import { parseCookies } from './files/cookies.js';
import { nextTopicSeq, completeEnvelope } from './files/utils.js';

/**
 * Safely quote a string for JSON embedding. Throws on invalid characters.
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
 * Build a JSON envelope string matching the production wire format.
 * @param {string} topic
 * @param {string} event
 * @param {unknown} [data]
 * @param {number | null} [seq]
 * @returns {string}
 */
function envelope(topic, event, data, seq) {
	const prefix = '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":';
	return completeEnvelope(prefix, data, seq);
}

/**
 * Create a lightweight test server backed by a real uWebSockets.js instance.
 *
 * Starts on a random port and provides a Platform-compatible API for
 * publishing, sending, and asserting on WebSocket behavior.
 *
 * @param {import('./testing.js').TestServerOptions} [options]
 * @returns {Promise<import('./testing.js').TestServer>}
 */
export async function createTestServer(options = {}) {
	const { port = 0, wsPath = '/ws', handler = {} } = options;

	let uWS;
	try {
		uWS = (await import('uWebSockets.js')).default;
	} catch {
		throw new Error(
			'createTestServer requires uWebSockets.js to be installed.\n' +
			'  npm install uNetworking/uWebSockets.js#v20.60.0'
		);
	}

	const app = uWS.App();

	/** @type {Set<import('uWebSockets.js').WebSocket<any>>} */
	const wsConnections = new Set();

	/** @type {Map<string, number>} */
	const topicSeqs = new Map();

	/** @type {Array<(value: any) => void>} */
	let connectionWaiters = [];

	/** @type {Array<{ resolve: (value: any) => void, timer: ReturnType<typeof setTimeout> }>} */
	let messageWaiters = [];

	const platform = {
		publish(topic, event, data, options) {
			const seq = (options && options.seq === false)
				? null
				: nextTopicSeq(topicSeqs, topic);
			const msg = envelope(topic, event, data, seq);
			return app.publish(topic, msg, false, false);
		},
		send(ws, topic, event, data) {
			return ws.send(envelope(topic, event, data), false, false);
		},
		sendTo(filter, topic, event, data) {
			const msg = envelope(topic, event, data);
			let count = 0;
			for (const ws of wsConnections) {
				if (filter(ws.getUserData())) {
					ws.send(msg, false, false);
					count++;
				}
			}
			return count;
		},
		get connections() { return wsConnections.size; },
		subscribers(topic) { return app.numSubscribers(topic); },
		batch(messages) {
			return messages.map(({ topic, event, data }) => platform.publish(topic, event, data));
		},
		topic(name) {
			return {
				publish: (event, data) => platform.publish(name, event, data),
				created: (data) => platform.publish(name, 'created', data),
				updated: (data) => platform.publish(name, 'updated', data),
				deleted: (data) => platform.publish(name, 'deleted', data),
				set: (value) => platform.publish(name, 'set', value),
				increment: (amount = 1) => platform.publish(name, 'increment', amount),
				decrement: (amount = 1) => platform.publish(name, 'decrement', amount)
			};
		}
	};

	app.ws(wsPath, {
		maxPayloadLength: 64 * 1024,
		idleTimeout: 120,
		sendPingsAutomatically: true,

		upgrade(res, req, context) {
			const headers = {};
			req.forEach((k, v) => { headers[k] = v; });
			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();
			const rawIp = new TextDecoder().decode(res.getRemoteAddressAsText());

			if (!handler.upgrade) {
				res.cork(() => {
					res.upgrade({ remoteAddress: rawIp }, secKey, secProtocol, secExtensions, context);
				});
				return;
			}

			let aborted = false;
			res.onAborted(() => { aborted = true; });

			const cookies = parseCookies(headers['cookie']);
			Promise.resolve(handler.upgrade({ headers, cookies, url, remoteAddress: rawIp }))
				.then((result) => {
					if (aborted) return;
					if (result === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						return;
					}
					let userData;
					let responseHeaders = null;
					if (result && result.__upgradeResponse === true) {
						userData = result.userData || {};
						responseHeaders = result.headers;
					} else {
						userData = result || {};
					}
					if (!userData.remoteAddress) userData.remoteAddress = rawIp;
					res.cork(() => {
						if (responseHeaders) {
							for (const [hk, hv] of Object.entries(responseHeaders)) {
								if (Array.isArray(hv)) {
									for (const v of hv) res.writeHeader(hk, v);
								} else {
									res.writeHeader(hk, hv);
								}
							}
						}
						res.upgrade(userData, secKey, secProtocol, secExtensions, context);
					});
				})
				.catch((err) => {
					if (!aborted) {
						res.cork(() => {
							res.writeStatus('500 Internal Server Error');
							res.writeHeader('content-type', 'text/plain');
							res.end('Internal Server Error');
						});
					}
				});
		},

		open(ws) {
			ws.getUserData().__subscriptions = new Set();
			wsConnections.add(ws);
			handler.open?.(ws, { platform });
			for (const resolve of connectionWaiters) resolve(undefined);
			connectionWaiters = [];
		},

		message(ws, message, isBinary) {
			// Handle subscribe/unsubscribe from client store
			if (!isBinary && message.byteLength < 8192) {
				const bytes = new Uint8Array(message);
				if (bytes[3] === 0x79) {
					try {
						const msg = JSON.parse(Buffer.from(message).toString());
						if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
							if (msg.topic.length === 0 || msg.topic.length > 256) return;
							if (handler.subscribe && handler.subscribe(ws, msg.topic, { platform }) === false) return;
							ws.subscribe(msg.topic);
							ws.getUserData().__subscriptions?.add(msg.topic);
							return;
						}
						if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
							ws.unsubscribe(msg.topic);
							ws.getUserData().__subscriptions?.delete(msg.topic);
							handler.unsubscribe?.(ws, msg.topic, { platform });
							return;
						}
						if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
							for (const topic of msg.topics.slice(0, 256)) {
								if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) continue;
								if (handler.subscribe && handler.subscribe(ws, topic, { platform }) === false) continue;
								ws.subscribe(topic);
								ws.getUserData().__subscriptions?.add(topic);
							}
							return;
						}
					} catch {}
				}
			}

			for (const waiter of messageWaiters) {
				clearTimeout(waiter.timer);
				waiter.resolve({ data: Buffer.from(message).toString(), isBinary });
			}
			messageWaiters = [];

			handler.message?.(ws, { data: message, isBinary, platform });
		},

		close(ws, code, message) {
			const subs = ws.getUserData()?.__subscriptions || new Set();
			handler.close?.(ws, { code, message, platform, subscriptions: subs });
			wsConnections.delete(ws);
		}
	});

	return new Promise((resolve, reject) => {
		app.listen(port, (listenSocket) => {
			if (!listenSocket) return reject(new Error('Failed to listen'));
			const boundPort = uWS.us_socket_local_port(listenSocket);
			resolve({
				url: `http://localhost:${boundPort}`,
				wsUrl: `ws://localhost:${boundPort}${wsPath}`,
				port: boundPort,
				platform,
				close() {
					for (const ws of wsConnections) ws.close(1001, 'Test server closing');
					wsConnections.clear();
					uWS.us_listen_socket_close(listenSocket);
				},
				waitForConnection(timeout = 5000) {
					return new Promise((resolve, reject) => {
						const timer = setTimeout(
							() => reject(new Error('waitForConnection timed out')),
							timeout
						);
						connectionWaiters.push(() => { clearTimeout(timer); resolve(undefined); });
					});
				},
				waitForMessage(timeout = 5000) {
					return new Promise((resolve, reject) => {
						const timer = setTimeout(
							() => {
								messageWaiters = messageWaiters.filter(w => w.timer !== timer);
								reject(new Error('waitForMessage timed out'));
							},
							timeout
						);
						messageWaiters.push({ resolve(v) { clearTimeout(timer); resolve(v); }, timer });
					});
				}
			});
		});
	});
}
