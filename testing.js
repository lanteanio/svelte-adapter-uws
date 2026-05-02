import { randomUUID } from 'node:crypto';
import { parseCookies } from './files/cookies.js';
import { nextTopicSeq, completeEnvelope, esc, isValidWireTopic, createScopedTopic, WS_SUBSCRIPTIONS, WS_SESSION_ID } from './files/utils.js';

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

	/** @param {unknown} ref @returns {ref is number | string} */
	function hasRefT(ref) { return typeof ref === 'number' || typeof ref === 'string'; }
	/** @param {any} ws @param {string} topic @returns {string | null} */
	function runSubscribeHookT(ws, topic) {
		if (!handler.subscribe) return null;
		const result = handler.subscribe(ws, topic, { platform });
		if (result === false) return 'FORBIDDEN';
		if (typeof result === 'string') return result;
		return null;
	}
	/** @param {any} ws @param {string[]} topics @returns {Record<string, string> | null} */
	function runSubscribeBatchHookT(ws, topics) {
		if (!handler.subscribeBatch) return null;
		const result = handler.subscribeBatch(ws, topics, { platform });
		/** @type {Record<string, string>} */
		const denials = {};
		if (!result || typeof result !== 'object') return denials;
		for (const [topic, val] of Object.entries(result)) {
			if (val === false) denials[topic] = 'FORBIDDEN';
			else if (typeof val === 'string') denials[topic] = val;
		}
		return denials;
	}
	/** @param {any} ws @param {string} topic @param {number | string | null} ref */
	function sendSubscribedT(ws, topic, ref) {
		if (ref === null) return;
		ws.send(JSON.stringify({ type: 'subscribed', topic, ref }), false, false);
	}
	/** @param {any} ws @param {string} topic @param {number | string | null} ref @param {string} reason */
	function sendDeniedT(ws, topic, ref, reason) {
		if (ref === null) return;
		ws.send(JSON.stringify({ type: 'subscribe-denied', topic, ref, reason }), false, false);
	}

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
			return createScopedTopic(platform.publish, name);
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
			const userData = ws.getUserData();
			userData[WS_SUBSCRIPTIONS] = new Set();
			const sessionId = randomUUID();
			userData[WS_SESSION_ID] = sessionId;
			ws.send('{"type":"welcome","sessionId":"' + sessionId + '"}', false, false);
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
							const ref = hasRefT(msg.ref) ? msg.ref : null;
							if (!isValidWireTopic(msg.topic)) {
								sendDeniedT(ws, msg.topic, ref, 'INVALID_TOPIC');
								return;
							}
							const denial = runSubscribeHookT(ws, msg.topic);
							if (denial !== null) {
								sendDeniedT(ws, msg.topic, ref, denial);
								return;
							}
							ws.subscribe(msg.topic);
							ws.getUserData()[WS_SUBSCRIPTIONS]?.add(msg.topic);
							sendSubscribedT(ws, msg.topic, ref);
							return;
						}
						if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
							ws.unsubscribe(msg.topic);
							ws.getUserData()[WS_SUBSCRIPTIONS]?.delete(msg.topic);
							handler.unsubscribe?.(ws, msg.topic, { platform });
							return;
						}
						if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
							const ref = hasRefT(msg.ref) ? msg.ref : null;
							const valid = [];
							for (const topic of msg.topics.slice(0, 256)) {
								if (!isValidWireTopic(topic)) {
									sendDeniedT(ws, topic, ref, 'INVALID_TOPIC');
									continue;
								}
								valid.push(topic);
							}
							const batchDenials = runSubscribeBatchHookT(ws, valid);
							for (const topic of valid) {
								const denial = batchDenials !== null
									? (batchDenials[topic] ?? null)
									: runSubscribeHookT(ws, topic);
								if (denial !== null) {
									sendDeniedT(ws, topic, ref, denial);
									continue;
								}
								ws.subscribe(topic);
								ws.getUserData()[WS_SUBSCRIPTIONS]?.add(topic);
								sendSubscribedT(ws, topic, ref);
							}
							return;
						}
						if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
							msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
							if (handler.resume) {
								try {
									handler.resume(ws, {
										sessionId: msg.sessionId,
										lastSeenSeqs: msg.lastSeenSeqs,
										platform
									});
								} catch (err) {
									console.error('[adapter-uws/testing] resume hook threw:', err);
								}
							}
							ws.send('{"type":"resumed"}', false, false);
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
			const subs = ws.getUserData()?.[WS_SUBSCRIPTIONS] || new Set();
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
