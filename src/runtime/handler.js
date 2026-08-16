import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import uWS from 'uWebSockets.js';
import { manifest, prerendered, base } from 'MANIFEST';
import { env } from 'ENV';
// IMPORTANT: ./_init.js MUST be imported before WS_HANDLER. It runs
// `await server.init({ env: process.env })` at module top level, which
// populates SvelteKit's `$env/dynamic/private` and `$env/dynamic/public`
// runtime proxies. ESM evaluates imports depth-first in source order, so
// _init.js's body (including the await) completes before the next import
// (WS_HANDLER) is processed - giving the user's hooks.ws / src/lib/server
// modules populated env values when their top-level code reads
// `env.DATABASE_URL` etc. Reordering these two imports re-introduces a
// real bug where `$env/dynamic/private` returns empty in the ws-handler
// import graph; do not move them.
import { server } from './_init.js';
import * as wsModule from 'WS_HANDLER';
import { metricsRegistry } from './metrics-bridge.js';
import { waitingRoomRenderer } from './waiting-room-renderer-bridge.js';
import { PRESSURE_REASON_CODES } from './observability-manifest.js';
import { ADAPTER_ERROR_IDS, REQUEST_CLOSED_DETAIL, adapterConsoleLine, adapterErrorMessage } from './error-registry.js';
import { emitOperationalEvent, formatDiagnostic, diagnosticError } from './diagnostic.js';
import { privateValueMetadata } from './utils/observability-privacy.js';
import { probeOsPressureSources, emitPressureMetricTelemetry } from './utils/os-pressure.js';
import { parseCookies, createCookies } from './cookies.js';
import { mimeLookup, parse_as_bytes, parse_origin, writeChunkWithBackpressure, drainCoalesced, computePressureReason, computeTopPublishers, nextTopicSeq, createHlc, processEpoch, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, isOriginAllowed, isAuthOriginAccepted, describeUnsafeSameOriginConfig, addressScope, createUpgradeAdmission, negotiateRejection, buildAccessibleCapacityRefusalPage, isCursorLaneUpgrade, resolveWaitingRoom, createWaitingRoomRequest, sendWaitingRoomPage, createPollCounter, containMetricInstrument, mirrorRegistry, readFdLimits, countOpenFds, applyCapacityReason, createPosture, resolveRequestId, assert, fatal, readAssertionCounts, wireAssertionMetrics, beginPendingSubscribe, settlePendingSubscribe, settleHeldSubscribe, settleDeniedSubscribe, unwindRevokedMembership, tombstonePendingSubscribe, isPendingSubscribeCancelled, releaseDerivedSubscriptions, pendingSubscribeTotal, setSubscriptionAccountingHook, addLogicalSubscription, removeLogicalSubscription, accountClosedLogicalSubscriptions, WS_SUBSCRIPTIONS, WS_PUBLISH_GRANT, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CONNECTION_PERMIT, WS_CAPS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_LEASE, WS_SHARED_COHORTS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_SUBSCRIBES_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION, MAX_COALESCED_KEYS_PER_CONNECTION, TOPIC_SEQS_WARN_THRESHOLD, PUBLISH_WARN_DEDUP_MAX } from './utils.js';
import { buildBinaryFrame, allocWireId, wireIdAnnounce, createCapCounts, createLeaseState, leasePressureValue, leaseGrantSize, samplePressureValue, leaseGrantFrame, controlFrameTooLargeFrame, DEFAULT_GRANT } from './wire.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './handler/ingress.js';
import { registerGameIngress, gameLaneClusterSafe } from './handler/game-ingress.js';
import { seqBound } from './handler/seq-bound.js';
import { now, monotonicNow, processMonotonicNow, randomUuid, randomFloat, randomU32, randomBytes, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from './runtime.js';
import { statePool, envelopePrefixCache, staticCache, prerenderedDirStyle, wsConnections, topicPublishStats, pressureSnapshot, pressureListeners, publishRateListeners, lastPublishWarnAt, capCounts, decodeCache, counters, maxSeenSeq, divergenceDiagnostics, sharedTopics, subscribeAuth, originStreams, streamTracking, takeConfirmedGaps, GAP_CONFIRM_MS } from './handler/state.js';
import { computeStateHash, partitionActiveTopics } from './invariants.js';
import { DIVERGENCE_TOPIC_LIMIT, summarizeTopicSequences } from './divergence-diagnostics.js';
import { createConsistencyAuditor } from './auditor.js';
import { buildConnectionAuditSnapshot } from './audit-snapshot.js';
import { structuralResourceProbes, createResourceGrowthAuditor } from './leak-probes.js';
import { PayloadTooLargeError, METHODS, send400, send413, send500 } from './handler/http-helpers.js';
import { acquireState, releaseState } from './handler/state-pool.js';
import { ENVELOPE_CACHE_MAX, envelopePrefix } from './handler/envelope-cache.js';
import { batchRelay } from './handler/relay.js';
import { readHlc } from './handler/hlc.js';
import { textDecoder, ssl_cert, ssl_key, is_tls, origin, xff_depth, address_header, protocol_header, host_header, port_header, body_size_limit, resolveClientIp, resolveTransportAddress, _t_app, app, wsDebug, closeHookRegistered, get_origin, WS_COMPRESSION_ON } from './handler/config.js';
import { cacheDir, clientDir, prerenderedDir, _t_static, serveStatic, DECODE_CACHE_MAX, tryPrerendered } from './handler/static-assets.js';
import { bumpIn, bumpOut, maybeWarnTopicRegistry, BATCH_FRAME_WARN_BYTES, warnLargeBatchFrame, grantSizeFor, resolvePressureThresholds, startPressureSampling, stopPressureSampling } from './handler/pressure-metrics.js';
import { hasRef, runSubscribeHook, runSubscribeBatchHook, runUserSubscribeGate, hasUserSubscribeHook, sendSubscribed, sendSubscribeDenied, flushCoalescedFor } from './handler/subscribe-hooks.js';
import { ensureWireId, ensureWireState, wireStatePoisoned, poisonWireState, detachWireStates } from './handler/wire-state.js';
import { joinSharedCohort, leaveSharedCohort } from './handler/cohort.js';
import { beginResumeCapture, discardResumeCapture, flushResumeTopic, coveredSeqFor } from './handler/resume-buffer.js';
import { releaseSharedWireId } from './handler/shared-wire-id.js';
import { setCohortHooks } from './utils.js';
import { deniesWireSystemTopicSubscribe, deniesWireSubscribePreHook, deniesWireSubscribeLanding, wantsRecover, recoverIsRevoked, exceedsSubscriptionCap, exceedsPendingSubscribeCap, deniesUngrantedObserve } from './utils/subscribe-policy.js';
import { startPostureExport } from './utils/posture-export.js';
import { snapshotUpgradeHeaders, warnSetCookieOnUpgradeOnce } from './utils/upgrade-headers.js';
import { collectRequestHeaders, declareSingleValuedProxyHeaders } from './utils/request-headers.js';
import { createSlidingWindowLimiter } from './utils/rate-limiter.js';
import { createMessageAdmission, messageOverloadedFrame, runAdmittedMessageHook, runAdmittedMessageWork } from './utils/message-admission.js';
import { createConnectionPermitCarrier } from './utils/connection-permit.js';
import { installAttribution } from './utils/attribution.js';
import { recordBackpressureDrop } from './utils/backpressure.js';
import {
	createTransportMetricHooks,
	HTTP_DURATION_BUCKETS,
	UPGRADE_DURATION_BUCKETS,
	WS_MESSAGE_DURATION_BUCKETS,
	WS_CONNECTION_DURATION_BUCKETS
} from './transport-metrics.js';
import { activeTraceContext, extractTraceContext, traceOperation, tracingEnabled } from './tracing.js';

const WS_TRACE_CONTEXT_KEY = '__uwsTraceContext';

/**
 * A stand-in for a uWS request, built from values read while it was still
 * valid. `createWaitingRoomRequest` is duck-typed over exactly these four
 * methods, so a refusal that runs after the tick has ended can still describe
 * the request without the waiting-room module needing to know that happened -
 * and without this fix reaching into that module, which sits inside the sealed
 * ingress/platform/wire-fanout graph.
 *
 * The method is handed over exactly as uWS reported it (lowercase); the builder
 * uppercases it, so the detached answer is identical to the live one rather
 * than a second normalisation that could drift from it.
 *
 * @param {{ method: string, url: string, query: string, headers: Record<string, string> }} snapshot
 */
function detachedRequestFacade(snapshot) {
	return {
		getMethod: () => snapshot.method,
		getUrl: () => snapshot.url,
		getQuery: () => snapshot.query,
		forEach: (visit) => {
			for (const name of Object.keys(snapshot.headers)) visit(name, snapshot.headers[name]);
		}
	};
}

function traceUpgradeRejection(req, headers, reason) {
	if (!tracingEnabled) return;
	// `req` is optional: a caller that has already left the uWS tick passes null
	// rather than a handle whose every read throws. A null `headers` short-
	// circuits before this, and the fallback below is only reached when headers
	// is undefined - so the optional calls are what stop that combination
	// becoming a TypeError instead of a missing trace parent.
	const parent = headers === null
		? null
		: extractTraceContext(headers ?? {
			traceparent: req?.getHeader('traceparent'),
			tracestate: req?.getHeader('tracestate')
		});
	traceOperation('adapter.websocket.admission', {
		kind: 'server',
		parent,
		attributes: {
			'network.protocol.name': 'websocket',
			'admission.outcome': 'rejected',
			'admission.reason': reason
		}
	}, () => undefined);
}

// Make the low-level membership primitive (trackedSubscribe / trackedUnsubscribe,
// used by plugins to establish server-side membership) cohort-aware: a tracked
// subscribe to an already-shared topic joins its cohort + announces the server-wide
// id; a tracked unsubscribe leaves the cohort + releases the wire-id ref. Without
// this, a plugin that server-side-subscribes a socket to a shared topic AFTER it was
// promoted would be in no cohort and miss every cohort-split publish.
setCohortHooks(
	(ws, ud, topic) => { if (sharedTopics.has(topic)) joinSharedCohort(ws, ud, topic, sharedTopics.get(topic)); },
	(ws, ud, topic) => { if (sharedTopics.has(topic)) leaveSharedCohort(ws, ud, topic); }
);

// Every logical membership mutation (wire, platform, or tracked plugin lane)
// routes through add/removeLogicalSubscription. Keep the counter non-negative
// even if a pre-existing mismatch is encountered; the assertion makes that
// corruption visible while the clamp prevents it from poisoning pressure and
// every subsequent close.
function adjustTotalSubscriptions(delta) {
	const next = counters.totalSubscriptions + delta;
	if (next < 0) {
		assert(false, 'subs.total-negative', { totalSubscriptions: next });
		counters.totalSubscriptions = 0;
		return;
	}
	counters.totalSubscriptions = next;
}
setSubscriptionAccountingHook(adjustTotalSubscriptions);
import { platform } from './handler/platform.js';
import { readBody, handleSSR } from './handler/ssr.js';
import { requestDone, isDraining, lifecycleState } from './handler/lifecycle.js';
// The lifecycle module's whole public surface, re-exported here because
// handler.js is the module the built runtime imports: a caller reaching into
// handler/lifecycle.js directly depends on the file split rather than on the
// contract. `beginDrain`, `lifecycleState` and `tlsReloadState` were reachable
// only that way - the boot driver dynamic-imports the submodule for the first
// (src/runtime/index.js), which is the shape this list exists to end.
export { drain, start, shutdown, getDescriptor, relayPublish, relayPublishBatched, forceCloseApp, reloadTls, beginDrain, lifecycleState, tlsReloadState } from './handler/lifecycle.js';
export { setRelayRingWriter, setRelayFrameCeiling } from './handler/relay.js';
export { collectLocalMetrics, resolveMetricsSnapshot } from './handler/metrics-snapshot.js';
export { markRelayAttached } from './handler/state.js';

// The relay frame-ceiling refusal fires in the boot driver's injected sink
// (runtime/index.js wires setRelayFrameCeiling), which has no reach into the
// registry built below - so the counter is bound here when instruments
// register and the driver increments through this one function. Before the
// registry exists (or without a `metrics` option) it is a no-op, matching
// every other instrument in this file.
let relayFrameRefusedInc = null;
/** @param {'publish' | 'batched'} lane */
export function noteRelayFrameRefused(lane) {
	relayFrameRefusedInc?.(lane);
}
import { handleRequest } from './handler/request.js';
import { handleAdminRequest } from './handler/admin.js';
import { registerRoute } from './handler/route-registry.js';

// EVERY route registration on `app` goes through this helper, never through
// `app.get(...)` directly: it records the registration so the TLS hot-reload
// can replay the full route set onto each SNI domain router it creates
// (route-registry.js) - a uWS server name carries its own empty router that
// force-closes anything it cannot route, so an unrecorded route would vanish
// for every SNI-matched connection after the first cert renewal.
let transportMetricHooks = null;
const route = (method, ...args) => {
	if (transportMetricHooks !== null) {
		const last = args.length - 1;
		if (method === 'ws' && args[last] !== null && typeof args[last] === 'object') {
			args[last] = transportMetricHooks.instrumentWebSocket(args[last]);
		} else if (typeof args[last] === 'function') {
			args[last] = transportMetricHooks.instrumentHttp(args[last], method);
		}
	}
	registerRoute(app, method, ...args);
};

// Tell the shared header collector which names THIS deployment reads as a
// single value, before anything listens. Repeated lines of a header the
// collector does not know about are comma-joined, which is right for a chain
// and wrong for these: `get_origin` throws on a joined protocol or builds an
// unparseable URL from a joined host, and the client-IP resolver takes a joined
// address header's LEADING bytes, which are the client's rather than the
// proxy's. The names are operator-chosen, so only this layer knows them.
// Declared here rather than at each collection site because handler/request.js
// and handler/admin.js share this module's process state, so one declaration
// covers every entry point including the ones added later.
declareSingleValuedProxyHeaders([protocol_header, host_header, port_header, address_header]);

/* global ENV_PREFIX */
/* global PRECOMPRESS */
/* global WS_ENABLED */
/* global WS_PATH */
/* global WS_OPTIONS */
/* global WS_AUTH_PATH */
/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
/* global STATIC_HEADERS */
/* global STATIC_CACHE_CONTROL */


// - Error response helpers ---------------------------------------------------


// - State object pool --------------------------------------------------------
// Avoids allocating { aborted: false } per SSR request. Objects survive to
// V8's old generation quickly and stay there, eliminating young-gen GC churn.


// Capacity caps (`MAX_SUBSCRIPTIONS_PER_CONNECTION`,
// `MAX_PENDING_REQUESTS_PER_CONNECTION`, `MAX_COALESCED_KEYS_PER_CONNECTION`,
// `TOPIC_SEQS_WARN_THRESHOLD`, `PUBLISH_WARN_DEDUP_MAX`) live in utils.js
// so handler.js, vite.js, and testing.js all enforce identical limits.


// - In-memory static file cache ---------------------------------------------

/**
 * @typedef {{
 *   buffer: Buffer,
 *   contentType: string,
 *   etag: string,
 *   headers: [string, string][],
 *   brBuffer?: Buffer,
 *   gzBuffer?: Buffer
 * }} StaticEntry
 */


// The HTTP Date header string is rebuilt once per second from the runtime
// clock so the static handler never formats a fresh timestamp per response.
// The wall-clock value itself comes from the injectable runtime module's
// now(), which is already the ~1s-cached read - the rate limiter and per-
// upgrade checks read it directly, so this timer only refreshes the header
// string. Unref'd so it never holds the loop open.
setIntervalTimer(() => {
	counters.cachedDateHeader = new Date(now()).toUTCString(); // determinism-allow: formats the runtime clock value, not a clock read
}, 1000).unref();


cacheDir(path.join(clientDir, base), base, true, STATIC_HEADERS, STATIC_CACHE_CONTROL);
cacheDir(path.join(prerenderedDir, base), base, false, STATIC_HEADERS, STATIC_CACHE_CONTROL);
console.log(`[svelte-adapter-uws] Static files indexed in ${(monotonicNow() - _t_static).toFixed(1)}ms (${staticCache.size} entries)`);

// - TLS config (must be before origin warning) ------------------------------


if ((ssl_cert || ssl_key) && !is_tls) {
	throw new Error(
		'Incomplete TLS config: both SSL_CERT and SSL_KEY must be set.\n' +
		`  SSL_CERT: ${ssl_cert ? 'set' : 'missing'}\n` +
		`  SSL_KEY: ${ssl_key ? 'set' : 'missing'}`
	);
}

// - SvelteKit Server --------------------------------------------------------


if (isNaN(xff_depth) || xff_depth < 1) {
	throw new Error(
		`Invalid XFF_DEPTH: '${env('XFF_DEPTH', '1')}'. Must be a positive integer.`
	);
}

if (isNaN(body_size_limit)) {
	throw new Error(
		`Invalid BODY_SIZE_LIMIT: '${env('BODY_SIZE_LIMIT')}'. Please provide a numeric value.`
	);
}

if (!origin && !host_header && !protocol_header && !is_tls) {
	console.warn(
		'[svelte-adapter-uws] Warning: No ORIGIN, HOST_HEADER, or PROTOCOL_HEADER configured. ' +
		'The server will use http:// with the request Host header. ' +
		'For production, either:\n' +
		'  SSL_CERT + SSL_KEY for native TLS (no proxy needed)\n' +
		'  ORIGIN=https://example.com (behind a TLS proxy)\n' +
		'  PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy)\n' +
		'  See: https://svti.me/adapter-origin'
	);
}


// Server instance + init have moved to ./_init.js so they run BEFORE the
// WS_HANDLER import is evaluated. See the comment above the import in the
// header block of this file for the init-order rationale. `server` is
// imported from there.

// - uWS App -----------------------------------------------------------------


// - Cross-worker pub/sub relay (batched) ------------------------------------
// Batch postMessage calls within a single event-loop iteration. A SvelteKit
// action that publishes N events sends one structured-clone across the thread
// boundary instead of N. No-op in single-process mode (parentPort is null).
//
// Why `setTimeout(0)` and not `queueMicrotask`: uWS dispatches each WS message
// as its own JS task, and N-API drains microtasks at the C++/JS boundary
// between tasks. A microtask-deferred flush fires BEFORE the next socket's
// handler runs, so cross-socket coalescing is impossible at the microtask
// level - N publishes from N socket handlers in the same iteration produce N
// postMessage structured-clones instead of one batched. `setTimeout(0)` lands
// in libuv's timers phase, which fires only after the poll phase has
// dispatched every ready socket message in the current iteration. Same
// structural choice the 0.5.6 cursor always-tick rewrite locked in.


// - Platform (exposed to SvelteKit via event.platform) ----------------------


// - Pressure tracking -------------------------------------------------------
// Coarse 1 Hz sampler exposed as `platform.pressure` (snapshot) and
// `platform.onPressure(cb)` (transition callback). State lives at module
// scope so platform.publish() and the subscribe/unsubscribe handlers can
// bump counters with one integer add - no allocations on the hot path.


/**
 * @typedef {{ topic: string, messagesPerSec: number, bytesPerSec: number }} TopicPublishRate
 */

/**
 * @typedef {{
 *   sampledAt: number | null,
 *   active: boolean,
 *   value: number,
 *   subscriberRatio: number,
 *   publishRate: number,
 *   memoryMB: number,
 *   reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CAPACITY',
 *   topPublishers: TopicPublishRate[]
 * }} PressureSnapshot
 */


// - Origin construction -----------------------------------------------------


// - SSR request deduplication -----------------------------------------------
// When multiple concurrent anonymous GET/HEAD requests arrive for the same URL,
// only one is dispatched to SvelteKit. The rest await the result and reconstruct
// their own Response from the shared buffer. This eliminates redundant SSR work
// during traffic spikes on public (non-personalized) pages.

/**
 * @typedef {{ status: number, statusText: string, headers: [string, string][], body: Uint8Array }} SharedResponse
 */


// - Body reading ------------------------------------------------------------


// - Static file serving -----------------------------------------------------


// - Prerendered page check --------------------------------------------------


// - SSR handler -------------------------------------------------------------


// - Response writer (with backpressure) -------------------------------------


// - Main request handler ----------------------------------------------------


// - WebSocket support -------------------------------------------------------

// WS_ENABLED is set by the adapter at build time - no inference from exports needed
if (WS_ENABLED) {
	// Register the client-relay (`game` lane) binary twin so a `wire.ingress:1`
	// client can bind an id to kind `game:1` and publish game frames as `0x03`
	// (the compact counterpart of the JSON `game` demux guard below).
	registerGameIngress();
	// Warn about unrecognized exports - catches typos like "mesage" or "opn"
	const knownWsExports = new Set([
		'init', 'shutdown',
		'open', 'message', 'upgrade', 'close', 'drain',
		'subscribe', 'subscribeBatch', 'unsubscribe',
		'authenticate', 'resume', 'admin', 'attribution'
	]);
	for (const name of Object.keys(wsModule)) {
		if (!knownWsExports.has(name)) {
			console.warn(
				`[svelte-adapter-uws] Warning: WebSocket handler exports unknown "${name}". ` +
				`Did you mean one of: ${[...knownWsExports].join(', ')}?\n` +
				'  See: https://svti.me/ws-hooks'
			);
		}
	}

	const wsOptions = WS_OPTIONS;
	const allowedOrigins = wsOptions.allowedOrigins || 'same-origin';

	// Refuse to start when the same-origin policy has no fronting trust to
	// pin against (no ORIGIN env, no HOST_HEADER env, no native TLS, no
	// upgrade hook). In that configuration the same-origin check compares
	// two attacker-controlled headers (Origin vs Host) and trivially passes
	// for any non-browser scripted client, leaving the WebSocket fully open
	// on a public-internet listener. Apps that have audited this and want
	// the previous warn-only behavior can opt out via
	// `websocket.unsafeSameOriginWithoutHostPin: true`.
	const _unsafeOriginErr = describeUnsafeSameOriginConfig({
		allowedOrigins,
		hasOriginEnv: !!origin,
		hasHostHeader: !!host_header,
		isTls: is_tls,
		hasUpgradeHook: !!wsModule.upgrade,
		optOut: wsOptions.unsafeSameOriginWithoutHostPin === true
	});
	if (_unsafeOriginErr) throw new Error(_unsafeOriginErr);

	// CSRF defense for the authenticate POST endpoint: by default the
	// request must carry one of `x-requested-with: XMLHttpRequest`,
	// `Sec-Fetch-Site: same-origin`, or an `Origin` header that matches the
	// configured `allowedOrigins`. Apps that need to accept this endpoint
	// from native (non-browser) clients without these headers can set
	// `websocket.authPathRequireOrigin: false` in svelte.config.js.
	const AUTH_PATH_REQUIRE_ORIGIN = wsOptions.authPathRequireOrigin !== false;

	// Wire-level subscribes to `__`-prefixed system topics are blocked by
	// default. Framework internals (`__signal:userId`, `__rpc`, plugin
	// channels like `__presence:*` / `__group:*` / `__replay:*`) reach
	// clients via per-connection `platform.send` or via server-initiated
	// `platform.publish` - never via a client `subscribe` frame. Allowing
	// clients to subscribe to these topics let any authenticated user
	// intercept other users' signals, presence rosters, and group
	// broadcasts. A registered plugin namespace may reach its own subscribe
	// hook, but landing still requires tracked membership. Apps that
	// intentionally route public topics through the `__` prefix can opt in
	// broadly via `websocket.allowSystemTopicSubscribe`.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE = wsOptions.allowSystemTopicSubscribe === true;

	// Wire topics default to printable ASCII only - the loop in
	// `isValidWireTopic` rejects characters outside 0x20-0x7E (plus the
	// always-illegal `"` 0x22 and `\\` 0x5C). This closes a class of
	// look-alike attacks (Unicode line separators U+2028/9, RTL override
	// U+202E, BOM U+FEFF) and keeps the wire trivially log-safe. Apps
	// that legitimately use non-ASCII topic names can opt in.
	const ALLOW_NON_ASCII_TOPICS = wsOptions.allowNonAsciiTopics === true;

	// Wire-subscribe authorization. Off by default: standalone, any connected
	// client may subscribe to any (non-`__`, shape-valid) topic - the adapter's
	// documented primitive contract. When on, a CLIENT subscribe / subscribe-batch
	// frame is honored only for a topic the server already authorized for that
	// connection via `platform.subscribe` (recorded in `WS_SUBSCRIPTIONS`), unless
	// the app exports its own `subscribe` / `subscribeBatch` hook (which then
	// decides). This closes the bypass where a client names a topic it was never
	// granted - a private room, another tenant's channel - and receives its
	// fan-out, since server-side authorization (a guard / RPC) ran only on the
	// server-initiated subscribe, not the client's wire frame. A framework whose
	// subscriptions are all server-initiated (svelte-realtime) turns this on via
	// `platform.authorizeWireSubscribe()`; a direct adapter app can set it here.
	if (wsOptions.authorizeWireSubscribe === true || wsOptions.authorizeWireSubscribe === 'strict') {
		subscribeAuth.enabled = true;
		if (wsOptions.authorizeWireSubscribe === 'strict') subscribeAuth.strict = true;
	}

	// Keys that suggest sensitive or personally-identifying data being
	// stored in userData. userData is accessible to every server-side
	// handler via ws.getUserData() and ships out via platform.publish
	// fanout when callers stuff it into a publish payload, so storing
	// raw credentials or PII there is a footgun.
	const SENSITIVE_KEY_PATTERNS = [
		'token', 'secret', 'password', 'key', 'session', 'credential',
		'email', 'phone', 'ssn', 'dob', 'iban', 'creditcard', 'cc', 'pin'
	];
	/** @type {Set<string>} warned key names - suppress duplicate warnings across connections */
	const warnedUserDataKeys = new Set();

	// Per-IP upgrade rate limiter (configurable, 0 = disabled)
	const UPGRADE_MAX_PER_WINDOW = wsOptions.upgradeRateLimit ?? 10;
	const UPGRADE_WINDOW_MS = (wsOptions.upgradeRateLimitWindow ?? 10) * 1000;
	// Maximum number of IP entries to retain in the rate map under sustained DDoS.
	// Enforced at insertion time by EVICTING the least active of a bounded
	// sample, so the map can never outgrow the cap between sweeps and a new
	// client is never refused because other identities filled it; the 60s sweep
	// still purges expired entries.
	const MAX_RATE_ENTRIES = 10000;
	// How many entries each rotating insertion-time eviction sample inspects.
	const RATE_MAP_EVICTION_SAMPLE = 16;
	// Longest key the rate map will store. Capping the ENTRY COUNT alone does
	// not bound memory, because the key is not necessarily an address: with a
	// configured ADDRESS_HEADER and no TRUSTED_PROXIES it is the client's header
	// value verbatim. Ten thousand multi-kilobyte keys is tens of megabytes per
	// worker, not the ~2 MB the entry cap implies. Keep this aligned with the
	// resolver's single-address-header ceiling: accepted identities must not
	// collide merely because the limiter uses a shorter prefix, while XFF's
	// legitimate multi-hop 8 KiB value still needs a bound.
	const MAX_RATE_KEY_LEN = 128;

	// Per-IP rate limit for the auth preflight, the door `connect({ auth: true })`
	// clients POST before upgrading. Without it the app's authenticate() hook -
	// typically a credential check against a database - was reachable at raw
	// server capacity from a single address, while the upgrade door beside it was
	// metered. The Origin gate does not bound rate: a non-browser client sends
	// whatever Origin it likes.
	//
	// The default deliberately EXCEEDS the upgrade limit rather than matching it.
	// Every reconnect that preflights also upgrades, so a deploy's reconnect wave
	// hits this door at least as hard as the upgrade door, and a NAT'd office
	// behind one address multiplies both. Sizing it 1:1 would make the preflight
	// the binding constraint on a legitimate reconnect storm, refusing traffic the
	// upgrade limit would have admitted. `0` disables it, matching
	// `upgradeRateLimit`.
	//
	// Declared here rather than beside the route so the periodic sweep below can
	// reach it; the route itself is registered only when an authenticate hook
	// exists.
	const authRateLimiter = createSlidingWindowLimiter({
		maxPerWindow: wsOptions.authPathRateLimit ?? 30,
		windowMs: (wsOptions.authPathRateLimitWindow ?? 10) * 1000,
		maxEntries: MAX_RATE_ENTRIES,
		evictionSample: RATE_MAP_EVICTION_SAMPLE,
		maxKeyLen: MAX_RATE_KEY_LEN,
		onEvict: () => mUpgradeRateEvicted?.inc({ door: 'auth' })
	});
	// The upgrade door runs the SAME limiter as the preflight door above rather
	// than an inlined copy of it. The two copies were behaviourally identical
	// when written, which is exactly why keeping them was a bad bet: every later
	// correction - the IPv6 /64 key fold most recently - has to be made twice or
	// the doors silently diverge, and the one that gets missed is a hole nobody
	// is looking at.
	const upgradeRateLimiter = createSlidingWindowLimiter({
		maxPerWindow: UPGRADE_MAX_PER_WINDOW,
		windowMs: UPGRADE_WINDOW_MS,
		maxEntries: MAX_RATE_ENTRIES,
		evictionSample: RATE_MAP_EVICTION_SAMPLE,
		maxKeyLen: MAX_RATE_KEY_LEN,
		onEvict: () => mUpgradeRateEvicted?.inc({ door: 'upgrade' })
	});
	// One-shot guard for the proxy-collapse advisory below. The per-IP upgrade
	// limit silently degrades to a single GLOBAL cap when the server sits behind
	// an address-rewriting proxy (docker userland-proxy, an L4 load balancer, a
	// non-XFF proxy) and ADDRESS_HEADER is unset: every client then shares one
	// gateway address, so the rate map has one key for the whole site.
	let warnedRateLimitProxyCollapse = false;

	// Upgrade admission control opts in through WebSocketOptions. Concurrency,
	// connection, cursor-lane, and per-tick pacing limits are independent; the
	// pacing queue is bounded by maxDeferred. State + queue live inside the
	// factory closure.
	const admission = createUpgradeAdmission(wsOptions.upgradeAdmission);
	const connectionPermitCarrier = createConnectionPermitCarrier();
	const ADMISSION_PER_TICK_BUDGET = wsOptions.upgradeAdmission?.perTickBudget ?? 0;
	const messageAdmission = createMessageAdmission(wsOptions.messageAdmission);
	const rejectApplicationMessage = (ws, rejection) => {
		mMessageAdmissionRejected?.inc({ reason: rejection.reason, scope: rejection.scope });
		const frame = messageOverloadedFrame(rejection);
		try { ws.send(frame, false, false); bumpOut(ws, frame); } catch { counters.closedWsAborts++; }
	};
	const runIngressApplicationWork = (ws, context) =>
		dispatchIngressFrame(ws, ws.getUserData(), context.data, context.platform);
	const runGameApplicationWork = (ws, context) => {
		const msg = context.msg;
		const gud = ws.getUserData();
		const grantTopic = gud[WS_PUBLISH_GRANT];
		const clusterSafe = gameLaneClusterSafe(workerData);
		if (!clusterSafe || !grantTopic || typeof msg.event !== 'string') {
			const reason = clusterSafe && grantTopic ? 'INVALID' : 'FORBIDDEN';
			const denied = msg.id === undefined
				? JSON.stringify({ type: 'game-denied', reason })
				: JSON.stringify({ type: 'game-denied', reason, id: msg.id });
			try { ws.send(denied, false, false); bumpOut(ws, denied); } catch { counters.closedWsAborts++; }
			return;
		}
		context.platform.publishGame(ws, grantTopic, msg.event, msg.data, msg.id);
	};

	// Content-negotiated rejection for over-capacity upgrades. Resolved once
	// here (or null when off); when null the gate emits today's bare 503.
	// On by default whenever any ceiling or bounded pacing can reject; the
	// escape is `waitingRoom: false`.
	const WAITING_ROOM = resolveWaitingRoom(wsOptions.upgradeAdmission, waitingRoomRenderer);

	// Admission observability. Opt-in via the `metrics` option - a module path
	// (`websocket.metrics`) whose default export is a registry shaped like the
	// extensions `createMetrics()` (positional counter/gauge factories). The build
	// bundles it; the runtime imports it here (via the bridge) and also exposes it
	// on `platform.metrics` for a scrape route. Instruments resolve once; every
	// emit is optional-chained, so the disabled path (registry null) costs one
	// undefined check per site and the accept path allocates nothing.
	// Registrations go through a mirroring wrapper: every value the runtime
	// writes is recorded under the adapter's own declared name, which is what
	// `platform.metricsSnapshot()` merges across worker threads. Merging the
	// registry's RENDERED text instead was tried and is wrong - a registry that
	// namespaces its output (the documented way to use one) renders names the
	// manifest cannot match, and the cluster merge would silently degrade to
	// per-worker passthrough. `platform.metrics` still exposes the real
	// registry, so an app's own scrape route is unaffected.
	const METRICS = mirrorRegistry(metricsRegistry);
	const mUpgradeAdmitted = containMetricInstrument(METRICS?.counter(
		'upgrade_admitted_total', 'WebSocket upgrades accepted'
	));
	const mUpgradeRejected = containMetricInstrument(METRICS?.counter(
		'upgrade_rejected_total', 'WebSocket upgrades rejected before open', ['reason']
	));
	const mUpgradeDeferredRejected = containMetricInstrument(METRICS?.counter(
		'upgrade_deferred_rejected_total',
		'Upgrade callbacks shed because the bounded deferral queue was full'
	));
	const mUpgradeRateEvicted = containMetricInstrument(METRICS?.counter(
		'upgrade_rate_map_evicted_total', 'Rate-limit entries evicted at the map cap', ['door']
	));
	const mPostureTransitions = containMetricInstrument(METRICS?.counter(
		'protection_posture_transitions_total', 'Protection posture level changes', ['from', 'to']
	));
	const gPostureState = containMetricInstrument(METRICS?.gauge(
		'protection_posture_state', 'Current protection posture (0 normal, 1 elevated, 2 siege)'
	));
	const gUpgradeInflight = containMetricInstrument(METRICS?.gauge(
		'upgrade_inflight', 'Upgrades currently between admission and open'
	));
	const gUpgradeDeferredDepth = containMetricInstrument(METRICS?.gauge(
		'upgrade_deferred_depth', 'Upgrade callbacks waiting in the bounded pacing queue'
	));
	const gUpgradeDeferredOldestAge = containMetricInstrument(METRICS?.gauge(
		'upgrade_deferred_oldest_age_seconds',
		'Age of the oldest callback in the bounded upgrade pacing queue'
	));
	if (gUpgradeDeferredDepth !== undefined || gUpgradeDeferredOldestAge !== undefined) {
		admission.setDeferredObserver((depth, oldestAgeMs) => {
			gUpgradeDeferredDepth?.set(depth);
			gUpgradeDeferredOldestAge?.set(oldestAgeMs / 1000);
		});
	}
	const gConnectionHeadroom = admission.maxConnections > 0
		? containMetricInstrument(METRICS?.gauge(
			'ws_connection_headroom',
			'Remaining reserved-or-live WebSocket connection permits'
		))
		: undefined;
	gConnectionHeadroom?.set(admission.connectionHeadroom);
	const gQueueDepth = containMetricInstrument(METRICS?.gauge(
		'waiting_room_queue_depth', 'Clients currently polling the waiting room'
	));
	// Outbound-backpressure telemetry, sampled from the 1 Hz pressure snapshot.
	// Worst per-connection buffered bytes seen over the sampled connection set,
	// and the count of sampled connections holding a notable outbound queue.
	const gBackpressureMaxBytes = containMetricInstrument(METRICS?.gauge(
		'ws_backpressure_max_bytes', 'Worst per-connection outbound buffered bytes over the sampled set'
	));
	const gBackpressureConnections = containMetricInstrument(METRICS?.gauge(
		'ws_backpressure_connections', 'Sampled connections holding a backpressured outbound queue'
	));
	const mDroppedFrames = containMetricInstrument(METRICS?.counter(
		'ws_dropped_frames_total', 'Outbound WebSocket frames dropped by the native backpressure limit', []
	));
	const mDroppedBytes = containMetricInstrument(METRICS?.counter(
		'ws_dropped_bytes_total', 'Outbound WebSocket payload bytes dropped by the native backpressure limit', []
	));
	// The rest of what the 1 Hz sampler already computes. These are scalars the
	// fold produces and then discarded before this hook existed - exporting them
	// adds gauge writes to a callback that already runs, and no new work to any
	// per-request or per-message path.
	const gConnections = containMetricInstrument(METRICS?.gauge(
		'ws_connections', 'Live WebSocket connections'
	));
	const gSubscriptions = containMetricInstrument(METRICS?.gauge(
		'ws_subscriptions', 'Live topic subscriptions; divide by ws_connections for the subscriber ratio'
	));
	// A counter, not the sampler's precomputed rate: a rate baked at our cadence
	// cannot be re-windowed by the query, and reads wrong whenever the scrape
	// interval differs from the sample interval. Counts publish CALLS - uWS fans
	// out in C++, so per-recipient counting would mean walking the subscriber
	// set in JS on every publish.
	const mPublishes = containMetricInstrument(METRICS?.counter(
		'ws_publishes_total', 'Publish calls made (fan-out happens in C++; not per-recipient deliveries)', []
	));
	const mHttpRequests = containMetricInstrument(METRICS?.counter(
		'http_requests_total', 'Completed HTTP requests by bounded method and outcome', ['method', 'outcome']
	));
	const hHttpDuration = containMetricInstrument(METRICS?.histogram?.(
		'http_request_duration_seconds', 'HTTP request completion duration in seconds', {
			labelNames: ['method', 'outcome'],
			buckets: [...HTTP_DURATION_BUCKETS]
		}
	));
	const hUpgradeDuration = containMetricInstrument(METRICS?.histogram?.(
		'upgrade_duration_seconds', 'WebSocket upgrade decision duration in seconds', {
			labelNames: ['outcome'],
			buckets: [...UPGRADE_DURATION_BUCKETS]
		}
	));
	const mWsMessages = containMetricInstrument(METRICS?.counter(
		'ws_messages_total', 'Completed inbound WebSocket messages by kind and outcome', ['kind', 'outcome']
	));
	const mMessageAdmissionRejected = containMetricInstrument(METRICS?.counter(
		'ws_message_admission_rejected_total', 'Application WebSocket messages shed by established-message admission', ['reason', 'scope']
	));
	const hWsMessageDuration = containMetricInstrument(METRICS?.histogram?.(
		'ws_message_duration_seconds', 'Inbound WebSocket message handling duration in seconds', {
			labelNames: ['kind', 'outcome'],
			buckets: [...WS_MESSAGE_DURATION_BUCKETS]
		}
	));
	const hWsConnectionDuration = containMetricInstrument(METRICS?.histogram?.(
		'ws_connection_duration_seconds', 'WebSocket connection lifetime in seconds', {
			labelNames: ['outcome'],
			buckets: [...WS_CONNECTION_DURATION_BUCKETS]
		}
	));
	const mPublishOutcomes = containMetricInstrument(METRICS?.counter(
		'ws_publish_outcomes_total', 'Native publish calls by aggregate delivery outcome', ['outcome']
	));
	transportMetricHooks = createTransportMetricHooks({
		httpRequests: mHttpRequests,
		httpDuration: hHttpDuration,
		upgradeDuration: hUpgradeDuration,
		wsMessages: mWsMessages,
		wsMessageDuration: hWsMessageDuration,
		wsConnectionDuration: hWsConnectionDuration,
		publishOutcomes: mPublishOutcomes
	}, monotonicNow);
	counters.publishOutcomeHook = transportMetricHooks?.publishOutcome ?? null;
	const gPressureSaturation = containMetricInstrument(METRICS?.gauge(
		'pressure_saturation', 'Worker saturation, 0 healthy to 1 at the configured thresholds'
	));
	const gPressureReason = containMetricInstrument(METRICS?.gauge(
		'pressure_reason', 'Pressure reason as a severity-ordered code (0 none to 6 memory)'
	));
	const mPressureReasonTransitions = containMetricInstrument(METRICS?.counter(
		'pressure_reason_transitions_total', 'Pressure reason changes, including incidents and recoveries', ['from', 'to']
	));
	const gResidentBytes = containMetricInstrument(METRICS?.gauge(
		'resident_memory_bytes', 'Resident set size of the process'
	));
	const gHeapUsedRatio = containMetricInstrument(METRICS?.gauge(
		'heap_used_ratio', 'Used fraction of this worker isolate V8 heap'
	));
	// Freshness of the sample the gauges above were written from. The pressure
	// timer is unref'd and driven from one interval; if it ever stops, every
	// gauge here keeps serving its last value against a target that still reads
	// up. Alerting on the age of this timestamp is what separates "healthy and
	// steady" from "frozen".
	const gSampleTimestamp = containMetricInstrument(METRICS?.gauge(
		'pressure_sample_timestamp_seconds', 'Unix time of the most recent pressure sample; alert on its age'
	));
	// Kernel pressure readings. Availability is probed ONCE here rather than
	// discovered on the first sample, so these register at startup like every
	// other instrument: creating an instrument inside the 1 Hz tick would put a
	// configuration fault (a registry that throws on registration, which is
	// meant to fail loudly at boot) into a timer callback that repeats forever.
	// A host without the source registers nothing, so the gauges are absent
	// rather than serving a zero that reads as "no pressure". A transient probe
	// error registers the gauge but leaves the source unknown so sampling can
	// recover into it instead of permanently erasing the signal.
	// Keep `null` distinct from a confirmed absence: when metrics are disabled,
	// the protection sampler retains its existing lazy probe rather than being
	// told the sources do not exist. When this probe does run, the same result is
	// handed to the sampler below so one transient first-tick failure cannot
	// overturn a source that was just proven available.
	const OS_PRESSURE_SOURCES = METRICS == null ? null : probeOsPressureSources();
	const gPsiCpuSome = OS_PRESSURE_SOURCES?.psi !== false
		? containMetricInstrument(METRICS?.gauge(
			'psi_cpu_some_avg10', 'Kernel pressure-stall CPU some avg10'
		))
		: undefined;
	const gPsiMemoryFull = OS_PRESSURE_SOURCES?.psi !== false
		? containMetricInstrument(METRICS?.gauge(
			'psi_memory_full_avg10', 'Kernel pressure-stall memory full avg10'
		))
		: undefined;
	const gPsiIoFull = OS_PRESSURE_SOURCES?.psi !== false
		? containMetricInstrument(METRICS?.gauge(
			'psi_io_full_avg10', 'Kernel pressure-stall IO full avg10'
		))
		: undefined;
	const gCpuThrottled = OS_PRESSURE_SOURCES?.cpuThrottle !== false
		? containMetricInstrument(METRICS?.gauge(
			'cpu_throttled_ratio', 'Fraction of the window the cgroup CPU quota held the process suspended'
		))
		: undefined;
	// Descriptor observability. Worker threads share one process-wide fd
	// table, so any worker's registry reports the whole-process truth. Each
	// gauge registers only where its source exists (Linux/macOS; null on
	// Windows). The soft limit is captured once - an external prlimit change
	// mid-flight is rare enough to ignore.
	const FD_SOFT_LIMIT = METRICS == null ? null : (readFdLimits()?.soft ?? null);
	const gOpenFds = METRICS != null && countOpenFds() !== null
		? containMetricInstrument(METRICS?.gauge(
			'open_fds', 'File descriptors currently open by the process'
		))
		: undefined;
	const gFdSoftLimit = FD_SOFT_LIMIT !== null && Number.isFinite(FD_SOFT_LIMIT)
		? containMetricInstrument(METRICS?.gauge(
			'fd_soft_limit', 'Soft file-descriptor limit; new sockets fail with EMFILE at this count'
		))
		: undefined;
	gFdSoftLimit?.set(FD_SOFT_LIMIT);
	// Cross-worker state-hash divergence detections. The primary owns the
	// detector but has no registry over the thread boundary, so it posts a
	// notice back to the worker(s) and the count is incremented here, where the
	// registry lives. No client identity / no topic strings (the hash is
	// structure-only); the optional role label is majority|minority.
	const mStateDivergence = containMetricInstrument(METRICS?.counter(
		'state_divergence_total', 'Cross-worker state hash divergence detections', ['role']
	));
	// Relayed frames this worker was sent and never received, counted where they
	// are found (unlike a divergence, a gap needs no cross-worker comparison to
	// establish). Counts FRAMES, not incidents, so one lost burst reads as the
	// burst it was. No topic strings and no client identity cross into the
	// registry - the topic is named only in the local log line.
	const mRelayGap = containMetricInstrument(METRICS?.counter(
		'relay_gap_frames_total', 'Relayed frames proven lost to this worker', []
	));
	// Primary-owned spill incidents are attributed exactly once to a healthy
	// worker registry. Counts remain cluster-summable without pretending the
	// primary has its own metrics registry.
	const mRelaySpillQuarantines = containMetricInstrument(METRICS?.counter(
		'relay_spill_quarantines_total', 'Workers quarantined after a relay spill ceiling', ['reason']
	));
	const mRelaySpillDroppedBytes = containMetricInstrument(METRICS?.counter(
		'relay_spill_dropped_bytes_total', 'Pending relay bytes discarded when a lagging worker was quarantined', []
	));
	const gRelaySpillPendingAge = containMetricInstrument(METRICS?.gauge(
		'relay_spill_pending_age_seconds', 'Worst oldest-pending age observed at relay spill quarantine', []
	));
	// A refusal is decided on THIS worker (the sender), so the count lands here
	// directly; the boot driver reaches it through noteRelayFrameRefused above.
	const mRelayFrameRefused = containMetricInstrument(METRICS?.counter(
		'relay_frame_refused_total', 'Publishes refused by the sender-side relay frame ceiling; local subscribers still received them', ['lane']
	));
	relayFrameRefusedInc = (lane) => mRelayFrameRefused?.inc({ lane: lane === 'batched' ? 'batched' : 'publish' });
	// An oversized-frame stop is a primary-side incident with no registry of its
	// own; like the spill quarantines it is attributed exactly once to a
	// surviving worker registry via a posted notice.
	const mRelayFrameOversized = containMetricInstrument(METRICS?.counter(
		'relay_frame_oversized_total', 'Relay frames refused at the reassembly ceiling; the sending worker relay stream was stopped', []
	));
	let relaySpillPendingAgePeak = 0;
	if (parentPort) {
		parentPort.on('message', (msg) => {
			if (!msg) return;
			if (msg.type === 'relay-frame-oversized') {
				mRelayFrameOversized?.inc();
				return;
			}
			if (msg.type !== 'relay-spill-overflow') return;
			const reason = msg.reason === 'age' ? 'age' : 'bytes';
			const droppedBytes = Number.isFinite(msg.droppedBytes) ? Math.max(0, msg.droppedBytes) : 0;
			const pendingAgeMs = Number.isFinite(msg.pendingAgeMs) ? Math.max(0, msg.pendingAgeMs) : 0;
			mRelaySpillQuarantines?.inc({ reason });
			mRelaySpillDroppedBytes?.inc({}, droppedBytes);
			relaySpillPendingAgePeak = Math.max(relaySpillPendingAgePeak, pendingAgeMs / 1000);
			gRelaySpillPendingAge?.set(relaySpillPendingAgePeak);
		});
	}
	// Route the framework's own invariant violations (assert/fatal) into the
	// same registry, labelled by category and severity, so the `metrics` option
	// lights up `framework_assertion_violations_total` without the app touching
	// the internal assert seam. Registers once here; no-op when no registry is
	// configured. The emit itself is best-effort inside the assert path, so a
	// throwing registry can never turn an invariant check into a crash.
	if (METRICS) wireAssertionMetrics(METRICS);

	// - Cross-worker state-hash reporter (clustered mode only) ------------
	// On a slow, seam-jittered interval each worker folds its delivered-seq map
	// into one structure-only integer hash and reports it to the primary, which
	// compares the live workers' hashes per primary-assigned epoch. Only the
	// integer hash + this worker's thread id cross the boundary - no topic
	// strings, no payloads (the structure-only contract). Gated on parentPort
	// (multi-worker only) AND a positive interval (off by default), so a
	// single-process or unconfigured deployment never schedules the timer and
	// pays nothing. The timer is unref'd so it never holds the loop open.
	const STATE_HASH_INTERVAL_MS = wsOptions.stateHashIntervalMs ?? 0;
	if (parentPort && STATE_HASH_INTERVAL_MS > 0) {
		// The same interval also drives the relay-contiguity check below, so the
		// tracker only runs when something will read it.
		streamTracking.enabled = true;
		// Reporter-side activity tracking: diffed per tick against the previous
		// snapshot, so the publish and relay hot paths pay nothing for the split.
		// These two maps mirror maxSeenSeq entry-for-entry (topic strings shared
		// by reference) and are bounded by exactly its cardinality - which is
		// bounded with the seq registries: the partition prunes entries whose
		// topic left the live map, so the registry cap is these mirrors' cap too.
		let reporterTick = 0;
		/** @type {Map<string, number>} */
		const reporterPrevSeqs = new Map();
		/** @type {Map<string, number>} */
		const reporterLastChanged = new Map();
		// The registry bound may forget a subscriber-free topic to stay inside
		// its ceiling, and a sibling that still holds it then reports a
		// different hash. That is only safe while the forgotten topic is
		// QUIET: the quiet lane logs a disagreement, the active lane can
		// restart a worker over one. So the reporter lends the bound its
		// activity window, and eviction never takes a topic whose seq moved
		// inside it. Single-process workers never install this - they have no
		// sibling to disagree with.
		seqBound.useQuietProbe((topic) => {
			const changedAt = reporterLastChanged.get(topic);
			return changedAt !== undefined && reporterTick - changedAt > 1;
		});
		const reportStateHash = () => {
			reporterTick++;
			// The comparison is split: ACTIVE topics (seq moved within the last
			// tick window) carry the restart-authorized vote, because an active
			// divergence either self-heals on the next publish or is real; QUIET
			// topics ride a separate log-only hash, because a respawned worker
			// legitimately holds none of its siblings' quiet history and a
			// maximum over a topic nobody publishes can never re-converge - the
			// exact shape that once made the repair switch a kill loop on an
			// idle cluster.
			const { active, quiet } = partitionActiveTopics(maxSeenSeq, reporterPrevSeqs, reporterLastChanged, reporterTick);
			const hash = computeStateHash({ topicSeqs: active });
			const quietHash = computeStateHash({ topicSeqs: quiet });
			parentPort.postMessage({ type: 'state-hash', hash, quietHash, threadId, intervalMs: STATE_HASH_INTERVAL_MS });

			// A maximum only ever reveals a lost TAIL. A lost INTERIOR frame moves no
			// maximum - a worker that got [2,3] of a stream and one that got [1,2,3]
			// both report 3 - so it is caught by contiguity instead, and reported
			// rather than voted on: this worker found the hole in a stream that is
			// dense by construction, so it already knows it lost the frames and no
			// comparison could tell it more. Each hole is drained once, so this is
			// silent until something is actually lost.
			for (const gap of takeConfirmedGaps(originStreams, processMonotonicNow(), GAP_CONFIRM_MS)) {
				emitOperationalEvent({
					source: 'svelte-adapter-uws',
					component: 'runtime.relay-gap',
					event: 'runtime.relay-gap.detected',
					severity: 'error',
					dataClass: 'pseudonymous',
					message: 'This worker is missing relayed state that sibling workers received.',
					attributes: {
						count: gap.count,
						topic: privateValueMetadata(gap.topic, 'topic'),
						originWorker: gap.origin,
						fromOrdinal: gap.from,
						toOrdinal: gap.to
					}
				});
				mRelayGap?.inc({}, gap.count);
				parentPort.postMessage({ type: 'relay-gap', threadId, count: gap.count });
			}
		};
		// Spread the FIRST report by a per-worker jitter (drawn from the
		// injectable RNG so a seeded harness reproduces it) to avoid a thundering
		// herd, then report on a FIXED period. A fixed period keeps every worker
		// on the same cadence, so the primary - which sizes its epoch bucket to
		// comfortably exceed the period - reliably collects one report from each
		// worker. Jittering the period itself would let workers drift out of any
		// shared bucket and a real divergence could go undetected.
		const firstReportDelay = randomFloat() * STATE_HASH_INTERVAL_MS;
		const stateHashKickoff = setTimer(() => {
			reportStateHash();
			const stateHashTimer = setIntervalTimer(reportStateHash, STATE_HASH_INTERVAL_MS);
			if (stateHashTimer.unref) stateHashTimer.unref();
		}, firstReportDelay);
		if (stateHashKickoff.unref) stateHashKickoff.unref();

		// The primary cannot increment a registry counter across the thread
		// boundary, so on a detected divergence it posts a notice back and the
		// worker bumps its own counter here. Epoch-deduped at the primary (it
		// judges each bucket once), so this is one increment per divergent epoch
		// per role. An additional listener on parentPort - index.js owns the
		// publish/heartbeat/shutdown cases; this only handles the divergence
		// notice, so the two never conflict.
		parentPort.on('message', (msg) => {
			if (msg && msg.type === 'state-divergence') {
				mStateDivergence?.inc({ role: msg.role === 'minority' ? 'minority' : 'majority' });
				// The aggregate detector deliberately carries no topic names. Only
				// after it fires does the primary request this bounded, keyed
				// high-water snapshot. The shared random key lives in workerData and
				// never appears in a message, log, metric, or admin response.
				if (
					typeof msg.diagnosticId === 'string' && msg.diagnosticId.length <= 128 &&
					workerData?.divergenceDiagnosticKey
				) {
					parentPort.postMessage({
						type: 'state-divergence-detail',
						diagnosticId: msg.diagnosticId,
						threadId,
						summary: summarizeTopicSequences(
							maxSeenSeq,
							workerData.divergenceDiagnosticKey,
							// Honor the primary's requested bound, capped by this
							// worker's own limit so a compromised primary message
							// cannot inflate the snapshot.
							Number.isInteger(msg.topicLimit) && msg.topicLimit > 0
								? Math.min(msg.topicLimit, DIVERGENCE_TOPIC_LIMIT)
								: DIVERGENCE_TOPIC_LIMIT
						)
					});
				}
			} else if (msg && msg.type === 'state-divergence-diagnostic') {
				divergenceDiagnostics.set(msg.diagnostic);
			}
		});
	}

	// - Per-worker consistency auditor ------------------------------------
	// A background check that runs the shared invariant predicates against a
	// BOUNDED, structure-only snapshot of live connection state on a slow,
	// seam-jittered, unref'd timer. It NEVER runs on the hot path: publish /
	// send / subscribe / close pay nothing; the only cost is the bookkeeping
	// they already do. Unlike the state-hash reporter above this is NOT gated on
	// parentPort - it is a per-worker safety net that must run single-process AND
	// clustered alike. Default on (5000ms); set `consistencyAuditIntervalMs: 0`
	// to disable entirely (no timer scheduled, zero cost). A violation logs +
	// increments the assertion counter (the soft tier); only a `subs.shape`
	// corruption that PERSISTS across two consecutive audits of the same window
	// escalates to the hard tier (a deferred worker restart), so a healthy or
	// transient state is never killed.
	const CONSISTENCY_AUDIT_INTERVAL_MS = wsOptions.consistencyAuditIntervalMs ?? 5000;
	if (CONSISTENCY_AUDIT_INTERVAL_MS > 0) {
		// Build a bounded snapshot over the round-robin window the factory requests.
		// The builder iterates the connection Set ONCE with a skip-counter and only
		// allocates the window, so the cost is fixed per tick regardless of how many
		// connections the worker holds. `counters.totalSubscriptions` is read at call
		// time (not captured), so the cap accountant reflects the live value.
		const buildAuditSnapshot = ({ offset, limit }) => buildConnectionAuditSnapshot({
			connections: wsConnections,
			subscriptionsKey: WS_SUBSCRIPTIONS,
			sessionIdKey: WS_SESSION_ID,
			totalSubscriptions: counters.totalSubscriptions,
			offset,
			limit
		});
		// Soft by default; only `subs.shape` (a per-connection subscription slot
		// that is not a Set) escalates, and only when it persists across two audits.
		const auditor = createConsistencyAuditor({
			snapshot: buildAuditSnapshot,
			assert,
			fatal,
			hardCategories: ['subs.shape'],
			intervalMs: CONSISTENCY_AUDIT_INTERVAL_MS
		});
		counters.consistencyAuditor = auditor;
		auditor.start();
	}

	// - Optional resource-growth trend auditor ----------------------------
	// Distinct from the consistency auditor above (which checks point-in-time
	// invariants): this one trends the SIZE of the live bookkeeping collections
	// across samples and flags a series that grows monotonically - the signature
	// of a close / unsubscribe / eviction path that stopped shedding. It reads
	// ONLY Map/Set `.size` (never a monotonic-by-design counter), rides its own
	// slow, seam-jittered, unref'd timer, and is OBSERVE-ONLY: a suspected trend
	// increments a metric and logs at most one throttled warning, and NEVER
	// asserts or terminates. Off by default (interval 0), because a trend signal
	// is inherently probabilistic and the always-on structural guard is the
	// deterministic simulator, not production.
	const RESOURCE_GROWTH_AUDIT_INTERVAL_MS = wsOptions.resourceGrowthAuditIntervalMs ?? 0;
	if (RESOURCE_GROWTH_AUDIT_INTERVAL_MS > 0) {
		const mResourceGrowth = containMetricInstrument(METRICS?.counter(
			'framework_resource_growth_suspected_total',
			'Sustained resource-growth suspicions raised by the optional auditor',
			['resource']
		));
		let growthWarned = false;
		const growthAuditor = createResourceGrowthAuditor({
			// Self-healing / bounded collections only, so a rising trend really is a
			// leak: wsConnections shrinks as clients disconnect, topicPublishStats is
			// cleared every pressure tick, and lastPublishWarnAt / decodeCache /
			// envelopePrefixCache are LRU-evicted while staticCache plateaus at the
			// finite asset set. The per-topic registries topicSeqs and sharedTopics
			// grow with topic cardinality BY DESIGN, so probing them here would
			// self-fire a false leak: topicSeqs is held to its configured ceiling by
			// the seq bound (handler/seq-bound.js), which can only evict a topic no
			// client is on, and sharedTopics has no such bound at all.
			probes: structuralResourceProbes({
				wsConnections,
				topicPublishStats,
				lastPublishWarnAt,
				decodeCache,
				envelopePrefixCache,
				staticCache
			}),
			intervalMs: RESOURCE_GROWTH_AUDIT_INTERVAL_MS,
			metrics: mResourceGrowth,
			onGrowth(report) {
				// One throttled warning for the whole worker lifetime - the metric
				// carries the ongoing signal; the log is a one-time nudge.
				if (growthWarned) return;
				growthWarned = true;
				console.warn(adapterConsoleLine(ADAPTER_ERROR_IDS.RESOURCE_GROWTH,
					`'${report.name}' size trending upward (delta ${report.delta} over ${report.n} samples); investigate a close/unsubscribe/eviction path that stopped shedding.`));
			}
		});
		counters.resourceGrowthAuditor = growthAuditor;
		growthAuditor.start();
	}

	// The depth probe is closure-local to the waiting-room block below; this
	// holder lets the sampling hook read it without widening that scope.
	/** @type {(() => number) | null} */
	let queueDepthProbe = null;

	// Graduated protection posture over the 1 Hz pressure signal. Opt-in via
	// the `protection` option; absent or `'normal'` leaves `counters.activePosture` null,
	// so the reject path, the pressure snapshot, and the poll response stay
	// byte-identical to a deployment that never sets it. `'auto'` resolves the
	// level from pressure; `'elevated'`/`'siege'` pin it for incident response.
	// The posture is module-ticked from `samplePressure` (no new timer) but
	// instantiated here because it reads the closure-local admission gate.
	const PROTECTION_MODE = wsOptions.protection || 'normal';
	const postureLevel = () => (counters.activePosture !== null ? counters.activePosture.level : 'normal');
	counters.activePosture = (PROTECTION_MODE === 'normal')
		? null
		: createPosture({
			admission,
			getThresholds: () => resolvePressureThresholds(wsOptions.pressure),
			pin: PROTECTION_MODE === 'auto' ? undefined : PROTECTION_MODE,
			// One log line per level change - the operator's incident
			// timeline. Dwell-gated by the machine, so it can never flood.
			// No client identity in the line: rate and reason only.
			onTransition: (from, to) => {
				mPostureTransitions?.inc({ from, to });
				console.warn(adapterConsoleLine(
					ADAPTER_ERROR_IDS.POSTURE_TRANSITION,
					`${from} -> ${to} rejected/s=${counters.activePosture !== null ? counters.activePosture.rejectedPerSecond : 0} ` +
					`pressure=${counters.lastBasePressureReason}`
				));
				// Push the transition to export subscribers immediately - a
				// defense daemon reacting to a posture change must not wait
				// out the rest of the sample window.
				if (counters.postureExportHook !== null) counters.postureExportHook();
			}
		});

	// Posture push-export (opt-in): a local stream socket where an external
	// process (an edge-defense daemon, a watchdog) follows the live posture as
	// newline-delimited JSON - pushed on connect, on every transition, and on
	// every 1 Hz sample (the cadence doubles as a liveness signal). Local-only
	// and payload-free: posture, reason, and kernel pressure numbers.
	const POSTURE_EXPORT = wsOptions.postureExport;
	if (POSTURE_EXPORT !== undefined && POSTURE_EXPORT !== false) {
		const exportPath = typeof POSTURE_EXPORT === 'string' ? POSTURE_EXPORT : POSTURE_EXPORT?.path;
		if (typeof exportPath !== 'string' || exportPath.length === 0) {
			throw new Error("websocket.postureExport must be a socket path string or { path } (or omitted)");
		}
		const exporter = startPostureExport(exportPath, () => ({
			v: 1,
			posture: postureLevel(),
			reason: pressureSnapshot.reason,
			value: pressureSnapshot.value,
			psi: pressureSnapshot.psi ?? null,
			cpuThrottle: pressureSnapshot.cpuThrottle ?? null
		}));
		counters.postureExporter = exporter;
		counters.postureExportHook = () => exporter.broadcast();
	} else {
		counters.postureExporter = null;
		counters.postureExportHook = null;
	}

	// Gauge sampling rides the existing 1 Hz pressure timer - no new timer.
	// Always assigned (hook or null) so a factory re-run replaces any previous
	// hook and a stale closure can never outlive its server.
	// Counting open fds is a directory read whose cost scales with the count
	// itself, so it rides every 5th sample (~5s) instead of every tick. Seeded
	// one below the modulus so the very first sample publishes a value.
	let fdSampleTick = 4;
	counters.metricsSampleHook = METRICS == null ? null : (telemetry) => {
		const lvl = postureLevel();
		gPostureState?.set(lvl === 'siege' ? 2 : lvl === 'elevated' ? 1 : 0);
		gUpgradeInflight?.set(admission.inFlight);
		gUpgradeDeferredDepth?.set(admission.deferredDepth);
		gUpgradeDeferredOldestAge?.set(admission.deferredOldestAgeMs / 1000);
		gQueueDepth?.set(queueDepthProbe !== null ? queueDepthProbe() : 0);
		// Read the snapshot the sampler just folded (this hook runs later in the
		// same tick), so these track the current window's backpressure figures.
		gBackpressureMaxBytes?.set(pressureSnapshot.maxBufferedBytes);
		gBackpressureConnections?.set(pressureSnapshot.backpressuredConnections);
		// Healthy workers publish an explicit zero, so absent-vs-zero stays
		// queryable and the completeness gate can be satisfied by a worker that
		// has never seen a quarantine. The IPC handler raises the peak the
		// moment a spill happens; this rewrite never lowers it.
		gRelaySpillPendingAge?.set(relaySpillPendingAgePeak);
		if (counters.lastDroppedFrames > 0) mDroppedFrames?.inc({}, counters.lastDroppedFrames);
		if (counters.lastDroppedBytes > 0) mDroppedBytes?.inc({}, counters.lastDroppedBytes);
		gConnections?.set(counters.lastConnections);
		gSubscriptions?.set(counters.totalSubscriptions);
		gPressureSaturation?.set(pressureSnapshot.value);
		// Unknown reasons floor to 0 rather than throwing: the vocabulary is
		// source-declared, so an unmapped value means the two lists drifted, and
		// silently reading "no pressure" is the safer of two wrong answers here
		// only because the reason string also reaches the log and the export.
		gPressureReason?.set(PRESSURE_REASON_CODES[pressureSnapshot.reason] ?? 0);
		gResidentBytes?.set(counters.lastResidentBytes);
		gHeapUsedRatio?.set(counters.lastHeapUsedRatio);
		if (counters.lastSampleWallMs > 0) gSampleTimestamp?.set(counters.lastSampleWallMs / 1000);
		if (counters.lastPublishCount > 0) mPublishes?.inc({}, counters.lastPublishCount);
		emitPressureMetricTelemetry(telemetry, {
			reasonTransitions: mPressureReasonTransitions,
			psiCpuSome: gPsiCpuSome,
			psiMemoryFull: gPsiMemoryFull,
			psiIoFull: gPsiIoFull,
			cpuThrottled: gCpuThrottled
		});
		if (gOpenFds !== undefined && ++fdSampleTick >= 5) {
			fdSampleTick = 0;
			const openFds = countOpenFds();
			if (openFds !== null) gOpenFds.set(openFds);
		}
	};

	// Single 60-second interval for all periodic cache maintenance.
	// Keeps timer overhead to one wakeup per minute regardless of how many
	// caches exist. Add future periodic tasks here rather than creating
	// additional intervals.
	setIntervalTimer(() => {
		// 1. Purge rate-limit entries whose entire two-window history has expired.
		//    Two windows must elapse with no activity before an entry is stale -
		//    after one window the previous slot still contributes to the estimate.
		//    The insertion-time cap is what actually bounds each map; this only
		//    reclaims idle entries so a quiet server does not hold identities
		//    indefinitely.
		//
		// Read once for every task below. A block-scoped copy of this left the
		// second sweep reading an undeclared name - a ReferenceError on the first
		// tick that took the whole worker down 60 s after boot, and with it every
		// task further down this callback.
		const t = now();
		upgradeRateLimiter.sweep(t);
		authRateLimiter.sweep(t);
		// 2. Trim module-level LRU caches if they are full. When a cache is at
		//    capacity it evicts one entry per insertion, but traffic patterns can
		//    shift and leave the cache full of stale entries. Clearing the oldest
		//    half every 60 s lets hot entries reclaim the freed slots.
		if (decodeCache.size >= DECODE_CACHE_MAX) {
			let i = 0;
			for (const k of decodeCache.keys()) {
				if (i++ >= DECODE_CACHE_MAX / 2) break;
				decodeCache.delete(k);
			}
		}
		if (envelopePrefixCache.size >= ENVELOPE_CACHE_MAX) {
			let i = 0;
			for (const k of envelopePrefixCache.keys()) {
				if (i++ >= ENVELOPE_CACHE_MAX / 2) break;
				envelopePrefixCache.delete(k);
			}
		}
	}, 60000).unref();

	// - Authenticate endpoint (pre-upgrade HTTP hook) ---------------------
	// Optional `authenticate` export in hooks.ws.ts runs as a normal HTTP POST
	// so session cookies can be refreshed via a standard Set-Cookie on a 200
	// response. This works behind Cloudflare Tunnel and other strict edge
	// proxies that silently drop WebSocket connections whose 101 response
	// carries Set-Cookie. The client store POSTs here before opening the WS
	// when `connect({ auth: true })` is used.
	if (typeof wsModule.authenticate === 'function') {
		const authPath = WS_AUTH_PATH;
		// Body size cap for the authenticate endpoint. Most requests have no
		// body at all - the hook reads cookies from the Cookie header. Cap at
		// a small value to make malicious payloads cheap to reject.
		const AUTH_BODY_LIMIT = 64 * 1024;


		route('post', authPath, (res, req) => {
			// Repeated header lines are merged per header class. A repeated
			// framing / identity header is refused outright: this door reads the
			// Origin and hands the whole header set to a credential check, and
			// neither can be given one of two possible readings.
			/** @type {Record<string, string>} */
			const authHeaders = {};
			if (collectRequestHeaders(req, authHeaders) !== null) {
				send400(res);
				return;
			}
			const method = 'POST';
			const url = req.getUrl() + (req.getQuery() ? '?' + req.getQuery() : '');
			const authAddr = resolveTransportAddress(res);
			const clientIp = resolveClientIp(authAddr.effective, authHeaders, authAddr.direct);

			if (AUTH_PATH_REQUIRE_ORIGIN && !isAuthOriginAccepted(authHeaders, {
				allowedOrigins,
				hostHeader: host_header,
				protocolHeader: protocol_header,
				portHeader: port_header,
				// Same ORIGIN-env pin as the upgrade-side check below.
				pinnedOrigin: origin,
				isTls: is_tls,
				hasUpgradeHook: false
			})) {
				res.cork(() => {
					res.writeStatus('403 Forbidden');
					res.writeHeader('content-type', 'text/plain');
					res.end('Origin not allowed');
				});
				return;
			}

			// Meter accepted origins before any body is read or app hook runs.
			// The origin predicate is a cheap header-only gate; charging rejected
			// origins first lets hostile traffic behind a shared NAT consume the
			// legitimate clients' whole authentication budget.
			if (authRateLimiter.exceeded(clientIp, now())) {
				mUpgradeRejected?.inc({ reason: 'auth_rate_limit' });
				res.cork(() => {
					res.writeStatus('429 Too Many Requests');
					res.writeHeader('content-type', 'text/plain');
					res.end('Too many authentication requests');
				});
				return;
			}

			// `get_origin` derives the base origin from the Host (and the
			// configured PROTOCOL / HOST / PORT headers) when ORIGIN is unset -
			// the zero-config default. It THROWS on a value it cannot make an
			// origin out of, and nothing wraps this route: an unguarded throw
			// escapes the uWS callback as a synchronous exception, so no response
			// is ever written and the request hangs until the client gives up.
			// The reachable trigger is a client-supplied PROTOCOL_HEADER /
			// PORT_HEADER value on a deployment configured for one; a Host-less
			// request cannot reach here, because uWS answers that itself.
			// Resolved BEFORE the state object and the body reader exist, so
			// refusing costs nothing to unwind. The admin route carries the same
			// guard for the same reason.
			let base_origin;
			try {
				base_origin = origin || get_origin(authHeaders);
			} catch {
				send400(res);
				return;
			}

			const state = acquireState();
			res.onAborted(() => { state.aborted = true; });

			const contentLength = parseInt(authHeaders['content-length'], 10);
			if (!isNaN(contentLength) && contentLength > AUTH_BODY_LIMIT) {
				send413(res);
				releaseState(state);
				return;
			}

			const body = readBody(res, AUTH_BODY_LIMIT, state, isNaN(contentLength) ? -1 : contentLength);

			// A base origin that satisfied the protocol and port checks can still
			// build a URL the WHATWG parser refuses, and a header value the
			// Headers constructor rejects throws here too. Same guard the admin
			// route already carries, with the pooled state handed back on the way
			// out - the response is ended first, so uWS will not call onAborted
			// against a state object that now belongs to another request.
			let request;
			let cookies;
			try {
				request = new Request(base_origin + url, {
					method,
					headers: authHeaders,
					body,
					// @ts-expect-error
					duplex: 'half'
				});
				// Inside the same guard: createCookies throws when handed no
				// usable URL, and an unguarded throw here is a hung request
				// plus a leaked pooled state. Request.url is absolute by spec
				// today; the guard is what keeps that a 400 if this ever moves.
				cookies = createCookies(authHeaders['cookie'], request.url);
			} catch {
				send400(res);
				releaseState(state);
				return;
			}

			const authRequestId = resolveRequestId(authHeaders['x-request-id']) || randomUuid();
			const authPlatform = Object.create(platform);
			authPlatform.requestId = authRequestId;

			const event = {
				request,
				headers: authHeaders,
				cookies,
				url,
				remoteAddress: clientIp,
				getClientAddress: () => clientIp,
				platform: authPlatform
			};

			const authenticate = (span = null) => Promise.resolve()
				.then(() => wsModule.authenticate(event))
				.then(async (result) => {
					if (state.aborted) return;

					if (result === false) {
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						return;
					}

					if (result instanceof Response) {
						// User returned a full Response - honour it, but merge any
						// cookies set via cookies.set() so both APIs work together.
						const buf = result.body ? Buffer.from(await result.arrayBuffer()) : null;
						if (state.aborted) return;
						res.cork(() => {
							res.writeStatus(String(result.status));
							for (const [hk, hv] of result.headers) {
								if (hk === 'set-cookie' || hk === 'content-length') continue;
								res.writeHeader(hk, hv);
							}
							for (const c of result.headers.getSetCookie()) res.writeHeader('set-cookie', c);
							for (const c of cookies._serialize()) res.writeHeader('set-cookie', c);
							if (buf) res.end(buf);
							else res.end();
						});
						return;
					}

					// Implicit success: 204 No Content with any Set-Cookie headers
					res.cork(() => {
						res.writeStatus('204 No Content');
						for (const c of cookies._serialize()) res.writeHeader('set-cookie', c);
						res.endWithoutBody(0);
					});
				})
				.catch((err) => {
					try { span?.recordException?.(err); } catch {}
					if (state.aborted) return;
					if (err instanceof PayloadTooLargeError) {
						send413(res);
						return;
					}
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.authenticate',
						event: 'runtime.authenticate.failed',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'The WebSocket authentication endpoint failed.',
						attributes: { requestId: authRequestId, error: diagnosticError(err) }
					});
					if (!state.aborted) send500(res, authRequestId);
				})
				.finally(() => { releaseState(state); });
			if (tracingEnabled) {
				traceOperation('adapter.http.websocket-authenticate', {
					kind: 'server',
					parent: extractTraceContext(authHeaders),
					attributes: {
						'http.request.method': method,
						'network.protocol.name': 'http'
					}
				}, authenticate);
			} else {
				authenticate(null);
			}
		});

		// Reject non-POST verbs on the auth path so GET/HEAD do not fall through
		// to the SSR catch-all (which would try to render a SvelteKit route).
		route('any', authPath, (res) => {
			res.cork(() => {
				res.writeStatus('405 Method Not Allowed');
				res.writeHeader('allow', 'POST');
				res.writeHeader('content-type', 'text/plain');
				res.end('Method Not Allowed');
			});
		});

		console.log(`[svelte-adapter-uws] WebSocket auth endpoint registered at ${authPath}`);
	}

	// - Waiting-room poll + holding page ----------------------------------
	// Registered whenever the waiting room is enabled (a sibling of the
	// authenticate block, not nested inside it, so the poll endpoint exists
	// regardless of whether an authenticate hook is present). Both routes are
	// read-only: the poll probes capacity via `admission.hasCapacity()` and
	// never calls `tryAcquire()`, so polling can never consume a gate slot.
	if (WAITING_ROOM !== null) {
		// Rolling poll counter behind the queue-depth estimate. The pure
		// window math lives in utils.js so the sampler's timer-driven reads
		// decay identically to the poll endpoint's own reads.
		const pollCounter = createPollCounter(WAITING_ROOM.pollIntervalMs);
		const currentQueueDepth = () => pollCounter.depth(now());
		queueDepthProbe = currentQueueDepth;

		route('get', WAITING_ROOM.admitCheckPath, (res) => {
			res.onAborted(() => {});
			pollCounter.record(now());
			// Siege never admits a reload into a full gate: it always reports
			// busy, even while the live gate has free slots. At normal/elevated
			// `hasCapacity()` stays the source of truth, so the poll only ever
			// ADDS the siege always-202 gate - it never admits a client the
			// real gate would reject.
			if (postureLevel() !== 'siege' && admission.hasCapacity()) {
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
			// Widen the poll cadence under siege so a packed room thins its own
			// retry rate; normal/elevated keep today's interval.
			const pollAfterMs = postureLevel() === 'siege'
				? WAITING_ROOM.pollIntervalMs * 2
				: WAITING_ROOM.pollIntervalMs;
			// 202 (not 503) so the poll itself is never treated as a failed or
			// rate-limited upgrade, holds no socket, and is distinguishable in
			// logs.
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

		// Direct navigation to the configured path renders the same page the
		// gate serves on rejection, seeded from the live poll counter.
		route('get', WAITING_ROOM.path, (res, req) => {
			res.onAborted(() => {});
			const page = WAITING_ROOM.renderResponse(
				currentQueueDepth(),
				createWaitingRoomRequest(req)
			);
			sendWaitingRoomPage(res, page);
		});
	}

	route('ws', WS_PATH, {
		// Handle HTTP -> WebSocket upgrade with user-provided auth
		upgrade: (res, req, context) => {
			// Cursor-only upgrade lane (the worker's second WebSocket). Read the
			// requested subprotocol and route the upgrade through the reserved
			// cursor sub-budget only when a lane is configured; an unconfigured
			// deployment never reads the header for lane purposes and never
			// branches on the lane, so the main path is unchanged.
			const cursorLaneEnabled = admission.cursorMaxConcurrent > 0;
			const isCursor = cursorLaneEnabled && isCursorLaneUpgrade(req.getHeader('sec-websocket-protocol'));

			// Serve an at-capacity upgrade refusal without ever consuming a
			// gate slot. Shared by the gate-full reject and the siege
			// short-circuit so both content-negotiate identically: a browser
			// navigation gets the self-polling holding page (it holds no
			// socket), everything else keeps the `503` + jittered
			// `Retry-After`. The jitter band widens as the posture rises
			// (`0.5` at normal reproduces today's exact band). A cursor-lane
			// upgrade is never a browser navigation, so it always gets the bare
			// `503` - never the holding page - and skips the Accept negotiation.
			// `detached` is the pre-read snapshot taken while `req` was still valid,
			// passed only by the caller that runs after the uWS tick has ended. The
			// four synchronous refusals pass nothing and read the live request
			// exactly as before, so their bytes are unchanged.
			const serveUpgradeRefusal = (detached) => {
				if (WAITING_ROOM === null || isCursor) {
					// An HTML navigation keeps a minimal document baseline even
					// when the interactive room is disabled. Cursor upgrades are
					// never navigations and retain the byte-identical bare refusal.
					if (!isCursor && negotiateRejection(
						detached ? detached.accept : req.getHeader('accept'),
						detached ? detached.upgrade : req.getHeader('upgrade')
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
				const accept = detached ? detached.accept : req.getHeader('accept');
				if (negotiateRejection(accept, detached ? detached.upgrade : req.getHeader('upgrade')) === 'html') {
					// Browser navigation: serve the self-polling holding page.
					// The builder is duck-typed, so the detached path hands it a plain
					// facade over the snapshot instead of a request handle that is no
					// longer alive - which keeps this fix out of upgrade-admission.js,
					// and therefore out of the sealed ingress/platform/wire-fanout
					// module graph it sits inside.
					const page = WAITING_ROOM.renderResponse(
						undefined,
						createWaitingRoomRequest(detached ? detachedRequestFacade(detached) : req)
					);
					sendWaitingRoomPage(res, page);
					return;
				}

				// WebSocket upgrade / library client (Accept lacks text/html):
				// keep the 503, refined with a posture-widened jittered
				// Retry-After. At normal the spread is today's exact 0.5.
				const lvl = postureLevel();
				const spread = lvl === 'siege' ? 1.5 : lvl === 'elevated' ? 1.0 : 0.5;
				const retryAfter = WAITING_ROOM.jitteredRetryAfter(spread);
				res.cork(() => {
					res.writeStatus('503 Service Unavailable');
					res.writeHeader('content-type', 'text/plain');
					res.writeHeader('retry-after', String(retryAfter));
					res.end('Server is at upgrade capacity, please retry');
				});
			};

			// Siege refuses every NEW upgrade at static-serve cost, even
			// while the gate has free slots - no slot is acquired, so an
			// existing connection is never touched. Counted as an
			// over-capacity reject so an auto posture stays escalated.
			if (postureLevel() === 'siege') {
				if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
				mUpgradeRejected?.inc({ reason: 'siege' });
				traceUpgradeRejection(req, undefined, 'siege');
				serveUpgradeRefusal();
				return;
			}

			// Pre-upgrade soft filter: cap on concurrent upgrades currently
			// being processed. The cheapest possible rejection - no header
			// walk, no IP decode, no origin check - so a connection storm
			// is shed before it consumes per-request CPU. A cursor-lane
			// upgrade is admitted through its reserved sub-budget so it can
			// never starve main-WS admission; a saturated cursor lane is real
			// capacity pressure, so it counts as an over-capacity reject too.
			const handshakeAcquired = isCursor ? admission.tryAcquireCursor() : admission.tryAcquire();
			if (!handshakeAcquired) {
				// Count the over-capacity reject (and only this one) so the
				// posture's rolling reject rate reflects true gate pressure.
				if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
				mUpgradeRejected?.inc({ reason: isCursor ? 'cursor_lane' : 'over_capacity' });
				traceUpgradeRejection(req, undefined, isCursor ? 'cursor_lane' : 'over_capacity');
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
				gConnectionHeadroom?.set(admission.connectionHeadroom);
			}
			function releaseInFlight() {
				if (!inFlightReleased) {
					inFlightReleased = true;
					if (isCursor) admission.releaseCursorInFlight();
					else admission.release();
				}
				releaseConnectionPermit();
			}
			// `detached` is passed only by the caller that runs after an application
			// upgrade hook resolved - by then uWS has ended the tick and every read
			// of `req` throws, which turned a normal shed into a swallowed throw, a
			// 500 the client cannot tell from a broken server, and a spurious
			// error-severity hook_error that double-counted the rejection. The
			// hookless caller passes nothing and is unchanged.
			function rejectDeferredOverflow(headers, detached) {
				if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
				mUpgradeRejected?.inc({ reason: 'deferred_overflow' });
				mUpgradeDeferredRejected?.inc();
				traceUpgradeRejection(detached ? null : req, headers, 'deferred_overflow');
				releaseInFlight();
				serveUpgradeRefusal(detached);
			}

			if (!admission.tryAcquireConnection()) {
				if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
				mUpgradeRejected?.inc({ reason: 'connection_capacity' });
				traceUpgradeRejection(req, undefined, 'connection_capacity');
				releaseInFlight();
				serveUpgradeRefusal();
				return;
			}
			connectionPermitHeld = admission.maxConnections > 0;
			gConnectionHeadroom?.set(admission.connectionHeadroom);

			// Read everything synchronously - uWS req is stack-allocated.
			// Repeated lines are merged per header class; a repeated framing /
			// identity header is refused before the address is even decoded,
			// which is the cheapest point at which the ambiguity can die. The
			// in-flight slot acquired above is handed back on the way out.
			/** @type {Record<string, string>} */
			const headers = {};
			if (collectRequestHeaders(req, headers) !== null) {
				mUpgradeRejected?.inc({ reason: 'duplicate_header' });
				traceUpgradeRejection(req, null, 'duplicate_header');
				send400(res);
				releaseInFlight();
				return;
			}
			// Snapshot what a deferred-overflow refusal needs, here, where every
			// other synchronous read happens. That refusal can only run after an
			// application upgrade hook resolves, and uWS invalidates `req` at the
			// end of the native tick - so every read it used to do threw, the catch
			// turned a normal shed into a 500, and the client could not tell being
			// shed from a broken server.
			//
			// Gated on pacing being configured: without a per-tick budget no upgrade
			// is ever deferred, so an accepted upgrade on the default configuration
			// pays nothing for this.
			//
			// `accept` and `upgrade` are read from `req`, NOT from the collected
			// `headers`: collectRequestHeaders joins repeated lines with ', ' and
			// neither header is single-valued, so a duplicated Accept would content-
			// negotiate differently here than on the four synchronous refusals. The
			// header bag is COPIED rather than aliased, because the same object is
			// handed to the application hook, which may mutate it before the
			// refusal reads it.
			const deferredRefusal = ADMISSION_PER_TICK_BUDGET > 0
				? {
					accept: req.getHeader('accept'),
					upgrade: req.getHeader('upgrade'),
					method: req.getMethod(),
					url: req.getUrl(),
					query: req.getQuery(),
					headers: { ...headers }
				}
				: null;

			// Decode the client IP once. resolveTransportAddress applies the
			// opt-in PROXY-protocol substitution, then resolveClientIp applies
			// the configured proxy header (ADDRESS_HEADER / XFF_DEPTH) - both
			// gated on TRUSTED_PROXIES when set - so rate limiting keys on the
			// real client address, not the proxy address, and an untrusted
			// peer cannot spoof its rate-limit identity.
			const upgradeAddr = resolveTransportAddress(res);
			const clientIp = resolveClientIp(upgradeAddr.effective, headers, upgradeAddr.direct);

			// Rate limit upgrade requests per IP using a sliding window (0 =
			// disabled), which stops a client doubling its effective rate by
			// placing requests either side of a fixed-window boundary.
			//
			// This runs the SAME limiter as the auth preflight door rather than an
			// inlined copy of it. The two copies were behaviourally identical when
			// written, which is precisely why keeping both was a bad bet: every
			// later correction - the IPv6 /64 key fold most recently - has to be
			// made twice, and the copy that gets missed is a hole nobody is
			// looking at. The eviction policy, the key bound and the window
			// arithmetic all live in rate-limiter.js now.
			if (UPGRADE_MAX_PER_WINDOW > 0) {
				if (upgradeRateLimiter.exceeded(clientIp, now())) {
					// Per-IP rate-limit reject. Reported on its own counter, never
					// the over-capacity one, so an attack-driven 429 storm can
					// never escalate the protection posture toward siege.
					if (counters.activePosture !== null) counters.activePosture.recordRateLimitReject();
					mUpgradeRejected?.inc({ reason: 'ip_rate_limit' });
					traceUpgradeRejection(req, headers, 'ip_rate_limit');
					res.cork(() => {
						res.writeStatus('429 Too Many Requests');
						res.writeHeader('content-type', 'text/plain');
						res.end('Too many upgrade requests');
					});
					// Proxy-collapse advisory: this rejection was keyed on a
					// loopback/private address while no ADDRESS_HEADER is configured,
					// which is the signature of an address-rewriting proxy collapsing
					// every client onto one rate-limit bucket (so the per-IP cap is
					// really a global one). Warn once - this is the exact "intermittent
					// 429 on /ws under trivial traffic" symptom that is otherwise hard
					// to attribute. A directly internet-facing server sees real public
					// client IPs here and never trips this.
					if (!warnedRateLimitProxyCollapse && !address_header) {
						const scope = addressScope(clientIp);
						if (scope === 'loopback' || scope === 'private') {
							warnedRateLimitProxyCollapse = true;
							console.warn(
								`[ws] Rejected a WebSocket upgrade (429) keyed on a ${scope} client address ` +
								`(${clientIp}) while ADDRESS_HEADER is unset. If this server runs behind a ` +
								'reverse proxy, load balancer, or docker userland-proxy that rewrites the ' +
								'source address, every client shares one address and the per-IP ' +
								'`upgradeRateLimit` becomes a single GLOBAL cap (also true for the ' +
								'plugins/ratelimit per-message limiter, which keys on the same address). ' +
								'Restore real client IPs with one of:\n' +
								'  ADDRESS_HEADER=x-forwarded-for (+ XFF_DEPTH for the trusted-proxy hop count)\n' +
								'  docker `userland-proxy: false` so iptables DNAT preserves the source IP\n' +
								'  websocket.upgradeRateLimit: 0 to disable the per-IP limit if you throttle upstream\n' +
								'  See: https://svti.me/upgrade-ratelimit-proxy'
							);
						}
					}
					releaseInFlight();
					return;
				}
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

			// Origin validation - reject cross-origin WebSocket connections.
			// Requests without an Origin header are also rejected unless the
			// user supplied an upgrade hook that can authenticate non-browser
			// clients itself.
			if (!isOriginAllowed(headers['origin'], headers, {
				allowedOrigins,
				hostHeader: host_header,
				protocolHeader: protocol_header,
				portHeader: port_header,
				// The ORIGIN env (already parsed + URL-normalized for SSR) is
				// the authoritative same-origin pin when set - the startup
				// guard above counts it as a pin, so the check must compare
				// against it rather than the attacker-controlled Host header.
				pinnedOrigin: origin,
				isTls: is_tls,
				hasUpgradeHook: !!wsModule.upgrade
			})) {
				mUpgradeRejected?.inc({ reason: 'bad_origin' });
				traceUpgradeRejection(req, headers, 'bad_origin');
				res.cork(() => {
					res.writeStatus('403 Forbidden');
					res.writeHeader('content-type', 'text/plain');
					res.end('Origin not allowed');
				});
				releaseInFlight();
				return;
			}

			// Per-connection requestId stamped at upgrade time. Honours an
			// X-Request-ID upgrade header if present, else generates a fresh
			// UUID. Carried across the upgrade boundary as a string-keyed
			// userData slot (uWebSockets.js strips Symbol keys when handing
			// userData to the WS binding). The `open` hook promotes this
			// string into the Symbol-keyed per-connection platform clone.
			const wsRequestId = resolveRequestId(headers['x-request-id']) || randomUuid();
			const wsTraceParent = tracingEnabled ? extractTraceContext(headers) : null;

			// No user upgrade handler - accept synchronously (no microtask yield,
			// no cookie parsing). Inject remoteAddress so plugins/ratelimit can
			// key on the real client IP via ws.getUserData().remoteAddress.
			if (!wsModule.upgrade) {
				// Track aborted so a deferred upgrade does not call res.upgrade()
				// on a connection the client already closed. Only relevant when
				// the per-tick budget pushes the call onto setImmediate.
				let fastPathAborted = false;
				if (ADMISSION_PER_TICK_BUDGET > 0) {
					res.onAborted(() => { fastPathAborted = true; releaseInFlight(); });
				}
				const pacingOutcome = admission.admit(() => {
					if (fastPathAborted) return;
					try {
						const acceptUpgrade = () => {
							const connectionTraceContext = activeTraceContext() ?? wsTraceParent;
							res.cork(() => {
								upgradeWithConnectionPermit({
									remoteAddress: clientIp,
									[WS_REQUEST_ID_KEY]: wsRequestId,
									[WS_TRACE_CONTEXT_KEY]: connectionTraceContext
								});
							});
						};
						if (tracingEnabled) {
							traceOperation('adapter.websocket.upgrade', {
								kind: 'server',
								parent: wsTraceParent,
								attributes: { 'network.protocol.name': 'websocket' }
							}, acceptUpgrade);
						} else {
							acceptUpgrade();
						}
						mUpgradeAdmitted?.inc();
					} finally {
						// Also releases both permits if the native upgrade throws.
						releaseInFlight();
					}
				});
				if (pacingOutcome === null) rejectDeferredOverflow(headers);
				return;
			}

			// - User upgrade handler path (may be async) --
			const query = req.getQuery();
			const url = query ? req.getUrl() + '?' + query : req.getUrl();

			let aborted = false;
			res.onAborted(() => {
				aborted = true;
				releaseInFlight();
			});

			const cookies = parseCookies(headers['cookie']);

			let timedOut = false;
			let timer;
			if (wsOptions.upgradeTimeout > 0) {
				timer = setTimer(() => {
					timedOut = true;
					if (!aborted) {
						mUpgradeRejected?.inc({ reason: 'auth_timeout' });
						traceUpgradeRejection(req, headers, 'auth_timeout');
						res.cork(() => {
							res.writeStatus('504 Gateway Timeout');
							res.writeHeader('content-type', 'text/plain');
							res.end('Upgrade timed out');
						});
					}
					releaseInFlight();
				}, wsOptions.upgradeTimeout * 1000);
			}

			// A synchronous throw must take the same path as an async rejection:
			// without the wrap it would escape the upgrade callback before the
			// catch below exists, serving no response and leaking the in-flight
			// slot (releaseInFlight would never run).
			let upgradeHookResult;
			let connectionTraceContext = wsTraceParent;
			const callUpgradeHook = () => {
				connectionTraceContext = activeTraceContext() ?? wsTraceParent;
				return wsModule.upgrade({
					headers,
					cookies,
					url,
					remoteAddress: clientIp,
					requestId: wsRequestId,
					traceContext: connectionTraceContext
				});
			};
			try {
				upgradeHookResult = tracingEnabled
					? traceOperation('adapter.websocket.upgrade', {
						kind: 'server',
						parent: wsTraceParent,
						attributes: { 'network.protocol.name': 'websocket' }
					}, callUpgradeHook)
					: callUpgradeHook();
			} catch (err) {
				upgradeHookResult = Promise.reject(err);
			}
			Promise.resolve(upgradeHookResult)
				.then((result) => {
					clearTimer(timer);
					if (aborted || timedOut) return;
					if (result === false) {
						mUpgradeRejected?.inc({ reason: 'auth_rejected' });
						traceUpgradeRejection(req, headers, 'auth_rejected');
						res.cork(() => {
							res.writeStatus('401 Unauthorized');
							res.writeHeader('content-type', 'text/plain');
							res.end('Unauthorized');
						});
						releaseInFlight();
						return;
					}
					// Unpack upgradeResponse() wrapper if present
					let responseHeaders = null;
					let userData;
					if (result && result.__upgradeResponse === true) {
						userData = result.userData || {};
						responseHeaders = result.headers;
					} else {
						userData = result || {};
					}
					// Warn once per unique key name about potentially sensitive data in userData.
					// userData is readable by every server-side handler via ws.getUserData().
					if (userData && typeof userData === 'object') {
						for (const key of Object.keys(userData)) {
							if (!warnedUserDataKeys.has(key)) {
								const lower = key.toLowerCase();
								if (SENSITIVE_KEY_PATTERNS.some((s) => lower.includes(s))) {
									warnedUserDataKeys.add(key);
									console.warn(
										'[ws] userData key "' + key + '" may contain sensitive data. ' +
										'userData is accessible to all server-side handlers via ws.getUserData(). ' +
										'Store sensitive data outside userData and reference it by a non-sensitive ID.\n' +
										'  See: https://svti.me/userdata-sensitive'
									);
								}
							}
						}
					}
					const ud = userData || {};
					if (!ud.remoteAddress) ud.remoteAddress = clientIp;
					ud[WS_REQUEST_ID_KEY] = wsRequestId;
					ud[WS_TRACE_CONTEXT_KEY] = connectionTraceContext;
					// Headers actually written to the 101. This is a SNAPSHOT, not the
					// app's object, and the snapshot is what gets validated and what
					// gets written. The object belongs to the app and stays mutable,
					// while admission.admit() below may defer the write to a later
					// macrotask - so validating the live object and writing it later
					// leaves a window in which another connection's upgrade hook can
					// rewrite a shared or module-level headers object between the
					// check and the write, and the poisoned value would go out
					// unvalidated. Validate what will be written; write what was
					// validated.
					const safeHeaders = snapshotUpgradeHeaders(responseHeaders);
					if (safeHeaders) warnSetCookieOnUpgradeOnce(safeHeaders);
					const pacingOutcome = admission.admit(() => {
						// Recheck after possible setImmediate defer: the client
						// may have hung up between admission and execution.
						if (aborted || timedOut) { releaseInFlight(); return; }
						try {
							res.cork(() => {
								if (safeHeaders) {
									// Write the switching-protocols status line BEFORE any
									// header. uWS emits an implicit "200 OK" on the first
									// writeHeader, and a 200 makes spec-compliant WebSocket
									// clients reject the handshake ("Unexpected server
									// response: 200"). res.upgrade() below tolerates the
									// pre-written 101 and appends Sec-WebSocket-Accept to it.
									res.writeStatus('101 Switching Protocols');
									for (const [hk, hv] of Object.entries(safeHeaders)) {
										if (Array.isArray(hv)) {
											// Index the trusted snapshot; never invoke an
											// app-controlled Symbol.iterator at the wire sink.
											for (let i = 0; i < hv.length; i++) res.writeHeader(hk, hv[i]);
										} else {
											res.writeHeader(hk, hv);
										}
									}
								}
								upgradeWithConnectionPermit(ud);
							});
							mUpgradeAdmitted?.inc();
						} finally {
							// The deferred drain catches native throws outside this
							// promise chain, so release locally as well.
							releaseInFlight();
						}
					});
					// This one runs inside the upgrade hook's `.then()`, so the uWS
					// tick has ended and `req` is dead - the refusal takes the
					// snapshot read before the hook was ever called.
					if (pacingOutcome === null) rejectDeferredOverflow(headers, deferredRefusal);
				})
				.catch((err) => {
					clearTimer(timer);
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.websocket-upgrade',
						event: 'runtime.websocket-upgrade.failed',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'The WebSocket upgrade hook failed.',
						attributes: { requestId: wsRequestId, error: diagnosticError(err) }
					});
					if (!aborted && !timedOut) {
						mUpgradeRejected?.inc({ reason: 'hook_error' });
						traceUpgradeRejection(req, headers, 'hook_error');
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

		open: (ws) => {
			// Track which topics this connection is subscribed to.
			// Used to populate CloseContext.subscriptions for the user's close handler,
			// enabling deterministic cleanup of per-subscription server state.
			const userData = ws.getUserData();
			if (admission.maxConnections > 0) {
				const permitRestored = connectionPermitCarrier.restore(userData);
				fatal(permitRestored, 'ws.connection-permit-carrier', null);
				if (!permitRestored) return;
			}
			// A platform slot already set on a fresh open is unrecoverable structural
			// corruption: a re-entrant or duplicate open on the same handle. Continuing
			// would overwrite live per-connection state, so escalate to the hard tier.
			fatal(!userData[WS_PLATFORM], 'ws.platform-double-init', null);
			userData[WS_SUBSCRIPTIONS] = new Set();
			// Promote the upgrade-time requestId (carried as a string slot
			// because Symbol keys do not survive res.upgrade) into a
			// per-connection platform clone on the Symbol slot, then drop
			// the string slot so userData stays clean for hook code.
			const wsPlatform = Object.create(platform);
			wsPlatform.requestId = userData[WS_REQUEST_ID_KEY];
			Object.defineProperty(wsPlatform, 'connectionTraceContext', {
				value: userData[WS_TRACE_CONTEXT_KEY] ?? null
			});
			userData[WS_PLATFORM] = wsPlatform;
			delete userData[WS_REQUEST_ID_KEY];
			delete userData[WS_TRACE_CONTEXT_KEY];
			assert(userData[WS_REQUEST_ID_KEY] === undefined, 'ws.request-id-leak', null);
			// Server-trusted attribution, resolved exactly once per connection and
			// BEFORE the app open hook, so open/message hooks and every bundled
			// limiter read one settled answer. Placed after the platform install so
			// the refusal's close path finds the slots it asserts on. Fail-closed
			// and loud: an invalid id or a throwing resolver refuses the connection,
			// because admitting it unattributed would silently stand down every
			// tenant-scoped limit downstream.
			try {
				installAttribution(wsModule.attribution, userData);
			} catch (err) {
				emitOperationalEvent({
					source: 'svelte-adapter-uws',
					component: 'runtime.websocket-attribution',
					event: 'runtime.websocket-attribution.failed',
					severity: 'error',
					dataClass: 'pseudonymous',
					message: 'The WebSocket attribution hook failed; the connection was refused at open.',
					attributes: { requestId: wsPlatform.requestId, error: diagnosticError(err) }
				});
				try { ws.end(1008, 'Attribution failed'); } catch { /* native side already gone */ }
				return;
			}
			// Stamp a fresh session id and announce it. The client stores it
			// in sessionStorage and presents it back via { type: 'resume' }
			// after a reconnect so the user's resume hook can fill the gap.
			const sessionId = randomUuid();
			userData[WS_SESSION_ID] = sessionId;
			// Per-connection traffic stats are only allocated when the user
			// has a `close` hook to receive them - keeps userData lean for
			// stats-uninterested apps.
			if (closeHookRegistered) {
				userData[WS_STATS] = {
					openedAt: monotonicNow(),
					messagesIn: 0,
					messagesOut: 0,
					bytesIn: 0,
					bytesOut: 0
				};
			}
			const welcome = '{"type":"welcome","sessionId":"' + sessionId + '"}';
			ws.send(welcome, false, false);
			bumpOut(ws, welcome);
			wsConnections.add(ws);
			if (wsDebug) console.log('[ws] open connections=%d session=%s', wsConnections.size, sessionId);
			wsModule.open?.(ws, { platform: userData[WS_PLATFORM] });
		},

		message: async (ws, message, isBinary) => {
			// A message on a connection with no platform slot means open never ran or
			// the slot was clobbered - unrecoverable. One truthiness check (the property
			// read happens regardless), so the hot path is unchanged.
			fatal(ws.getUserData()[WS_PLATFORM], 'ws.platform-missing-in-message', null);
			bumpIn(ws, message);
			// Binary ingress (client->server 0x03): a connection that advertised
			// `wire.ingress:1` sends id-addressed binary frames the demux decodes
			// and routes here, ahead of the JSON control block and the app hook.
			// Only an actual 0x03 frame pays the capability lookup; every other
			// binary frame (realtime's outbound-only 0x01/0x02 and the 0x00 binary
			// RPC) reads one leading byte and falls through unchanged.
			if (isBinary && new Uint8Array(message)[0] === 0x03 /* WIRE_BINARY_TAG, ingress direction */) {
				const iud = ws.getUserData();
				const icaps = iud[WS_CAPS];
				if (icaps !== undefined && icaps.has(WIRE_INGRESS_CAP)) {
					await runAdmittedMessageWork(messageAdmission, ws, { data: message, platform: iud[WS_PLATFORM] }, runIngressApplicationWork, rejectApplicationMessage);
					return;
				}
			}
			// Oversized control-shaped frame: a text frame beginning {"type"
			// (byte[3]='y') at or above the 8192-byte control ceiling never
			// reaches the control demux below, so it would otherwise fall
			// through to the app hook with msg undefined - a control frame
			// lost with no signal. Reject it explicitly (without parsing the
			// oversized payload) so the client learns its frame overflowed.
			// Data envelopes ({"topic", byte[3]='o') and other large text
			// frames are not control-shaped and fall through unchanged.
			if (!isBinary && message.byteLength >= 8192 &&
				(new Uint8Array(message))[3] === 0x79 /* 'y' in {"type" */) {
				// Count this reject's bytes into the connection's outbound total,
				// symmetric with every other control-demux send (welcome, lease-ok,
				// resumed, ingress-ok, subscribe-denied), each of which pairs ws.send
				// with bumpOut. An error frame is outbound traffic like any other; a
				// close hook's byte accounting must not silently drop it.
				const rejectFrame = controlFrameTooLargeFrame(message.byteLength);
				ws.send(rejectFrame, false, false);
				bumpOut(ws, rejectFrame);
				return;
			}
			// Built-in: handle subscribe/unsubscribe from the client store.
			// Control messages are JSON text: {"type":"subscribe","topic":"..."}
			// Byte-prefix check: {"type" has byte[3]='y' (0x79), while user
			// envelopes {"topic" have byte[3]='o' (0x6F). Only JSON.parse when
			// the prefix matches - skips parsing for 99%+ of messages.
			// The 8192-byte ceiling is generous enough for subscribe-batch with
			// many topics (N * 256-char names) while keeping the JSON.parse
			// guard against truly large user messages.
			// `msg` is hoisted to outer scope so it can be forwarded to the user
			// handler in the fall-through delegation below. When the prefix
			// matched and JSON.parse produced an object that did NOT match any
			// known control type, the parsed value reaches plugin-layer
			// dispatchers (e.g. svelte-realtime's `onJsonMessage`) directly, so
			// they don't re-run TextDecoder + JSON.parse on every frame.
			/** @type {any} */
			let msg;
			if (!isBinary && message.byteLength < 8192 &&
				(new Uint8Array(message))[3] === 0x79 /* 'y' in {"type" */) {
				/** @type {any} */
				let parsed;
				try {
					parsed = JSON.parse(textDecoder.decode(message));
				} catch {
					parsed = undefined;
				}
				if (parsed === null || typeof parsed !== 'object') {
					// Not a JSON object envelope (parse failed, or parsed to
					// null / primitive / array). Forward raw bytes only.
					await runAdmittedMessageHook(messageAdmission, wsModule.message, ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] }, rejectApplicationMessage);
					return;
				}
				msg = parsed;
				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					const ref = hasRef(msg.ref) ? msg.ref : null;
					if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS)) {
						sendSubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE, topic: msg.topic })) {
						sendSubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
					// The subscription slot is assigned a Set once at open and never
					// reassigned; a non-Set here is unrecoverable heap/dispatch corruption.
					// One instanceof guard, identical in cost to the assert it replaces.
					fatal(subs instanceof Set, 'subs.shape', null);
					const isNew = !subs.has(msg.topic);
					if (exceedsSubscriptionCap({ held: !isNew, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					// Wire-subscribe authorization: a client may (re)subscribe only to a
					// topic the server already authorized for this connection (already in
					// `subs` via a prior `platform.subscribe`). A topic the server never
					// granted is hard-denied here UNLESS the app ships its own subscribe
					// hook, which then decides via `runUserSubscribeGate` below. `isNew`
					// is exactly "not already server-authorized on this connection".
					if (deniesWireSubscribePreHook({ armed: subscribeAuth.enabled, hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict, held: !isNew, topic: msg.topic })) {
						sendSubscribeDenied(ws, msg.topic, ref, 'FORBIDDEN');
						return;
					}
					const pendingUd = ws.getUserData();
					// In-flight authorization is bounded BEFORE it begins: every
					// pending attempt is a live hook invocation (typically a DB or
					// session-store query), and the landed cap above cannot see
					// attempts that never land - repeated frames stack that work
					// whether their topics are distinct or not. Checked after the
					// cheap denials so a capped connection still gets its
					// INVALID_TOPIC / FORBIDDEN answers for frames that cost no
					// hook work.
					if (exceedsPendingSubscribeCap({ pending: pendingSubscribeTotal(pendingUd), max: MAX_PENDING_SUBSCRIBES_PER_CONNECTION })) {
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					// Track the in-flight subscribe: a revocation
					// (platform.unsubscribe) landing during the hook await
					// cannot remove a subscription that does not exist yet,
					// so it tombstones this topic in the connection's
					// pending-subscribe set; the landing below checks the
					// tombstone and discards the grant (revocation TOCTOU).
					const pendingToken = beginPendingSubscribe(pendingUd, msg.topic, subs.has(msg.topic));
					const denial = await runUserSubscribeGate(ws, msg.topic);
					if (denial !== null) {
						// The hook denied, but it may have installed tracked membership
						// (a plugin join) before deciding, and a revocation may have
						// tombstoned this attempt mid-await. Settling blindly here left
						// that membership standing: the held branch below defers to a
						// sibling attempt still in flight, so when that sibling's hook
						// denies too, every attempt leaves through this exit and nothing
						// remains to judge the membership.
						if (settleDeniedSubscribe(pendingUd, msg.topic, pendingToken, subs.has(msg.topic)) === 'deny-unwind') {
							unwindRevokedMembership(ws, msg.topic);
							wsModule.unsubscribe?.(ws, msg.topic, { platform: pendingUd[WS_PLATFORM] });
						}
						sendSubscribeDenied(ws, msg.topic, ref, denial);
						return;
					}
					// Post-await re-check: a concurrent subscribe (single or batch)
					// may have raced through and already added the topic while
					// the user hook awaited. Idempotent ack and skip the
					// logical accounting add to avoid double-counting.
					// NOT when a gap-fill was requested. Live membership arriving during
					// the await - a re-grant, a concurrent subscribe - carries no
					// HISTORY, so acking here left a client that asked to recover from
					// an offset subscribed and believing itself caught up, with the tail
					// between its last-seen seq and now silently missing. Fall through to
					// the recover lane instead; it acks through its own
					// already-subscribed branch once the gap is filled.
					const _wantsRecover = wantsRecover({ hasResumeHook: wsModule.resume, recover: msg.recover });
					if (subs.has(msg.topic) && !_wantsRecover) {
						// Held is not enough: the membership may have been installed
						// mid-await by THIS attempt's own hook after a revocation
						// tombstoned it. settleHeldSubscribe reads the provenance -
						// ack a surviving attempt or a fresh post-revoke grant, deny
						// a revoked one, unwinding hook-installed membership when no
						// live authority backs it.
						const heldVerdict = settleHeldSubscribe(pendingUd, msg.topic, pendingToken);
						if (heldVerdict === 'ack') {
							sendSubscribed(ws, msg.topic, ref);
							return;
						}
						if (heldVerdict === 'deny-unwind') {
							unwindRevokedMembership(ws, msg.topic);
							wsModule.unsubscribe?.(ws, msg.topic, { platform: pendingUd[WS_PLATFORM] });
						}
						sendSubscribeDenied(ws, msg.topic, ref, 'FORBIDDEN');
						return;
					}
					// Scoped to a topic the socket does NOT already hold. The recover
					// fall-through above can now reach this line with the topic
					// already a membership, and refusing that would answer
					// RATE_LIMITED to a connection that is not growing at all.
					if (exceedsSubscriptionCap({ held: subs.has(msg.topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
						settlePendingSubscribe(pendingUd, msg.topic, pendingToken);
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					// Resume-on-subscribe: when the client attached a recovery offset,
					// gap-fill the missed tail (epoch-checked) through the same resume hook
					// the `resume` frame uses, BEFORE subscribing to live - so the __replay
					// frames precede the first live frame. No-ops when no replay backend is
					// mounted (like `resume`).
					// A recovery barrier spans the resume await: a live-frame buffer for
					// this topic opens BEFORE the hook runs, every fan-out site holds
					// frames in it during the await, and the held frames flush in order
					// once live membership is installed - so a publish landing inside an
					// async resume window (past the backend read, before ws.subscribe) is
					// delivered rather than silently lost. A synchronous in-memory resume
					// never yields, so the buffer stays empty and this is a no-op.
					let _cap = null;
					let _covered;
					// A revocation can land while the authorization hook is parked, and
					// this call serves the topic's REPLAY HISTORY. The tombstone below
					// refuses the subscription, but it runs afterwards - by then the
					// history has gone out. Checked here for the same reason the batch
					// lane is. Under the grant model the current grant set is
					// authoritative (a revoke followed by a re-grant is a topic the
					// connection legitimately holds again); with the gate off the
					// revocation epoch is the only signal there is.
					// MEMBERSHIP FIRST - see the batch lane for why. The epoch is
					// consulted only when the socket does not hold the topic, so a
					// revoke followed by a re-grant inside one await window is served
					// rather than acked-and-silently-dropped.
					const _recoverRevoked = recoverIsRevoked({
						held: subs instanceof Set && subs.has(msg.topic),
						wireAuthz: subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook()),
						cancelled: isPendingSubscribeCancelled(pendingUd, msg.topic, pendingToken),
						topic: msg.topic
					});
					if (!_recoverRevoked && _wantsRecover) {
						const _rEpochs = Number.isInteger(msg.recover.epoch) ? { [msg.topic]: msg.recover.epoch } : undefined;
						_cap = beginResumeCapture([msg.topic], ws);
						try {
							_covered = await wsModule.resume(ws, { sessionId: ws.getUserData()[WS_SESSION_ID], lastSeenSeqs: { [msg.topic]: msg.recover.offset }, lastSeenEpochs: _rEpochs, platform: ws.getUserData()[WS_PLATFORM] });
						} catch (err) { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err); }
						// Re-check after the await: a concurrent subscribe may have added
						// it, so the client is already live and the buffered frames would
						// be duplicates - discard them.
						if (subs.has(msg.topic)) {
							const heldVerdictR = settleHeldSubscribe(pendingUd, msg.topic, pendingToken);
							if (heldVerdictR === 'ack') { discardResumeCapture(_cap); sendSubscribed(ws, msg.topic, ref); return; }
							// Revoked mid-await; the replay went out, but a grant
							// installed by the revoked attempt's own hook must not stand.
							if (heldVerdictR === 'deny-unwind') {
								unwindRevokedMembership(ws, msg.topic);
								wsModule.unsubscribe?.(ws, msg.topic, { platform: pendingUd[WS_PLATFORM] });
							}
							discardResumeCapture(_cap);
							sendSubscribeDenied(ws, msg.topic, ref, 'FORBIDDEN');
							return;
						}
					}
					// Revocation tombstone: a platform.unsubscribe that landed
					// during the gate / resume awaits cancelled this pending
					// subscribe - discard the grant instead of subscribing, and
					// answer the client's ref'd frame with a denial (not the ack)
					// so its awaited subscribe resolves truthfully.
					// Gate re-check BEFORE the grant is marked: stamping this attempt as
					// post-revocation authority and then refusing the install left a
					// revoked sibling's landing reading that mark as current. The batch
					// and dev lanes already check first; this makes the single lane agree.
					if (deniesWireSubscribeLanding({ armed: subscribeAuth.enabled, hasUserHook: hasUserSubscribeHook() && !subscribeAuth.strict, held: subs.has(msg.topic), topic: msg.topic })) {
						settlePendingSubscribe(pendingUd, msg.topic, pendingToken);
						if (_cap) discardResumeCapture(_cap);
						sendSubscribeDenied(ws, msg.topic, ref, 'FORBIDDEN');
						return;
					}
					if (!settlePendingSubscribe(pendingUd, msg.topic, pendingToken, true)) {
						if (_cap) discardResumeCapture(_cap);
						sendSubscribeDenied(ws, msg.topic, ref, 'FORBIDDEN');
						return;
					}
					try { ws.subscribe(msg.topic); }
					catch { if (_cap) discardResumeCapture(_cap); counters.closedWsAborts++; return; }
					addLogicalSubscription(subs, msg.topic);
					// Live membership is installed: flush any frames held during the resume
					// window to this connection, in order, skipping what the resume already
					// covered, before the ack.
					// A flush that could not tell the client its window is incomplete
					// closes the connection, and uWS runs the close handler inside that
					// call - so everything below is bookkeeping for a connection that is
					// already gone. The cohort join would take a shared wire-id reference
					// and hand it straight back when its announce throws, and the ack
					// would charge a closed-socket abort for a client that is not waiting
					// for one. Both are individually guarded, so this is not a crash;
					// stopping here is simply the honest answer, and it keeps the
					// closed-socket counter reading real closes rather than our own.
					if (_cap && flushResumeTopic(_cap, msg.topic, coveredSeqFor(_covered, msg.topic))) return;
					// A topic already promoted to shared fan-out cohorts this new joiner
					// into the right cohort (announcing the server-wide id now) so the
					// next cohort-split publish reaches it. No-op for an ordinary topic.
					if (sharedTopics.has(msg.topic)) joinSharedCohort(ws, ws.getUserData(), msg.topic, sharedTopics.get(msg.topic));
					if (wsDebug) console.log(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'runtime.subscription',
						event: 'runtime.subscription.accepted',
						severity: 'debug',
						message: 'A client topic subscription was installed.',
						attributes: { topic: msg.topic }
					}));
					sendSubscribed(ws, msg.topic, ref);
					return;
				}
				if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
					// A client unsubscribing while its OWN subscribe for the same topic is
					// still parked in an async authorization hook is the same TOCTOU
					// platform.unsubscribe has: the membership does not exist yet, so
					// removing it is a no-op and the parked subscribe installs it after the
					// app's unsubscribe hook has already run. Tombstone it so the landing
					// discards the grant.
					tombstonePendingSubscribe(ws.getUserData(), msg.topic);
					// The observer taps are authority derived from the base topic. A
					// client-driven revocation must release them just like
					// platform.unsubscribe does; otherwise leaving `room` removes the
					// base membership while `__cursor:room` / `__presence:room` keeps
					// delivering private fan-out (and cursor keeps accepting writes).
					releaseDerivedSubscriptions(ws, msg.topic);
					ws.unsubscribe(msg.topic);
					const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
					assert(udSubs instanceof Set, 'subs.shape-unsubscribe', null);
					removeLogicalSubscription(udSubs, msg.topic);
					// Read and write are granted together and are dropped together,
					// on this path as on platform.unsubscribe and the plugin evict
					// primitive. The client-driven `game` lane carries no topic, so
					// a binding left behind here keeps publishing into a room the
					// sender just left.
					{
						const _ud = ws.getUserData();
						if (_ud[WS_PUBLISH_GRANT] === msg.topic) _ud[WS_PUBLISH_GRANT] = undefined;
					}
					// Drop the cohort memberships + release the shared wire-id ref for a
					// shared topic, so an unsubscribed client stops receiving its
					// cohort-split publishes. No-op for an ordinary topic.
					if (sharedTopics.has(msg.topic)) leaveSharedCohort(ws, ws.getUserData(), msg.topic);
					if (wsDebug) console.log(formatDiagnostic({
						source: 'svelte-adapter-uws',
						component: 'runtime.subscription',
						event: 'runtime.subscription.removed',
						severity: 'debug',
						message: 'A client topic subscription was removed.',
						attributes: { topic: msg.topic }
					}));
					wsModule.unsubscribe?.(ws, msg.topic, { platform: ws.getUserData()[WS_PLATFORM] });
					return;
				}
				if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
					// Sent by the client store on reconnect to resubscribe all topics
					// in a single message instead of N individual subscribe messages.
					// Cap at 256 topics. Topics past the cap are denied LOUDLY
					// (BATCH_OVERFLOW), never silently dropped: without the denial a
					// client that overflowed the cap would wait forever on acks that
					// never come, with no signal which topics were never subscribed.
					const topics = msg.topics.slice(0, 256);
					const ref = hasRef(msg.ref) ? msg.ref : null;
					for (let i = 256; i < msg.topics.length; i++) {
						if (typeof msg.topics[i] === 'string') {
							sendSubscribeDenied(ws, msg.topics[i], ref, 'BATCH_OVERFLOW');
						}
					}
					const userData = ws.getUserData();
					assert(userData[WS_SUBSCRIPTIONS] instanceof Set, 'subs.shape-batch', null);

					// Pass 1: validate topics. INVALID_TOPIC denials emit immediately;
					// the batch hook (if any) only sees validated topics.
					const valid = [];
					for (const topic of topics) {
						if (!isValidWireTopic(topic, ALLOW_NON_ASCII_TOPICS)) {
							sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
							continue;
						}
						if (deniesWireSystemTopicSubscribe({ allowSystem: ALLOW_SYSTEM_TOPIC_SUBSCRIBE, topic })) {
							sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
							continue;
						}
						valid.push(topic);
					}

					// Wire-subscribe authorization (batch): when on and no app hook is
					// exported, every valid topic the server has NOT already authorized
					// for this connection is denied FORBIDDEN before the hook pass. With
					// an app hook present, authorization is deferred to it (below), same
					// as the single-subscribe path. `authzDenied` short-circuits the
					// hook calls for the pre-denied topics.
					// Hoisted once per frame rather than read per topic, so every topic
					// in one frame is judged against one reading of the app's hooks.
					// NOT hoisted: the ARM flag. `subscribeAuth.enabled` is
					// runtime-mutable and is read fresh at each decision below.
					const _hasUserHook = hasUserSubscribeHook();
					const _wireAuthz = subscribeAuth.enabled && (subscribeAuth.strict || !_hasUserHook);
					const authzDenied = _wireAuthz
						? valid.map((t) => deniesWireSubscribePreHook({ armed: subscribeAuth.enabled, hasUserHook: _hasUserHook && !subscribeAuth.strict, held: userData[WS_SUBSCRIPTIONS].has(t), topic: t }))
						: null;

					// In-flight authorization capacity: topics beyond the connection's
					// pending-attempt budget take no further part in the frame - they
					// never enrol, never reach a hook, and never appear in the landing
					// loop. The budget counts what is in flight NOW plus what this frame
					// admits ahead of them, so one oversized frame cannot vault it, and
					// truncating `valid` in place keeps every downstream pass over this
					// frame index-aligned.
					//
					// A topic the grant gate already refused is answered FORBIDDEN even
					// here, because that verdict is about the topic and costs no hook
					// work, while RATE_LIMITED says "ask again". The client retries
					// RATE_LIMITED and only RATE_LIMITED, so handing it that reason for
					// a topic it will never be allowed would arm an endless retry - the
					// same reason the single lane answers its cheap denials first.
					{
						const _headroom = MAX_PENDING_SUBSCRIBES_PER_CONNECTION - pendingSubscribeTotal(userData);
						if (_headroom < valid.length) {
							for (let i = Math.max(_headroom, 0); i < valid.length; i++) {
								sendSubscribeDenied(ws, valid[i], ref, authzDenied?.[i] ? 'FORBIDDEN' : 'RATE_LIMITED');
							}
							valid.length = Math.max(_headroom, 0);
						}
					}

					// Pass 2: gather denial decisions. If a batch hook is exported,
					// call it once (typically backed by a single DB auth query) and
					// use its decisions. Otherwise fall back to the per-topic
					// `subscribe` hook for parity with single-subscribe behaviour.
					// Both paths are awaited so async hooks (the idiomatic style for
					// hooks that touch a session store or DB) gate correctly.
					// Track every topic in this batch as in-flight, exactly as the
					// single-subscribe path does: platform.unsubscribe cannot remove a
					// membership that does not exist yet, so it tombstones the topic and
					// the landing below discards the grant. Without it a revocation
					// arriving during the hook await is lost for batch frames, and once
					// only the single path tracked, a client with the same topic in
					// flight on BOTH made platform.unsubscribe answer `true` while this
					// path installed the membership anyway.
					const batchUd = ws.getUserData();
					const batchTokens = valid.map((t) => beginPendingSubscribe(batchUd, t, batchUd[WS_SUBSCRIPTIONS].has(t)));
					// A topic the grant gate already denied must not reach the hook at
					// all. The single-subscribe path denies before its hook runs; this
					// path used to compute `authzDenied` and then call the hooks over
					// every valid topic anyway, consulting the decision only at the
					// landing. Hooks are not pure - a plugin's subscribe hook joins a
					// roster and establishes its observer tap - so for a denied topic
					// those side effects had already happened by the time the client
					// was told FORBIDDEN: the caller was added to a private topic's
					// roster, broadcast to its real members, handed the full roster,
					// and left holding a live tap. The single-frame asymmetry between
					// the two paths was the whole bug.
					const hookTopics = authzDenied === null
						// Never hand the hook the landing queue itself. Hooks receive
						// ordinary mutable arrays; an in-place filter/sort must not
						// remove or reorder topics after their pending tokens have
						// already been enrolled, otherwise refs go unanswered and the
						// pending entries never settle. The filtered branch already
						// returns a fresh array; copy the all-authorized branch too.
						? valid.slice()
						: valid.filter((_t, i) => !authzDenied[i]);
					const batchDenials = hookTopics.length > 0
						? await runSubscribeBatchHook(ws, hookTopics)
						: null;
					// When falling back to per-topic, run the hooks in parallel so
					// a slow async hook on N topics is one round-trip not N.
					const perTopicDenials = batchDenials === null && wsModule.subscribe
						? await Promise.all(valid.map((t, i) =>
							(authzDenied !== null && authzDenied[i]) ? null : runSubscribeHook(ws, t)))
						: null;

					// Resume-on-subscribe (batch): gap-fill every recover-tagged topic that
					// passed the auth gate in one resume-hook call, before the subscribe loop
					// (so __replay frames precede the first live frame for each recovered topic).
					let _recoverSeqs = null;
					let _recoverEpochs = null;
					// Recovery barrier for the batch cutover: one live-frame buffer per
					// recovered topic, opened before the shared resume await and flushed
					// per topic after that topic subscribes (see the single-subscribe
					// path). Empty behind a synchronous resume.
					let _batchCap = null;
					let _batchCovered;
					if (msg.recover && typeof msg.recover === 'object') {
						for (let i = 0; i < valid.length; i++) {
							const _t = valid[i];
							// This lane sits BETWEEN the hook awaits and the landing, so
							// neither the landing's re-check nor its tombstone covers it -
							// and it is the largest client-named lane there is, handing the
							// app's resume hook a topic's replay history rather than a
							// roster. It therefore re-reads the CURRENT grant set and the
							// revocation instead of trusting the `authzDenied` snapshot
							// taken before the awaits: a revocation that landed while a
							// hook was parked would otherwise still get the history
							// flushed, and the landing would deny the subscription only
							// afterwards - refusing the membership having already served
							// the messages.
							//
							// Under the grant model the CURRENT grant set is the
							// authority, and the revocation epoch is deliberately NOT
							// consulted as well: the epoch only ever rises, so a revoke
							// followed by a re-grant inside the same await window could
							// never clear it, and the gap-fill was refused forever while
							// the landing below acked the subscription - a positive ack
							// and a silently dropped replay. With the gate off there is
							// no grant set to read, so there the epoch is the only signal.
							// MEMBERSHIP FIRST, in every configuration. Reading the epoch
							// only when the socket does NOT hold the topic is what makes a
							// re-grant visible: a re-grant is exactly what puts the topic
							// back in the registry. Restricting that correction to the
							// grant model left the same defect in the two mainstream
							// configurations, since `authorizeWireSubscribe` defaults to
							// false and exporting a subscribe hook is the documented way to
							// keep control. Under the grant model this still reduces to the
							// grant-set test it replaces.
							const _batchSubs = userData[WS_SUBSCRIPTIONS];
							const _revoked = recoverIsRevoked({
								held: _batchSubs instanceof Set && _batchSubs.has(_t),
								// Read FRESH, not from the pre-await `_wireAuthz` snapshot.
								// `subscribeAuth.enabled` is runtime-mutable via
								// platform.authorizeWireSubscribe() and latches false->true, so a
								// gate armed while this batch was parked in its hook left the
								// snapshot reading "off" - and this call serves REPLAY HISTORY.
								// The landing 40 lines below already reads it fresh, so the stale
								// snapshot disclosed a topic's history and then denied the
								// subscription in the same frame.
								// BOTH halves must read the way the LANDING reads them, or the two
								// sites disagree inside one frame - which is how the first version
								// of this repair still served history and then denied. `armed` is
								// fresh at both; `hasUserHook` is the frame's single reading at
								// both, because an app hook appearing or vanishing mid-await must
								// not split one batch across two authorization models.
								wireAuthz: subscribeAuth.enabled && (subscribeAuth.strict || !_hasUserHook),
								cancelled: isPendingSubscribeCancelled(batchUd, _t, batchTokens[i]),
								topic: _t
							});
							// The pre-hook decision comes FIRST, as it did before this lane was
							// rewritten. A topic denied there is filtered out of `hookTopics`, so
							// `batchDenials[_t]` is undefined for it and nothing downstream would
							// catch it: dropping this clause let a pre-denied topic reach the
							// resume hook and have its history served, before the landing denied
							// the subscription it never got.
							const _denial = (authzDenied !== null && authzDenied[i] ? 'FORBIDDEN' : null)
								?? (_revoked ? 'FORBIDDEN' : null)
								?? (batchDenials !== null ? (batchDenials[_t] ?? null) : (perTopicDenials !== null ? perTopicDenials[i] : null));
							if (_denial !== null) continue;
							const _rec = msg.recover[_t];
							if (wantsRecover({ hasResumeHook: wsModule.resume, recover: _rec })) {
								if (_recoverSeqs === null) _recoverSeqs = {};
								_recoverSeqs[_t] = _rec.offset;
								if (Number.isInteger(_rec.epoch)) { if (_recoverEpochs === null) _recoverEpochs = {}; _recoverEpochs[_t] = _rec.epoch; }
							}
						}
						if (_recoverSeqs !== null && wsModule.resume) {
							_batchCap = beginResumeCapture(Object.keys(_recoverSeqs), ws);
							try {
								_batchCovered = await wsModule.resume(ws, { sessionId: ws.getUserData()[WS_SESSION_ID], lastSeenSeqs: _recoverSeqs, lastSeenEpochs: _recoverEpochs || undefined, platform: ws.getUserData()[WS_PLATFORM] });
							} catch (err) { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK), err); }
						}
					}
					let subscribed = 0;
					for (let i = 0; i < valid.length; i++) {
						const topic = valid[i];
						const subs = userData[WS_SUBSCRIPTIONS];
						// The server-grant gate is re-evaluated HERE, against the current
						// grant set, rather than trusting the `authzDenied` reading taken
						// before the awaits. The tombstone below only fires for revocation
						// paths that bump the epoch, so a revocation that merely drops the
						// membership would otherwise let a decision made before the await
						// install a grant the server no longer authorizes. Under the pure
						// grant model this can only deny a topic whose grant disappeared
						// mid-await: an unauthorized one is already false here and reaches
						// the same denial, and an authorized one takes the idempotent-ack
						// branch below.
						// Read once and handed to both decisions below. Nothing between
						// here and the subscribe mutates `subs` for this topic, and the
						// inline spelling this replaces asked the same Set twice.
						const held = subs.has(topic);
						const denial = (deniesWireSubscribeLanding({ armed: subscribeAuth.enabled, hasUserHook: _hasUserHook && !subscribeAuth.strict, held, topic }) ? 'FORBIDDEN' : null)
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
								wsModule.unsubscribe?.(ws, topic, { platform: batchUd[WS_PLATFORM] });
							}
							sendSubscribeDenied(ws, topic, ref, denial);
							continue;
						}
						// Post-await re-check: idempotent ack on race with another
						// concurrent subscribe.
						if (held) {
							// Same provenance read as the single lane: a revoked
							// attempt whose own hook installed the membership must
							// not ack it.
							const heldVerdict = settleHeldSubscribe(batchUd, topic, batchTokens[i]);
							if (heldVerdict === 'ack') {
								sendSubscribed(ws, topic, ref);
								continue;
							}
							if (heldVerdict === 'deny-unwind') {
								unwindRevokedMembership(ws, topic);
								wsModule.unsubscribe?.(ws, topic, { platform: batchUd[WS_PLATFORM] });
							}
							sendSubscribeDenied(ws, topic, ref, 'FORBIDDEN');
							continue;
						}
						if (exceedsSubscriptionCap({ held, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
							settlePendingSubscribe(batchUd, topic, batchTokens[i]);
							sendSubscribeDenied(ws, topic, ref, 'RATE_LIMITED');
							continue;
						}
						// Revocation tombstone: a platform.unsubscribe that landed during
						// the hook or resume awaits cancelled this topic - discard the
						// grant and answer the client truthfully rather than acking it.
						if (!settlePendingSubscribe(batchUd, topic, batchTokens[i], true)) {
							sendSubscribeDenied(ws, topic, ref, 'FORBIDDEN');
							continue;
						}
						try { ws.subscribe(topic); }
						catch { counters.closedWsAborts++; continue; }
						addLogicalSubscription(subs, topic);
						subscribed++;
						// Flush frames held for this topic during the resume window, in
						// order, before it starts receiving live frames.
						if (_batchCap) {
							// Batch: honor only a per-topic map watermark; a bare number is ambiguous
							// across topics (it would apply one floor to all and could wrongly skip a
							// lagging topic), so ignore it here - the pre-window floor covers that topic.
							const _cov = (_batchCovered !== null && typeof _batchCovered === 'object') ? coveredSeqFor(_batchCovered, topic) : undefined;
							// A close here ends the connection, so the topics after this one
							// have nobody to ack and nothing to flush to. Stop the loop; the
							// sweep below still closes their buffers, and it reads no socket.
							if (flushResumeTopic(_batchCap, topic, _cov)) break;
						}
						if (sharedTopics.has(topic)) joinSharedCohort(ws, userData, topic, sharedTopics.get(topic));
						sendSubscribed(ws, topic, ref);
					}
					// Close any buffers not flushed above (a recovered topic that was
					// denied, rate-limited, raced, or failed to subscribe) so none stays
					// registered capturing frames.
					if (_batchCap) discardResumeCapture(_batchCap);
					if (wsDebug) console.log('[ws] subscribe-batch count=%d', subscribed);
					return;
				}
				if (msg.type === 'reply' && hasRef(msg.ref)) {
					// Reply to a server-initiated request. Look up the pending
					// promise on this connection's userData, clear its timeout,
					// and resolve / reject accordingly. Refs scoped per-WS so a
					// stray reply from one connection cannot affect another.
					const pending = ws.getUserData()[WS_PENDING_REQUESTS];
					const entry = pending?.get(msg.ref);
					if (entry) {
						assert(typeof entry.resolve === 'function', 'request.entry-resolve-shape', { ref: msg.ref });
						assert(typeof entry.reject === 'function', 'request.entry-reject-shape', { ref: msg.ref });
						pending.delete(msg.ref);
						clearTimer(entry.timer);
						if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
						else entry.resolve(msg.data);
					}
					return;
				}
				if (msg.type === 'hello' && Array.isArray(msg.caps)) {
					// Capability negotiation. Old clients never send 'hello',
					// so the absence of the WS_CAPS slot is the safe-default
					// "no opt-in features" signal that publishBatched relies
					// on to fall back to N individual frames per connection.
					const caps = new Set();
					for (let i = 0; i < msg.caps.length; i++) {
						if (typeof msg.caps[i] === 'string') caps.add(msg.caps[i]);
					}
					const ud = ws.getUserData();
					// Maintain the live per-capability connection counts so the
					// binary publish fast path knows whether any client wants
					// binary. A re-sent hello replaces the prior set; diff it.
					capCounts.adjust(ud[WS_CAPS], caps);
					ud[WS_CAPS] = caps;
					// Opt-in arm for internal flow control. Presence of the cap
					// turns the connection window-managed; absence keeps the
					// immediate send path byte-identical. Only the first hello
					// allocates the slot and emits the first window so a
					// re-sent hello (lazy-plugin re-advertise) does not reset it.
					if (caps.has('lease') && !ud[WS_LEASE]) {
						// The server is grant-and-observe, not enforcing: it sizes
						// and hands out windows the client paces itself against, and
						// reads pressureValue() for the worker saturation scalar. It
						// never consumes a permit (no tryAcquire here) - the same
						// state machine's acquire/enqueue surface is the CLIENT's,
						// where the flood risk lives and the pacing is enforced.
						const g = grantSizeFor();
						const window = createLeaseState({ requestCount: g.count, ttlMs: g.ttlMs });
						window.grant();
						ud[WS_LEASE] = { gate: window, saturation: window.pressureValue() };
						// Echo that the capability is honoured, then hand out
						// the first window. Additive: old clients never sent the
						// cap so never receive these.
						const echo = '{"type":"lease-ok"}';
						ws.send(echo, false, false);
						bumpOut(ws, echo);
						const frame = leaseGrantFrame(g.count, g.ttlMs);
						ws.send(frame, false, false);
						bumpOut(ws, frame);
					}
					// Opt-in confirm for binary ingress. When the client advertised
					// the ingress cap, echo `ingress-ok` (mirror of lease-ok) so it
					// knows this server understands ingress and may announce
					// bindings. Old clients never send the cap, so never receive it.
					if (caps.has(WIRE_INGRESS_CAP)) {
						const okFrame = ingressOkFrame();
						ws.send(okFrame, false, false);
						bumpOut(ws, okFrame);
					}
					if (wsDebug) console.log('[ws] hello caps=%o', [...caps]);
					return;
				}
				if (msg.type === 'resume' && typeof msg.sessionId === 'string' &&
					msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
					// Client presents the previous session id plus per-topic
					// lastSeenSeqs so the user's resume hook can fill the gap
					// (typically by calling replay.replay(ws, topic, sinceSeq, platform)
					// for each topic). The hook is optional - if unset, we still
					// ack so the client can switch to live mode.
					assert(ws.getUserData()[WS_PLATFORM], 'ws.platform-missing-in-resume', null);
					// Per-topic generation the client last saw, parallel to
					// lastSeenSeqs and keyed the same. Additive: an old client
					// omits it, and the hook then treats every topic as a match
					// (gap-fill as before). Forwarded raw so the hook compares
					// each topic's presented epoch to the live one
					// (`platform.topicEpoch(topic)`) and chooses gap-fill on a
					// match or cold-rehydrate on a mismatch - never serving a
					// seq space that has since reset as if it were contiguous.
					const lastSeenEpochs = (msg.lastSeenEpochs && typeof msg.lastSeenEpochs === 'object')
						? msg.lastSeenEpochs
						: undefined;
					// The resume lane is CLIENT-NAMED: the frame carries the topics,
					// and the app's hook typically answers each one with its replay
					// buffer. Under the pure-grant model that is the largest of the
					// observer lanes - it yields a topic's message history, not just
					// a roster - so an ungranted topic is dropped here before the
					// hook sees it, exactly as the wire subscribe and the plugin
					// observer lanes are gated. Filtered rather than refused whole:
					// a resume names many topics at once and a client legitimately
					// holds some of them, so dropping only the ungranted ones keeps
					// a reconnect working while serving nothing it was not granted.
					// Untouched when the gate is off or an app hook owns the topic
					// decision, which is the same condition the other lanes use.
					let resumeSeqs = msg.lastSeenSeqs;
					if (subscribeAuth.enabled && (subscribeAuth.strict || !hasUserSubscribeHook())) {
						const _grants = ws.getUserData()[WS_SUBSCRIPTIONS];
						/** @type {Record<string, unknown>} */
						const _allowed = Object.create(null);
						let _dropped = 0;
						for (const _t of Object.keys(resumeSeqs)) {
							if (deniesUngrantedObserve(true, false, _grants, _t)) { _dropped++; continue; }
							_allowed[_t] = resumeSeqs[_t];
						}
						if (_dropped > 0) resumeSeqs = _allowed;
					}
					if (wsModule.resume) {
						try {
							// Await the hook so per-topic replay flushes
							// __replay frames before the `resumed` ack
							// tells the client to switch to live mode -
							// otherwise live publishes can arrive ahead of
							// gap-fill frames and produce out-of-order
							// events. Replay backends emit `denied` on
							// `__replay:{topic}` for denied subscribes;
							// the client store handles it like `truncated`.
							await wsModule.resume(ws, {
								sessionId: msg.sessionId,
								lastSeenSeqs: resumeSeqs,
								lastSeenEpochs,
								platform: ws.getUserData()[WS_PLATFORM]
							});
						} catch (err) {
							emitOperationalEvent({
								source: 'svelte-adapter-uws',
								component: 'runtime.resume',
								event: 'resume.hook-failed',
								severity: 'error',
								dataClass: 'pseudonymous',
								message: 'The resume hook threw; the client falls back to a fresh subscribe.',
								attributes: { error: diagnosticError(err) }
							});
						}
					}
					// No recovery barrier here: this frame installs no live membership (it
					// never calls ws.subscribe), so there is no atomic cutover window in THIS
					// branch to bridge. A client makes topics live through separate subscribe
					// frames; when those carry a recover offset the barrier runs there. A
					// legacy client that follows a standalone resume with plain (no-recover)
					// subscribes has an unprotected window, but a buffer here cannot close it
					// (it would have to span the client's separate round-trip), so that
					// residual gap is a limitation of the standalone frame, not fixable here.
					ws.send('{"type":"resumed"}', false, false);
					bumpOut(ws, '{"type":"resumed"}');
					if (wsDebug) console.log('[ws] resume sessionId=%s', msg.sessionId);
					return;
				}
				if (msg.type === 'request-n') {
					// Window-replenish request from an opted-in connection.
					// Re-grant from the current worker posture and hand the
					// client a fresh window. Connections that never opted in
					// have no slot; the request is a no-op for them.
					const slot = ws.getUserData()[WS_LEASE];
					if (slot) {
						const g = grantSizeFor();
						slot.gate.requestN(g.count, g.ttlMs);
						const frame = leaseGrantFrame(g.count, g.ttlMs);
						ws.send(frame, false, false);
						bumpOut(ws, frame);
						slot.saturation = slot.gate.pressureValue();
						if (slot.saturation > counters.leaseSaturationPeak) counters.leaseSaturationPeak = slot.saturation;
					}
					return;
				}
				if (msg.type === 'ingress-bind' && typeof msg.id === 'number' && typeof msg.kind === 'string') {
					// Client binds a client-allocated ingress id to a decode+route
					// destination (mirror of the server's `wire-id` announce, reversed).
					// Resolve the kind to a registered handler; on success store the
					// binding and ack with `ingress-bound` so the client promotes this
					// id to binary. An unknown kind gets no binding and no ack - the
					// client keeps that destination on its JSON fallback, never a
					// silent drop.
					const ud = ws.getUserData();
					if (bindIngress(ud, ws, msg.id, msg.kind, msg.target)) {
						const boundFrame = ingressBoundFrame(msg.id);
						ws.send(boundFrame, false, false);
						bumpOut(ws, boundFrame);
					} else if (wsDebug) {
						console.log('[ws] ingress-bind for unregistered kind=%s (kept on JSON fallback)', msg.kind);
					}
					return;
				}
				if (msg.type === 'game') {
					// Client-driven relay publish (the game lane). The connection must
					// hold a publish grant (bound server-side via platform.grantPublish);
					// the topic IS that grant, never client-supplied, so a client can
					// never publish to a room it did not join. Ungranted (or a malformed
					// event) -> game-denied. Granted -> stamp the per-room seq, fan out to
					// the room excluding this sender, and echo the client id.
					// `data` carries the raw frame so the byte-rate buckets charge
					// this lane like every other application-work lane; the game
					// work itself reads only `msg`.
					await runAdmittedMessageWork(messageAdmission, ws, { msg, platform, data: message }, runGameApplicationWork, rejectApplicationMessage);
					return;
				}
			}
			// Delegate everything else to the user's handler (if provided).
			// `msg` is the JSON-parsed envelope when the prefix matched + parsed
			// to an object + no control type matched; otherwise undefined.
			await runAdmittedMessageHook(messageAdmission, wsModule.message, ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] }, rejectApplicationMessage);
		},

		dropped: (_ws, message) => {
			// uWS owns `message` and guarantees it only for this callback. Retain
			// the exact event and byte count, never the transient ArrayBuffer.
			recordBackpressureDrop(counters, message);
		},

		drain: (ws) => {
			assert(ws.getUserData()[WS_PLATFORM], 'ws.platform-missing-in-drain', null);
			// Resume any sendCoalesced traffic held back by backpressure
			// before delegating to the user's drain hook.
			flushCoalescedFor(ws);
			wsModule.drain?.(ws, { platform: ws.getUserData()[WS_PLATFORM] });
		},

		close: (ws, code, message) => {
			const userData = ws.getUserData();
			messageAdmission.close(ws);
			assert(userData[WS_PLATFORM], 'ws.platform-missing-in-close', null);
			const subscriptions = userData[WS_SUBSCRIPTIONS] || new Set();
			// Reject any in-flight server-initiated requests so callers stop
			// awaiting promises that can never resolve. Clearing the timer
			// avoids the close-then-timer race that would otherwise reject
			// twice (delete from the map first so the timer's check is a no-op).
			const pending = userData[WS_PENDING_REQUESTS];
			if (pending && pending.size > 0) {
				for (const entry of pending.values()) {
					clearTimer(entry.timer);
					try {
						entry.reject(new Error(adapterErrorMessage(
							ADAPTER_ERROR_IDS.REQUEST_CLOSED,
							entry.sent
								? REQUEST_CLOSED_DETAIL.UNANSWERED
								: REQUEST_CLOSED_DETAIL.NEVER_SENT
						)));
					} catch {}
				}
				pending.clear();
			}
			// Build the per-connection stats meta when a close hook exists.
			// Counters were populated by the bumpIn / bumpOut helpers across
			// the connection's lifetime; this is the single read site.
			const stats = userData[WS_STATS];
			const closePlatform = userData[WS_PLATFORM];
			const ctx = stats
				? {
					code,
					message,
					platform: closePlatform,
					subscriptions,
					id: userData[WS_SESSION_ID],
					duration: monotonicNow() - stats.openedAt,
					messagesIn: stats.messagesIn,
					messagesOut: stats.messagesOut,
					bytesIn: stats.bytesIn,
					bytesOut: stats.bytesOut
				}
				: { code, message, platform: closePlatform, subscriptions };
			try {
				// The app close hook mirrors the app open hook: a connection
				// refused at open (a failed attribution) never ran open, so
				// close stays silent for it too - a counter paired across
				// open/close must not go negative on a refusal. The session id
				// is stamped immediately after the refusal point, so its
				// absence marks exactly the connections whose open hook never
				// ran. Everything in the finally still runs for them.
				if (userData[WS_SESSION_ID] !== undefined) wsModule.close?.(ws, ctx);
			} finally {
				if (userData[WS_CONNECTION_PERMIT]) {
					userData[WS_CONNECTION_PERMIT] = undefined;
					admission.releaseConnection();
					gConnectionHeadroom?.set(admission.connectionHeadroom);
				}
				accountClosedLogicalSubscriptions(subscriptions);
				// Release this connection's advertised capabilities from the
				// live counts so the binary publish fast path stays accurate.
				capCounts.adjust(userData[WS_CAPS], null);
				// Dispose any per-connection wire-codec state (e.g. the cursor
				// short-id dictionary) so a long-lived server frees it promptly.
				detachWireStates(ws, userData);
				// Release each shared-topic wire-id reference this connection held so
				// the server-wide id table reclaims a topic on its last cohort leave.
				// uWS drops the cohort subscriptions themselves natively on close.
				const sharedCohorts = userData[WS_SHARED_COHORTS];
				if (sharedCohorts) { for (const t of sharedCohorts) releaseSharedWireId(t); }
				// Free the per-connection send-gate slot (only present when the
				// connection opted into internal flow control).
				if (userData[WS_LEASE]) userData[WS_LEASE] = undefined;
				wsConnections.delete(ws);
				if (wsDebug) console.log('[ws] close code=%d connections=%d', code, wsConnections.size);
			}
		},

		maxPayloadLength: wsOptions.maxPayloadLength,
		idleTimeout: wsOptions.idleTimeout,
		maxBackpressure: wsOptions.maxBackpressure,
		closeOnBackpressureLimit: wsOptions.closeOnBackpressureLimit,
		sendPingsAutomatically: wsOptions.sendPingsAutomatically,
		compression: typeof wsOptions.compression === 'number'
			? wsOptions.compression
			: wsOptions.compression
				? uWS.SHARED_COMPRESSOR
				: uWS.DISABLED
	});

	// app.ws handles real handshakes. Register this GET afterwards so a direct
	// browser navigation can receive the opted-out accessible refusal without
	// shadowing upgrades. When the gate is open, this endpoint is not a
	// capacity page and retains the ordinary Upgrade Required response.
	// uWS routes a GET without sec-websocket-key PAST the ws() handler
	// (req.setYield on a non-handshake), so a real browser NAVIGATION to the
	// WS path never reaches serveUpgradeRefusal - without this route it would
	// fall through to the SSR catch-all. Registered for EVERY enabled ceiling
	// resolveWaitingRoom() honors, including perTickBudget, whether the
	// waiting room is on (holding page) or opted out (accessible 503).
	if (admission.maxConcurrent > 0 || admission.maxConnections > 0 || ADMISSION_PER_TICK_BUDGET > 0) {
		route('get', WS_PATH, (res, req) => {
			res.onAborted(() => {});
			const atCapacity = postureLevel() === 'siege' || !admission.hasCapacity();
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
					// Same page the refusal path serves: no seeded count, the
					// first poll fills it in.
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

	console.log(`[svelte-adapter-uws] WebSocket endpoint registered at ${WS_PATH}`);
	if (WS_PATH !== '/ws') {
		console.log(`[svelte-adapter-uws] Client must match: connect({ path: '${WS_PATH}' })`);
	}

	startPressureSampling(wsOptions.pressure, OS_PRESSURE_SOURCES ?? undefined);
}

// Health check endpoint (before catch-all so it never hits SSR). This is a
// LIVENESS probe: it reports 200 whenever the process is up, INCLUDING during a
// graceful drain - so a k8s liveness probe never restarts a pod mid-shutdown.
if (HEALTH_CHECK_PATH) {
	route('get', HEALTH_CHECK_PATH, (res) => {
		res.cork(() => {
			res.writeStatus('200 OK').end('OK');
		});
	});
}

// Readiness endpoint (before catch-all so it never hits SSR). This is a
// READINESS probe, distinct from liveness: it reports 200 when ready and 503
// whenever this instance must not be sent new traffic, so a fronting load
// balancer stops routing NEW traffic while in-flight requests finish. Keep it
// separate from `healthCheckPath` so a single endpoint is never used for both
// purposes (a readiness 503 must NOT trip a liveness probe into a restart).
//
// THE BODY IS THE LIFECYCLE STATE, not a fixed word. Not-ready covers `starting`
// (bound, but the app's init has not committed) as well as `draining` and
// `closed`, and those mean opposite things to an operator: during a rolling
// deploy every freshly started instance would otherwise report that it is
// draining, which reads as a stuck or reversed rollout. The routing decision is
// the same for all of them - which is why it stays isDraining() - but the word
// an operator reads has to say which one it is.
if (READINESS_CHECK_PATH) {
	route('get', READINESS_CHECK_PATH, (res) => {
		if (isDraining()) {
			const state = lifecycleState();
			res.cork(() => {
				res.writeStatus('503 Service Unavailable').end(state);
			});
		} else {
			res.cork(() => {
				res.writeStatus('200 OK').end('ready');
			});
		}
	});
}

// Reserved admin / observability route. When the app's WebSocket handler
// exports an `admin(request)` function (svelte-realtime's auth-gated
// introspection handler), mount it at the configured prefix
// (`websocket.adminPath`, default `/__realtime`) before the catch-all so admin
// traffic never hits SSR. `websocket.adminPath: false` disables the auto-mount
// for apps that mount it themselves (e.g. a SvelteKit `+server.js` route with
// their own middleware). All authorization lives in the app handler; the
// adapter is pure request/response plumbing.
const ADMIN_PATH = (WS_OPTIONS && WS_OPTIONS.adminPath !== undefined) ? WS_OPTIONS.adminPath : '/__realtime';
if (WS_ENABLED && ADMIN_PATH !== false && typeof wsModule.admin === 'function') {
	route('any', ADMIN_PATH + '/*', handleAdminRequest);
	console.log(`[svelte-adapter-uws] Admin route registered at ${ADMIN_PATH}/*`);
	// The adapter cannot see whether the app's admin() handler gates its own
	// requests, so it says so once at boot. An operator who HAS gated it sets
	// `adminAuthAcknowledged: true` to silence the line - a warning that
	// cannot be turned off after the operator has acted on it is how a log
	// learns to be ignored, which costs more than it buys.
	if (!(WS_OPTIONS && WS_OPTIONS.adminAuthAcknowledged)) {
		console.warn(
			`[svelte-adapter-uws] Warning: Admin route ${ADMIN_PATH}/* is mounted with NO adapter-level ` +
			'authentication. It is publicly reachable unless the app\'s admin() ' +
			'handler gates it (e.g. by validating a session cookie or bearer token). ' +
			'Set websocket.adminAuthAcknowledged: true once it is gated to silence this.'
		);
	}
}

// Register HTTP handler (after WS so the WS route takes priority)
route('any', '/*', handleRequest);

// - In-flight request tracking -------------------------------------------


// - Exports -----------------------------------------------------------------
