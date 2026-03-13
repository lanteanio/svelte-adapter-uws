import { WebSocketServer } from 'ws';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseCookies } from './files/cookies.js';

/**
 * Safely quote a string for JSON embedding. Throws on invalid characters
 * (quotes, backslashes, control chars)  - these are always bugs in topic/event names.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

/**
 * Vite plugin that provides WebSocket support during development.
 *
 * Uses the same subscribe/unsubscribe/publish protocol as the production
 * uWS handler, so the client store works identically in dev and prod.
 *
 * @param {{ path?: string, handler?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function uws(options = {}) {
	const wsPath = options.path || '/ws';

	/** @type {WebSocketServer} */
	let wss;

	/** @type {Map<import('ws').WebSocket, Set<string>>} */
	const subscriptions = new Map();

	/** @type {Set<import('ws').WebSocket>} */
	const connections = new Set();

	/** @type {Map<import('ws').WebSocket, object>} */
	const wsWrappers = new Map();

	/** @type {{ upgrade?: Function, open?: Function, message?: Function, close?: Function, drain?: Function, subscribe?: Function }} */
	let userHandlers = {};

	/**
	 * Wrap a ws WebSocket to mimic the uWS WebSocket API.
	 * @param {import('ws').WebSocket} rawWs
	 * @param {unknown} userData
	 */
	function wrapWebSocket(rawWs, userData) {
		const topics = subscriptions.get(rawWs) || new Set();
		return {
			send(message, isBinary = false, _compress = false) {
				if (rawWs.readyState !== 1) return 0;
				rawWs.send(typeof message === 'string' ? message : Buffer.from(message));
				return 1;
			},
			close() { rawWs.close(); },
			end(code, message) { rawWs.close(code, message?.toString()); },
			subscribe(topic) { topics.add(topic); return true; },
			unsubscribe(topic) { topics.delete(topic); return true; },
			publish(topic, message, isBinary = false, _compress = false) {
				const msg = typeof message === 'string' ? message : Buffer.from(message);
				for (const [ws, wsTopics] of subscriptions) {
					if (ws !== rawWs && wsTopics.has(topic) && ws.readyState === 1) {
						ws.send(msg);
					}
				}
				return true;
			},
			isSubscribed(topic) { return topics.has(topic); },
			getTopics() { return [...topics]; },
			getUserData() { return userData; },
			getBufferedAmount() { return rawWs.bufferedAmount || 0; },
			getRemoteAddress() {
				// uWS returns raw binary bytes (4 for IPv4, 16 for IPv6).
				// Dev only handles IPv4; exotic addresses fall back to text encoding.
				const ip = rawWs._socket?.remoteAddress || '127.0.0.1';
				const v4 = ip.replace(/^::ffff:/, '');
				const parts = v4.split('.');
				if (parts.length === 4) return new Uint8Array(parts.map(Number)).buffer;
				return new TextEncoder().encode(ip).buffer;
			},
			getRemoteAddressAsText() {
				return new TextEncoder().encode(rawWs._socket?.remoteAddress || '127.0.0.1').buffer;
			},
			cork(fn) { fn(); }
		};
	}

	/**
	 * Publish to all subscribers of a topic.
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @returns {boolean}
	 */
	function publish(topic, event, data) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}';
		let sent = false;
		for (const [ws, topics] of subscriptions) {
			if (topics.has(topic) && ws.readyState === 1) {
				ws.send(envelope);
				sent = true;
			}
		}
		return sent;
	}

	/**
	 * Send to a single connection.
	 * @param {object} ws - Wrapped WebSocket
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @returns {number}
	 */
	function send(ws, topic, event, data) {
		return ws.send('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}', false, false) ?? 1;
	}

	/**
	 * Send to connections matching a filter (by userData).
	 * @param {(userData: any) => boolean} filter
	 * @param {string} topic
	 * @param {string} event
	 * @param {unknown} [data]
	 * @returns {number}
	 */
	function sendTo(filter, topic, event, data) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data) + '}';
		let count = 0;
		for (const [, wrapped] of wsWrappers) {
			if (filter(wrapped.getUserData())) {
				wrapped.send(envelope);
				count++;
			}
		}
		return count;
	}

	// Dev-mode platform - same API shape as production
	const platform = {
		publish,
		send,
		sendTo,
		get connections() { return connections.size; },
		subscribers(topic) {
			let count = 0;
			for (const [, topics] of subscriptions) {
				if (topics.has(topic)) count++;
			}
			return count;
		},
		topic(name) {
			return {
				publish: (/** @type {string} */ event, /** @type {unknown} */ data) => publish(name, event, data),
				created: (/** @type {unknown} */ data) => publish(name, 'created', data),
				updated: (/** @type {unknown} */ data) => publish(name, 'updated', data),
				deleted: (/** @type {unknown} */ data) => publish(name, 'deleted', data),
				set: (/** @type {number} */ value) => publish(name, 'set', value),
				increment: (/** @type {number} */ amount = 1) => publish(name, 'increment', amount),
				decrement: (/** @type {number} */ amount = 1) => publish(name, 'decrement', amount)
			};
		}
	};

	// Expose platform globally so hooks/load functions can access it in dev
	globalThis.__uws_dev_platform = platform;

	/** @type {Promise<void>} */
	let handlerReady;

	/** @type {import('vite').ViteDevServer | null} */
	let viteServer = null;

	/** @type {string | null} Resolved absolute path of the WS handler file */
	let resolvedHandlerPath = null;

	/** True when a handler file was found but failed to load - reject upgrades */
	let handlerFailed = false;

	/**
	 * Extract handler functions from a loaded module.
	 * @param {Record<string, any>} mod
	 */
	function applyHandlers(mod) {
		userHandlers = {
			upgrade: mod.upgrade,
			open: mod.open,
			message: mod.message,
			close: mod.close,
			drain: mod.drain,
			subscribe: mod.subscribe
		};
	}

	/**
	 * Discover the WS handler file path.
	 * @param {string} root
	 * @returns {string | null}
	 */
	function discoverHandler(root) {
		if (options.handler) return path.resolve(root, options.handler);
		const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
		for (const candidate of candidates) {
			const full = path.resolve(root, candidate);
			if (existsSync(full)) return full;
		}
		return null;
	}

	return {
		name: 'svelte-adapter-uws',
		config(config, env) {
			// During SSR build, inject ws-handler as an additional entry so it
			// goes through the same Vite pipeline as hooks.server.ts - resolving
			// $lib, $env, $app aliases and sharing modules with the server bundle.
			if (env.isSsrBuild) {
				const root = config.root || process.cwd();
				const handlerPath = discoverHandler(root);
				if (handlerPath) {
					return {
						build: {
							rollupOptions: {
								input: {
									'ws-handler': handlerPath
								}
							}
						}
					};
				}
			}
		},
		configureServer(server) {
			console.warn('[adapter-uws] Dev mode does not enforce allowedOrigins. ' +
				'WebSocket origin checks only run in production.');
			wss = new WebSocketServer({ noServer: true });
			viteServer = server;
			const root = server.config.root;

			// Load user's WebSocket handler via Vite's ssrLoadModule (handles TS/aliases/etc.)
			const handlerPath = options.handler
				? path.resolve(root, options.handler)
				: null;

			if (handlerPath) {
				resolvedHandlerPath = handlerPath;
				handlerReady = server.ssrLoadModule(handlerPath).then((mod) => {
					handlerFailed = false;
					applyHandlers(mod);
				}).catch((err) => {
					handlerFailed = true;
					console.error(`[adapter-uws] Failed to load WebSocket handler '${options.handler}':`, err);
				});
			} else {
				// Auto-discover src/hooks.ws.{js,ts,mjs}
				const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
				handlerReady = (async () => {
					for (const candidate of candidates) {
						const fullPath = path.resolve(root, candidate);
						if (!existsSync(fullPath)) continue;
						resolvedHandlerPath = fullPath;
						try {
							const mod = await server.ssrLoadModule(fullPath);
							handlerFailed = false;
							applyHandlers(mod);
							break;
						} catch (err) {
							handlerFailed = true;
							console.error(`[adapter-uws] Error loading '${candidate}':`, err.message);
							break;
						}
					}
				})();
			}

			server.httpServer?.on('upgrade', async (req, socket, head) => {
				const { pathname } = new URL(req.url || '', 'http://localhost');
				if (pathname !== wsPath) return;

				// If user has an upgrade handler, run it for auth
				let userData = {};
				await handlerReady;

				// If the handler file exists but failed to load, reject the
				// upgrade so a broken auth handler does not silently degrade
				// to open access.
				if (handlerFailed) {
					socket.write(
						'HTTP/1.1 500 Internal Server Error\r\n' +
						'Content-Type: text/plain\r\n\r\n' +
						'WebSocket handler failed to load - check the server console'
					);
					socket.destroy();
					return;
				}

				if (userHandlers.upgrade) {
					/** @type {Record<string, string>} */
					const headers = {};
					for (const [key, value] of Object.entries(req.headers)) {
						if (typeof value === 'string') headers[key] = value;
						else if (Array.isArray(value)) headers[key] = value.join(', ');
					}

					try {
						const result = await Promise.resolve(
							userHandlers.upgrade({
								headers,
								cookies: parseCookies(headers['cookie']),
								url: pathname,
								remoteAddress: req.socket?.remoteAddress || ''
							})
						);
						if (result === false) {
							socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized');
							socket.destroy();
							return;
						}
						userData = result || {};
					} catch (err) {
						console.error('[adapter-uws] WebSocket upgrade error:', err);
						socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nInternal Server Error');
						socket.destroy();
						return;
					}
				}

				wss.handleUpgrade(req, socket, head, (ws) => {
					/** @type {any} */ (ws).__userData = userData;
					wss.emit('connection', ws, req);
				});
			});

			wss.on('connection', (ws) => {
				connections.add(ws);
				subscriptions.set(ws, new Set());

				const userData = /** @type {any} */ (ws).__userData || {};
				const wrapped = wrapWebSocket(ws, userData);
				wsWrappers.set(ws, wrapped);

				// Call user open handler
				userHandlers.open?.(wrapped, { platform });

				ws.on('message', async (raw, isBinary) => {
					// Convert to ArrayBuffer (matching uWS interface)
					const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
					const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

					// Handle subscribe/unsubscribe from client store
				// Byte-prefix check: {"type" has byte[3]='y' (0x79), user envelopes
				// {"topic" have byte[3]='o' - skip JSON.parse for non-control messages.
					if (!isBinary && buf.byteLength < 512 && buf[3] === 0x79) {
						try {
							const msg = JSON.parse(buf.toString());
							if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
								if (userHandlers.subscribe && userHandlers.subscribe(wrapped, msg.topic, { platform }) === false) {
									return;
								}
								subscriptions.get(ws)?.add(msg.topic);
								return;
							}
							if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
								subscriptions.get(ws)?.delete(msg.topic);
								return;
							}
						} catch {
							// Not JSON - fall through to user handler
						}
					}

					// Delegate to user handler
					await handlerReady;
					if (userHandlers.message) {
						userHandlers.message(wrapped, { data: arrayBuffer, isBinary: !!isBinary, platform });
					}
				});

				ws.on('close', (code, reason) => {
					const reasonBuf = reason || Buffer.alloc(0);
					const reasonAB = reasonBuf.buffer.slice(reasonBuf.byteOffset, reasonBuf.byteOffset + reasonBuf.byteLength);
					userHandlers.close?.(wrapped, { code, message: reasonAB, platform });
					connections.delete(ws);
					subscriptions.delete(ws);
					wsWrappers.delete(ws);
				});
			});

			console.log(`[adapter-uws] Dev WebSocket endpoint at ${wsPath}`);
			if (wsPath !== '/ws') {
				console.log(`[adapter-uws] Client must match: connect({ path: '${wsPath}' })`);
			}
		},
		handleHotUpdate({ server }) {
			if (!resolvedHandlerPath) return;
			// Vite invalidates a module and all its importers when a file changes.
			// Re-load the handler on every HMR update - ssrLoadModule returns the
			// cached module instantly when nothing was invalidated, so this is cheap.
			// We compare function references to detect actual changes.
			handlerReady = server.ssrLoadModule(resolvedHandlerPath).then((mod) => {
				handlerFailed = false;
				if (mod.upgrade !== userHandlers.upgrade ||
					mod.open !== userHandlers.open ||
					mod.message !== userHandlers.message ||
					mod.close !== userHandlers.close ||
					mod.drain !== userHandlers.drain ||
					mod.subscribe !== userHandlers.subscribe) {
					applyHandlers(mod);
					console.log('[adapter-uws] WebSocket handler reloaded');
				}
			}).catch((err) => {
				handlerFailed = true;
				console.error('[adapter-uws] Failed to reload WebSocket handler:', err.message);
			});
		}
	};
}

/** @deprecated Use `uws()` instead. */
export const uwsDev = uws;
