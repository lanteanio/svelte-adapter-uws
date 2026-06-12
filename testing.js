import { now, monotonicNow, setTimer, clearTimer, randomUuid } from './files/runtime.js';
import { parseCookies } from './files/cookies.js';
import { nextTopicSeq, processEpoch, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, resolveRequestId, createChaosState, createUpgradeAdmission, negotiateRejection, isCursorLaneUpgrade, resolveWaitingRoom, createPollCounter, containMetricInstrument, applyCapacityReason, createPosture, readAssertionCounts, assert, WS_SUBSCRIPTIONS, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_LEASE, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './files/utils.js';
import { buildBinaryFrame, allocWireId, wireIdAnnounce, createCapCounts, createLeaseState, leaseGrantFrame, DEFAULT_GRANT } from './files/wire.js';

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
	const { port = 0, wsPath = '/ws', handler = {}, upgradeAdmission, protection, metrics } = options;
	// Mirror production: block client-initiated subscribes to `__`-prefixed
	// system topics by default. Tests that intentionally exercise system
	// channels can opt in with `allowSystemTopicSubscribe: true`.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T = options.allowSystemTopicSubscribe === true;
	// Mirror production: wire topics default to printable ASCII only.
	const ALLOW_NON_ASCII_TOPICS_T = options.allowNonAsciiTopics === true;

	// Same wiring shape as the production handler: a per-instance
	// admission state instantiated once, consulted at the top of the
	// upgrade hook (`tryAcquire` -> 503), and paced via `admit()` around
	// the actual `res.upgrade()` call. Off when both knobs are 0/unset.
	const admission = createUpgradeAdmission(upgradeAdmission);
	const ADMISSION_PER_TICK_BUDGET = upgradeAdmission?.perTickBudget || 0;

	// Content-negotiated rejection for over-capacity upgrades. Mirrors the
	// production handler exactly: resolved once (or null when off); null keeps
	// today's bare 503. On by default whenever the gate can reject.
	const WAITING_ROOM = resolveWaitingRoom(upgradeAdmission);

	// Admission counters, mirroring the production handler at the upgrade
	// branches this harness mirrors (same names, same reasons). The sampled
	// gauges and the per-IP/origin reasons are production-only: the harness
	// runs no pressure sampler, no per-IP limiter, and no origin check.
	const mUpgradeAdmittedT = containMetricInstrument(metrics?.counter('upgrade_admitted_total', 'WebSocket upgrades accepted'));
	const mUpgradeRejectedT = containMetricInstrument(metrics?.counter('upgrade_rejected_total', 'WebSocket upgrades rejected before open', ['reason']));

	// Graduated protection posture, mirroring the production handler. Absent or
	// `'normal'` leaves the posture inert so the reject path, pressure reason,
	// and poll response stay byte-identical to a server that never sets it.
	// `'auto'` resolves from pressure; `'elevated'`/`'siege'` pin the level.
	const PROTECTION_T = protection || 'normal';
	const activePostureT = (PROTECTION_T === 'normal' || PROTECTION_T === 'auto')
		? (PROTECTION_T === 'auto'
			? createPosture({
				admission,
				getThresholds: () => ({ memoryHeapUsedRatio: 0.85, sampleIntervalMs: 1000 })
			})
			: null)
		: createPosture({
			admission,
			getThresholds: () => ({ memoryHeapUsedRatio: 0.85, sampleIntervalMs: 1000 }),
			pin: PROTECTION_T
		});
	// Test-only override: `platform.__setProtection(level)` moves the live level
	// on a running server (the mutation path; `get protection()` stays
	// read-only). Takes precedence over the posture's own level so a test can
	// drive a transition under an already-open connection. `null` clears it.
	/** @type {'normal' | 'elevated' | 'siege' | null} */
	let forcedLevelT = null;
	const postureLevelT = () => {
		if (forcedLevelT !== null) return forcedLevelT;
		return activePostureT !== null ? activePostureT.level : 'normal';
	};

	/** @param {unknown} ref @returns {ref is number | string} */
	function hasRefT(ref) { return typeof ref === 'number' || typeof ref === 'string'; }
	/** @param {any} ws @param {string} topic @returns {Promise<string | null>} */
	async function runSubscribeHookT(ws, topic) {
		if (!handler.subscribe) return null;
		try {
			const result = await handler.subscribe(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
			if (result === false) return 'FORBIDDEN';
			if (typeof result === 'string') return result;
			return null;
		} catch (err) {
			console.error('[ws] subscribe hook threw:', err);
			return 'INTERNAL_ERROR';
		}
	}
	/** @param {any} ws @param {string[]} topics @returns {Promise<Record<string, string> | null>} */
	async function runSubscribeBatchHookT(ws, topics) {
		if (!handler.subscribeBatch) return null;
		let result;
		try {
			result = await handler.subscribeBatch(ws, topics, { platform: ws.getUserData()[WS_PLATFORM] });
		} catch (err) {
			console.error('[ws] subscribeBatch hook threw:', err);
			/** @type {Record<string, string>} */
			const failed = {};
			for (let i = 0; i < topics.length; i++) failed[topics[i]] = 'INTERNAL_ERROR';
			return failed;
		}
		/** @type {Record<string, string>} */
		const denials = {};
		if (!result || typeof result !== 'object') return denials;
		for (const [topic, val] of Object.entries(result)) {
			if (val === false) denials[topic] = 'FORBIDDEN';
			else if (typeof val === 'string') denials[topic] = val;
		}
		return denials;
	}
	/** @param {any} ws @param {string} topic @returns {Promise<string | null>} */
	async function runUserSubscribeGateT(ws, topic) {
		const batchDenials = await runSubscribeBatchHookT(ws, [topic]);
		if (batchDenials !== null) {
			return batchDenials[topic] ?? null;
		}
		return await runSubscribeHookT(ws, topic);
	}
	/** @param {any} ws @param {string} topic @param {number | string | null} ref */
	function sendSubscribedT(ws, topic, ref) {
		if (ref === null) return;
		// Mirror the production handler: carry the topic's current generation
		// on the ack, read from the per-connection platform's topicEpoch so a
		// test that overrides it (modeling a per-topic store authority) is
		// exercised. Single worker returns the one process-generation value.
		// A throw in the topicEpoch delegate falls back to PROCESS_EPOCH and
		// still sends the ack; it is not a closed-socket abort.
		let epoch = processEpoch();
		try {
			const p = ws.getUserData()[WS_PLATFORM];
			if (p && typeof p.topicEpoch === 'function') epoch = p.topicEpoch(topic);
		} catch { epoch = processEpoch(); }
		const payload = JSON.stringify({ type: 'subscribed', topic, ref, epoch });
		sendOutboundT(ws, payload);
	}
	/** @param {any} ws @param {string} topic @param {number | string | null} ref @param {string} reason */
	function sendDeniedT(ws, topic, ref, reason) {
		if (ref === null) return;
		const payload = JSON.stringify({ type: 'subscribe-denied', topic, ref, reason });
		sendOutboundT(ws, payload);
	}

	// The simulator injects an in-memory app + a uWS helper bundle via the
	// internal __app / __uws options so the same dispatch runs over the virtual
	// clock. The default path constructs a real uWebSockets.js server exactly as
	// before, so existing createTestServer callers are unaffected.
	let uWS = options.__uws;
	if (!uWS) {
		try {
			uWS = (await import('uWebSockets.js')).default;
		} catch {
			throw new Error(
				'createTestServer requires uWebSockets.js to be installed.\n' +
				'  npm install uNetworking/uWebSockets.js#v20.60.0'
			);
		}
	}

	const app = options.__app || uWS.App();

	// Sim-only relay observer. The multi-worker simulator injects this to capture
	// each originating publish (its already-built envelope + stamped seq) for the
	// cross-worker relay model, exactly where production's handler.js hands the
	// envelope to batchRelay. Null on every normal createTestServer path, so the
	// default dispatch pays nothing.
	const onPublishT = typeof options.__onPublish === 'function' ? options.__onPublish : null;

	/** @type {Set<import('uWebSockets.js').WebSocket<any>>} */
	const wsConnections = new Set();

	/** @type {Map<string, number>} */
	const topicSeqs = new Map();

	/** @type {Array<(value: any) => void>} */
	let connectionWaiters = [];

	/** @type {Array<{ resolve: (value: any) => void, timer: ReturnType<typeof setTimeout> }>} */
	let messageWaiters = [];

	const closeHookRegisteredT = !!handler.close;
	let sendToAsyncWarnedT = false;
	// Mirrors prod's `closedWsAborts`. createTestServer uses real uWS,
	// so a closed-WS race (subscribe gate awaits something, client
	// closes during the await, post-await ws.subscribe throws) is
	// exercisable here exactly like in production. Hardening below
	// catches the uWS exception, bumps this counter, and returns the
	// platform's success-shaped no-op sentinel.
	let closedWsAbortsT = 0;
	function bumpInT(ws, message) {
		if (!closeHookRegisteredT) return;
		let stats;
		try { stats = ws.getUserData()[WS_STATS]; } catch { return; }
		if (!stats) return;
		stats.messagesIn++;
		stats.bytesIn += typeof message === 'string' ? message.length : message.byteLength;
	}
	function bumpOutT(ws, payload) {
		if (!closeHookRegisteredT) return;
		let stats;
		try { stats = ws.getUserData()[WS_STATS]; } catch { return; }
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
			setTimer(() => {
				try { ws.send(payload, false, false); }
				catch { closedWsAbortsT++; return; }
				bumpOutT(ws, payload);
			}, delay);
			return 1;
		}
		let result;
		try { result = ws.send(payload, false, false); }
		catch { closedWsAbortsT++; return 2; }
		bumpOutT(ws, payload);
		return result;
	}

	/**
	 * Binary-frame variant of sendOutboundT (isBinary=true). Routes through the
	 * same chaos chokepoint so drop/slow-drain scenarios apply to `0x03` frames.
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {Uint8Array} frame
	 */
	function sendOutboundBinaryT(ws, frame) {
		if (chaos.shouldDropOutbound()) return 0;
		const delay = chaos.getDelayMs();
		if (delay > 0) {
			setTimer(() => {
				try { ws.send(frame, true, false); }
				catch { closedWsAbortsT++; return; }
				bumpOutT(ws, frame);
			}, delay);
			return 1;
		}
		let result;
		try { result = ws.send(frame, true, false); }
		catch { closedWsAbortsT++; return 2; }
		bumpOutT(ws, frame);
		return result;
	}

	// Binary wire (0x03) capability accounting + topic-id assignment, mirroring
	// production handler.js so the cap-gated binary publish path is exercised
	// by createTestServer-based suites. Shared primitives live in ./files/wire.js.
	const capCountsT = createCapCounts();

	/**
	 * Per-connection topic-id resolution + lazy `wire-id` announce. Binary
	 * frames and the announce flow through sendOutboundT so chaos scenarios
	 * apply to them too.
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {any} ud
	 * @param {string} topic
	 * @returns {number}
	 */
	function ensureWireIdT(ws, ud, topic) {
		const { id, isNew } = allocWireId(ud, WS_TOPIC_IDS, topic);
		if (isNew) sendOutboundT(ws, wireIdAnnounce(topic, id));
		return id;
	}

	/**
	 * Per-connection wire-codec state resolution, mirroring handler.js so the
	 * stateful binary path (e.g. the cursor short-id dictionary) is exercised by
	 * createTestServer-based suites. Returns null for a stateless codec or on
	 * attach failure.
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {any} ud
	 * @param {{ capability: string, state?: { onAttach: (ws: any) => any, onDetach?: (ws: any, state: any) => void } }} wire
	 * @returns {any}
	 */
	function ensureWireStateT(ws, ud, wire) {
		if (!wire.state) return null;
		let m = ud[WS_WIRE_STATE];
		if (!m) { m = new Map(); ud[WS_WIRE_STATE] = m; }
		let entry = m.get(wire.capability);
		if (entry === undefined) {
			let state = null;
			try { state = wire.state.onAttach(ws); } catch { state = null; }
			entry = { state, detach: wire.state.onDetach };
			m.set(wire.capability, entry);
		}
		return entry.state;
	}

	/** @param {import('uWebSockets.js').WebSocket<any>} ws @param {any} ud */
	function detachWireStatesT(ws, ud) {
		const m = ud[WS_WIRE_STATE];
		if (!m) return;
		for (const entry of m.values()) {
			if (entry && typeof entry.detach === 'function') {
				try { entry.detach(ws, entry.state); } catch {}
			}
		}
		m.clear();
	}

	const platform = {
		publish(topic, event, data, options) {
			const seq = (options && options.seq === false)
				? null
				: nextTopicSeq(topicSeqs, topic);
			const msg = envelope(topic, event, data, seq);
			// Relay the already-built envelope to other workers (sim), mirroring
			// handler.js's `relayed = parentPort && options.relay !== false` gate.
			if (onPublishT && !(options && options.relay === false)) {
				onPublishT({ kind: 'publish', topic, envelope: msg, seq, compress: !!(options && options.compress) });
			}
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
		send(ws, topic, event, data, options) {
			// `options` (e.g. `{ compress }`) is accepted for Platform-shape parity
			// with production; the test server configures no compressor, so it is
			// a no-op here.
			void options;
			const payload = envelope(topic, event, data);
			return sendOutboundT(ws, payload);
		},
		publishWire(topic, event, data, wire, options) {
			const seq = (options && options.seq === false)
				? null
				: nextTopicSeq(topicSeqs, topic);
			const env = envelope(topic, event, data, seq);
			// Cross-worker subscribers receive the JSON envelope only (binary frames
			// are same-worker), so the relay carries `env`, never a 0x03 frame -
			// mirroring handler.js publishWire's relay path.
			if (onPublishT && !(options && options.relay === false)) {
				onPublishT({ kind: 'publish', topic, envelope: env, seq, compress: false });
			}
			// JSON fast path: no capable client.
			if (!capCountsT.has(wire.capability)) {
				if (chaos.scenario === null) return app.publish(topic, env, false, false);
				let delivered = false;
				for (const ws of wsConnections) {
					if (!ws.isSubscribed(topic)) continue;
					sendOutboundT(ws, env);
					delivered = true;
				}
				return delivered;
			}
			const seqOnWire = seq == null ? 0 : seq;
			// Stateful codec: per-connection encode (null-state connections share
			// one encode-once frame, memoized by topic-id). Mirrors handler.js.
			if (wire.state) {
				let sharedPayload;
				let sharedEncoded = false;
				/** @type {Map<number, Uint8Array>} */
				const sharedFrameById = new Map();
				let delivered = false;
				for (const ws of wsConnections) {
					let ud;
					try { ud = ws.getUserData(); } catch { continue; }
					const subs = ud[WS_SUBSCRIPTIONS];
					if (!subs || !subs.has(topic)) continue;
					const caps = ud[WS_CAPS];
					if (!caps || !caps.has(wire.capability)) { sendOutboundT(ws, env); delivered = true; continue; }
					const state = ensureWireStateT(ws, ud, wire);
					if (state == null) {
						if (!sharedEncoded) { sharedPayload = wire.encode(event, data, null); sharedEncoded = true; }
						if (sharedPayload == null) { sendOutboundT(ws, env); delivered = true; continue; }
						const id = ensureWireIdT(ws, ud, topic);
						let frame = sharedFrameById.get(id);
						if (!frame) { frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, sharedPayload); sharedFrameById.set(id, frame); }
						sendOutboundBinaryT(ws, frame);
					} else {
						const payload = wire.encode(event, data, state);
						if (payload == null) { sendOutboundT(ws, env); delivered = true; continue; }
						const sv = typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
						sendOutboundBinaryT(ws, buildBinaryFrame(sv, ensureWireIdT(ws, ud, topic), seqOnWire, payload));
					}
					delivered = true;
				}
				return delivered;
			}
			// Stateless codec: encode once, send many.
			const payload = wire.encode(event, data);
			if (payload == null) {
				if (chaos.scenario === null) return app.publish(topic, env, false, false);
				let delivered = false;
				for (const ws of wsConnections) {
					if (!ws.isSubscribed(topic)) continue;
					sendOutboundT(ws, env);
					delivered = true;
				}
				return delivered;
			}
			/** @type {Map<number, Uint8Array>} */
			const frameById = new Map();
			let delivered = false;
			for (const ws of wsConnections) {
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = ud[WS_CAPS];
				if (caps && caps.has(wire.capability)) {
					const id = ensureWireIdT(ws, ud, topic);
					let frame = frameById.get(id);
					if (!frame) {
						frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload);
						frameById.set(id, frame);
					}
					sendOutboundBinaryT(ws, frame);
				} else {
					sendOutboundT(ws, env);
				}
				delivered = true;
			}
			return delivered;
		},
		sendWire(ws, topic, event, data, wire, options) {
			void options; // Platform-shape parity; the test server configures no compressor.
			let ud;
			try { ud = ws.getUserData(); } catch { closedWsAbortsT++; return 2; }
			const caps = ud[WS_CAPS];
			let payload = null;
			let schemaVersion = wire.schemaVersion;
			if (caps && caps.has(wire.capability)) {
				if (wire.state) {
					const state = ensureWireStateT(ws, ud, wire);
					payload = wire.encode(event, data, state);
					if (state != null && typeof state.schemaVersion === 'number') schemaVersion = state.schemaVersion;
				} else {
					payload = wire.encode(event, data);
				}
			}
			if (payload == null) {
				return sendOutboundT(ws, envelope(topic, event, data));
			}
			const id = ensureWireIdT(ws, ud, topic);
			const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
			return sendOutboundBinaryT(ws, frame);
		},
		sendTo(filter, topic, event, data, options) {
			void options; // Platform-shape parity; the test server configures no compressor.
			const msg = envelope(topic, event, data);
			let count = 0;
			for (const ws of wsConnections) {
				let userData;
				try { userData = ws.getUserData(); }
				catch { closedWsAbortsT++; continue; }
				const decision = filter(userData);
				if (decision && typeof decision.then === 'function') {
					if (!sendToAsyncWarnedT) {
						sendToAsyncWarnedT = true;
						console.error(
							'[adapter-uws/testing] platform.sendTo filter returned a Promise; treating as fail-closed.\n' +
							'  Resolve filter inputs into userData from your `upgrade` hook so the\n' +
							'  filter can read them synchronously.\n' +
							'  See: https://svti.me/sendto-async'
						);
					}
					continue;
				}
				if (decision) {
					sendOutboundT(ws, msg);
					count++;
				}
			}
			return count;
		},
		get connections() { return wsConnections.size; },
		get assertions() { return readAssertionCounts(); },
		get closedWsAborts() { return closedWsAbortsT; },
		subscribers(topic) { return app.numSubscribers(topic); },
		// Mirror production handler.js: walk the local subscriber set so
		// per-subscriber culling / backpressure paths are exercised by
		// createTestServer-based suites.
		forEachSubscriber(topic, fn) {
			for (const ws of wsConnections) {
				const ud = ws.getUserData();
				const subs = ud[WS_SUBSCRIPTIONS];
				if (subs && subs.has(topic)) fn(ws, ud);
			}
		},
		// Mirror production: report a numeric cap and a constant-time
		// bufferedAmount so test code can exercise the same backpressure-
		// aware branches it uses in production.
		get maxPayloadLength() { return 1024 * 1024; },
		bufferedAmount(ws) {
			try { return ws.getBufferedAmount(); } catch { return 0; }
		},
		async subscribe(ws, topic) {
			// Same contract as production platform.subscribe: runs the
			// user's hook chain before the actual ws.subscribe so
			// server-side test code that subscribes a connection on the
			// user's behalf inherits the centralized auth gate. Returns
			// null on success, denial reason string on failure. Awaits the
			// user hook so async hooks gate correctly.
			// Server-side caller: trust non-ASCII topics (matches platform.subscribe in production).
			if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
			let subs;
			try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
			catch { closedWsAbortsT++; return null; }
			if (!(subs instanceof Set)) return 'INVALID_TOPIC';
			if (subs.has(topic)) return null;
			if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
			const denial = await runUserSubscribeGateT(ws, topic);
			if (denial !== null) return denial;
			if (subs.has(topic)) return null;
			if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return 'RATE_LIMITED';
			try { ws.subscribe(topic); }
			catch { closedWsAbortsT++; return null; }
			subs.add(topic);
			return null;
		},
		async checkSubscribe(ws, topic) {
			// Server-side caller: see platform.subscribe note above.
			if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
			return await runUserSubscribeGateT(ws, topic);
		},
		unsubscribe(ws, topic) {
			let subs;
			try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
			catch { closedWsAbortsT++; return false; }
			if (!(subs instanceof Set) || !subs.has(topic)) return false;
			try { ws.unsubscribe(topic); }
			catch { closedWsAbortsT++; return false; }
			subs.delete(topic);
			handler.unsubscribe?.(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
			return true;
		},
		batch(messages) {
			return messages.map(({ topic, event, data }) => platform.publish(topic, event, data));
		},
		publishBatched(messages, options) {
			void options; // Platform-shape parity; the test server configures no compressor.
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
			// Fast-path batch relay (sim): forward the stamped events as one IPC frame,
			// mirroring handler.js's `publish-batched`. Per-message `relay: false` is
			// excluded from the relayed list (a frame from an external pub/sub source
			// already fans out to every process) while local fan-out keeps every event.
			// The slow-path fallback above relays per event through platform.publish.
			if (onPublishT) {
				const relayed = [];
				for (let i = 0; i < events.length; i++) {
					const o = messages[i].options;
					if (!o || o.relay !== false) relayed.push({ topic: events[i].topic, env: events[i].env });
				}
				if (relayed.length > 0) onPublishT({ kind: 'publishBatched', events: relayed, compress: false });
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
			let userData;
			try { userData = ws.getUserData(); }
			catch {
				closedWsAbortsT++;
				return Promise.reject(new Error('connection closed'));
			}
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
				const timer = setTimer(() => {
					if (pending.delete(ref)) reject(new Error('request timed out'));
				}, timeoutMs);
				pending.set(ref, { resolve, reject, timer });
				const payload = JSON.stringify({ type: 'request', ref, event, data: data ?? null });
				// Direct ws.send so we can distinguish "closed WS"
				// (throws -> reject now) from "backpressure DROPPED"
				// (returns 2 -> let it time out, matches production
				// semantics where uWS will not retry on its own).
				// sendOutboundT exists for chaos-injection; the request
				// flow takes the bare path and re-uses bumpOutT.
				try { ws.send(payload, false, false); }
				catch {
					closedWsAbortsT++;
					clearTimer(timer);
					pending.delete(ref);
					reject(new Error('connection closed'));
					return;
				}
				bumpOutT(ws, payload);
			});
		},
		topic(name) {
			return createScopedTopic(platform.publish, name);
		},
		/**
		 * Current generation of a topic's seq space, mirroring the production
		 * platform. Single worker: every topic shares the one process
		 * generation, so a resume hook comparing this to the client's
		 * presented epoch gap-fills on a match and cold-rehydrates on a
		 * mismatch (a value the live process never issued, e.g. after a
		 * restart).
		 * @param {string} topic
		 * @returns {number}
		 */
		topicEpoch(topic) {
			void topic;
			return processEpoch();
		},
		/**
		 * Activate or clear a chaos / fault-injection scenario. See
		 * `createChaosState` in `files/utils.js` for the supported shapes.
		 * Pass `null` to reset; the harness returns to its zero-overhead
		 * fast paths.
		 *
		 * Continuous scenarios (`drop-outbound`, `slow-drain`, `ipc-reorder`)
		 * are stored on the chaos state and consulted on every outbound
		 * frame. The `worker-flap` scenario is a one-shot trigger handled
		 * here directly: it closes every currently-live WS connection with
		 * the configured code/reason and returns; it does NOT change the
		 * continuous chaos state, so an active drop-outbound or
		 * ipc-reorder survives a flap.
		 */
		/**
		 * Live protection posture: `'normal'`, `'elevated'`, or `'siege'`.
		 * Mirrors the production platform getter; read-only.
		 */
		get protection() {
			return postureLevelT();
		},
		/**
		 * Minimal pressure snapshot mirroring production's shape. This
		 * harness has no live sampler, so the base reason is always `'NONE'`
		 * (an idle worker); the protection posture layers `'CAPACITY'` on
		 * top exactly as the production sampler does. Enough for tests that
		 * assert on `pressure.reason` under a pinned posture.
		 */
		get pressure() {
			const reason = applyCapacityReason('NONE', postureLevelT());
			return {
				active: reason !== 'NONE',
				value: 0,
				subscriberRatio: 0,
				publishRate: 0,
				memoryMB: 0,
				reason,
				topPublishers: []
			};
		},
		/**
		 * Test-only seam: move the live protection level on a running
		 * server (parallel to `__chaos`). `get protection()` stays
		 * read-only; this is the mutation path used to drive a transition
		 * under an already-open connection. Pass `null` to clear the
		 * override and fall back to the posture's own level.
		 *
		 * @param {'normal' | 'elevated' | 'siege' | null} level
		 */
		__setProtection(level) {
			forcedLevelT = (level === 'normal' || level === 'elevated' || level === 'siege')
				? level
				: null;
		},
		__chaos(cfg) {
			if (cfg && cfg.scenario === 'worker-flap') {
				const code = typeof cfg.code === 'number' ? cfg.code : 1012;
				const reason = typeof cfg.reason === 'string' ? cfg.reason : 'worker restart';
				// Snapshot first - end() removes the entry from
				// wsConnections via the close handler, which would mutate
				// the Set we are iterating. We use ws.end(code, reason)
				// rather than ws.close() so the client receives a clean
				// close frame with the configured code; ws.close() drops
				// the underlying socket and the client sees 1006 instead.
				const targets = Array.from(wsConnections);
				for (const ws of targets) {
					try { ws.end(code, reason); } catch {}
				}
				return;
			}
			chaos.set(cfg);
		},
		/**
		 * Sim-only: inject a relayed frame from another worker, mirroring the
		 * production handler's relayPublish / relayPublishBatched. The originating
		 * worker already stamped the per-topic seq into each envelope, so this
		 * re-publishes the pre-built envelope(s) via the app's fan-out with NO
		 * re-stamp and NO re-relay (it never re-enters platform.publish, so the
		 * cross-worker delivery cannot loop). The publishBatched path re-runs the
		 * allSeeAll / everyoneCapable detection against THIS server's own
		 * subscriber + capability set, so a worker with a different cap profile can
		 * take the slow path even when the originator took the fast path. The in-memory
		 * app models no compressor, so a carried `compress` intent is intentionally a
		 * no-op here (it is threaded through the relay only for IPC-frame-shape parity).
		 *
		 * @param {{ kind?: string, topic?: string, envelope?: string, compress?: boolean,
		 *   events?: Array<{ topic: string, env: string }> }} frame
		 */
		__relayReceive(frame) {
			if (!frame) return;
			if (frame.kind === 'publishBatched') {
				const events = frame.events;
				if (!Array.isArray(events) || events.length === 0) return;
				if (typeof events[0].topic !== 'string' || typeof events[0].env !== 'string') return;
				const firstTopic = events[0].topic;
				let allSameTopic = true;
				for (let i = 1; i < events.length; i++) {
					if (events[i].topic !== firstTopic) { allSameTopic = false; break; }
				}
				let allSeeAll = true;
				let everyoneCapable = true;
				let batchTopics = null;
				if (!allSameTopic) {
					batchTopics = new Set();
					for (let i = 0; i < events.length; i++) batchTopics.add(events[i].topic);
				}
				for (const ws of wsConnections) {
					let ud;
					try { ud = ws.getUserData(); } catch { continue; }
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
					for (let i = 0; i < events.length; i++) app.publish(events[i].topic, events[i].env, false, false);
					return;
				}
				const relaySlice = new Array(events.length);
				for (let i = 0; i < events.length; i++) relaySlice[i] = events[i].env;
				const sharedBatchEnv = wrapBatchEnvelope(relaySlice);
				const fanoutTopic = allSameTopic ? firstTopic : events[0].topic;
				app.publish(fanoutTopic, sharedBatchEnv, false, false);
				return;
			}
			if (typeof frame.topic === 'string' && typeof frame.envelope === 'string' && frame.envelope.length > 0) {
				app.publish(frame.topic, frame.envelope, false, false);
			}
		}
	};
	let nextRequestRefT = 1;

	app.ws(wsPath, {
		maxPayloadLength: 64 * 1024,
		idleTimeout: 120,
		sendPingsAutomatically: true,

		upgrade(res, req, context) {
			// Cursor-only upgrade lane (the worker's second WebSocket).
			// Mirrors the production handler: route through the reserved
			// cursor sub-budget only when a lane is configured.
			const cursorLaneEnabled = admission.cursorMaxConcurrent > 0;
			const isCursor = cursorLaneEnabled && isCursorLaneUpgrade(req.getHeader('sec-websocket-protocol'));

			// Serve an at-capacity upgrade refusal without consuming a gate slot.
			// Shared by the gate-full reject and the siege short-circuit so both
			// content-negotiate identically. Mirrors the production handler: a
			// browser navigation gets the holding page, everything else keeps the
			// 503 + a posture-widened jittered Retry-After (0.5 at normal is
			// today's exact band). A cursor-lane upgrade always gets the bare 503.
			const serveUpgradeRefusal = () => {
				if (WAITING_ROOM === null || isCursor) {
					// `waitingRoom: false` (or maxConcurrent unset): the exact
					// bare 503 - no Retry-After. Matches production byte-for-byte.
					res.cork(() => {
						res.writeStatus('503 Service Unavailable');
						res.writeHeader('content-type', 'text/plain');
						res.end('Server is at upgrade capacity, please retry');
					});
					return;
				}

				// One header read, no full walk on the reject path.
				const accept = req.getHeader('accept');
				if (negotiateRejection(accept) === 'html') {
					const body = WAITING_ROOM.renderPage();
					res.cork(() => {
						res.writeStatus('200 OK');
						res.writeHeader('content-type', 'text/html; charset=utf-8');
						res.writeHeader('cache-control', 'no-store');
						res.end(body);
					});
					return;
				}

				const lvl = postureLevelT();
				const spread = lvl === 'siege' ? 1.5 : lvl === 'elevated' ? 1.0 : 0.5;
				const retryAfter = WAITING_ROOM.jitteredRetryAfter(spread);
				res.cork(() => {
					res.writeStatus('503 Service Unavailable');
					res.writeHeader('content-type', 'text/plain');
					res.writeHeader('retry-after', String(retryAfter));
					res.end('Server is at upgrade capacity, please retry');
				});
			};

			// Siege refuses every NEW upgrade at static-serve cost even while the
			// gate has free slots - no slot is acquired, so an existing connection
			// is never touched. Counted as an over-capacity reject so an auto
			// posture stays escalated.
			if (postureLevelT() === 'siege') {
				if (activePostureT !== null) activePostureT.recordCapacityReject();
				mUpgradeRejectedT?.inc({ reason: 'siege' });
				serveUpgradeRefusal();
				return;
			}

			// Pre-upgrade soft filter: cap concurrent in-flight upgrades.
			// Crossed requests get a fast 503 before any per-request work,
			// matching handler.js's wiring exactly. A cursor-lane upgrade is
			// admitted through its reserved sub-budget so it cannot starve
			// main-WS admission; a saturated cursor lane still counts as an
			// over-capacity reject.
			const acquired = isCursor ? admission.tryAcquireCursor() : admission.tryAcquire();
			if (!acquired) {
				if (activePostureT !== null) activePostureT.recordCapacityReject();
				mUpgradeRejectedT?.inc({ reason: isCursor ? 'cursor_lane' : 'over_capacity' });
				serveUpgradeRefusal();
				return;
			}
			let inFlightReleased = false;
			function releaseInFlight() {
				if (inFlightReleased) return;
				inFlightReleased = true;
				if (isCursor) admission.releaseCursorInFlight();
				else admission.release();
			}

			const headers = {};
			req.forEach((k, v) => { headers[k] = v; });
			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();
			const rawIp = new TextDecoder().decode(res.getRemoteAddressAsText());

			const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();

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
					mUpgradeAdmittedT?.inc();
					releaseInFlight();
				});
				return;
			}

			let aborted = false;
			res.onAborted(() => { aborted = true; releaseInFlight(); });

			const cookies = parseCookies(headers['cookie']);
			// A synchronous throw must take the same path as an async rejection:
			// without the wrap it would escape the upgrade callback before the
			// catch below exists, serving no response and leaking the in-flight
			// slot (releaseInFlight would never run).
			let upgradeHookResult;
			try {
				upgradeHookResult = handler.upgrade({ headers, cookies, url, remoteAddress: rawIp, requestId: wsRequestId });
			} catch (err) {
				upgradeHookResult = Promise.reject(err);
			}
			Promise.resolve(upgradeHookResult)
				.then((result) => {
					if (aborted) { releaseInFlight(); return; }
					if (result === false) {
						mUpgradeRejectedT?.inc({ reason: 'auth_rejected' });
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
						mUpgradeAdmittedT?.inc();
						releaseInFlight();
					});
				})
				.catch((err) => {
					if (!aborted) {
						mUpgradeRejectedT?.inc({ reason: 'hook_error' });
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
			const sessionId = randomUuid();
			userData[WS_SESSION_ID] = sessionId;
			if (closeHookRegisteredT) {
				userData[WS_STATS] = {
					openedAt: monotonicNow(),
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

		async message(ws, message, isBinary) {
			bumpInT(ws, message);
			// Handle subscribe/unsubscribe from client store.
			//
			// `msg` is hoisted to outer scope so it can be forwarded to the
			// user handler in the fall-through delegation below. When the
			// prefix matched and JSON.parse produced an object that did NOT
			// match any known control type, the parsed value reaches plugin-
			// layer dispatchers (e.g. svelte-realtime's `onJsonMessage`)
			// directly, so they don't re-run TextDecoder + JSON.parse on
			// every frame. Mirrors handler.js + vite.js.
			/** @type {any} */
			let msg;
			if (!isBinary && message.byteLength < 8192) {
				const bytes = new Uint8Array(message);
				if (bytes[3] === 0x79) {
					try {
						msg = JSON.parse(Buffer.from(message).toString());
						// Reject null / primitives / arrays so `msg` only reaches
						// the user handler as a {type,...} object envelope. Throw
						// to the catch (which clears `msg`) for a unified fall-
						// through path with parse failures.
						if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) throw 0;
						if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
							const ref = hasRefT(msg.ref) ? msg.ref : null;
							if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS_T)) {
								sendDeniedT(ws, msg.topic, ref, 'INVALID_TOPIC');
								return;
							}
							if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T && msg.topic.charCodeAt(0) === 95 && msg.topic.charCodeAt(1) === 95) {
								sendDeniedT(ws, msg.topic, ref, 'INVALID_TOPIC');
								return;
							}
							const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
							// Mirror production: a missing or wrong-shape subs Set is
							// a framework invariant violation. Asserting here makes
							// the test harness fail the same way the production
							// handler does instead of silently bypassing the cap.
							assert(subs instanceof Set, 'subs.shape', null);
							const isNew = !subs.has(msg.topic);
							if (isNew && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
								sendDeniedT(ws, msg.topic, ref, 'RATE_LIMITED');
								return;
							}
							const denial = await runUserSubscribeGateT(ws, msg.topic);
							if (denial !== null) {
								sendDeniedT(ws, msg.topic, ref, denial);
								return;
							}
							if (subs.has(msg.topic)) {
								sendSubscribedT(ws, msg.topic, ref);
								return;
							}
							if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
								sendDeniedT(ws, msg.topic, ref, 'RATE_LIMITED');
								return;
							}
							try { ws.subscribe(msg.topic); }
							catch { closedWsAbortsT++; return; }
							subs.add(msg.topic);
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
							const helloUd = ws.getUserData();
							capCountsT.adjust(helloUd[WS_CAPS], caps);
							helloUd[WS_CAPS] = caps;
							// Opt-in arm for internal flow control, mirroring the
							// production handler. Only the first hello allocates
							// the slot and emits the first window; absence of the
							// cap keeps the immediate send path byte-identical.
							// Grant-and-observe like production: hand out a window
							// and read the saturation scalar, never consume a permit
							// here (the client paces itself). The harness pins the
							// static default window so the wire transcript is stable;
							// production sizes it from live worker posture.
							if (caps.has('lease') && !helloUd[WS_LEASE]) {
								const window = createLeaseState({ requestCount: DEFAULT_GRANT.requestCount, ttlMs: DEFAULT_GRANT.ttlMs });
								window.grant();
								helloUd[WS_LEASE] = { gate: window, saturation: window.pressureValue() };
								sendOutboundT(ws, '{"type":"lease-ok"}');
								sendOutboundT(ws, leaseGrantFrame(DEFAULT_GRANT.requestCount, DEFAULT_GRANT.ttlMs));
							}
							return;
						}
						if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
							const ref = hasRefT(msg.ref) ? msg.ref : null;
							const valid = [];
							for (const topic of msg.topics.slice(0, 256)) {
								if (!isValidWireTopic(topic, ALLOW_NON_ASCII_TOPICS_T)) {
									sendDeniedT(ws, topic, ref, 'INVALID_TOPIC');
									continue;
								}
								if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T && typeof topic === 'string' &&
									topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
									sendDeniedT(ws, topic, ref, 'INVALID_TOPIC');
									continue;
								}
								valid.push(topic);
							}
							const batchDenials = await runSubscribeBatchHookT(ws, valid);
							const perTopicDenials = batchDenials === null && handler.subscribe
								? await Promise.all(valid.map((t) => runSubscribeHookT(ws, t)))
								: null;
							const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
							assert(udSubs instanceof Set, 'subs.shape-batch', null);
							for (let i = 0; i < valid.length; i++) {
								const topic = valid[i];
								const denial = batchDenials !== null
									? (batchDenials[topic] ?? null)
									: (perTopicDenials !== null ? perTopicDenials[i] : null);
								if (denial !== null) {
									sendDeniedT(ws, topic, ref, denial);
									continue;
								}
								if (udSubs.has(topic)) {
									sendSubscribedT(ws, topic, ref);
									continue;
								}
								if (udSubs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
									sendDeniedT(ws, topic, ref, 'RATE_LIMITED');
									continue;
								}
								try { ws.subscribe(topic); }
								catch { closedWsAbortsT++; continue; }
								udSubs.add(topic);
								sendSubscribedT(ws, topic, ref);
							}
							return;
						}
						if (msg.type === 'reply' && hasRefT(msg.ref)) {
							const pending = ws.getUserData()[WS_PENDING_REQUESTS];
							const entry = pending?.get(msg.ref);
							if (entry) {
								pending.delete(msg.ref);
								clearTimer(entry.timer);
								if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
								else entry.resolve(msg.data);
							}
							return;
						}
						if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
							msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
							// Mirror production: forward the per-topic epochs the
							// client presented (raw, parallel to lastSeenSeqs) so
							// the hook can compare each to platform.topicEpoch and
							// choose gap-fill or cold-rehydrate. Absent for an old
							// client; the hook then treats every topic as a match.
							const lastSeenEpochs = (msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object')
								? msg.lastSeenEpochs
								: undefined;
							if (handler.resume) {
								try {
									// Mirror production: await the user hook so
									// per-topic replay completes before the
									// `resumed` ack tells the client to switch
									// to live mode.
									await handler.resume(ws, {
										sessionId: msg.sessionId,
										lastSeenSeqs: msg.lastSeenSeqs,
										lastSeenEpochs,
										platform: ws.getUserData()[WS_PLATFORM]
									});
								} catch (err) {
									console.error('[adapter-uws/testing] resume hook threw:', err);
								}
							}
							sendOutboundT(ws, '{"type":"resumed"}');
							return;
						}
						if (msg.type === 'request-n') {
							const slot = ws.getUserData()[WS_LEASE];
							if (slot) {
								slot.gate.requestN(DEFAULT_GRANT.requestCount, DEFAULT_GRANT.ttlMs);
								sendOutboundT(ws, leaseGrantFrame(DEFAULT_GRANT.requestCount, DEFAULT_GRANT.ttlMs));
								slot.saturation = slot.gate.pressureValue();
							}
							return;
						}
					} catch {
						// Not JSON, not an object envelope, or a known control
						// type that threw inside its handler. Clear `msg` so the
						// fall-through delegation sees `msg: undefined` (raw
						// bytes only).
						msg = undefined;
					}
				}
			}

			for (const waiter of messageWaiters) {
				clearTimer(waiter.timer);
				waiter.resolve({ data: Buffer.from(message).toString(), isBinary });
			}
			messageWaiters = [];

			// `msg` is the JSON-parsed envelope when the prefix matched + parsed
			// to an object + no control type matched; otherwise undefined.
			handler.message?.(ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] });
		},

		close(ws, code, message) {
			const ud = ws.getUserData() || {};
			const subs = ud[WS_SUBSCRIPTIONS] || new Set();
			const pending = ud[WS_PENDING_REQUESTS];
			if (pending && pending.size > 0) {
				for (const entry of pending.values()) {
					clearTimer(entry.timer);
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
					duration: monotonicNow() - stats.openedAt,
					messagesIn: stats.messagesIn,
					messagesOut: stats.messagesOut,
					bytesIn: stats.bytesIn,
					bytesOut: stats.bytesOut
				}
				: { code, message, platform: closePlatform, subscriptions: subs };
			// Mirror production handler.js: run the close hook inside try/finally
			// so the per-connection cleanup (cap counts, wire-codec state, the
			// connection set) always runs even if the user's close hook throws -
			// otherwise a leaked cap count would wedge a codec's JSON fast path on
			// and a stateful codec's per-connection state would never be freed.
			try {
				handler.close?.(ws, ctx);
			} finally {
				capCountsT.adjust(ud[WS_CAPS], null);
				detachWireStatesT(ws, ud);
				if (ud[WS_LEASE]) ud[WS_LEASE] = undefined;
				wsConnections.delete(ws);
			}
		}
	});

	// Waiting-room poll + holding page. Mirrors the production handler routes:
	// read-only, registered whenever the waiting room is enabled, and the poll
	// probes capacity via `admission.hasCapacity()` without consuming a slot.
	if (WAITING_ROOM !== null) {
		// The same pure window math the production handler uses, so stale
		// windows decay identically in both.
		const pollCounter = createPollCounter(WAITING_ROOM.pollIntervalMs);
		const currentQueueDepth = () => pollCounter.depth(now());

		app.get(WAITING_ROOM.admitCheckPath, (res) => {
			res.onAborted(() => {});
			pollCounter.record(now());
			// Siege always reports busy, even with free slots; normal/elevated
			// keep `hasCapacity()` as the source of truth. Mirrors production.
			if (postureLevelT() !== 'siege' && admission.hasCapacity()) {
				res.cork(() => {
					res.writeStatus('200 OK');
					res.writeHeader('content-type', 'application/json');
					res.writeHeader('cache-control', 'no-store');
					res.end('{"admit":true}');
				});
				return;
			}
			const queueDepth = currentQueueDepth();
			const estimatedSeconds = WAITING_ROOM.estimateSeconds(queueDepth);
			const pollAfterMs = postureLevelT() === 'siege'
				? WAITING_ROOM.pollIntervalMs * 2
				: WAITING_ROOM.pollIntervalMs;
			res.cork(() => {
				res.writeStatus('202 Accepted');
				res.writeHeader('content-type', 'application/json');
				res.writeHeader('cache-control', 'no-store');
				res.end(
					'{"admit":false,"queueDepth":' + queueDepth +
					',"estimatedSeconds":' + estimatedSeconds +
					',"pollAfterMs":' + pollAfterMs + '}'
				);
			});
		});

		app.get(WAITING_ROOM.path, (res) => {
			res.onAborted(() => {});
			const body = WAITING_ROOM.renderPage(currentQueueDepth());
			res.cork(() => {
				res.writeStatus('200 OK');
				res.writeHeader('content-type', 'text/html; charset=utf-8');
				res.writeHeader('cache-control', 'no-store');
				res.end(body);
			});
		});
	}

	return new Promise((resolve, reject) => {
		app.listen(port, async (listenSocket) => {
			if (!listenSocket) return reject(new Error('Failed to listen'));
			const boundPort = uWS.us_socket_local_port(listenSocket);

			// Fire the user's `init` hook once the test server is listening,
			// before resolving createTestServer(). Mirrors production
			// handler.js semantics: throwing init rejects the createTestServer
			// promise so test setup failure is loud.
			if (typeof handler.init === 'function') {
				try {
					await handler.init({ platform });
				} catch (err) {
					try { uWS.us_listen_socket_close(listenSocket); } catch {}
					return reject(err);
				}
			}

			resolve({
				url: `http://localhost:${boundPort}`,
				wsUrl: `ws://localhost:${boundPort}${wsPath}`,
				port: boundPort,
				platform,
				wsConnections,
				async close() {
					// Fire `shutdown` hook before kicking connections so the
					// hook sees a healthy platform. Throws are logged-and-
					// ignored (best-effort, mirrors production).
					if (typeof handler.shutdown === 'function') {
						try {
							await handler.shutdown({ platform });
						} catch (err) {
							console.error('[ws] shutdown hook threw:', err);
						}
					}
					for (const ws of wsConnections) ws.close(1001, 'Test server closing');
					wsConnections.clear();
					uWS.us_listen_socket_close(listenSocket);
				},
				waitForConnection(timeout = 5000) {
					return new Promise((resolve, reject) => {
						const timer = setTimer(
							() => reject(new Error('waitForConnection timed out')),
							timeout
						);
						connectionWaiters.push(() => { clearTimer(timer); resolve(undefined); });
					});
				},
				waitForMessage(timeout = 5000) {
					return new Promise((resolve, reject) => {
						const timer = setTimer(
							() => {
								messageWaiters = messageWaiters.filter(w => w.timer !== timer);
								reject(new Error('waitForMessage timed out'));
							},
							timeout
						);
						messageWaiters.push({ resolve(v) { clearTimer(timer); resolve(v); }, timer });
					});
				}
			});
		});
	});
}
