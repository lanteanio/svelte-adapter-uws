import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseCookies, createCookies } from './files/cookies.js';
import { esc, isValidWireTopic, createScopedTopic, WS_SUBSCRIPTIONS } from './files/utils.js';

/**
 * Vite plugin that provides WebSocket support during development.
 *
 * Uses the same subscribe/unsubscribe/publish protocol as the production
 * uWS handler, so the client store works identically in dev and prod.
 *
 * @param {{ path?: string, handler?: string, authPath?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function uws(options = {}) {
	const wsPath = options.path || '/ws';
	const wsAuthPath = options.authPath || '/__ws/auth';

	/** @type {import('ws').WebSocketServer | undefined} */
	let wss;

	/** @type {Map<import('ws').WebSocket, Set<string>>} */
	const subscriptions = new Map();

	/** @type {Set<import('ws').WebSocket>} */
	const connections = new Set();

	/** @type {Map<import('ws').WebSocket, object>} */
	const wsWrappers = new Map();

	/** @type {{ upgrade?: Function, open?: Function, message?: Function, close?: Function, drain?: Function, subscribe?: Function, unsubscribe?: Function, authenticate?: Function }} */
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
				const ip = rawWs._socket?.remoteAddress || '127.0.0.1';
				const v4 = ip.replace(/^::ffff:/, '');
				const parts = v4.split('.');
				if (parts.length === 4) return new Uint8Array(parts.map(Number)).buffer;
				// IPv6: expand :: into zeroes, pack 8 groups into 16 bytes
				const halves = v4.split('::');
				const left = halves[0] ? halves[0].split(':') : [];
				const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
				const pad = Array(8 - left.length - right.length).fill('0');
				const groups = [...left, ...pad, ...right].map(g => parseInt(g, 16));
				const buf = new Uint8Array(16);
				for (let i = 0; i < 8; i++) {
					buf[i * 2] = (groups[i] >> 8) & 0xff;
					buf[i * 2 + 1] = groups[i] & 0xff;
				}
				return buf.buffer;
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
	 * @param {{ relay?: boolean }} [_options] - Accepted for API parity with production; ignored in dev (single-process).
	 * @returns {boolean}
	 */
	function publish(topic, event, data, _options) {
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
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
		return ws.send('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}', false, false) ?? 1;
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
		const envelope = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":' + JSON.stringify(data ?? null) + '}';
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
			return createScopedTopic(publish, name);
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
			subscribe: mod.subscribe,
			unsubscribe: mod.unsubscribe,
			authenticate: mod.authenticate
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
		async configureServer(server) {
			// In middleware mode Vite does not own the HTTP server, so WS upgrade cannot be attached.
			if (!server.httpServer) {
				server.config.logger.warn(
					'[svelte-adapter-uws] WebSocket support requires Vite to own the HTTP server. ' +
					'It is not available in middleware mode (server.httpServer is null). ' +
					'WebSocket features will be disabled in dev.'
				);
				return;
			}

			/** @type {typeof import('ws').WebSocketServer} */
			let WebSocketServer;
			try {
				({ WebSocketServer } = await import('ws'));
			} catch {
				server.config.logger.warn(
					'[svelte-adapter-uws] The "ws" package is not installed. ' +
					'WebSocket features are disabled in dev. Install with: npm i -D ws'
				);
				return;
			}

			// Warn if our WS path collides with the Vite HMR WebSocket path.
			const hmrConfig = server.config.server?.hmr;
			if (hmrConfig && typeof hmrConfig === 'object' && hmrConfig.path === wsPath) {
				server.config.logger.warn(
					`[svelte-adapter-uws] WebSocket path "${wsPath}" collides with the Vite HMR path. ` +
					'Set a different path via the websocket.path adapter option or server.hmr.path in vite.config.'
				);
			}

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

			// /__ws/auth middleware: runs the user's `authenticate` hook as a normal
			// HTTP POST so session cookies are refreshed via a standard Set-Cookie
			// on a 200-series response. Mirrors the production handler in dev.
			server.middlewares.use(wsAuthPath, async (req, res, next) => {
				await handlerReady;
				if (!userHandlers.authenticate) { next(); return; }
				if (req.method !== 'POST') {
					res.statusCode = 405;
					res.setHeader('allow', 'POST');
					res.setHeader('content-type', 'text/plain');
					res.end('Method Not Allowed');
					return;
				}

				/** @type {Record<string, string>} */
				const headers = {};
				for (const [k, v] of Object.entries(req.headers)) {
					if (typeof v === 'string') headers[k] = v;
					else if (Array.isArray(v)) headers[k] = v.join(', ');
				}

				// Read body (capped at 64 KB; the hook rarely needs it).
				const AUTH_BODY_LIMIT = 64 * 1024;
				/** @type {Buffer[]} */
				const chunks = [];
				let total = 0;
				let oversized = false;
				for await (const chunk of req) {
					total += chunk.length;
					if (total > AUTH_BODY_LIMIT) { oversized = true; break; }
					chunks.push(chunk);
				}
				if (oversized) {
					res.statusCode = 413;
					res.setHeader('content-type', 'text/plain');
					res.end('Content Too Large');
					return;
				}
				const bodyBuf = Buffer.concat(chunks);

				const origin = 'http://' + (headers['host'] || 'localhost');
				const url = req.url || wsAuthPath;
				const request = new Request(origin + url, {
					method: 'POST',
					headers,
					body: bodyBuf.length > 0 ? bodyBuf : undefined,
					// @ts-expect-error
					duplex: 'half'
				});

				const cookies = createCookies(headers['cookie']);
				const clientIp = req.socket?.remoteAddress || '';
				const event = {
					request,
					headers,
					cookies,
					url,
					remoteAddress: clientIp,
					getClientAddress: () => clientIp,
					platform
				};

				try {
					const result = await Promise.resolve(userHandlers.authenticate(event));

					if (result === false) {
						res.statusCode = 401;
						res.setHeader('content-type', 'text/plain');
						res.end('Unauthorized');
						return;
					}

					if (result instanceof Response) {
						res.statusCode = result.status;
						for (const [hk, hv] of result.headers) {
							if (hk === 'set-cookie' || hk === 'content-length') continue;
							res.setHeader(hk, hv);
						}
						const outCookies = [
							...result.headers.getSetCookie(),
							...cookies._serialize()
						];
						if (outCookies.length > 0) res.setHeader('set-cookie', outCookies);
						if (result.body) {
							const buf = Buffer.from(await result.arrayBuffer());
							res.end(buf);
						} else {
							res.end();
						}
						return;
					}

					res.statusCode = 204;
					const outCookies = cookies._serialize();
					if (outCookies.length > 0) res.setHeader('set-cookie', outCookies);
					res.end();
				} catch (err) {
					console.error('[adapter-uws] authenticate error:', err);
					res.statusCode = 500;
					res.setHeader('content-type', 'text/plain');
					res.end('Internal Server Error');
				}
			});

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
								url: req.url || pathname,
								remoteAddress: req.socket?.remoteAddress || ''
							})
						);
						if (result === false) {
							socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized');
							socket.destroy();
							return;
						}
						if (result && result.__upgradeResponse === true) {
							userData = result.userData || {};
							if (result.headers && Object.keys(result.headers).length > 0) {
								const hasSetCookie = Object.keys(result.headers).some(
									(k) => k.toLowerCase() === 'set-cookie'
								);
								if (hasSetCookie) {
									console.warn(
										'[adapter-uws] upgradeResponse() attaches Set-Cookie to the 101 response. ' +
										'This fails silently behind Cloudflare Tunnel and some other strict edge proxies ' +
										'(WebSocket opens, then closes with 1006). Use the `authenticate` hook to ' +
										'refresh session cookies over a normal HTTP response.'
									);
								} else {
									console.warn('[adapter-uws] upgrade() returned response headers. These are only applied in production (uWS); the ws library used in dev does not support custom 101 headers.');
								}
							}
						} else {
							userData = result || {};
						}
					} catch (err) {
						console.error('[adapter-uws] WebSocket upgrade error:', err);
						socket.write('HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nInternal Server Error');
						socket.destroy();
						return;
					}
				}

				wss.handleUpgrade(req, socket, head, (ws) => {
					// Ensure remoteAddress is always present in userData, matching
					// what the production handler injects. Plugins like ratelimit
					// depend on ws.getUserData().remoteAddress for per-IP keying.
					const remoteAddress = /** @type {any} */ (userData).remoteAddress
						|| req.socket?.remoteAddress
						|| '';
					/** @type {any} */ (ws).__userData = { remoteAddress, .../** @type {any} */ (userData) };
					wss.emit('connection', ws, req);
				});
			});

			wss.on('connection', (ws) => {
				connections.add(ws);
				subscriptions.set(ws, new Set());

				const userData = /** @type {any} */ (ws).__userData || {};
				userData[WS_SUBSCRIPTIONS] = new Set();
				const wrapped = wrapWebSocket(ws, userData);
				wsWrappers.set(ws, wrapped);

				// Call user open handler
				userHandlers.open?.(wrapped, { platform });

				ws.on('message', async (raw, isBinary) => {
					// Convert to ArrayBuffer (matching uWS interface)
					const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
					const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

					// Handle subscribe/unsubscribe/subscribe-batch from client store.
				// Byte-prefix check: {"type" has byte[3]='y' (0x79), user envelopes
				// {"topic" have byte[3]='o' - skip JSON.parse for non-control messages.
				// 8192 bytes matches the production handler ceiling and is large
				// enough for a subscribe-batch with many topics.
					if (!isBinary && buf.byteLength < 8192 && buf[3] === 0x79) {
						try {
							const msg = JSON.parse(buf.toString());
							if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
								if (!isValidWireTopic(msg.topic)) return;
								if (userHandlers.subscribe && userHandlers.subscribe(wrapped, msg.topic, { platform }) === false) {
									return;
								}
								subscriptions.get(ws)?.add(msg.topic);
								/** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS]?.add(msg.topic);
								return;
							}
							if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
								subscriptions.get(ws)?.delete(msg.topic);
								/** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS]?.delete(msg.topic);
								userHandlers.unsubscribe?.(wrapped, msg.topic, { platform });
								return;
							}
							if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
								// Sent by the client store on open/reconnect to resubscribe all
								// topics in one message instead of N individual subscribe frames.
								const subs = subscriptions.get(ws);
								const topics = msg.topics.slice(0, 256);
								for (const topic of topics) {
									if (!isValidWireTopic(topic)) continue;
									if (userHandlers.subscribe && userHandlers.subscribe(wrapped, topic, { platform }) === false) continue;
									subs?.add(topic);
									/** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS]?.add(topic);
								}
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
					const subs = /** @type {any} */ (ws).__userData?.[WS_SUBSCRIPTIONS] || new Set();
					userHandlers.close?.(wrapped, { code, message: reasonAB, platform, subscriptions: subs });
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
					mod.subscribe !== userHandlers.subscribe ||
					mod.unsubscribe !== userHandlers.unsubscribe) {
					applyHandlers(mod);
					// Close existing connections so they reconnect with the new handler.
					// 1012 = "Service Restart" - clients with auto-reconnect will reconnect.
					for (const ws of connections) {
						ws.close(1012, 'Handler reloaded');
					}
					console.log('[adapter-uws] WebSocket handler reloaded, existing connections closed');
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
