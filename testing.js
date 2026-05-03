import { randomUUID } from 'node:crypto';
import { parseCookies } from './files/cookies.js';
import { nextTopicSeq, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, resolveRequestId, createChaosState, createUpgradeAdmission, readAssertionCounts, WS_SUBSCRIPTIONS, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './files/utils.js';

// Curated re-exports for downstream test code (extensions, app-side
// integration tests, custom transport bridges that need to assert on
// the wire shape). Five wire-protocol helpers, three behavior helpers,
// and all eight userData slot constants. Production-internal helpers
// (mime lookup, byte parsing, sampler internals, etc.) deliberately
// stay unexported so the surface stays semver-stable for tests without
// blocking future refactors of the production hot paths.
export {
	esc,
	completeEnvelope,
	wrapBatchEnvelope,
	isValidWireTopic,
	createScopedTopic,
	collapseByCoalesceKey,
	resolveRequestId,
	createChaosState,
	WS_SUBSCRIPTIONS,
	WS_COALESCED,
	WS_SESSION_ID,
	WS_PENDING_REQUESTS,
	WS_STATS,
	WS_PLATFORM,
	WS_CAPS,
	WS_REQUEST_ID_KEY
};

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
	const { port = 0, wsPath = '/ws', handler = {}, upgradeAdmission } = options;

	// Same wiring shape as the production handler: a per-instance
	// admission state instantiated once, consulted at the top of the
	// upgrade hook (`tryAcquire` -> 503), and paced via `admit()` around
	// the actual `res.upgrade()` call. Off when both knobs are 0/unset.
	const admission = createUpgradeAdmission(upgradeAdmission);
	const ADMISSION_PER_TICK_BUDGET = upgradeAdmission?.perTickBudget || 0;

	/** @param {unknown} ref @returns {ref is number | string} */
	function hasRefT(ref) { return typeof ref === 'number' || typeof ref === 'string'; }
	/** @param {any} ws @param {string} topic @returns {string | null} */
	function runSubscribeHookT(ws, topic) {
		if (!handler.subscribe) return null;
		const result = handler.subscribe(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
		if (result === false) return 'FORBIDDEN';
		if (typeof result === 'string') return result;
		return null;
	}
	/** @param {any} ws @param {string[]} topics @returns {Record<string, string> | null} */
	function runSubscribeBatchHookT(ws, topics) {
		if (!handler.subscribeBatch) return null;
		const result = handler.subscribeBatch(ws, topics, { platform: ws.getUserData()[WS_PLATFORM] });
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
		const payload = JSON.stringify({ type: 'subscribed', topic, ref });
		sendOutboundT(ws, payload);
	}
	/** @param {any} ws @param {string} topic @param {number | string | null} ref @param {string} reason */
	function sendDeniedT(ws, topic, ref, reason) {
		if (ref === null) return;
		const payload = JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
		sendOutboundT(ws, payload);
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

	const closeHookRegisteredT = !!handler.close;
	function bumpInT(ws, message) {
		if (!closeHookRegisteredT) return;
		const stats = ws.getUserData()[WS_STATS];
		if (!stats) return;
		stats.messagesIn++;
		stats.bytesIn += typeof message === 'string' ? message.length : message.byteLength;
	}
	function bumpOutT(ws, payload) {
		if (!closeHookRegisteredT) return;
		const stats = ws.getUserData()[WS_STATS];
		if (!stats) return;
		stats.messagesOut++;
		stats.bytesOut += payload.length;
	}

	// Chaos / fault-injection harness. Inactive by default - all platform
	// methods take their fast path. Tests opt in via platform.__chaos({...})
	// to drop or delay outbound frames; sendOutboundT is the single
	// chokepoint every server-to-client frame in this harness flows through.
	const chaos = createChaosState();

	/**
	 * Single outbound chokepoint. Consults the chaos state, then either
	 * drops the frame, defers it via setTimeout, or sends it immediately.
	 * Returns the same number ws.send returns on the immediate path
	 * (uWS: 0 BACKPRESSURE, 1 SUCCESS, 2 DROPPED). Returns 0 on drop and
	 * 1 on slow-drain (the dispatch is queued; tests assert via timing).
	 *
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {string} payload
	 */
	function sendOutboundT(ws, payload) {
		if (chaos.shouldDropOutbound()) return 0;
		const delay = chaos.getDelayMs();
		if (delay > 0) {
			setTimeout(() => {
				try { ws.send(payload, false, false); } catch {}
				bumpOutT(ws, payload);
			}, delay);
			return 1;
		}
		const result = ws.send(payload, false, false);
		bumpOutT(ws, payload);
		return result;
	}

	const platform = {
		publish(topic, event, data, options) {
			const seq = (options && options.seq === false)
				? null
				: nextTopicSeq(topicSeqs, topic);
			const msg = envelope(topic, event, data, seq);
			// Fast path: hand fan-out to uWS's C++ TopicTree. Chaos cannot
			// intercept C++ dispatch, so when a scenario is active we
			// degrade to a JS-side fanout that consults the chaos state
			// per recipient.
			if (chaos.scenario === null) {
				return app.publish(topic, msg, false, false);
			}
			let delivered = false;
			for (const ws of wsConnections) {
				if (!ws.isSubscribed(topic)) continue;
				sendOutboundT(ws, msg);
				delivered = true;
			}
			return delivered;
		},
		send(ws, topic, event, data) {
			const payload = envelope(topic, event, data);
			return sendOutboundT(ws, payload);
		},
		sendTo(filter, topic, event, data) {
			const msg = envelope(topic, event, data);
			let count = 0;
			for (const ws of wsConnections) {
				if (filter(ws.getUserData())) {
					sendOutboundT(ws, msg);
					count++;
				}
			}
			return count;
		},
		get connections() { return wsConnections.size; },
		get assertions() { return readAssertionCounts(); },
		subscribers(topic) { return app.numSubscribers(topic); },
		batch(messages) {
			return messages.map(({ topic, event, data }) => platform.publish(topic, event, data));
		},
		publishBatched(messages) {
			if (!Array.isArray(messages) || messages.length === 0) return;
			messages = collapseByCoalesceKey(messages);
			if (messages.length === 0) return;
			const firstTopic = messages[0].topic;
			let allSameTopic = true;
			for (let i = 1; i < messages.length; i++) {
				if (messages[i].topic !== firstTopic) { allSameTopic = false; break; }
			}
			let allSeeAll = true;
			let everyoneCapable = true;
			let batchTopics = null;
			if (!allSameTopic) {
				batchTopics = new Set();
				for (let i = 0; i < messages.length; i++) batchTopics.add(messages[i].topic);
			}
			for (const ws of wsConnections) {
				const ud = ws.getUserData();
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || subs.size === 0) continue;
				let touchesAny = false;
				if (allSameTopic) {
					touchesAny = subs.has(firstTopic);
				} else {
					let touchesAll = true;
					for (const t of batchTopics) {
						if (subs.has(t)) touchesAny = true;
						else touchesAll = false;
					}
					if (touchesAny && !touchesAll) { allSeeAll = false; break; }
				}
				if (!touchesAny) continue;
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has('batch')) { everyoneCapable = false; break; }
			}
			if ((!allSameTopic && !allSeeAll) || !everyoneCapable) {
				// Slow-path fallback: per-event publish().
				for (let i = 0; i < messages.length; i++) {
					const m = messages[i];
					platform.publish(m.topic, m.event, m.data, m.options);
				}
				return;
			}
			const events = new Array(messages.length);
			for (let i = 0; i < messages.length; i++) {
				const m = messages[i];
				const seq = (m.options && m.options.seq === false)
					? null
					: nextTopicSeq(topicSeqs, m.topic);
				events[i] = { topic: m.topic, env: envelope(m.topic, m.event, m.data, seq) };
			}
			const slice = new Array(events.length);
			for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
			const sharedBatchEnv = wrapBatchEnvelope(slice);
			// Chaos check: when active, sendOutboundT consults drop /
			// delay state per recipient, so we cannot use the C++
			// fanout shortcut. Walk subs in JS and route through the
			// chaos chokepoint.
			if (chaos.scenario !== null) {
				for (const ws of wsConnections) {
					const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
					if (!subs || subs.size === 0) continue;
					let receives = false;
					if (allSameTopic) {
						receives = subs.has(firstTopic);
					} else {
						for (const t of batchTopics) {
							if (subs.has(t)) { receives = true; break; }
						}
					}
					if (receives) sendOutboundT(ws, sharedBatchEnv);
				}
				return;
			}
			const fanoutTopic = allSameTopic ? firstTopic : messages[0].topic;
			app.publish(fanoutTopic, sharedBatchEnv, false, false);
		},
		request(ws, event, data, options) {
			const userData = ws.getUserData();
			let pending = userData[WS_PENDING_REQUESTS];
			if (!pending) {
				pending = new Map();
				userData[WS_PENDING_REQUESTS] = pending;
			}
			if (pending.size >= MAX_PENDING_REQUESTS_PER_CONNECTION) {
				return Promise.reject(new Error(
					'pending requests exceeded ' + MAX_PENDING_REQUESTS_PER_CONNECTION +
					' on this connection'
				));
			}
			const ref = nextRequestRefT++;
			const timeoutMs = (options && options.timeoutMs) || 5000;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					if (pending.delete(ref)) reject(new Error('request timed out'));
				}, timeoutMs);
				pending.set(ref, { resolve, reject, timer });
				const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
				sendOutboundT(ws, payload);
			});
		},
		topic(name) {
			return createScopedTopic(platform.publish, name);
		},
		/**
		 * Activate or clear a chaos / fault-injection scenario. See
		 * `createChaosState` in `files/utils.js` for the supported shapes.
		 * Pass `null` to reset; the harness returns to its zero-overhead
		 * fast paths.
		 */
		__chaos(cfg) { chaos.set(cfg); }
	};
	let nextRequestRefT = 1;

	app.ws(wsPath, {
		maxPayloadLength: 64 * 1024,
		idleTimeout: 120,
		sendPingsAutomatically: true,

		upgrade(res, req, context) {
			// Pre-upgrade soft filter: cap concurrent in-flight upgrades.
			// Crossed requests get a fast 503 before any per-request work,
			// matching handler.js's wiring exactly.
			if (!admission.tryAcquire()) {
				res.cork(() => {
					res.writeStatus('503 Service Unavailable');
					res.writeHeader('content-type', 'text/plain');
					res.end('Server is at upgrade capacity, please retry');
				});
				return;
			}
			let inFlightReleased = false;
			function releaseInFlight() {
				if (inFlightReleased) return;
				inFlightReleased = true;
				admission.release();
			}

			const headers = {};
			req.forEach((k, v) => { headers[k] = v; });
			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();
			const rawIp = new TextDecoder().decode(res.getRemoteAddressAsText());

			const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUUID();

			if (!handler.upgrade) {
				let fastPathAborted = false;
				if (ADMISSION_PER_TICK_BUDGET > 0) {
					res.onAborted(() => { fastPathAborted = true; releaseInFlight(); });
				}
				admission.admit(() => {
					if (fastPathAborted) return;
					res.cork(() => {
						res.upgrade({ remoteAddress: rawIp, [WS_REQUEST_ID_KEY]: wsRequestId }, secKey, secProtocol, secExtensions, context);
					});
					releaseInFlight();
				});
				return;
			}

			let aborted = false;
			res.onAborted(() => { aborted = true; releaseInFlight(); });

			const cookies = parseCookies(headers['cookie']);
			Promise.resolve(handler.upgrade({ headers, cookies, url, remoteAddress: rawIp, requestId: wsRequestId }))
				.then((result) => {
					if (aborted) { releaseInFlight(); return; }
					if (result === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						releaseInFlight();
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
					userData[WS_REQUEST_ID_KEY] = wsRequestId;
					admission.admit(() => {
						if (aborted) { releaseInFlight(); return; }
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
						releaseInFlight();
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
					releaseInFlight();
				});
		},

		open(ws) {
			const userData = ws.getUserData();
			userData[WS_SUBSCRIPTIONS] = new Set();
			// Promote the upgrade-time requestId into a Symbol-keyed
			// per-connection platform clone (parity with the production
			// handler - uWS strips Symbol keys at upgrade so the string
			// slot is the upgrade->open carrier).
			const wsPlatform = Object.create(platform);
			wsPlatform.requestId = userData[WS_REQUEST_ID_KEY];
			userData[WS_PLATFORM] = wsPlatform;
			delete userData[WS_REQUEST_ID_KEY];
			const sessionId = randomUUID();
			userData[WS_SESSION_ID] = sessionId;
			if (closeHookRegisteredT) {
				userData[WS_STATS] = {
					openedAt: Date.now(),
					messagesIn: 0,
					messagesOut: 0,
					bytesIn: 0,
					bytesOut: 0
				};
			}
			const welcome = '{"type":"welcome","sessionId":"' + sessionId + '"}';
			sendOutboundT(ws, welcome);
			wsConnections.add(ws);
			handler.open?.(ws, { platform: userData[WS_PLATFORM] });
			for (const resolve of connectionWaiters) resolve(undefined);
			connectionWaiters = [];
		},

		message(ws, message, isBinary) {
			bumpInT(ws, message);
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
							const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
							const isNew = subs ? !subs.has(msg.topic) : true;
							if (subs && isNew && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
								sendDeniedT(ws, msg.topic, ref, 'RATE_LIMITED');
								return;
							}
							const denial = runSubscribeHookT(ws, msg.topic);
							if (denial !== null) {
								sendDeniedT(ws, msg.topic, ref, denial);
								return;
							}
							ws.subscribe(msg.topic);
							subs?.add(msg.topic);
							sendSubscribedT(ws, msg.topic, ref);
							return;
						}
						if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
							ws.unsubscribe(msg.topic);
							ws.getUserData()[WS_SUBSCRIPTIONS]?.delete(msg.topic);
							handler.unsubscribe?.(ws, msg.topic, { platform: ws.getUserData()[WS_PLATFORM] });
							return;
						}
						if (msg.type === 'hello' && Array.isArray(msg.caps)) {
							const caps = new Set();
							for (let i = 0; i < msg.caps.length; i++) {
								if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
							}
							ws.getUserData()[WS_CAPS] = caps;
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
							const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
							for (const topic of valid) {
								const isNew = udSubs ? !udSubs.has(topic) : true;
								if (udSubs && isNew && udSubs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
									sendDeniedT(ws, topic, ref, 'RATE_LIMITED');
									continue;
								}
								const denial = batchDenials !== null
									? (batchDenials[topic] ?? null)
									: runSubscribeHookT(ws, topic);
								if (denial !== null) {
									sendDeniedT(ws, topic, ref, denial);
									continue;
								}
								ws.subscribe(topic);
								udSubs?.add(topic);
								sendSubscribedT(ws, topic, ref);
							}
							return;
						}
						if (msg.type === 'reply' && hasRefT(msg.ref)) {
							const pending = ws.getUserData()[WS_PENDING_REQUESTS];
							const entry = pending?.get(msg.ref);
							if (entry) {
								pending.delete(msg.ref);
								clearTimeout(entry.timer);
								if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
								else entry.resolve(msg.data);
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
										platform: ws.getUserData()[WS_PLATFORM]
									});
								} catch (err) {
									console.error('[adapter-uws/testing] resume hook threw:', err);
								}
							}
							sendOutboundT(ws, '{"type":"resumed"}');
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

			handler.message?.(ws, { data: message, isBinary, platform: ws.getUserData()[WS_PLATFORM] });
		},

		close(ws, code, message) {
			const ud = ws.getUserData() || {};
			const subs = ud[WS_SUBSCRIPTIONS] || new Set();
			const pending = ud[WS_PENDING_REQUESTS];
			if (pending && pending.size > 0) {
				for (const entry of pending.values()) {
					clearTimeout(entry.timer);
					try { entry.reject(new Error('connection closed')); } catch {}
				}
				pending.clear();
			}
			const stats = ud[WS_STATS];
			const closePlatform = ud[WS_PLATFORM];
			const ctx = stats
				? {
					code,
					message,
					platform: closePlatform,
					subscriptions: subs,
					id: ud[WS_SESSION_ID],
					duration: Date.now() - stats.openedAt,
					messagesIn: stats.messagesIn,
					messagesOut: stats.messagesOut,
					bytesIn: stats.bytesIn,
					bytesOut: stats.bytesOut
				}
				: { code, message, platform: closePlatform, subscriptions: subs };
			handler.close?.(ws, ctx);
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
				wsConnections,
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
