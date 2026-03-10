import { WebSocketServer } from 'ws';
import path from 'node:path';
import { parseCookies } from './files/cookies.js';

/**
 * Vite plugin that provides WebSocket support during development.
 *
 * Uses the same subscribe/unsubscribe/publish protocol as the production
 * uWS handler, so the client store works identically in dev and prod.
 *
 * @param {{ path?: string, handler?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function uwsDev(options = {}) {
	const wsPath = options.path || '/ws';

	/** @type {WebSocketServer} */
	let wss;

	/** @type {Map<import('ws').WebSocket, Set<string>>} */
	const subscriptions = new Map();

	/** @type {Set<import('ws').WebSocket>} */
	const connections = new Set();

	/** @type {Map<import('ws').WebSocket, object>} */
	const wsWrappers = new Map();

	/** @type {{ upgrade?: Function, open?: Function, message?: Function, close?: Function, drain?: Function }} */
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
				return new TextEncoder().encode(rawWs._socket?.remoteAddress || '127.0.0.1').buffer;
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
		const envelope = JSON.stringify({ topic, event, data });
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
		return ws.send(JSON.stringify({ topic, event, data }), false, false) ?? 1;
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
		const envelope = JSON.stringify({ topic, event, data });
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

	return {
		name: 'svelte-adapter-uws',
		configureServer(server) {
			wss = new WebSocketServer({ noServer: true });
			const root = server.config.root;

			// Load user's WebSocket handler - all exports, not just message
			const handlerPath = options.handler
				? path.resolve(root, options.handler)
				: null;

			if (handlerPath) {
				handlerReady = import(handlerPath).then((mod) => {
					userHandlers = {
						upgrade: mod.upgrade,
						open: mod.open,
						message: mod.message,
						close: mod.close,
						drain: mod.drain,
						subscribe: mod.subscribe
					};
				}).catch((err) => {
					console.error(`[adapter-uws] Failed to load WebSocket handler '${options.handler}':`, err);
				});
			} else {
				// Auto-discover src/hooks.ws.{js,ts,mjs}
				const candidates = ['src/hooks.ws.js', 'src/hooks.ws.ts', 'src/hooks.ws.mjs'];
				handlerReady = (async () => {
					for (const candidate of candidates) {
						try {
							const mod = await import(path.resolve(root, candidate));
							userHandlers = {
								upgrade: mod.upgrade,
								open: mod.open,
								message: mod.message,
								close: mod.close,
								drain: mod.drain,
								subscribe: mod.subscribe
							};
							break;
						} catch (err) {
							// File genuinely doesn't exist - try next candidate
							if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT') continue;
							// File exists but has errors - report and stop searching
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
				userHandlers.open?.(wrapped);

				ws.on('message', async (raw, isBinary) => {
					// Convert to ArrayBuffer (matching uWS interface)
					const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(/** @type {any} */ (raw));
					const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

					// Handle subscribe/unsubscribe from client store
					if (!isBinary && buf.byteLength < 512) {
						try {
							const msg = JSON.parse(buf.toString());
							if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
								if (userHandlers.subscribe && userHandlers.subscribe(wrapped, msg.topic) === false) {
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
						userHandlers.message(wrapped, arrayBuffer, !!isBinary);
					}
				});

				ws.on('close', (code, reason) => {
					const reasonBuf = reason || Buffer.alloc(0);
					const reasonAB = reasonBuf.buffer.slice(reasonBuf.byteOffset, reasonBuf.byteOffset + reasonBuf.byteLength);
					userHandlers.close?.(wrapped, code, reasonAB);
					connections.delete(ws);
					subscriptions.delete(ws);
					wsWrappers.delete(ws);
				});
			});

			console.log(`[adapter-uws] Dev WebSocket endpoint at ${wsPath}`);
			if (wsPath !== '/ws') {
				console.log(`[adapter-uws] Client must match: connect({ path: '${wsPath}' })`);
			}
		}
	};
}
