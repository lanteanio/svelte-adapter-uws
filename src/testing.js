import { now, monotonicNow, wallEpoch, setTimer, clearTimer, randomUuid } from './runtime/runtime.js';
import { parseCookies } from './runtime/cookies.js';
import { collectRequestHeaders } from './runtime/utils/request-headers.js';
import { stampSeq, processEpoch, completeEnvelope, completeGameEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, createTopicHelperCache, resolveRequestId, createChaosState, createUpgradeAdmission, negotiateRejection, buildAccessibleCapacityRefusalPage, isCursorLaneUpgrade, resolveWaitingRoom, createWaitingRoomRequest, sendWaitingRoomPage, createPollCounter, containMetricInstrument, applyCapacityReason, createPosture, readAssertionCounts, assert, fatal, WS_SUBSCRIPTIONS, WS_PUBLISH_GRANT, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CONNECTION_PERMIT, WS_CAPS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_LEASE, WS_SHARED_COHORTS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION } from './runtime/utils.js';
import { buildBinaryFrame, allocWireId, wireIdAnnounce, createCapCounts, createLeaseState, leaseGrantFrame, controlFrameTooLargeFrame, DEFAULT_GRANT } from './runtime/wire.js';
import { createSharedWireIdTable } from './runtime/handler/shared-wire-id.js';
import { deliverStatefulWireBatch, deliverStatelessWireFanout, encodeStatelessWirePayload } from './runtime/handler/wire-fanout.js';
import { snapshotUpgradeHeaders, warnSetCookieOnUpgradeOnce } from './runtime/utils/upgrade-headers.js';
import { deniesWireSystemTopicSubscribe, deniesWireSubscribePreHook, deniesWireSubscribeLanding, wantsRecover, recoverIsRevoked, exceedsSubscriptionCap, deniesUngrantedObserve } from './runtime/utils/subscribe-policy.js';
import { beginPendingSubscribe, settlePendingSubscribe, settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership, tombstonePendingSubscribe, isPendingSubscribeCancelled, releaseDerivedSubscriptions, isAuthorizationHook, WS_REVOKED_UNSUBSCRIBE } from './runtime/utils/ws-symbols.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './runtime/handler/ingress.js';
import { registerGameIngress, GAME_FANOUT_CAP, GAME_FANOUT_SCHEMA_VERSION, encodeGameFanoutPayload } from './runtime/handler/game-ingress.js';
import { createMessageAdmission, messageOverloadedFrame, runAdmittedMessageHook, runAdmittedMessageWork } from './runtime/utils/message-admission.js';
import { createConnectionPermitCarrier } from './runtime/utils/connection-permit.js';
import {
	assertWireSubscribeAuthorization,
	assertProtectiveNumber,
	DEFAULT_MAX_PAYLOAD_LENGTH
} from './config-guards.js';
import { assertBatchSequenceAuthority } from './runtime/handler/cluster-sequence-policy.js';
import { uwsLoadErrorMessage, readAdapterPackageJson } from './uws-load-hint.js';
import { runtimeVersionInfo } from './runtime/version-info.js';
import { ADAPTER_ERROR_IDS, adapterErrorMessage } from './runtime/error-registry.js';
import { emitOperationalEvent, formatDiagnostic, diagnosticError } from './runtime/diagnostic.js';
import { createDivergenceDiagnosticStore } from './runtime/divergence-diagnostics.js';

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

/** Default shutdown budget in seconds, the same value the server entry defaults to. */
const DEFAULT_SHUTDOWN_TIMEOUT_S = 30;

/**
 * The shutdown budget `close()` gives the app's `shutdown` hook, in ms.
 *
 * Read from `SHUTDOWN_TIMEOUT` at every call rather than once at import, so a
 * test can set the budget it wants to exercise immediately before closing.
 * `0` is the no-budget spelling, exactly as it is in production: nothing aborts
 * and the hook is awaited for as long as it takes. A value the runtime itself
 * would reject (not a number, or negative) falls back to the default rather than
 * silently disarming the budget.
 *
 * @returns {number} milliseconds, or 0 for no budget
 */
function shutdownBudgetMs() {
	const raw = process.env.SHUTDOWN_TIMEOUT;
	if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_TIMEOUT_S * 1000;
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_SHUTDOWN_TIMEOUT_S * 1000;
	return seconds * 1000;
}

/**
 * A promise that settles when `signal` aborts, and never when there is none.
 *
 * The never-settling half is deliberate: it is one side of a `Promise.race`, so
 * "no budget" has to mean "this side never wins" rather than "this side wins
 * immediately".
 *
 * @param {AbortSignal | null} signal
 * @returns {Promise<void>}
 */
