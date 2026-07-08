import { now, monotonicNow, setTimer, clearTimer, randomUuid } from './runtime/runtime.js';
import { parseCookies } from './runtime/cookies.js';
import { stampSeq, processEpoch, completeEnvelope, completeGameEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, createTopicHelperCache, resolveRequestId, createChaosState, createUpgradeAdmission, negotiateRejection, isCursorLaneUpgrade, resolveWaitingRoom, createPollCounter, containMetricInstrument, applyCapacityReason, createPosture, readAssertionCounts, assert, WS_SUBSCRIPTIONS, WS_PUBLISH_GRANT, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_LEASE, WS_SHARED_COHORTS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './runtime/utils.js';
import { buildBinaryFrame, allocWireId, wireIdAnnounce, createCapCounts, createLeaseState, leaseGrantFrame, controlFrameTooLargeFrame, DEFAULT_GRANT } from './runtime/wire.js';
import { createSharedWireIdTable } from './runtime/handler/shared-wire-id.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './runtime/handler/ingress.js';
import { registerGameIngress } from './runtime/handler/game-ingress.js';

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
	const { port = 0, wsPath = '/ws', handler = {}, upgradeAdmission, protection, metrics, adminPath = '/__realtime', readinessCheckPath = '/readyz', healthCheckPath = '/healthz', primaryInit } = options;

	// Readiness flag, mirroring the production `counters.draining`. Flipped true
	// at the start of the returned `close()` (graceful shutdown) so the readiness
	// route reports 503; a test can also flip it directly via
	// `platform.__setDraining(true)` to assert the route without tearing down.
	let drainingT = false;
	// Mirror production: block client-initiated subscribes to `__`-prefixed
	// system topics by default. Tests that intentionally exercise system
	// channels can opt in with `allowSystemTopicSubscribe: true`.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T = options.allowSystemTopicSubscribe === true;
	// Mirror production: wire topics default to printable ASCII only.
	const ALLOW_NON_ASCII_TOPICS_T = options.allowNonAsciiTopics === true;
	// Mirror production wire-subscribe authorization. `let` so the platform
	// method `authorizeWireSubscribe()` can arm it at runtime, exactly like the
	// framework does in production. Seeded from the config option for the
	// static-config path.
	let SUBSCRIBE_AUTHZ_T = options.authorizeWireSubscribe === true;
	const hasUserSubscribeHookT = () => !!(handler.subscribe || handler.subscribeBatch);

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

	// Register the client-relay (`game` lane) binary twin (ingress kind `game:1`),
	// matching production. Idempotent + per-server so it survives a test that
	// clears the global ingress registry (_resetIngressRegistry).
	registerGameIngress();

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
	// by createTestServer-based suites. Shared primitives live in ./src/runtime/wire.js.
	const capCountsT = createCapCounts();

	// Per-server wire-codec registry (capability -> codec), the in-process mirror of
	// production handler/codec-registry.js. The codec-aware relay re-encode
	// (relayPublishWire) re-derives a codec here from the capability a relay frame
	// carried. Local to this server so test servers stay isolated.
	const byCapabilityT = new Map();

	/**
	 * Per-connection topic-id resolution + lazy `wire-id` announce. Binary
	 * frames and the announce flow through sendOutboundT so chaos scenarios
	 * apply to them too. Mirrors handler.js: returns -1 when the announce was
	 * dropped by backpressure (send result 2) - the client never learns the
	 * mapping, so callers send the JSON envelope for the current frame and
	 * poison the capability. A result of 0 (enqueued, or a chaos drop) is NOT
	 * a drop here; only 2 signals failure.
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {any} ud
	 * @param {string} topic
	 * @returns {number} the topic id, or -1 when the announce was dropped
	 */
	function ensureWireIdT(ws, ud, topic) {
		const { id, isNew } = allocWireId(ud, WS_TOPIC_IDS, topic);
		if (isNew) {
			const result = sendOutboundT(ws, wireIdAnnounce(topic, id));
			if (result === 2) return -1;
		}
		return id;
	}

	/**
	 * Per-connection wire-codec state resolution, mirroring handler.js so the
	 * stateful binary path (e.g. the cursor short-id dictionary) is exercised by
	 * createTestServer-based suites. Returns null for a stateless codec, on
	 * attach failure, or for a poisoned capability (see poisonWireStateT).
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

	/**
	 * True when this connection's wire for a capability was degraded to JSON
	 * by poisonWireStateT. Mirrors handler.js.
	 * @param {any} ud
	 * @param {string} capability
	 * @returns {boolean}
	 */
	function wireStatePoisonedT(ud, capability) {
		const m = ud[WS_WIRE_STATE];
		if (!m) return false;
		const entry = m.get(capability);
		return entry !== undefined && entry.poisoned === true;
	}

	/**
	 * Permanently degrade this connection's wire for one capability to JSON
	 * (until reconnect), mirroring handler.js. A stateful codec mutates its
	 * per-connection encoder state DURING encode, so a frame dropped by
	 * backpressure (send result 2) leaves the client decoder desynced with no
	 * in-band resync - JSON is the recovery tier because the shared envelope
	 * carries full keys and absolute values. Disposes the codec's state via
	 * its onDetach exactly once (the sentinel carries no detach, so the
	 * close-time sweep skips it), then installs a poisoned entry so
	 * ensureWireStateT returns null and every publish/send path routes the
	 * capability to the JSON envelope.
	 * @param {import('uWebSockets.js').WebSocket<any>} ws
	 * @param {any} ud
	 * @param {string} capability
	 */
	function poisonWireStateT(ws, ud, capability) {
		let m = ud[WS_WIRE_STATE];
		if (!m) { m = new Map(); ud[WS_WIRE_STATE] = m; }
		const entry = m.get(capability);
		if (entry !== undefined && entry.poisoned === true) return;
		if (entry && typeof entry.detach === 'function') {
			try { entry.detach(ws, entry.state); } catch {}
		}
		m.set(capability, { state: null, detach: undefined, poisoned: true });
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

	// Per-server shared-fan-out topic registry (mirror of handler/state.js
	// sharedTopics): a topic enters on its first shared publish.
	const sharedTopicsT = new Map();
	// Per-server wire-id table (NOT the module singleton), so two test servers in one
	// process never co-mingle shared ids or refcounts. Production uses one table per
	// worker (one server per worker), which the module default models.
	const sharedWireIds = createSharedWireIdTable();

	// Cohort membership for shared binary fan-out (mirror of handler/cohort.js). The
	// in-memory app models `topic\0bin` / `topic\0json` as distinct exact-string
	// topics, and models no backpressure, so the announce always lands (no demote).
	function cohortTopicsT(topic) { return { bin: topic + '\0bin', json: topic + '\0json' }; }
	function joinCohortT(ws, ud, topic, capability) {
		const caps = ud[WS_CAPS];
		const { bin, json } = cohortTopicsT(topic);
		if (caps && caps.has(capability) && !wireStatePoisonedT(ud, capability)) {
			const id = sharedWireIds.acquire(topic);
			sendOutboundT(ws, wireIdAnnounce(topic, id));
			let cohorts = ud[WS_SHARED_COHORTS];
			if (!cohorts) { cohorts = new Set(); ud[WS_SHARED_COHORTS] = cohorts; }
			cohorts.add(topic);
			ws.subscribe(bin);
		} else {
			ws.subscribe(json);
		}
	}
	function leaveCohortT(ws, ud, topic) {
		const { bin, json } = cohortTopicsT(topic);
		ws.unsubscribe(bin); ws.unsubscribe(json);
		const cohorts = ud[WS_SHARED_COHORTS];
		if (cohorts && cohorts.delete(topic)) sharedWireIds.release(topic);
	}

	// Per-test-server LRU cache of scoped topic helpers (module-global would bind
	// helpers to the wrong publish across concurrent test servers).
	/** @type {((name: string) => ReturnType<typeof createScopedTopic>) | null} */
	let _topicHelperCache = null;
	const platform = {
		publish(topic, event, data, options) {
			const seq = stampSeq(options, topicSeqs, topic);
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
			// Relay re-encode (mirrors handler.js publishWire): a relayed wire publish
			// re-encodes binary against THIS server's local connections, stamping the
			// carried origin seq verbatim (no re-stamp) and never re-relaying
			// (relay:false suppresses the onPublishT relay below).
			const isRelay = !!(options && options._isRelay);
			const seq = isRelay
				? (typeof options._relaySeq === 'number' ? options._relaySeq : null)
				: stampSeq(options, topicSeqs, topic);
			const env = envelope(topic, event, data, seq);
			// The relay carries the JSON envelope plus, for a registered codec, its
			// capability + raw payload so the receiving server re-encodes binary
			// locally (codec-aware relay, mirroring handler.js). An unregistered codec
			// carries envelope-only. The relay fires once per publish regardless of
			// sender exclusion: the excluded socket only exists on this instance.
			const relayCap = (onPublishT && byCapabilityT.has(wire.capability)) ? wire.capability : undefined;
			if (onPublishT && !(options && options.relay === false)) {
				onPublishT({
					kind: 'publish', topic, envelope: env, seq, compress: false,
					capability: relayCap,
					event: relayCap !== undefined ? event : undefined,
					data: relayCap !== undefined ? data : undefined
				});
			}
			// Sender exclusion, mirroring handler.js: the single C++ app.publish
			// fan-out cannot skip a socket, so an excluding publish always takes
			// the per-subscriber walk.
			const excludeWs = (options && options.excludeWs) || null;
			// JSON fast path: no capable client.
			if (excludeWs === null && !capCountsT.has(wire.capability)) {
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
					if (ws === excludeWs) continue;
					let ud;
					try { ud = ws.getUserData(); } catch { continue; }
					const subs = ud[WS_SUBSCRIPTIONS];
					if (!subs || !subs.has(topic)) continue;
					const caps = ud[WS_CAPS];
					if (!caps || !caps.has(wire.capability)) { sendOutboundT(ws, env); delivered = true; continue; }
					const state = ensureWireStateT(ws, ud, wire);
					if (state == null) {
						// A poisoned capability is served exactly like a caps-less
						// connection: the shared JSON envelope, never binary.
						if (wireStatePoisonedT(ud, wire.capability)) { sendOutboundT(ws, env); delivered = true; continue; }
						if (!sharedEncoded) { sharedPayload = wire.encode(event, data, null); sharedEncoded = true; }
						if (sharedPayload == null) { sendOutboundT(ws, env); delivered = true; continue; }
						const id = ensureWireIdT(ws, ud, topic);
						if (id === -1) {
							// Dropped wire-id announce: JSON for this frame + poison.
							poisonWireStateT(ws, ud, wire.capability);
							sendOutboundT(ws, env);
							delivered = true;
							continue;
						}
						let frame = sharedFrameById.get(id);
						if (!frame) { frame = buildBinaryFrame(wire.schemaVersion, id, seqOnWire, sharedPayload); sharedFrameById.set(id, frame); }
						// A dropped shared frame needs no poisoning: the payload
						// carries no per-connection state.
						sendOutboundBinaryT(ws, frame);
					} else {
						const payload = wire.encode(event, data, state);
						if (payload == null) { sendOutboundT(ws, env); delivered = true; continue; }
						const sv = typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
						const id = ensureWireIdT(ws, ud, topic);
						if (id === -1) {
							// Dropped wire-id announce: JSON for this frame + poison.
							poisonWireStateT(ws, ud, wire.capability);
							sendOutboundT(ws, env);
							delivered = true;
							continue;
						}
						const result = sendOutboundBinaryT(ws, buildBinaryFrame(sv, id, seqOnWire, payload));
						// 2 = dropped past maxBackpressure (0 = enqueued or a chaos
						// drop, NOT a drop here). The encode above already mutated
						// this connection's dictionary for the dropped frame, so
						// degrade the capability to JSON until reconnect.
						if (result === 2) poisonWireStateT(ws, ud, wire.capability);
					}
					delivered = true;
				}
				return delivered;
			}
			// Stateless codec: encode once, send many.
			const payload = wire.encode(event, data);
			if (payload == null) {
				if (excludeWs === null) {
					if (chaos.scenario === null) return app.publish(topic, env, false, false);
					let delivered = false;
					for (const ws of wsConnections) {
						if (!ws.isSubscribed(topic)) continue;
						sendOutboundT(ws, env);
						delivered = true;
					}
					return delivered;
				}
				// Declined frame with sender exclusion: per-subscriber JSON walk,
				// skipping the excluded socket. Mirrors handler.js.
				let delivered = false;
				for (const ws of wsConnections) {
					if (ws === excludeWs) continue;
					let ud;
					try { ud = ws.getUserData(); } catch { continue; }
					const subs = ud[WS_SUBSCRIPTIONS];
					if (!subs || !subs.has(topic)) continue;
					sendOutboundT(ws, env);
					delivered = true;
				}
				return delivered;
			}
			// Shared binary fan-out (mirror of handler.js): the first shared publish
			// migrates current subscribers into cohorts, then the publish is two native
			// app.publish calls - the 0x03 frame to `topic\0bin`, the envelope to
			// `topic\0json`. excludeWs falls through to the per-subscriber walk below.
			if (wire.shared && excludeWs === null) {
				if (!sharedTopicsT.has(topic)) {
					for (const ws of wsConnections) {
						let ud;
						try { ud = ws.getUserData(); } catch { continue; }
						const subs = ud[WS_SUBSCRIPTIONS];
						if (!subs || !subs.has(topic)) continue;
						joinCohortT(ws, ud, topic, wire.capability);
					}
					sharedTopicsT.set(topic, wire.capability);
				}
				const { bin, json } = cohortTopicsT(topic);
				const id = sharedWireIds.get(topic);
				const frame = id !== undefined ? buildBinaryFrame(wire.schemaVersion, id, seqOnWire, payload) : null;
				if (chaos.scenario === null) {
					if (frame) app.publish(bin, frame, true, false);
					app.publish(json, env, false, false);
				} else {
					// Chaos cannot intercept the app's C++-style fan-out, so degrade to a
					// per-recipient walk through the chaos chokepoint, like every other path.
					for (const ws of wsConnections) {
						if (frame && ws.isSubscribed(bin)) sendOutboundBinaryT(ws, frame);
						else if (ws.isSubscribed(json)) sendOutboundT(ws, env);
					}
				}
				return true;
			}
			/** @type {Map<number, Uint8Array>} */
			const frameById = new Map();
			let delivered = false;
			for (const ws of wsConnections) {
				if (ws === excludeWs) continue;
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = ud[WS_CAPS];
				if (caps && caps.has(wire.capability) && !wireStatePoisonedT(ud, wire.capability)) {
					const id = ensureWireIdT(ws, ud, topic);
					if (id === -1) {
						// Dropped wire-id announce: the topic-id mapping is itself
						// per-connection state the client now permanently lacks.
						// JSON for this frame + poison. A dropped binary FRAME
						// below needs no such handling - the shared payload
						// carries no per-connection state.
						poisonWireStateT(ws, ud, wire.capability);
						sendOutboundT(ws, env);
						delivered = true;
						continue;
					}
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
		registerWireCodec(wire) {
			if (wire && typeof wire.capability === 'string') byCapabilityT.set(wire.capability, wire);
		},
		relayPublishWire(topic, event, data, capability, seq, compress) {
			// Mirror of handler/platform.js relayPublishWire: re-derive the codec from
			// the relay-carried capability and re-encode binary locally for this
			// server's binary-capable subscribers, or return false to let the caller
			// fall back to the JSON envelope.
			const codec = byCapabilityT.get(capability);
			if (!codec) return false;
			if (!capCountsT.has(capability)) return false;
			platform.publishWire(topic, event, data, codec, { relay: false, _isRelay: true, _relaySeq: seq, compress });
			return true;
		},
		sendWire(ws, topic, event, data, wire, options) {
			void options; // Platform-shape parity; the test server configures no compressor.
			let ud;
			try { ud = ws.getUserData(); } catch { closedWsAbortsT++; return 2; }
			const caps = ud[WS_CAPS];
			let payload = null;
			let schemaVersion = wire.schemaVersion;
			// A poisoned capability is served exactly like a caps-less
			// connection: the JSON envelope, never binary. Mirrors handler.js.
			if (caps && caps.has(wire.capability) && !wireStatePoisonedT(ud, wire.capability)) {
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
			if (id === -1) {
				// Dropped wire-id announce: JSON for this frame + poison.
				poisonWireStateT(ws, ud, wire.capability);
				return sendOutboundT(ws, envelope(topic, event, data));
			}
			const frame = buildBinaryFrame(schemaVersion, id, 0, payload);
			const result = sendOutboundBinaryT(ws, frame);
			// 2 = dropped past maxBackpressure. A stateful encode already mutated
			// this connection's dictionary for the dropped frame - degrade the
			// capability to JSON until reconnect. Stateless payloads carry no
			// per-connection state, so no poisoning.
			if (result === 2 && wire.state) poisonWireStateT(ws, ud, wire.capability);
			return result;
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
		adviseReconnect(options) {
			const windowMs = options && typeof options.windowMs === 'number' && options.windowMs > 0
				? Math.floor(options.windowMs) : 0;
			if (windowMs <= 0) return 0;
			const afterMs = options && typeof options.afterMs === 'number' && options.afterMs > 0
				? Math.floor(options.afterMs) : 0;
			const doClose = !options || options.close !== false;
			const filter = options && typeof options.filter === 'function' ? options.filter : null;
			const frame = afterMs > 0
				? '{"type":"reconnect","afterMs":' + afterMs + ',"windowMs":' + windowMs + '}'
				: '{"type":"reconnect","windowMs":' + windowMs + '}';
			let count = 0;
			for (const ws of [...wsConnections]) {
				let userData;
				try { userData = ws.getUserData(); }
				catch { closedWsAbortsT++; continue; }
				if (filter) {
					const decision = filter(userData);
					if (decision && typeof decision.then === 'function') continue;
					if (!decision) continue;
				}
				sendOutboundT(ws, frame);
				if (doClose && typeof ws.end === 'function') { try { ws.end(1001, 'Server draining'); } catch { closedWsAbortsT++; } }
				count++;
			}
			return count;
		},
		get connections() { return wsConnections.size; },
		get assertions() { return readAssertionCounts(); },
		get closedWsAborts() { return closedWsAbortsT; },
		// PII-free transport-layer snapshot, mirroring the production platform.
		// Scalar pressure signals only (topPublishers is omitted, topic names can
		// embed ids). svelte-realtime's introspect() composes this under a
		// `transport` key when present.
		introspect() {
			const p = platform.pressure;
			return {
				connections: platform.connections,
				closedWsAborts: platform.closedWsAborts,
				protection: platform.protection,
				maxPayloadLength: platform.maxPayloadLength,
				pressure: {
					active: p.active,
					reason: p.reason,
					value: p.value,
					subscriberRatio: p.subscriberRatio,
					publishRate: p.publishRate,
					memoryMB: p.memoryMB,
					maxBufferedBytes: p.maxBufferedBytes,
					backpressuredConnections: p.backpressuredConnections
				},
				assertions: Object.fromEntries(platform.assertions)
			};
		},
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
			if (sharedTopicsT.has(topic)) joinCohortT(ws, ws.getUserData(), topic, sharedTopicsT.get(topic));
			return null;
		},
		async checkSubscribe(ws, topic) {
			// Server-side caller: see platform.subscribe note above.
			if (!isValidWireTopic(topic, true)) return 'INVALID_TOPIC';
			return await runUserSubscribeGateT(ws, topic);
		},
		authorizeWireSubscribe() {
			// Mirror production: arm wire-subscribe authorization at runtime.
			SUBSCRIBE_AUTHZ_T = true;
		},
		unsubscribe(ws, topic) {
			let subs;
			try { subs = ws.getUserData()[WS_SUBSCRIPTIONS]; }
			catch { closedWsAbortsT++; return false; }
			if (!(subs instanceof Set) || !subs.has(topic)) return false;
			try { ws.unsubscribe(topic); }
			catch { closedWsAbortsT++; return false; }
			subs.delete(topic);
			if (sharedTopicsT.has(topic)) leaveCohortT(ws, ws.getUserData(), topic);
			handler.unsubscribe?.(ws, topic, { platform: ws.getUserData()[WS_PLATFORM] });
			return true;
		},
		// Client-publish authorization (the `game` lane), mirroring the
		// production platform. grantPublish binds a connection to exactly one
		// topic it may publish to via a topicless `game` frame; the wire handler
		// derives the topic from this binding, so a client can never publish to a
		// room it was not granted. See src/runtime/handler/platform.js for the
		// production contract.
		grantPublish(ws, topic) {
			let ud;
			try { ud = ws.getUserData(); } catch { closedWsAbortsT++; return false; }
			ud[WS_PUBLISH_GRANT] = topic;
			return true;
		},
		revokePublish(ws) {
			let ud;
			try { ud = ws.getUserData(); } catch { return false; }
			if (ud[WS_PUBLISH_GRANT] === undefined) return false;
			ud[WS_PUBLISH_GRANT] = undefined;
			return true;
		},
		publishGrant(ws) {
			let ud;
			try { ud = ws.getUserData(); } catch { return null; }
			return ud[WS_PUBLISH_GRANT] ?? null;
		},
		publishGame(senderWs, topic, event, data, id) {
			// Stamp the per-room seq (the session-home sequencer) and fan the
			// game envelope out to the topic's local subscribers EXCLUDING the
			// sender (echo suppression), echoing the sender's client id. Routes
			// through sendOutboundT so chaos scenarios apply, matching the
			// production per-subscriber walk (uncompressed 60 Hz input path).
			const seq = stampSeq(undefined, topicSeqs, topic);
			const env = completeGameEnvelope('{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":', data, seq, id);
			let delivered = 0;
			for (const ws of wsConnections) {
				if (ws === senderWs) continue;
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				sendOutboundT(ws, env);
				delivered++;
			}
			return { seq, delivered };
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
				const seq = stampSeq(m.options, topicSeqs, m.topic);
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
		// Broadcast-request to every local subscriber of `topic`; partial success
		// (a timed-out / errored / closed socket -> { ok:false, error }). Mirrors
		// the production platform.requestTopic.
		requestTopic(topic, event, data, options) {
			const timeoutMs = (options && options.timeoutMs) || 5000;
			const targets = [];
			for (const ws of wsConnections) {
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (subs && subs.has(topic)) targets.push(ws);
			}
			return Promise.all(targets.map((ws) =>
				platform.request(ws, event, data, { timeoutMs })
					.then((reply) => ({ ok: true, reply }))
					.catch((err) => ({ ok: false, error: (err && err.message) ? err.message : String(err) }))
			));
		},
		topic(name) {
			if (!_topicHelperCache) _topicHelperCache = createTopicHelperCache(platform.publish);
			return _topicHelperCache(name);
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
		 * `createChaosState` in `src/runtime/utils.js` for the supported shapes.
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
				maxBufferedBytes: 0,
				backpressuredConnections: 0,
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
		/**
		 * Test-only seam: flip the readiness flag the readiness route reports on,
		 * without tearing the server down (the returned `close()` also sets it).
		 * @param {boolean} value
		 */
		__setDraining(value) {
			drainingT = value === true;
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
		 *   seq?: number | null, capability?: string, event?: string, data?: any,
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
				// Codec-aware relay (mirrors handler/lifecycle.js relayPublish): when the
				// origin carried a registered codec's capability, re-encode binary
				// locally for this server's binary-capable subscribers (stamping the
				// carried origin seq, never re-relaying); otherwise the JSON envelope.
				if (frame.capability !== undefined &&
					platform.relayPublishWire(frame.topic, frame.event, frame.data, frame.capability, frame.seq, frame.compress)) {
					return;
				}
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
								// Status line first: uWS emits an implicit "200 OK" on
								// the first writeHeader, and a 200 makes spec-compliant
								// WebSocket clients reject the handshake. Mirrors the
								// production handler.js fix.
								res.writeStatus('101 Switching Protocols');
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
			// Binary ingress (client->server 0x03), mirroring the production
			// handler: an ingress-capable connection's id-addressed binary frames
			// decode and route here ahead of the JSON control block and the app
			// hook. Only an actual 0x03 frame pays the cap lookup.
			if (isBinary && new Uint8Array(message)[0] === 0x03) {
				const iud = ws.getUserData();
				const icaps = iud[WS_CAPS];
				if (icaps !== undefined && icaps.has(WIRE_INGRESS_CAP)) {
					dispatchIngressFrame(ws, iud, message, iud[WS_PLATFORM]);
					return;
				}
			}
			// Oversized control-shaped frame: reject explicitly instead of a
			// silent fall-through. Mirrors handler.js + vite.js.
			if (!isBinary && message.byteLength >= 8192 &&
				new Uint8Array(message)[3] === 0x79 /* 'y' in {"type" */) {
				// Count the reject bytes into the connection's outbound total, matching
				// handler.js so the mock and the real handler agree on a close hook's
				// byte accounting.
				const rejectFrame = controlFrameTooLargeFrame(message.byteLength);
				ws.send(rejectFrame, false, false);
				bumpOutT(ws, rejectFrame);
				return;
			}
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
							// Wire-subscribe authorization (mirror): a client may only
							// (re)subscribe to a topic the server already authorized for
							// this connection, unless the app ships its own subscribe hook.
							if (SUBSCRIBE_AUTHZ_T && !subs.has(msg.topic) && !hasUserSubscribeHookT()) {
								sendDeniedT(ws, msg.topic, ref, 'FORBIDDEN');
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
							// Resume-on-subscribe (mirror): gap-fill via the resume hook before
							// subscribing to live, so __replay frames precede the first live frame.
							if (msg.recover && typeof msg.recover === 'object' && Number.isInteger(msg.recover.offset) && msg.recover.offset >= 0 && handler.resume) {
								const _rEpochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
								try {
									await handler.resume(ws, { sessionId: ws.getUserData()[WS_SESSION_ID], lastSeenSeqs: { [msg.topic]: msg.recover.offset }, lastSeenEpochs: _rEpochs, platform: ws.getUserData()[WS_PLATFORM] });
								} catch (err) { console.error('[ws] recover-on-subscribe hook threw:', err); }
								if (subs.has(msg.topic)) { sendSubscribedT(ws, msg.topic, ref); return; }
							}
							try { ws.subscribe(msg.topic); }
							catch { closedWsAbortsT++; return; }
							subs.add(msg.topic);
							if (sharedTopicsT.has(msg.topic)) joinCohortT(ws, ws.getUserData(), msg.topic, sharedTopicsT.get(msg.topic));
							sendSubscribedT(ws, msg.topic, ref);
							return;
						}
						if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
							ws.unsubscribe(msg.topic);
							ws.getUserData()[WS_SUBSCRIPTIONS]?.delete(msg.topic);
							if (sharedTopicsT.has(msg.topic)) leaveCohortT(ws, ws.getUserData(), msg.topic);
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
							// Opt-in confirm for binary ingress (mirror of lease-ok).
							if (caps.has(WIRE_INGRESS_CAP)) {
								sendOutboundT(ws, ingressOkFrame());
							}
							return;
						}
						if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
							const ref = hasRefT(msg.ref) ? msg.ref : null;
							// Topics past the 256 cap are denied loudly, never silently
							// dropped (same rule as the production runtime).
							for (let i = 256; i < msg.topics.length; i++) {
								if (typeof msg.topics[i] === 'string') {
									sendDeniedT(ws, msg.topics[i], ref, 'BATCH_OVERFLOW');
								}
							}
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
							// Wire-subscribe authorization (mirror, batch): pre-deny every valid
							// topic the server has not already authorized when no app hook is
							// present; with a hook, that hook decides.
							const _wireAuthzT = SUBSCRIBE_AUTHZ_T && !hasUserSubscribeHookT();
							const authzDeniedT = _wireAuthzT
								? valid.map((t) => !ws.getUserData()[WS_SUBSCRIPTIONS].has(t))
								: null;
							const batchDenials = await runSubscribeBatchHookT(ws, valid);
							const perTopicDenials = batchDenials === null && handler.subscribe
								? await Promise.all(valid.map((t) => runSubscribeHookT(ws, t)))
								: null;
							const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
							assert(udSubs instanceof Set, 'subs.shape-batch', null);
							// Resume-on-subscribe (mirror, batch): gap-fill every recover-tagged topic
							// that passed the auth gate in one resume-hook call, before the subscribe loop.
							let _recoverSeqs = null;
							let _recoverEpochs = null;
							if (msg.recover && typeof msg.recover === 'object') {
								for (let i = 0; i < valid.length; i++) {
									const _t = valid[i];
									const _denial = (authzDeniedT !== null && authzDeniedT[i] ? 'FORBIDDEN' : null)
										?? (batchDenials !== null ? (batchDenials[_t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
									if (_denial !== null) continue;
									const _rec = msg.recover[_t];
									if (_rec && typeof _rec === 'object' && Number.isInteger(_rec.offset) && _rec.offset >= 0) {
										if (_recoverSeqs === null) _recoverSeqs = {};
										_recoverSeqs[_t] = _rec.offset;
										if (Number.isInteger(_rec.epoch)) { if (_recoverEpochs === null) _recoverEpochs = {}; _recoverEpochs[_t] = _rec.epoch; }
									}
								}
								if (_recoverSeqs !== null && handler.resume) {
									try {
										await handler.resume(ws, { sessionId: ws.getUserData()[WS_SESSION_ID], lastSeenSeqs: _recoverSeqs, lastSeenEpochs: _recoverEpochs || undefined, platform: ws.getUserData()[WS_PLATFORM] });
									} catch (err) { console.error('[ws] recover-on-subscribe hook threw:', err); }
								}
							}
							for (let i = 0; i < valid.length; i++) {
								const topic = valid[i];
								const denial = (authzDeniedT !== null && authzDeniedT[i] ? 'FORBIDDEN' : null)
									?? (batchDenials !== null
										? (batchDenials[topic] ?? null)
										: (perTopicDenials !== null ? perTopicDenials[i] : null));
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
								if (sharedTopicsT.has(topic)) joinCohortT(ws, ws.getUserData(), topic, sharedTopicsT.get(topic));
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
						if (msg.type === 'ingress-bind' && typeof msg.id === 'number' && typeof msg.kind === 'string') {
							// Client binds a client-allocated ingress id to a
							// decode+route destination (mirror of the production
							// handler). Unknown kind -> no bind, no ack, JSON fallback.
							const bindUd = ws.getUserData();
							if (bindIngress(bindUd, ws, msg.id, msg.kind, msg.target)) {
								sendOutboundT(ws, ingressBoundFrame(msg.id));
							}
							return;
						}
						if (msg.type === 'game') {
							// Client-driven relay publish (the game lane). The topic is
							// the connection's publish grant, never client-supplied.
							// Ungranted or a non-string event -> game-denied; granted ->
							// stamp seq, fan out to the room excluding this sender, echo id.
							const gud = ws.getUserData();
							const grantTopic = gud[WS_PUBLISH_GRANT];
							if (!grantTopic || typeof msg.event !== 'string') {
								const reason = grantTopic ? 'INVALID' : 'FORBIDDEN';
								const denied = msg.id === undefined
									? JSON.stringify({ type: 'game-denied', reason })
									: JSON.stringify({ type: 'game-denied', reason, id: msg.id });
								sendOutboundT(ws, denied);
								return;
							}
							platform.publishGame(ws, grantTopic, msg.event, msg.data, msg.id);
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
				const sc = ud[WS_SHARED_COHORTS];
				if (sc) { for (const t of sc) sharedWireIds.release(t); }
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

	// Reserved admin / observability route, mirroring handler.js: when the app's
	// WS handler exports `admin(request)`, mount it at /__realtime/* and bridge
	// the uWS request to the Web Request/Response contract the handler speaks.
	// All authorization lives in the app handler; this is pure plumbing. The
	// mirror buffers the request body fully before constructing the Request
	// (production streams it); both deliver the same Request to the handler.
	if (adminPath !== false && typeof handler.admin === 'function') {
		app.any(adminPath + '/*', (res, req) => {
			const method = req.getMethod().toUpperCase();
			const pathname = req.getUrl();
			const query = req.getQuery();
			/** @type {Record<string, string>} */
			const adminHeaders = {};
			req.forEach((k, v) => { adminHeaders[k] = v; });
			const adminUrl = query ? `${pathname}?${query}` : pathname;
			const base = 'http://' + (adminHeaders.host || 'localhost');

			let adminAborted = false;
			res.onAborted(() => { adminAborted = true; });

			const failAdmin = (status) => {
				if (adminAborted) return;
				res.cork(() => {
					res.writeStatus(String(status));
					res.writeHeader('content-type', 'application/json');
					res.writeHeader('cache-control', 'no-store');
					res.writeHeader('x-content-type-options', 'nosniff');
					res.end(status === 400 ? '{"error":"bad request"}' : '{"error":"internal error"}');
				});
			};

			const writeAdmin = (response) => {
				Promise.resolve(response.body ? response.arrayBuffer() : null)
					.then((ab) => {
						if (adminAborted) return;
						const body = ab ? Buffer.from(ab) : null;
						res.cork(() => {
							res.writeStatus(String(response.status));
							let hasCTO = false;
							for (const [k, v] of response.headers) {
								if (k === 'content-length' || k === 'set-cookie') continue;
								if (k === 'x-content-type-options') hasCTO = true;
								res.writeHeader(k, v);
							}
							if (!hasCTO) res.writeHeader('x-content-type-options', 'nosniff');
							for (const c of response.headers.getSetCookie()) res.writeHeader('set-cookie', c);
							if (body && body.byteLength) res.end(body);
							else res.endWithoutBody(0);
						});
					})
					.catch(() => failAdmin(500));
			};

			const runAdmin = (body) => {
				let request;
				try {
					request = new Request(base + adminUrl, { method, headers: adminHeaders, body });
				} catch { failAdmin(400); return; }
				Promise.resolve()
					.then(() => handler.admin(request))
					.then((response) => {
						if (adminAborted) return;
						if (!(response instanceof Response)) { failAdmin(500); return; }
						writeAdmin(response);
					})
					.catch(() => failAdmin(500));
			};

			if (method === 'GET' || method === 'HEAD') { runAdmin(undefined); return; }
			/** @type {Buffer[]} */
			const adminChunks = [];
			res.onData((chunk, isLast) => {
				adminChunks.push(Buffer.from(new Uint8Array(chunk)));
				if (isLast) runAdmin(adminChunks.length ? Buffer.concat(adminChunks) : undefined);
			});
		});
	}

	// Liveness route, mirroring handler.js: always 200 while the process is up,
	// INCLUDING during a drain (a liveness probe must never restart a draining
	// instance mid-shutdown), so it does NOT consult `drainingT`.
	if (healthCheckPath !== false) {
		app.get(healthCheckPath, (res) => {
			res.onAborted(() => {});
			res.cork(() => { res.writeStatus('200 OK').end('OK'); });
		});
	}

	// Readiness route, mirroring handler.js: 200 'ready' normally, 503 'draining'
	// once `drainingT` is set (graceful shutdown or the __setDraining seam).
	if (readinessCheckPath !== false) {
		app.get(readinessCheckPath, (res) => {
			res.onAborted(() => {});
			if (drainingT) {
				res.cork(() => { res.writeStatus('503 Service Unavailable').end('draining'); });
			} else {
				res.cork(() => { res.writeStatus('200 OK').end('ready'); });
			}
		});
	}

	return new Promise((resolve, reject) => {
		app.listen(port, async (listenSocket) => {
			if (!listenSocket) return reject(new Error('Failed to listen'));
			const boundPort = uWS.us_socket_local_port(listenSocket);

			// Fire the user's `init` hook once the test server is listening,
			// before resolving createTestServer(). Mirrors production
			// handler.js semantics: throwing init rejects the createTestServer
			// promise so test setup failure is loud. An optional test `primaryInit`
			// runs once first (mirroring the production primary-thread hook) and its
			// result is surfaced as `workerData` - null when unset, matching
			// single-process mode which has no primary thread.
			if (typeof handler.init === 'function') {
				try {
					const testWorkerData = typeof primaryInit === 'function'
						? ((await primaryInit({ env: process.env })) ?? null)
						: null;
					await handler.init({ platform, workerData: testWorkerData });
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
					// Flip readiness to NOT-ready at the start of graceful shutdown,
					// mirroring production's `counters.draining = true` - the
					// readiness route now reports 503 while we drain.
					drainingT = true;
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
					// Advise clients to reconnect on a jittered schedule before closing
					// (opt-in via createTestServer({ reconnectDispersalMs }); 0 = no-op),
					// mirroring production shutdown() so the dispersal path is testable.
					if (options.reconnectDispersalMs > 0) {
						platform.adviseReconnect({ windowMs: options.reconnectDispersalMs, close: false });
					}
					// Mirror production graceful shutdown: end() (graceful) flushes
					// buffered frames + sends a clean 1001 close frame; close() drops
					// them and sends no code. Snapshot first - end() fires the close
					// handler, which mutates wsConnections mid-iteration. Some tests
					// inject a lightweight fake ws implementing only close(), so fall
					// back to it when end() is absent.
					for (const ws of [...wsConnections]) {
						if (typeof ws.end === 'function') ws.end(1001, 'Test server closing');
						else ws.close(1001, 'Test server closing');
					}
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