function whenAbortedT(signal) {
	if (!signal) return new Promise(() => {});
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
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
	const divergenceDiagnosticsT = createDivergenceDiagnosticStore();
	// A permissive test double for a restrictive production deployment creates a
	// false-green authorization test. Apply the same value guard as the adapter
	// and Vite surfaces before the option is normalized with `=== true`.
	assertWireSubscribeAuthorization(
		options,
		'authorizeWireSubscribe',
		'the createTestServer option authorizeWireSubscribe'
	);
	const { port = 0, wsPath = '/ws', handler = {}, upgradeAdmission, messageAdmission: messageAdmissionOptions, protection, metrics, adminPath = '/__realtime', readinessCheckPath = '/readyz', healthCheckPath = '/healthz', primaryInit } = options;
	// Read with `??`, not as a destructuring default. Every other surface folds
	// `null` into the default - assertProtectiveNumber returns early for it as an
	// absent value, and the adapter and Vite both use `??`. A destructuring
	// default replaces only `undefined`, so this surface alone reported `null`
	// from platform.maxPayloadLength and handed `null` to the receiver.
	const maxPayloadLength = options.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;
	// One constant drives BOTH the enforced uWS receiver cap and the reported
	// platform.maxPayloadLength. The harness once enforced 64 KiB while
	// reporting 1 MiB - the exact report-versus-enforce split the production
	// and Vite surfaces were fixed for, certified by its own tests. Chunking
	// code sized off the report must survive against the real socket.
	// The receiver stores its limit as a signed 32-bit integer, so a value
	// above it (or a fractional one) is silently truncated by the native
	// layer while the reported number keeps the caller's figure - the same
	// report-versus-enforce split in the other direction. One guard, shared
	// with the production and Vite surfaces, so the bound cannot drift.
	assertProtectiveNumber(options, 'maxPayloadLength', 'the createTestServer option maxPayloadLength', {
		allowZero: false,
		ceiling: 0x7fffffff,
		zeroMeans:
			'the receiver reads a zero maximum payload as a refusal of all traffic, not as a ' +
			'disabled limit. Raise the limit instead.'
	});

	// Lifecycle state, mirroring the production state machine
	// (runtime/handler/lifecycle.js) rather than a boolean: `starting` while the
	// socket is bound but the app's `init` has not committed, `ready` once it
	// has, `draining` from the start of the returned `close()`, `closed` once the
	// listen socket is gone. Readiness is 200 in exactly one of them and answers
	// 503 with the state's NAME in the other three - a two-valued flag reported
	// `draining` to an operator whose instance was still booting, which during a
	// rolling deploy reads as a stuck or reversed rollout.
	//
	// A test can drive it directly with `platform.__setDraining(true)` to assert
	// the route without tearing the server down.
	/** @type {'starting' | 'ready' | 'draining' | 'closed'} */
	let lifecycleT = 'starting';
	// Mirror production: block client-initiated subscribes to `__`-prefixed
	// system topics by default. A registered plugin namespace may reach its hook,
	// but landing still requires tracked membership. Tests that intentionally
	// exercise arbitrary system channels can opt in broadly with
	// `allowSystemTopicSubscribe: true`.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T = options.allowSystemTopicSubscribe === true;
	// Mirror production: wire topics default to printable ASCII only.
	const ALLOW_NON_ASCII_TOPICS_T = options.allowNonAsciiTopics === true;
	// Mirror production wire-subscribe authorization. `let` so the platform
	// method `authorizeWireSubscribe()` can arm it at runtime, exactly like the
	// framework does in production. Seeded from the config option for the
	// static-config path.
	let SUBSCRIBE_AUTHZ_T = options.authorizeWireSubscribe === true || options.authorizeWireSubscribe === 'strict';
	let SUBSCRIBE_AUTHZ_STRICT_T = options.authorizeWireSubscribe === 'strict';
	// A plugin's side-effect hook does not count as the app taking over the topic
	// decision, matching production - otherwise exporting presence's subscribe
	// hook disarms the grant gate. See WS_HOOK_SIDE_EFFECT_ONLY.
	const hasUserSubscribeHookT = () =>
		isAuthorizationHook(handler.subscribe) || isAuthorizationHook(handler.subscribeBatch);

	// Same wiring shape as the production handler: a per-instance
	// admission state instantiated once, consulted at the top of the
	// upgrade hook (`tryAcquire` -> 503), and paced via `admit()` around
	// the actual `res.upgrade()` call. The pacing queue is finite even when
	// perTickBudget is the only enabled admission control.
	const admission = createUpgradeAdmission(upgradeAdmission);
	const connectionPermitCarrier = createConnectionPermitCarrier();
	const ADMISSION_PER_TICK_BUDGET = upgradeAdmission?.perTickBudget || 0;
	const messageAdmission = createMessageAdmission(messageAdmissionOptions);
	const rejectApplicationMessageT = (ws, rejection) => {
		mMessageAdmissionRejectedT?.inc({ reason: rejection.reason, scope: rejection.scope });
		sendOutboundT(ws, messageOverloadedFrame(rejection));
	};
	const runIngressApplicationWorkT = (ws, context) =>
		dispatchIngressFrame(ws, ws.getUserData(), context.data, context.platform);
	const runGameApplicationWorkT = (ws, context) => {
		const msg = context.msg;
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
		context.platform.publishGame(ws, grantTopic, msg.event, msg.data, msg.id);
	};

	// Content-negotiated rejection for over-capacity upgrades. Mirrors the
	// production handler exactly: resolved once (or null when off); null keeps
	// today's bare 503. On by default whenever the gate can reject.
	const WAITING_ROOM = resolveWaitingRoom(upgradeAdmission);

	// Admission counters, mirroring the production handler at the upgrade
	// branches this harness mirrors (same names, same reasons). Queue gauges are
	// event-driven here; the other sampled gauges and per-IP/origin reasons are
	// production-only because the harness runs no pressure sampler or limiters.
	const mUpgradeAdmittedT = containMetricInstrument(metrics?.counter('upgrade_admitted_total', 'WebSocket upgrades accepted'));
	const mUpgradeRejectedT = containMetricInstrument(metrics?.counter('upgrade_rejected_total', 'WebSocket upgrades rejected before open', ['reason']));
	const mUpgradeDeferredRejectedT = containMetricInstrument(metrics?.counter(
		'upgrade_deferred_rejected_total',
		'Upgrade callbacks shed because the bounded deferral queue was full'
	));
	const mMessageAdmissionRejectedT = containMetricInstrument(metrics?.counter(
		'ws_message_admission_rejected_total',
		'Application WebSocket messages shed by established-message admission',
		['reason', 'scope']
	));
	const gConnectionHeadroomT = admission.maxConnections > 0
		? containMetricInstrument(metrics?.gauge(
			'ws_connection_headroom',
			'Remaining reserved-or-live WebSocket connection permits'
		))
		: undefined;
	gConnectionHeadroomT?.set(admission.connectionHeadroom);
	const gUpgradeDeferredDepthT = containMetricInstrument(metrics?.gauge(
		'upgrade_deferred_depth', 'Upgrade callbacks waiting in the bounded pacing queue'
	));
	const gUpgradeDeferredOldestAgeT = containMetricInstrument(metrics?.gauge(
		'upgrade_deferred_oldest_age_seconds',
		'Age of the oldest callback in the bounded upgrade pacing queue'
	));
	if (gUpgradeDeferredDepthT !== undefined || gUpgradeDeferredOldestAgeT !== undefined) {
		admission.setDeferredObserver((depth, oldestAgeMs) => {
			gUpgradeDeferredDepthT?.set(depth);
			gUpgradeDeferredOldestAgeT?.set(oldestAgeMs / 1000);
		});
	}

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
			const failed = Object.create(null);
			for (let i = 0; i < topics.length; i++) failed[topics[i]] = 'INTERNAL_ERROR';
			return failed;
		}
		// Null-prototype for the same reason as production: an empty `{}` reads back
		// every Object.prototype member name as truthy, so a topic named `toString`
		// or `constructor` would be DENIED here while production allows it, and a
		// `__proto__` key would reach the inherited setter and store nothing.
		/** @type {Record<string, string>} */
		const denials = Object.create(null);
		if (!result || typeof result !== 'object') return denials;
		// Reading the hook RESULT can throw - a getter, a Proxy, a lazy row -
		// and this sits between the pending-subscribe begin and settle. An escape
		// would leak the pending entry forever, so every later unsubscribe on that
		// topic would falsely report cancelling an in-flight grant and the map would
		// grow unbounded. Fail closed on the whole batch instead.
		try {
			for (const [topic, val] of Object.entries(result)) {
				if (val === false) denials[topic] = 'FORBIDDEN';
				else if (typeof val === 'string') denials[topic] = val;
			}
		} catch (err) {
			console.error('[ws] subscribeBatch result read threw:', err);
			/** @type {Record<string, string>} */
			const broken = Object.create(null);
			for (let i = 0; i < topics.length; i++) broken[topics[i]] = 'INTERNAL_ERROR';
			return broken;
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
		} catch (cause) {
			throw new Error(
				'createTestServer: ' + uwsLoadErrorMessage(readAdapterPackageJson(), cause),
				{ cause }
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
	// Client sockets registered via track(): close() terminates and JOINS
	// them before the listen socket goes away, so no client-side dial or
	// close handshake outlives this server into the next test's listen.
	const trackedClients = new Set();

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

	function sendWireFanoutT(ws, value, binary) {
		return binary ? sendOutboundBinaryT(ws, value) : sendOutboundT(ws, value);
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
	// --- Resume-cutover live-frame barrier (harness twin of handler/resume-buffer.js) ---
	// The test server is single-process and configures no compressor, so buffered
	// frames flush uncompressed. See src/runtime/handler/resume-buffer.js for the
	// design; this mirror runs over the createTestEnv-local topicSeqs + sendOutboundT.
	const resumeBuffersT = new Map();
	const MAX_RESUME_BUFFERED_FRAMES_T = 4096;
	function captureResumeFrameT(topic, seq, env) {
		const set = resumeBuffersT.get(topic);
		if (set === undefined) return;
		for (const b of set) {
			if (b.frames.length >= MAX_RESUME_BUFFERED_FRAMES_T) { b.overflow = true; continue; }
			b.frames.push({ seq, env });
		}
	}
	function beginResumeCaptureT(topics, ws) {
		const entries = [];
		for (const topic of topics) {
			const buffer = { frames: [], overflow: false };
			let set = resumeBuffersT.get(topic);
			if (set === undefined) { set = new Set(); resumeBuffersT.set(topic, set); }
			set.add(buffer);
			// Fallback floor: topicSeqs is this single-process harness twin of production maxSeenSeq (equivalent with no cross-worker relay).
			const before = topicSeqs.get(topic);
			entries.push({ topic, buffer, before: typeof before === 'number' ? before : 0 });
		}
		return { ws, entries };
	}
	function unregisterResumeT(entry) {
		const set = resumeBuffersT.get(entry.topic);
		if (set === undefined) return;
		set.delete(entry.buffer);
		if (set.size === 0) resumeBuffersT.delete(entry.topic);
	}
	function discardResumeCaptureT(handle) {
		for (const entry of handle.entries) unregisterResumeT(entry);
	}
	function flushResumeTopicT(handle, topic, coveredSeq) {
		const entry = handle.entries.find((e) => e.topic === topic);
		if (entry === undefined) return;
		if (entry.buffer.overflow) {
			// Overflow: signal truncation FIRST so the resync marker is not lost
			// behind the partial flush (mirror of handler/resume-buffer.js).
			sendOutboundT(handle.ws, '{"topic":' + JSON.stringify('__replay:' + topic) + ',"event":"truncated","data":null}');
		}
		const floor = typeof coveredSeq === 'number' ? coveredSeq : entry.before;
		for (const f of entry.buffer.frames) {
			if (f.seq !== null && f.seq !== undefined && f.seq <= floor) continue;
			sendOutboundT(handle.ws, f.env);
		}
		unregisterResumeT(entry);
		// Drop the entry from the handle too, so a repeat flush for this topic is a
		// no-op and the batch final-sweep discard only touches un-flushed topics.
		const ei = handle.entries.indexOf(entry);
		if (ei !== -1) handle.entries.splice(ei, 1);
	}
	function coveredSeqForT(covered, topic) {
		if (covered == null) return undefined;
		if (typeof covered === 'number') return covered;
		if (typeof covered === 'object') {
			// Guarded for the same reason as production's coveredSeqFor: this reads
			// the app's `resume` hook result between beginPendingSubscribe and
			// settlePendingSubscribe on the batch path, so a throwing getter would
			// abort the loop and leak a pending entry for every remaining topic.
			try {
				const v = covered[topic];
				return typeof v === 'number' ? v : undefined;
			} catch (err) {
				console.error('[ws] resume hook result read threw for topic', topic, err);
				return undefined;
			}
		}
		return undefined;
	}

	const platform = {
		// The observer lane's deny-unwind (authorizeDerivedSubscribe) runs the
		// app's unsubscribe hook through this slot - the shared primitive has no
		// reference to this server's hook container. Per-platform rather than
		// process-global: several test servers coexist in one process, and a
		// global slot would run server A's unsubscribe hook for server B's
		// connections. See WS_REVOKED_UNSUBSCRIBE.
		[WS_REVOKED_UNSUBSCRIBE](ws, topic, ud) {
			handler.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
		},
		publish(topic, event, data, options) {
			const seq = stampSeq(options, topicSeqs, topic);
			const msg = envelope(topic, event, data, seq);
			// Relay the already-built envelope to other workers (sim), mirroring
			// handler.js's `relayed = parentPort && options.relay !== false` gate.
			if (onPublishT && !(options && options.relay === false)) {
				onPublishT({ kind: 'publish', topic, envelope: msg, seq, compress: !!(options && options.compress) });
			}
			if (resumeBuffersT.size > 0) captureResumeFrameT(topic, seq, msg);
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
			if (resumeBuffersT.size > 0) captureResumeFrameT(topic, seq, env);
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
			const payload = encodeStatelessWirePayload(wire, event, data);
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
				return deliverStatelessWireFanout(wire, payload, {
					topic, envelope: env, seq: seqOnWire, excludeWs, connections: wsConnections,
					ensureId: ensureWireIdT, isPoisoned: wireStatePoisonedT,
					poison: poisonWireStateT, send: sendWireFanoutT
				});
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
			return deliverStatelessWireFanout(wire, payload, {
				topic, envelope: env, seq: seqOnWire, excludeWs, connections: wsConnections,
				ensureId: ensureWireIdT, isPoisoned: wireStatePoisonedT,
				poison: poisonWireStateT, send: sendWireFanoutT
			});
		},
		publishWireBatch(topic, event, entries, wire, options) {
			// A permissive test double for a restrictive production rule creates a
			// false-green test, so the batch-seq refusal is applied here too: without
			// it, a harness batch stamps every entry with one caller-supplied seq and
			// the suite certifies a wire shape production refuses.
			// Checked before the entries are, exactly as production does: an empty
			// harness batch must refuse the options a full one refuses, or a suite
			// certifies a call shape production rejects.
			const opts = options == null ? options : { ...options };
			assertBatchSequenceAuthority(opts);
			// Mirror of handler/platform.js publishWireBatch: one binary frame per
			// capable connection (the codec's `<event>-batch` form), per-entry JSON
			// envelopes for everyone else, per-entry sender exclusion, per-entry
			// seq/relay, poison-on-drop. A stateless codec routes per entry.
			if (!Array.isArray(entries) || entries.length === 0) return false;
			// Same one-read rule as production (see platform.js publishWireBatch):
			// a payload's toJSON runs during envelope building, so anything read
			// out of the caller's entries afterwards could differ from what the
			// earlier reads saw. A harness that re-read them would disagree with
			// production about which bytes a subscriber gets.
			const count = entries.length;
			if (!wire || !wire.state) {
				const statelessDatas = new Array(count);
				const statelessExcludes = new Array(count);
				for (let i = 0; i < count; i++) {
					const entry = entries[i];
					statelessDatas[i] = entry.data;
					statelessExcludes[i] = entry.excludeWs;
				}
				let ok = false;
				for (let i = 0; i < count; i++) {
					const per = statelessExcludes[i] !== undefined
						? { ...(opts || {}), excludeWs: statelessExcludes[i] }
						: opts;
					ok = platform.publishWire(topic, event, statelessDatas[i], wire, per) || ok;
				}
				return ok;
			}
			const envs = new Array(count);
			const seqs = new Array(count);
			const datas = new Array(count);
			let excludes = null;
			let anyExclude = false;
			for (let i = 0; i < count; i++) {
				const entry = entries[i];
				const data = entry.data;
				const exclude = entry.excludeWs;
				datas[i] = data;
				if (exclude !== undefined && exclude !== null) {
					if (excludes === null) excludes = new Array(count);
					excludes[i] = exclude;
					anyExclude = true;
				}
				const seq = stampSeq(opts, topicSeqs, topic);
				seqs[i] = seq == null ? 0 : seq;
				envs[i] = envelope(topic, event, data, seq);
				if (onPublishT && !(opts && opts.relay === false)) {
					onPublishT({ kind: 'publish', topic, envelope: envs[i], seq, compress: false });
				}
			}
			if (resumeBuffersT.size > 0) {
				for (let i = 0; i < count; i++) captureResumeFrameT(topic, seqs[i] === 0 ? null : seqs[i], envs[i]);
			}
			const sendJsonT = (ws, list) => { for (let i = 0; i < list.length; i++) sendOutboundT(ws, list[i]); };
			if (!anyExclude && !capCountsT.has(wire.capability)) {
				if (chaos.scenario === null) {
					for (let i = 0; i < count; i++) app.publish(topic, envs[i], false, false);
					return true;
				}
				let delivered = false;
				for (const ws of wsConnections) {
					if (!ws.isSubscribed(topic)) continue;
					sendJsonT(ws, envs);
					delivered = true;
				}
				return delivered;
			}
			let delivered = false;
			for (const ws of wsConnections) {
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				let dataList = datas;
				let envList = envs;
				let seqList = seqs;
				if (anyExclude) {
					dataList = [];
					envList = [];
					seqList = [];
					for (let i = 0; i < count; i++) {
						if (excludes[i] === ws) continue;
						dataList.push(datas[i]);
						envList.push(envs[i]);
						seqList.push(seqs[i]);
					}
					if (envList.length === 0) continue;
				}
				const caps = ud[WS_CAPS];
				if (!caps || !caps.has(wire.capability)) { sendJsonT(ws, envList); delivered = true; continue; }
				const state = ensureWireStateT(ws, ud, wire);
				if (state == null) { sendJsonT(ws, envList); delivered = true; continue; }
				deliverStatefulWireBatch({
					wire, event, datas: dataList, envelopes: envList, seqs: seqList,
					state, ws, ud, topic, ensureId: ensureWireIdT,
					poison: poisonWireStateT, send: sendWireFanoutT
				});
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
		sendWireBatch(ws, topic, event, entries, wire, options) {
			// Mirror of handler/platform.js sendWireBatch: one binary frame for a
			// capable subscriber (the codec's `<event>-batch` form), per-entry JSON
			// envelopes otherwise, poison-on-drop.
			void options;
			if (!Array.isArray(entries) || entries.length === 0) return 1;
			let ud;
			try { ud = ws.getUserData(); } catch { closedWsAbortsT++; return 2; }
			const caps = ud[WS_CAPS];
			// Mirroring production: `source` is the pinned payload array once one
			// exists and null while it does not, so a JSON-only send reads the
			// caller's entry as it reaches it and allocates nothing. Pinning
			// protects what has already been BUILT, and a JSON-only send to one
			// socket builds nothing a later entry's toJSON could rewrite.
			const count = entries.length;
			const sendJsonFromT = (i, source) => {
				let result = 1;
				for (; i < count; i++) {
					result = sendOutboundT(ws, envelope(topic, event, source === null ? entries[i].data : source[i]));
				}
				return result;
			};
			if (!caps || !caps.has(wire.capability) || wireStatePoisonedT(ud, wire.capability) || !wire.state) {
				return sendJsonFromT(0, null);
			}
			const state = ensureWireStateT(ws, ud, wire);
			if (state == null) return sendJsonFromT(0, null);
			// From here the payloads are pinned: the batch encode is application
			// code handed the whole array, and a decline falls back to per-entry
			// encodes that must see what the batch attempt saw. Handed to the codec
			// directly rather than copied into a second array.
			const datas = new Array(count);
			for (let i = 0; i < count; i++) datas[i] = entries[i].data;
			const schemaVersion = typeof state.schemaVersion === 'number' ? state.schemaVersion : wire.schemaVersion;
			const payload = wire.encode(event + '-batch', { updates: datas }, state);
			if (payload == null) {
				let result = 1;
				for (let i = 0; i < count; i++) {
					const p = wire.encode(event, datas[i], state);
					if (p == null) { result = sendOutboundT(ws, envelope(topic, event, datas[i])); continue; }
					const id = ensureWireIdT(ws, ud, topic);
					if (id === -1) { poisonWireStateT(ws, ud, wire.capability); return sendJsonFromT(i, datas); }
					result = sendOutboundBinaryT(ws, buildBinaryFrame(schemaVersion, id, 0, p));
					if (result === 2) { poisonWireStateT(ws, ud, wire.capability); return sendJsonFromT(i + 1, datas); }
				}
				return result;
			}
			const id = ensureWireIdT(ws, ud, topic);
			if (id === -1) {
				poisonWireStateT(ws, ud, wire.capability);
				return sendJsonFromT(0, datas);
			}
			const result = sendOutboundBinaryT(ws, buildBinaryFrame(schemaVersion, id, 0, payload));
			if (result === 2) poisonWireStateT(ws, ud, wire.capability);
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
		// Scalar pressure signals and package versions only (topPublishers is
		// omitted; topic names can embed ids). svelte-realtime's introspect()
		// composes this under a `transport` key when present.
		introspect() {
			const p = platform.pressure;
			return {
				connections: platform.connections,
				closedWsAborts: platform.closedWsAborts,
				protection: platform.protection,
				maxPayloadLength: platform.maxPayloadLength,
				versions: { ...runtimeVersionInfo },
				pressure: {
					sampledAt: p.sampledAt ?? null,
					active: p.active,
					reason: p.reason,
					value: p.value,
					subscriberRatio: p.subscriberRatio,
					publishRate: p.publishRate,
					memoryMB: p.memoryMB,
					maxBufferedBytes: p.maxBufferedBytes,
					backpressuredConnections: p.backpressuredConnections,
					droppedFrames: p.droppedFrames,
					droppedBytes: p.droppedBytes
				},
				assertions: Object.fromEntries(platform.assertions),
				diagnostics: {
					retained: divergenceDiagnosticsT.size,
					recent: divergenceDiagnosticsT.list()
				}
			};
		},
		diagnostic(diagnosticId) { return divergenceDiagnosticsT.get(diagnosticId); },
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
		// Mirror production: report the ENFORCED numeric cap and a constant-time
		// bufferedAmount so test code can exercise the same backpressure-
		// aware branches it uses in production.
		get maxPayloadLength() { return maxPayloadLength; },
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
			let ud;
			try { ud = ws.getUserData(); }
			catch { closedWsAbortsT++; return null; }
			const subs = ud[WS_SUBSCRIPTIONS];
			if (!(subs instanceof Set)) return 'INVALID_TOPIC';
			if (subs.has(topic)) return null;
			if (exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
			// Track this subscribe across its authorization await. A revocation
			// landing in that gap cannot remove a subscription that does not exist
			// yet, so unsubscribe tombstones the in-flight attempt and the landing
			// below discards the grant instead of installing it. Same primitive as
			// the production runtime - without it an app's ban logic verified
			// against this server passes while the equivalent production path is
			// the one that was fixed.
			const token = beginPendingSubscribe(ud, topic, subs.has(topic));
			const denial = await runUserSubscribeGateT(ws, topic);
			if (denial !== null) {
				// The hook denied, but it may have installed tracked membership
				// (a plugin join) before deciding, and a revocation may have tombstoned
				// this attempt mid-await. Settling blindly here left that membership
				// standing: the held branch below defers to a sibling attempt still in
				// flight, so when that sibling's hook denies too, every attempt leaves
				// through this exit and nothing remains to judge the membership.
				if (settleDeniedSubscribe(ud, topic, token, subs.has(topic)) === 'deny-unwind') {
					unwindRevokedMembership(ws, topic);
					handler.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
				}
				return denial;
			}
			if (subs.has(topic)) {
				// Held is not enough when this attempt was revoked mid-await and
				// its own hook installed the membership (a plugin join): read the
				// provenance, and unwind a grant no live authority backs.
				const heldVerdict = settleHeldSubscribe(ud, topic, token);
				if (heldVerdict === 'ack') return null;
				if (heldVerdict === 'deny-unwind') {
					unwindRevokedMembership(ws, topic);
					handler.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
				}
				return 'FORBIDDEN';
			}
			if (exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) { settlePendingSubscribe(ud, topic, token); return 'RATE_LIMITED'; }
			// Revoked while parked: discard the grant rather than installing it.
			if (!settlePendingSubscribe(ud, topic, token, true)) return 'FORBIDDEN';
			try { ws.subscribe(topic); }
			catch { closedWsAbortsT++; return null; }
			subs.add(topic);
			if (sharedTopicsT.has(topic)) joinCohortT(ws, ws.getUserData(), topic, sharedTopicsT.get(topic));
			return null;
		},
		// `opts`, not `options`: the enclosing createTestServer(options) is in scope
		// here, and shadowing it invites a future config read from the caller's
		// object instead.
		async checkSubscribe(ws, topic, opts) {
			// Ordinary callers are trusted server code. Observer-mode callers are
			// fed client-named snapshot topics, so mirror the configured wire
			// alphabet rather than silently accepting a larger topic space.
			if (!isValidWireTopic(topic, opts && opts.requireGrant ? ALLOW_NON_ASCII_TOPICS_T : true)) {
				return 'INVALID_TOPIC';
			}
			// `requireGrant` is the observer-lane mode - "may this connection see
			// what it already holds?" - and it must not be the default, because the
			// ordinary use of this method gates BEFORE a grant exists. Same shared
			// predicate and same precedence as the production runtime: an app
			// asserting its own tenancy boundary against this server must not get
			// the opposite answer from the one production would give.
			const requireGrant = Boolean(opts && opts.requireGrant);
			let observerHasUserHook = false;
			if (requireGrant) {
				observerHasUserHook = hasUserSubscribeHookT();
				let granted;
				try { granted = ws.getUserData()[WS_SUBSCRIPTIONS]; }
				catch { closedWsAbortsT++; return 'FORBIDDEN'; }
				if (deniesUngrantedObserve(SUBSCRIBE_AUTHZ_T, observerHasUserHook && !SUBSCRIBE_AUTHZ_STRICT_T, granted, topic)) {
					return 'FORBIDDEN';
				}
			}
			const denial = await runUserSubscribeGateT(ws, topic);
			if (denial !== null) return denial;
			if (requireGrant) {
				// Re-read after the async hook: a grant revoked inside that await must
				// not produce an allow answer after it is gone.
				let granted;
				try { granted = ws.getUserData()[WS_SUBSCRIPTIONS]; }
				catch { closedWsAbortsT++; return 'FORBIDDEN'; }
				if (deniesUngrantedObserve(SUBSCRIBE_AUTHZ_T, observerHasUserHook && !SUBSCRIBE_AUTHZ_STRICT_T, granted, topic)) {
					return 'FORBIDDEN';
				}
			}
			return null;
		},
		authorizeWireSubscribe(mode = 'legacy') {
			// Mirror production: arm wire-subscribe authorization at runtime.
			if (mode !== 'legacy' && mode !== 'strict') {
				throw new TypeError("authorizeWireSubscribe mode must be 'legacy' or 'strict'");
			}
			SUBSCRIBE_AUTHZ_T = true;
			if (mode === 'strict') SUBSCRIBE_AUTHZ_STRICT_T = true;
			return SUBSCRIBE_AUTHZ_STRICT_T ? 'strict' : 'legacy';
		},
		unsubscribe(ws, topic) {
			let ud;
			try { ud = ws.getUserData(); }
			catch { closedWsAbortsT++; return false; }
			const subs = ud[WS_SUBSCRIPTIONS];
			// Cancel any subscribe for this topic parked in its authorization await.
			// Taken BEFORE the membership early-return below, because the racing
			// case is precisely "not a member yet" - returning false there without
			// tombstoning is the silent no-op that lets a revoked connection end up
			// subscribed anyway. `true` here is the truthful answer for a revoke
			// that cancelled an in-flight grant.
			const cancelledInFlight = tombstonePendingSubscribe(ud, topic);
			// Release any observer tap derived from this topic, as production does:
			// presence and cursor keep their tap alive across a participant leave
			// and drop it only on socket close, so a revocation that left it in
			// place kept delivering the roster and every peer's cursor position to
			// a client that had just been kicked. Also before the early return -
			// revoking a topic must release its taps whether or not the primary
			// membership is still present.
			releaseDerivedSubscriptions(ws, topic);
			// Withdraw WRITE access with read access, as production does: the
			// `game` lane carries no topic and publishes to whatever binding the
			// connection holds, so a kick that left the binding behind kept the
			// kicked sender publishing into the room.
			if (ud[WS_PUBLISH_GRANT] === topic) ud[WS_PUBLISH_GRANT] = undefined;
			if (!(subs instanceof Set) || !subs.has(topic)) return cancelledInFlight;
			try { ws.unsubscribe(topic); }
			catch { closedWsAbortsT++; return false; }
			subs.delete(topic);
			if (sharedTopicsT.has(topic)) leaveCohortT(ws, ws.getUserData(), topic);
			handler.unsubscribe?.(ws, topic, { platform: ud[WS_PLATFORM] });
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
			// Compact fan-out (PROTOCOL.md 6.7): mirror of the production
			// publishGame - a game.fanout:1 subscriber receives the value-codec
			// 0x03 frame (encoded once, framed per connection by its wire-id),
			// everyone else the JSON envelope; the sender is excluded either way.
			if (resumeBuffersT.size > 0) captureResumeFrameT(topic, seq, env);
			const wantBinary = capCountsT.has(GAME_FANOUT_CAP);
			const seqOnWire = seq == null ? 0 : seq;
			/** @type {Uint8Array | null} */
			let sharedPayload = null;
			let sharedEncoded = false;
			/** @type {Map<number, Uint8Array> | null} */
			let sharedFrameById = null;
			let delivered = 0;
			for (const ws of wsConnections) {
				if (ws === senderWs) continue;
				let ud;
				try { ud = ws.getUserData(); } catch { continue; }
				const subs = ud[WS_SUBSCRIPTIONS];
				if (!subs || !subs.has(topic)) continue;
				const caps = wantBinary ? ud[WS_CAPS] : null;
				if (caps && caps.has(GAME_FANOUT_CAP) && !wireStatePoisonedT(ud, GAME_FANOUT_CAP)) {
					if (!sharedEncoded) {
						sharedPayload = encodeGameFanoutPayload(event, data, id);
						sharedEncoded = true;
						sharedFrameById = new Map();
					}
					const wid = ensureWireIdT(ws, ud, topic);
					if (wid === -1) {
						poisonWireStateT(ws, ud, GAME_FANOUT_CAP);
						sendOutboundT(ws, env);
						delivered++;
						continue;
					}
					let frame = sharedFrameById.get(wid);
					if (!frame) {
						frame = buildBinaryFrame(GAME_FANOUT_SCHEMA_VERSION, wid, seqOnWire, /** @type {Uint8Array} */ (sharedPayload));
						sharedFrameById.set(wid, frame);
					}
					sendOutboundBinaryT(ws, frame);
					delivered++;
					continue;
				}
				sendOutboundT(ws, env);
				delivered++;
			}
			return { seq, delivered };
		},
		batch(messages) {
			return messages.map(({ topic, event, data, options }) => platform.publish(topic, event, data, options));
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
				const env = envelope(m.topic, m.event, m.data, seq);
				events[i] = { topic: m.topic, env };
				// A caps-less resuming connection receives these as per-event JSON.
				if (resumeBuffersT.size > 0) captureResumeFrameT(m.topic, seq, env);
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
				return Promise.reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_CLOSED)));
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
					if (pending.delete(ref)) reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT)));
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
					reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_CLOSED)));
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
				// Permanently null: the harness fabricates this snapshot and never
				// runs the sampler, so every number below is a placeholder rather
				// than a reading. A test asserting on real pressure values needs the
				// production runtime, and this is what says so.
				sampledAt: null,
				active: reason !== 'NONE',
				value: 0,
				subscriberRatio: 0,
				publishRate: 0,
				memoryMB: 0,
				reason,
				maxBufferedBytes: 0,
				backpressuredConnections: 0,
				droppedFrames: 0,
				droppedBytes: 0,
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
		 * Test-only seam: move the lifecycle state the readiness route reports on,
		 * without tearing the server down (the returned `close()` also moves it).
		 *
		 * Boolean, because that is the transition a readiness test drives: `true`
		 * is `draining`, `false` puts the instance back in rotation as `ready`.
		 * The `starting` state is not reachable through this seam - it is the boot
		 * window, and the only honest way to observe it is from an `init` hook
		 * while the server is genuinely in it.
		 * @param {boolean} value
		 */
		__setDraining(value) {
			lifecycleT = value === true ? 'draining' : 'ready';
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
					if (resumeBuffersT.size > 0) for (let i = 0; i < events.length; i++) captureResumeFrameT(events[i].topic, events[i].seq, events[i].env);
					for (let i = 0; i < events.length; i++) app.publish(events[i].topic, events[i].env, false, false);
					return;
				}
				if (resumeBuffersT.size > 0) for (let i = 0; i < events.length; i++) captureResumeFrameT(events[i].topic, events[i].seq, events[i].env);
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
				if (resumeBuffersT.size > 0) captureResumeFrameT(frame.topic, frame.seq, frame.envelope);
				app.publish(frame.topic, frame.envelope, false, false);
			}
		}
	};
	let nextRequestRefT = 1;

	app.ws(wsPath, {
		maxPayloadLength,
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
					if (!isCursor && negotiateRejection(
						req.getHeader('accept'),
						req.getHeader('upgrade')
					) === 'html') {
						sendWaitingRoomPage(res, {
							body: buildAccessibleCapacityRefusalPage(),
							lang: 'en',
							dir: 'ltr',
							headers: [],
							varyAcceptLanguage: false
						}, '503 Service Unavailable');
						return;
					}
					res.cork(() => {
						res.writeStatus('503 Service Unavailable');
						res.writeHeader('content-type', 'text/plain');
						res.end('Server is at upgrade capacity, please retry');
					});
					return;
				}

				// One header read, no full walk on the reject path.
				const accept = req.getHeader('accept');
				if (negotiateRejection(accept, req.getHeader('upgrade')) === 'html') {
					const page = WAITING_ROOM.renderResponse(
						undefined,
						createWaitingRoomRequest(req)
					);
					sendWaitingRoomPage(res, page);
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
			const handshakeAcquired = isCursor ? admission.tryAcquireCursor() : admission.tryAcquire();
			if (!handshakeAcquired) {
				if (activePostureT !== null) activePostureT.recordCapacityReject();
				mUpgradeRejectedT?.inc({ reason: isCursor ? 'cursor_lane' : 'over_capacity' });
				serveUpgradeRefusal();
				return;
			}
			let inFlightReleased = false;
			let connectionPermitHeld = false;
			let connectionPermitTransferred = false;
			function releaseConnectionPermit() {
				if (!connectionPermitHeld || connectionPermitTransferred) return;
				connectionPermitHeld = false;
				admission.releaseConnection();
				gConnectionHeadroomT?.set(admission.connectionHeadroom);
			}
			function releaseInFlight() {
				if (!inFlightReleased) {
					inFlightReleased = true;
					if (isCursor) admission.releaseCursorInFlight();
					else admission.release();
				}
				releaseConnectionPermit();
			}
			function rejectDeferredOverflow() {
				if (activePostureT !== null) activePostureT.recordCapacityReject();
				mUpgradeRejectedT?.inc({ reason: 'deferred_overflow' });
				mUpgradeDeferredRejectedT?.inc();
				releaseInFlight();
				serveUpgradeRefusal();
			}

			if (!admission.tryAcquireConnection()) {
				if (activePostureT !== null) activePostureT.recordCapacityReject();
				mUpgradeRejectedT?.inc({ reason: 'connection_capacity' });
				releaseInFlight();
				serveUpgradeRefusal();
				return;
			}
			connectionPermitHeld = admission.maxConnections > 0;
			gConnectionHeadroomT?.set(admission.connectionHeadroom);

			// Repeated header lines are merged per header class, and a repeated
			// framing / identity header refuses the upgrade - the production
			// wiring exactly, since an app verifying its handshake against this
			// mirror must not see an ambiguity the real server rejects.
			/** @type {Record<string, string>} */
			const headers = {};
			if (collectRequestHeaders(req, headers) !== null) {
				mUpgradeRejectedT?.inc({ reason: 'duplicate_header' });
				res.cork(() => {
					res.writeStatus('400 Bad Request');
					res.writeHeader('content-type', 'text/plain');
					res.end('Bad Request');
				});
				releaseInFlight();
				return;
			}
			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');
			const upgradeWithConnectionPermit = (userData) => {
				let carrier = null;
				if (connectionPermitHeld) {
					carrier = connectionPermitCarrier.install(userData);
					connectionPermitTransferred = true;
				}
				try {
					res.upgrade(userData, secKey, secProtocol, secExtensions, context);
				} catch (error) {
					if (connectionPermitTransferred) {
						connectionPermitTransferred = false;
						connectionPermitCarrier.rollback(userData, carrier);
					}
					releaseConnectionPermit();
					throw error;
				}
			};
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();
			const rawIp = new TextDecoder().decode(res.getRemoteAddressAsText());

			const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();

			if (!handler.upgrade) {
				let fastPathAborted = false;
				if (ADMISSION_PER_TICK_BUDGET > 0) {
					res.onAborted(() => { fastPathAborted = true; releaseInFlight(); });
				}
				const pacingOutcome = admission.admit(() => {
					if (fastPathAborted) return;
					try {
						res.cork(() => {
							upgradeWithConnectionPermit({ remoteAddress: rawIp, [WS_REQUEST_ID_KEY]: wsRequestId });
						});
						mUpgradeAdmittedT?.inc();
					} finally {
						// Also releases both permits if the native upgrade throws.
						releaseInFlight();
					}
				});
				if (pacingOutcome === null) rejectDeferredOverflow();
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
						// Same shared guard as the production runtime, with the same
						// consequence: throwing here takes the hook-error path below
						// (500, no 101). The sentinel is duck-typed, so an app can
						// reach this with headers upgradeResponse() never validated -
						// by mutating a helper result, or by building the shape by
						// hand. Without this check an app could verify its handshake
						// against this server, see a clean pass, and ship a
						// splittable header to production.
						//
						// Validated as a SNAPSHOT that is also what gets written, for
						// the same reason as production: the object is the app's and
						// admission may defer the write, so checking the live object
						// and writing it later leaves a mutation window.
						responseHeaders = snapshotUpgradeHeaders(responseHeaders);
						// Same one-shot Cloudflare advisory production gives, so an app
						// developing against this server is not told a different story.
						if (responseHeaders) warnSetCookieOnUpgradeOnce(responseHeaders);
					} else {
						userData = result || {};
					}
					if (!userData.remoteAddress) userData.remoteAddress = rawIp;
					userData[WS_REQUEST_ID_KEY] = wsRequestId;
					const pacingOutcome = admission.admit(() => {
						if (aborted) { releaseInFlight(); return; }
						try {
							res.cork(() => {
								if (responseHeaders) {
									// Status line first: uWS emits an implicit "200 OK" on
									// the first writeHeader, and a 200 makes spec-compliant
									// WebSocket clients reject the handshake. Mirrors the
									// production handler.js fix.
									res.writeStatus('101 Switching Protocols');
									for (const [hk, hv] of Object.entries(responseHeaders)) {
										if (Array.isArray(hv)) {
											// Index the trusted snapshot; never invoke an
											// app-controlled Symbol.iterator at the wire sink.
											for (let i = 0; i < hv.length; i++) res.writeHeader(hk, hv[i]);
										} else {
											res.writeHeader(hk, hv);
										}
									}
								}
								upgradeWithConnectionPermit(userData);
							});
							mUpgradeAdmittedT?.inc();
						} finally {
							// The deferred drain catches native throws outside this
							// promise chain, so release locally as well.
							releaseInFlight();
						}
					});
					if (pacingOutcome === null) rejectDeferredOverflow();
				})
				.catch((err) => {
					// Say WHY, as the production handler does. This path now also
					// carries the upgrade-response header validation failures, whose
					// whole point is naming the offending header - discarding that on
					// the surface an app uses to debug its handshake leaves it with a
					// bare 500 and nothing to go on.
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.websocket-upgrade',
						event: 'runtime.websocket-upgrade.failed',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'The WebSocket upgrade hook failed.',
						attributes: { requestId: wsRequestId, error: diagnosticError(err) }
					});
					if (!aborted) {
						mUpgradeRejectedT?.inc({ reason: 'hook_error' });
						res.cork(() => {
							res.writeStatus('500 Internal Server Error');
							res.writeHeader('content-type', 'text/plain');
							res.writeHeader('x-request-id', wsRequestId);
							res.end('Internal Server Error');
						});
					}
					releaseInFlight();
				});
		},

		open(ws) {
			const userData = ws.getUserData();
			if (admission.maxConnections > 0) {
				const permitRestored = connectionPermitCarrier.restore(userData);
				fatal(permitRestored, 'ws.connection-permit-carrier', null);
				if (!permitRestored) return;
			}
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
					await runAdmittedMessageWork(messageAdmission, ws, { data: message, platform: iud[WS_PLATFORM] }, runIngressApplicationWorkT, rejectApplicationMessageT);
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
							if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T, topic: msg.topic })) {
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
							if (exceedsSubscriptionCap({ held: !isNew, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
								sendDeniedT(ws, msg.topic, ref, 'RATE_LIMITED');
								return;
							}
							// Wire-subscribe authorization (mirror): a client may only
							// (re)subscribe to a topic the server already authorized for
							// this connection, unless the app ships its own subscribe hook.
							// The plugin-owned carve-out belongs on BOTH spellings. It was
							// on the batch path only, so the same client, server and topic
							// got opposite answers depending on how many topics happened to
							// be pending when the client flushed - src/client.js sends a
							// single `subscribe` frame when exactly one is queued, so a
							// documented group join worked or failed on microtask
							// coalescing. Safe here for the same reason as production: the
							// landing re-check below re-tests real membership.
							if (deniesWireSubscribePreHook({ armed: SUBSCRIBE_AUTHZ_T, hasUserHook: hasUserSubscribeHookT() && !SUBSCRIBE_AUTHZ_STRICT_T, held: subs.has(msg.topic), topic: msg.topic })) {
								sendDeniedT(ws, msg.topic, ref, 'FORBIDDEN');
								return;
							}
							// Track the in-flight subscribe, exactly as production does: a
							// revocation (platform.unsubscribe) landing during the hook
							// await cannot remove a subscription that does not exist yet,
							// so it tombstones this topic in the connection's
							// pending-subscribe set and the landing below discards the
							// grant. platform.unsubscribe already tombstones here, so
							// without this the tombstone was a guaranteed no-op for every
							// client-driven subscribe - the attacker-controlled path.
							const pendingUd = ws.getUserData();
							const pendingToken = beginPendingSubscribe(pendingUd, msg.topic, subs.has(msg.topic));
							const denial = await runUserSubscribeGateT(ws, msg.topic);
							if (denial !== null) {
								// The hook denied, but it may have installed tracked membership
								// (a plugin join) before deciding, and a revocation may have tombstoned
								// this attempt mid-await. Settling blindly here left that membership
								// standing: the held branch below defers to a sibling attempt still in
								// flight, so when that sibling's hook denies too, every attempt leaves
								// through this exit and nothing remains to judge the membership.
								if (settleDeniedSubscribe(pendingUd, msg.topic, pendingToken, subs.has(msg.topic)) === 'deny-unwind') {
									unwindRevokedMembership(ws, msg.topic);
									handler.unsubscribe?.(ws, msg.topic, { platform: pendingUd[WS_PLATFORM] });
								}
								sendDeniedT(ws, msg.topic, ref, denial);
								return;
							}
							// Mirrors production: a client that asked to recover from an
							// offset is not caught up merely because something else
							// installed live membership during the await, since a
							// re-grant carries no HISTORY. Fall through to the recover
							// lane, which acks through its own already-subscribed branch.
							const _wantsRecoverT = wantsRecover({ hasResumeHook: handler.resume, recover: msg.recover });
							if (subs.has(msg.topic) && !_wantsRecoverT) {
								// Held is not enough: the membership may have been installed
								// mid-await by THIS attempt's own hook after a revocation
								// tombstoned it. settleHeldSubscribe reads the provenance -
								// ack a surviving attempt or a fresh post-revoke grant, deny
								// a revoked one, unwinding hook-installed membership when no
								// live authority backs it. Mirrors runtime/handler.js.
								const heldVerdict = settleHeldSubscribe(pendingUd, msg.topic, pendingToken);
								if (heldVerdict === 'ack') {
									sendSubscribedT(ws, msg.topic, ref);
									return;
								}
								if (heldVerdict === 'deny-unwind') {
									unwindRevokedMembership(ws, msg.topic);
									handler.unsubscribe?.(ws, msg.topic, { platform: pendingUd[WS_PLATFORM] });
								}
								sendDeniedT(ws, msg.topic, ref, 'FORBIDDEN');
								return;
							}
							if (exceedsSubscriptionCap({ held: subs.has(msg.topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
								settlePendingSubscribe(pendingUd, msg.topic, pendingToken);
								sendDeniedT(ws, msg.topic, ref, 'RATE_LIMITED');
								return;
							}
							// Resume-on-subscribe (mirror): gap-fill via the resume hook before
							// subscribing to live, so __replay frames precede the first live frame.
							//
							// GUARDED, as production is: this call serves the topic's
							// replay HISTORY, and the tombstone below refuses the
							// subscription only afterwards - by which time the messages
							// have gone out. Membership first, epoch only when the socket
							// does not hold the topic, so a revoke-then-re-grant inside
							// one await window is still served.
							const _recoverRevokedT = recoverIsRevoked({
								held: subs instanceof Set && subs.has(msg.topic),
								wireAuthz: SUBSCRIBE_AUTHZ_T && (SUBSCRIBE_AUTHZ_STRICT_T || !hasUserSubscribeHookT()),
								cancelled: isPendingSubscribeCancelled(pendingUd, msg.topic, pendingToken),
								topic: msg.topic
							});
							let _cap = null;
							let _covered;
							if (!_recoverRevokedT && _wantsRecoverT) {
								const _rEpochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
								_cap = beginResumeCaptureT([msg.topic], ws);
								try {
									_covered = await handler.resume(ws, { sessionId: ws.getUserData()[WS_SESSION_ID], lastSeenSeqs: { [msg.topic]: msg.recover.offset }, lastSeenEpochs: _rEpochs, platform: ws.getUserData()[WS_PLATFORM] });
								} catch (err) { console.error('[ws] recover-on-subscribe hook threw:', err); }
								if (subs.has(msg.topic)) {
									const heldVerdictR = settleHeldSubscribe(pendingUd, msg.topic, pendingToken);
									if (heldVerdictR === 'ack') { discardResumeCaptureT(_cap); sendSubscribedT(ws, msg.topic, ref); return; }
									// Revoked mid-await; the replay went out, but a grant
									// installed by the revoked attempt's own hook must not stand.
									if (heldVerdictR === 'deny-unwind') {
										unwindRevokedMembership(ws, msg.topic);
										handler.unsubscribe?.(ws, msg.topic, { platform: pendingUd[WS_PLATFORM] });
									}
									discardResumeCaptureT(_cap);
									sendDeniedT(ws, msg.topic, ref, 'FORBIDDEN');
									return;
								}
							}
							// Revocation tombstone: a platform.unsubscribe that landed during
							// the gate / resume awaits cancelled this pending subscribe -
							// discard the grant rather than subscribing, and answer the
							// client's ref'd frame with a denial so its awaited subscribe
							// resolves truthfully.
							if (!settlePendingSubscribe(pendingUd, msg.topic, pendingToken, true)) {
								if (_cap) discardResumeCaptureT(_cap);
								sendDeniedT(ws, msg.topic, ref, 'FORBIDDEN');
								return;
							}
							// Re-check the server-grant gate against the CURRENT grant set,
							// not the reading taken before the awaits: the tombstone above
							// fires only for revocation paths that bump the epoch. Mirrors
							// the production landing in runtime/handler.js. Not applied to
							// the platform.subscribe helper above, which is the trusted
							// server-side path that MINTS grants - a grant check there would
							// refuse every server-initiated subscribe.
							if (deniesWireSubscribeLanding({ armed: SUBSCRIBE_AUTHZ_T, hasUserHook: hasUserSubscribeHookT() && !SUBSCRIBE_AUTHZ_STRICT_T, held: subs.has(msg.topic), topic: msg.topic })) {
								if (_cap) discardResumeCaptureT(_cap);
								sendDeniedT(ws, msg.topic, ref, 'FORBIDDEN');
								return;
							}
							try { ws.subscribe(msg.topic); }
							catch { if (_cap) discardResumeCaptureT(_cap); closedWsAbortsT++; return; }
							subs.add(msg.topic);
							if (_cap) flushResumeTopicT(_cap, msg.topic, coveredSeqForT(_covered, msg.topic));
							if (sharedTopicsT.has(msg.topic)) joinCohortT(ws, ws.getUserData(), msg.topic, sharedTopicsT.get(msg.topic));
							sendSubscribedT(ws, msg.topic, ref);
							return;
						}
						if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
							// Same TOCTOU as platform.unsubscribe: a subscribe for this topic may
							// still be parked in the app's authorization hook, so the membership
							// does not exist yet and removing it is a no-op.
							tombstonePendingSubscribe(ws.getUserData(), msg.topic);
							// The observer taps are authority derived from the base topic: a
							// client-driven revocation must release them just like
							// platform.unsubscribe does, or leaving `room` removes the base
							// membership while `__cursor:room` / `__presence:room` keeps
							// delivering private fan-out (and cursor keeps accepting writes).
							releaseDerivedSubscriptions(ws, msg.topic);
							ws.unsubscribe(msg.topic);
							ws.getUserData()[WS_SUBSCRIPTIONS]?.delete(msg.topic);
							// Read access gone means write access gone, as production and the
							// platform.unsubscribe above both do.
							const udWireUnsub = ws.getUserData();
							if (udWireUnsub[WS_PUBLISH_GRANT] === msg.topic) udWireUnsub[WS_PUBLISH_GRANT] = undefined;
							if (sharedTopicsT.has(msg.topic)) leaveCohortT(ws, ws.getUserData(), msg.topic);
							handler.unsubscribe?.(ws, msg.topic, { platform: udWireUnsub[WS_PLATFORM] });
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
								if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE_T, topic })) {
									sendDeniedT(ws, topic, ref, 'INVALID_TOPIC');
									continue;
								}
								valid.push(topic);
							}
							// Wire-subscribe authorization (mirror, batch): pre-deny every valid
							// topic the server has not already authorized when no app hook is
							// present; with a hook, that hook decides.
							// Hoisted once per frame, so every topic in one frame is judged
							// against one reading of the app's hooks. The caller owns this
							// handler object and may mutate it, which is exactly why the
							// reading is taken once here rather than per topic.
							const _hasUserHookT = hasUserSubscribeHookT();
							const _wireAuthzT = SUBSCRIBE_AUTHZ_T && (SUBSCRIBE_AUTHZ_STRICT_T || !_hasUserHookT);
							const authzDeniedT = _wireAuthzT
								? valid.map((t) => deniesWireSubscribePreHook({ armed: SUBSCRIBE_AUTHZ_T, hasUserHook: _hasUserHookT && !SUBSCRIBE_AUTHZ_STRICT_T, held: ws.getUserData()[WS_SUBSCRIPTIONS].has(t), topic: t }))
								: null;
							// Track every topic in this batch as in-flight, for the same reason
							// the single path does: platform.unsubscribe cannot remove a
							// membership that does not exist yet, so it tombstones the topic
							// and the landing below discards the grant.
							//
							// This has to match the single path or the mismatch is worse than
							// either gap alone: with only the single path tracked, a client
							// sending BOTH frames for one topic made platform.unsubscribe
							// answer `true` - "I cancelled the in-flight grant" - while this
							// path went on to ack the topic and install the membership.
							const batchUd = ws.getUserData();
							const batchTokens = valid.map((t) => beginPendingSubscribe(batchUd, t, batchUd[WS_SUBSCRIPTIONS].has(t)));
							// A topic the grant gate already denied must not reach the hook,
							// exactly as on the single path. Running the hook first and
							// reading the decision only at the landing lets a plugin hook's
							// side effects (roster join, observer tap) land for a topic the
							// caller is then told FORBIDDEN about.
							const hookTopics = authzDeniedT === null
								// Keep the hook's mutable input separate from the landing
								// queue whose topics/tokens still have to settle.
								? valid.slice()
								: valid.filter((_t, i) => !authzDeniedT[i]);
							const batchDenials = hookTopics.length > 0
								? await runSubscribeBatchHookT(ws, hookTopics)
								: null;
							const perTopicDenials = batchDenials === null && handler.subscribe
								? await Promise.all(valid.map((t, i) =>
									(authzDeniedT !== null && authzDeniedT[i]) ? null : runSubscribeHookT(ws, t)))
								: null;
							const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
							assert(udSubs instanceof Set, 'subs.shape-batch', null);
							// Resume-on-subscribe (mirror, batch): gap-fill every recover-tagged topic
							// that passed the auth gate in one resume-hook call, before the subscribe loop.
							let _recoverSeqs = null;
							let _recoverEpochs = null;
							let _batchCap = null;
							let _batchCovered;
							if (msg.recover && typeof msg.recover === 'object') {
								for (let i = 0; i < valid.length; i++) {
									const _t = valid[i];
									// Between the hook awaits and the landing, so neither the
									// landing re-check nor its tombstone covers it - and it
									// serves a topic's replay history. Re-read the CURRENT
									// grant set and the revocation tombstone rather than the
									// pre-await snapshot.
									// MEMBERSHIP FIRST, matching production: the epoch only ever
									// rises, so consulting it unconditionally refuses a topic
									// that was revoked and then legitimately RE-GRANTED inside
									// one await window. Reading it only when the socket does
									// not hold the topic makes the re-grant visible, because a
									// re-grant is what puts the topic back in the registry.
									const _batchSubsT = ws.getUserData()[WS_SUBSCRIPTIONS];
									const _heldT = _batchSubsT instanceof Set && _batchSubsT.has(_t);
									// Pre-hook decision first (a pre-denied topic is filtered out of the
									// hook pass, so nothing downstream would catch it), and both halves
									// of wireAuthz read exactly as the landing reads them.
									const _denial = (authzDeniedT !== null && authzDeniedT[i] ? 'FORBIDDEN' : null)
										?? (recoverIsRevoked({ held: _heldT, wireAuthz: SUBSCRIBE_AUTHZ_T && (SUBSCRIBE_AUTHZ_STRICT_T || !_hasUserHookT), cancelled: isPendingSubscribeCancelled(batchUd, _t, batchTokens[i]), topic: _t }) ? 'FORBIDDEN' : null)
										?? (batchDenials !== null ? (batchDenials[_t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
									if (_denial !== null) continue;
									const _rec = msg.recover[_t];
									if (wantsRecover({ hasResumeHook: handler.resume, recover: _rec })) {
										if (_recoverSeqs === null) _recoverSeqs = {};
										_recoverSeqs[_t] = _rec.offset;
										if (Number.isInteger(_rec.epoch)) { if (_recoverEpochs === null) _recoverEpochs = {}; _recoverEpochs[_t] = _rec.epoch; }
									}
								}
								if (_recoverSeqs !== null && handler.resume) {
								_batchCap = beginResumeCaptureT(Object.keys(_recoverSeqs), ws);
									try {
										_batchCovered = await handler.resume(ws, { sessionId: ws.getUserData()[WS_SESSION_ID], lastSeenSeqs: _recoverSeqs, lastSeenEpochs: _recoverEpochs || undefined, platform: ws.getUserData()[WS_PLATFORM] });
									} catch (err) { console.error('[ws] recover-on-subscribe hook threw:', err); }
								}
							}
							for (let i = 0; i < valid.length; i++) {
								const topic = valid[i];
								// Re-evaluated HERE against the current grant set, not from the
								// reading taken before the awaits: the tombstone below fires only
								// for revocation paths that bump the epoch, so a revocation that
								// merely drops the membership would otherwise let a pre-await
								// decision install a grant the server no longer authorizes.
								// Mirrors the production landing in runtime/handler.js.
								// Read once and handed to both decisions below; nothing between
								// here and the subscribe mutates the set for this topic.
								const held = udSubs.has(topic);
								const denial = (deniesWireSubscribeLanding({ armed: SUBSCRIBE_AUTHZ_T, hasUserHook: _hasUserHookT && !SUBSCRIBE_AUTHZ_STRICT_T, held, topic }) ? 'FORBIDDEN' : null)
									?? (batchDenials !== null
										? (batchDenials[topic] ?? null)
										: (perTopicDenials !== null ? perTopicDenials[i] : null));
								if (denial !== null) {
									// The hook denied, but it may have installed tracked membership
									// (a plugin join) before deciding, and a revocation may have tombstoned
									// this attempt mid-await. Settling blindly here left that membership
									// standing: the held branch below defers to a sibling attempt still in
									// flight, so when that sibling's hook denies too, every attempt leaves
									// through this exit and nothing remains to judge the membership.
									if (settleDeniedSubscribe(batchUd, topic, batchTokens[i], held) === 'deny-unwind') {
										unwindRevokedMembership(ws, topic);
										handler.unsubscribe?.(ws, topic, { platform: batchUd[WS_PLATFORM] });
									}
									sendDeniedT(ws, topic, ref, denial);
									continue;
								}
								if (held) {
									// Same provenance read as the single lane: a revoked
									// attempt whose own hook installed the membership must
									// not ack it.
									const heldVerdict = settleHeldSubscribe(batchUd, topic, batchTokens[i]);
									if (heldVerdict === 'ack') {
										sendSubscribedT(ws, topic, ref);
										continue;
									}
									if (heldVerdict === 'deny-unwind') {
										unwindRevokedMembership(ws, topic);
										handler.unsubscribe?.(ws, topic, { platform: batchUd[WS_PLATFORM] });
									}
									sendDeniedT(ws, topic, ref, 'FORBIDDEN');
									continue;
								}
								if (exceedsSubscriptionCap({ held, size: udSubs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
									settlePendingSubscribe(batchUd, topic, batchTokens[i]);
									sendDeniedT(ws, topic, ref, 'RATE_LIMITED');
									continue;
								}
								// Revocation tombstone: a platform.unsubscribe that landed during
								// the hook or resume awaits cancelled this topic - discard the
								// grant and answer the client truthfully rather than acking it.
								if (!settlePendingSubscribe(batchUd, topic, batchTokens[i], true)) {
									sendDeniedT(ws, topic, ref, 'FORBIDDEN');
									continue;
								}
								try { ws.subscribe(topic); }
								catch { closedWsAbortsT++; continue; }
								udSubs.add(topic);
								if (_batchCap) {
									// Batch: honor only a per-topic map watermark; a bare number is ambiguous
									// across topics (it would apply one floor to all and could wrongly skip a
									// lagging topic), so ignore it here - the pre-window floor covers that topic.
									const _cov = (_batchCovered !== null && typeof _batchCovered === 'object') ? coveredSeqForT(_batchCovered, topic) : undefined;
									flushResumeTopicT(_batchCap, topic, _cov);
								}
								if (sharedTopicsT.has(topic)) joinCohortT(ws, ws.getUserData(), topic, sharedTopicsT.get(topic));
								sendSubscribedT(ws, topic, ref);
							}
							if (_batchCap) discardResumeCaptureT(_batchCap);
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
							// Mirror production's grant filter. `resume` is
							// client-named and yields a topic's replay history -
							// the largest thing any client-named lane serves - so
							// under the pure-grant model topics the connection was
							// never granted are dropped before the hook sees them.
							// This is a published test double, and a double that
							// hands the app's replay backend topics production
							// refuses passes exactly the case it exists to catch.
							let resumeSeqsT = msg.lastSeenSeqs;
							if (SUBSCRIBE_AUTHZ_T && (SUBSCRIBE_AUTHZ_STRICT_T || !hasUserSubscribeHookT()) && resumeSeqsT && typeof resumeSeqsT === 'object') {
								const grantsT = ws.getUserData()[WS_SUBSCRIPTIONS];
								/** @type {Record<string, unknown>} */
								const allowedT = Object.create(null);
								let droppedT = 0;
								for (const t of Object.keys(resumeSeqsT)) {
									if (deniesUngrantedObserve(true, false, grantsT, t)) { droppedT++; continue; }
									allowedT[t] = resumeSeqsT[t];
								}
								if (droppedT > 0) resumeSeqsT = allowedT;
							}
							if (handler.resume) {
								try {
									// Mirror production: await the user hook so
									// per-topic replay completes before the
									// `resumed` ack tells the client to switch
									// to live mode.
									await handler.resume(ws, {
										sessionId: msg.sessionId,
										lastSeenSeqs: resumeSeqsT,
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
							await runAdmittedMessageWork(messageAdmission, ws, { msg, platform }, runGameApplicationWorkT, rejectApplicationMessageT);
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
			await runAdmittedMessageHook(messageAdmission, handler.message, ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] }, rejectApplicationMessageT);
		},

		close(ws, code, message) {
			const ud = ws.getUserData() || {};
			messageAdmission.close(ws);
			const subs = ud[WS_SUBSCRIPTIONS] || new Set();
			const pending = ud[WS_PENDING_REQUESTS];
			if (pending && pending.size > 0) {
				for (const entry of pending.values()) {
					clearTimer(entry.timer);
					try { entry.reject(new Error(adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_CLOSED))); } catch {}
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
				if (ud[WS_CONNECTION_PERMIT]) {
					ud[WS_CONNECTION_PERMIT] = undefined;
					admission.releaseConnection();
					gConnectionHeadroomT?.set(admission.connectionHeadroom);
				}
				capCountsT.adjust(ud[WS_CAPS], null);
				detachWireStatesT(ws, ud);
				const sc = ud[WS_SHARED_COHORTS];
				if (sc) { for (const t of sc) sharedWireIds.release(t); }
				if (ud[WS_LEASE]) ud[WS_LEASE] = undefined;
				wsConnections.delete(ws);
			}
		}
	});

	// app.ws handles real handshakes; uWS yields a keyless GET past it, so
	// browser NAVIGATION lands here. Mirrors the production handler: register
	// for every enabled ceiling (including perTickBudget), serving the
	// holding page when the waiting room is on and the accessible 503 when it
	// is opted out.
	if (admission.maxConcurrent > 0 || admission.maxConnections > 0 || ADMISSION_PER_TICK_BUDGET > 0) {
		app.get(wsPath, (res, req) => {
			res.onAborted(() => {});
			const atCapacity = postureLevelT() === 'siege' || !admission.hasCapacity();
			if (!atCapacity) {
				res.cork(() => {
					res.writeStatus('426 Upgrade Required');
					res.writeHeader('content-type', 'text/plain');
					res.end('WebSocket upgrade required');
				});
				return;
			}
			if (negotiateRejection(req.getHeader('accept'), req.getHeader('upgrade')) === 'html') {
				if (WAITING_ROOM !== null) {
					sendWaitingRoomPage(res, WAITING_ROOM.renderResponse(
						undefined,
						createWaitingRoomRequest(req)
					));
					return;
				}
				sendWaitingRoomPage(res, {
					body: buildAccessibleCapacityRefusalPage(),
					lang: 'en',
					dir: 'ltr',
					headers: [],
					varyAcceptLanguage: false
				}, '503 Service Unavailable');
				return;
			}
			res.cork(() => {
				res.writeStatus('503 Service Unavailable');
				res.writeHeader('content-type', 'text/plain');
				res.end('Server is at upgrade capacity, please retry');
			});
		});
	}

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

		app.get(WAITING_ROOM.path, (res, req) => {
			res.onAborted(() => {});
			const page = WAITING_ROOM.renderResponse(
				currentQueueDepth(),
				createWaitingRoomRequest(req)
			);
			sendWaitingRoomPage(res, page);
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
			// Repeated header lines are merged per header class, mirroring the
			// production admin route. An ambiguous framing / identity header is
			// refused below, as soon as the error writer exists.
			/** @type {Record<string, string>} */
			const adminHeaders = {};
			const ambiguousAdminHeader = collectRequestHeaders(req, adminHeaders);
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

			if (ambiguousAdminHeader !== null) {
				failAdmin(400);
				return;
			}

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
	// instance mid-shutdown), so it does NOT consult the lifecycle state.
	if (healthCheckPath !== false) {
		app.get(healthCheckPath, (res) => {
			res.onAborted(() => {});
			res.cork(() => { res.writeStatus('200 OK').end('OK'); });
		});
	}

	// Readiness route, mirroring handler.js: 200 'ready' in the one ready state,
	// 503 in every other one with the state's name as the body - `starting`
	// during boot, `draining` from the start of close(), `closed` afterwards.
	if (readinessCheckPath !== false) {
		app.get(readinessCheckPath, (res) => {
			res.onAborted(() => {});
			if (lifecycleT !== 'ready') {
				const state = lifecycleT;
				res.cork(() => { res.writeStatus('503 Service Unavailable').end(state); });
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

			// Readiness commits HERE, not at the bind, exactly as production does:
			// the socket is open while `init` runs so arriving connections queue
			// rather than being refused, and /readyz answers 503 `starting` for that
			// whole window. An app whose init hook probes its own readiness sees the
			// same answer it would get from a real instance.
			lifecycleT = 'ready';

			resolve({
				url: `http://localhost:${boundPort}`,
				wsUrl: `ws://localhost:${boundPort}${wsPath}`,
				port: boundPort,
				platform,
				wsConnections,
				async close() {
					// Enter the draining state at the start of graceful shutdown,
					// mirroring production's `beginDrain()` - the readiness route now
					// reports 503 `draining` while we drain.
					lifecycleT = 'draining';
					// Fire `shutdown` hook before kicking connections so the
					// hook sees a healthy platform. Throws are logged-and-
					// ignored (best-effort, mirrors production).
					//
					// THE HOOK GETS PRODUCTION'S CONTEXT AND PRODUCTION'S BUDGET.
					// Handing it `{ platform }` alone and awaiting it forever made
					// this server disagree with the deployment it stands in for on
					// both halves of the contract an app writes its hook against: the
					// hook could not read `reason` / `signal` / `deadline`, so a flush
					// that gives up cleanly when the budget is spent had no way to be
					// exercised, and a hook that never settles passed here while
					// production cut it off at SHUTDOWN_TIMEOUT and logged that its
					// work did NOT finish. Same env knob, same default, same 0-means-
					// unbounded spelling, read at close() so a test can set it per
					// case. The one difference from production: ENV_PREFIX is not
					// applied here, the harness reads the bare name.
					const budgetMs = shutdownBudgetMs();
					const expiry = new AbortController();
					const budgetTimer = budgetMs > 0 ? setTimer(() => expiry.abort(), budgetMs) : null;
					// Null with no budget, which is how a hook reads "nothing will cut
					// me off" rather than having to guess from a far-future number.
					const signal = budgetMs > 0 ? expiry.signal : null;
					const deadline = budgetMs > 0 ? wallEpoch() + budgetMs : null;
					if (typeof handler.shutdown === 'function') {
						const started = monotonicNow();
						try {
							// The rejection handler is attached BEFORE the race: once
							// the race is lost nothing awaits the hook any more, and a
							// late rejection would surface as an unhandled rejection in
							// the middle of teardown.
							const hook = Promise.resolve(
								handler.shutdown({ platform, reason: 'shutdown', signal, deadline })
							).then(() => true, (err) => { console.error('[ws] shutdown hook threw:', err); return true; });
							// The hook keeps running after the budget expires - user
							// code cannot be interrupted - but it no longer holds the
							// close path.
							const settled = await Promise.race([hook, whenAbortedT(signal).then(() => false)]);
							if (!settled) {
								console.error(
									`[ws] shutdown hook has not settled after ${(monotonicNow() - started).toFixed(0)}ms and the shutdown budget is spent; ` +
									'closing anyway - whatever the hook was flushing did NOT finish.'
								);
							}
						} catch (err) {
							// A hook that threw synchronously, before it ever returned a
							// promise. Log-and-continue: shutdown is best-effort.
							console.error('[ws] shutdown hook threw:', err);
						} finally {
							if (budgetTimer !== null) clearTimer(budgetTimer);
						}
					} else if (budgetTimer !== null) {
						clearTimer(budgetTimer);
					}
					// Advise clients to reconnect on a jittered schedule before closing
					// (opt-in via createTestServer({ reconnectDispersalMs }); 0 = no-op),
					// mirroring production shutdown() so the dispersal path is testable.
					if (options.reconnectDispersalMs > 0) {
						platform.adviseReconnect({ windowMs: options.reconnectDispersalMs, close: false });
					}
					// Terminate and JOIN every tracked client socket first: a
					// client dial or close handshake still in flight when the
					// next test binds is exactly the cross-test contention that
					// makes parallel suites flaky. Joining is bounded - a socket
					// that never reports terminal cannot wedge teardown.
					await Promise.allSettled([...trackedClients].map((sock) => new Promise((resolve) => {
						if (sock.readyState === 3 /* CLOSED */) return resolve(undefined);
						let guard = null;
						const done = () => {
							if (guard !== null) { clearTimer(guard); guard = null; }
							resolve(undefined);
						};
						guard = setTimer(done, 1000);
						try {
							sock.once('close', done);
							sock.once('error', done);
						} catch { return done(); }
						try {
							if (typeof sock.terminate === 'function') sock.terminate();
							else sock.close();
						} catch { done(); }
					})));
					trackedClients.clear();
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
					// Join the close callbacks those kicks fire, so a resolved
					// close() means the sockets are gone, not merely told to go.
					// Bounded: injected fake sockets without a close handler
					// never empty the set and must not hang teardown.
					const kickDeadline = monotonicNow() + 1000;
					while (wsConnections.size > 0 && monotonicNow() < kickDeadline) {
						await new Promise((r) => setTimer(r, 5));
					}
					wsConnections.clear();
					uWS.us_listen_socket_close(listenSocket);
					// Accepting stops HERE, not when readiness flipped: the window
					// between the two is what the drain delay exists for, and
					// production moves the same state at the same point.
					lifecycleT = 'closed';
				},
				/**
				 * Register a client socket (any `ws`-shaped object) this server
				 * owns for teardown: close() will terminate it and await its
				 * terminal event before releasing the port. Returns the socket
				 * for inline use: `const ws = server.track(new WebSocket(url))`.
				 */
				track(sock) {
					trackedClients.add(sock);
					return sock;
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
