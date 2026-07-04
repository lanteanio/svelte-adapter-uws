import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { parentPort, threadId } from 'node:worker_threads';
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
import { parseCookies, createCookies } from './cookies.js';
import { mimeLookup, parse_as_bytes, parse_origin, writeChunkWithBackpressure, drainCoalesced, computePressureReason, computeTopPublishers, nextTopicSeq, createHlc, processEpoch, completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey, esc, isValidWireTopic, createScopedTopic, isOriginAllowed, isAuthOriginAccepted, describeUnsafeSameOriginConfig, addressScope, createUpgradeAdmission, negotiateRejection, isCursorLaneUpgrade, resolveWaitingRoom, createPollCounter, containMetricInstrument, readFdLimits, countOpenFds, applyCapacityReason, createPosture, resolveRequestId, assert, fatal, readAssertionCounts, wireAssertionMetrics, WS_SUBSCRIPTIONS, WS_COALESCED, WS_SESSION_ID, WS_PENDING_REQUESTS, WS_STATS, WS_PLATFORM, WS_REQUEST_ID_KEY, WS_CAPS, WS_TOPIC_IDS, WS_WIRE_STATE, WS_LEASE, WS_SHARED_COHORTS, MAX_SUBSCRIPTIONS_PER_CONNECTION, MAX_PENDING_REQUESTS_PER_CONNECTION, MAX_COALESCED_KEYS_PER_CONNECTION, TOPIC_SEQS_WARN_THRESHOLD, PUBLISH_WARN_DEDUP_MAX } from './utils.js';
import { buildBinaryFrame, allocWireId, wireIdAnnounce, createCapCounts, createLeaseState, leasePressureValue, leaseGrantSize, samplePressureValue, leaseGrantFrame, DEFAULT_GRANT } from './wire.js';
import { dispatchIngressFrame, bindIngress, ingressOkFrame, ingressBoundFrame, WIRE_INGRESS_CAP } from './handler/ingress.js';
import { now, monotonicNow, randomUuid, randomFloat, randomU32, randomBytes, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from './runtime.js';
import { statePool, envelopePrefixCache, staticCache, prerenderedDirStyle, wsConnections, topicSeqs, topicPublishStats, pressureSnapshot, pressureListeners, publishRateListeners, lastPublishWarnAt, capCounts, decodeCache, counters, maxSeenSeq, sharedTopics } from './handler/state.js';
import { computeStateHash } from './invariants.js';
import { createConsistencyAuditor } from './auditor.js';
import { buildConnectionAuditSnapshot } from './audit-snapshot.js';
import { PayloadTooLargeError, METHODS, send400, send413, send500 } from './handler/http-helpers.js';
import { acquireState, releaseState } from './handler/state-pool.js';
import { ENVELOPE_CACHE_MAX, envelopePrefix } from './handler/envelope-cache.js';
import { batchRelay } from './handler/relay.js';
import { readHlc } from './handler/hlc.js';
import { textDecoder, ssl_cert, ssl_key, is_tls, origin, xff_depth, address_header, protocol_header, host_header, port_header, body_size_limit, resolveClientIp, _t_app, app, wsDebug, closeHookRegistered, get_origin, WS_COMPRESSION_ON } from './handler/config.js';
import { cacheDir, clientDir, prerenderedDir, _t_static, serveStatic, DECODE_CACHE_MAX, tryPrerendered } from './handler/static-assets.js';
import { bumpIn, bumpOut, maybeWarnTopicRegistry, BATCH_FRAME_WARN_BYTES, warnLargeBatchFrame, grantSizeFor, resolvePressureThresholds, startPressureSampling, stopPressureSampling } from './handler/pressure-metrics.js';
import { hasRef, runSubscribeHook, runSubscribeBatchHook, runUserSubscribeGate, sendSubscribed, sendSubscribeDenied, flushCoalescedFor } from './handler/subscribe-hooks.js';
import { ensureWireId, ensureWireState, wireStatePoisoned, poisonWireState, detachWireStates } from './handler/wire-state.js';
import { joinSharedCohort, leaveSharedCohort } from './handler/cohort.js';
import { releaseSharedWireId } from './handler/shared-wire-id.js';
import { setCohortHooks } from './utils.js';

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
import { platform } from './handler/platform.js';
import { readBody, handleSSR } from './handler/ssr.js';
import { requestDone, isDraining } from './handler/lifecycle.js';
export { drain, start, shutdown, getDescriptor, relayPublish, relayPublishBatched } from './handler/lifecycle.js';
import { handleRequest } from './handler/request.js';
import { handleAdminRequest } from './handler/admin.js';

/* global ENV_PREFIX */
/* global PRECOMPRESS */
/* global WS_ENABLED */
/* global WS_PATH */
/* global WS_OPTIONS */
/* global WS_AUTH_PATH */
/* global HEALTH_CHECK_PATH */
/* global READINESS_CHECK_PATH */
/* global STATIC_HEADERS */


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


cacheDir(path.join(clientDir, base), base, true, STATIC_HEADERS);
cacheDir(path.join(prerenderedDir, base), base, false, STATIC_HEADERS);
console.log(`Static files indexed in ${(monotonicNow() - _t_static).toFixed(1)}ms (${staticCache.size} entries)`);

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
		'Warning: No ORIGIN, HOST_HEADER, or PROTOCOL_HEADER configured. ' +
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


 // 512 KB

/**
 * @typedef {{ status: number, statusText: string, headers: [string, string][], body: Uint8Array }} SharedResponse
 */


// - Body reading ------------------------------------------------------------

 // 64 KB


// - Static file serving -----------------------------------------------------


// - Prerendered page check --------------------------------------------------


// - SSR handler -------------------------------------------------------------


// - Response writer (with backpressure) -------------------------------------


// - Main request handler ----------------------------------------------------


// - WebSocket support -------------------------------------------------------

// WS_ENABLED is set by the adapter at build time - no inference from exports needed
if (WS_ENABLED) {
	// Warn about unrecognized exports - catches typos like "mesage" or "opn"
	const knownWsExports = new Set([
		'init', 'shutdown',
		'open', 'message', 'upgrade', 'close', 'drain',
		'subscribe', 'subscribeBatch', 'unsubscribe',
		'authenticate', 'resume', 'admin'
	]);
	for (const name of Object.keys(wsModule)) {
		if (!knownWsExports.has(name)) {
			console.warn(
				`Warning: WebSocket handler exports unknown "${name}". ` +
				`Did you mean one of: ${[...knownWsExports].join(', ')}?\n` +
				'  See: https://svti.me/ws-hooks'
			);
		}
	}

	// One-shot runtime warning when a user upgrade handler attaches Set-Cookie
	// to the 101 Switching Protocols response. Cloudflare Tunnel and some other
	// strict edge proxies silently close WebSocket connections with 1006 when
	// the 101 carries Set-Cookie. The `authenticate` hook refreshes cookies
	// over a normal HTTP response and works behind every proxy.
	let warnedSetCookieOnUpgrade = false;
	/** @param {Record<string, string | string[]> | null | undefined} responseHeaders */
	function maybeWarnSetCookieOnUpgrade(responseHeaders) {
		if (warnedSetCookieOnUpgrade || !responseHeaders) return;
		for (const k of Object.keys(responseHeaders)) {
			if (k.toLowerCase() === 'set-cookie') {
				warnedSetCookieOnUpgrade = true;
				console.warn(
					'[adapter-uws] Set-Cookie on the 101 upgrade response is rejected by ' +
					'Cloudflare Tunnel and some other edge proxies (WebSocket opens, then ' +
					'closes with 1006 TCP FIN). Migrate to the `authenticate` hook to ' +
					'refresh session cookies over a normal HTTP response: ' +
					'export function authenticate({ cookies }) { cookies.set(...); }\n' +
					'  See: https://svti.me/cf-cookies'
				);
				return;
			}
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
	// broadcasts. Apps that intentionally route public topics through the
	// `__` prefix can opt in via `websocket.allowSystemTopicSubscribe`.
	const ALLOW_SYSTEM_TOPIC_SUBSCRIBE = wsOptions.allowSystemTopicSubscribe === true;

	// Wire topics default to printable ASCII only - the loop in
	// `isValidWireTopic` rejects characters outside 0x20-0x7E (plus the
	// always-illegal `"` 0x22 and `\\` 0x5C). This closes a class of
	// look-alike attacks (Unicode line separators U+2028/9, RTL override
	// U+202E, BOM U+FEFF) and keeps the wire trivially log-safe. Apps
	// that legitimately use non-ASCII topic names can opt in.
	const ALLOW_NON_ASCII_TOPICS = wsOptions.allowNonAsciiTopics === true;

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
	// Excess entries are evicted by lowest activity score during the 60s sweep.
	const MAX_RATE_ENTRIES = 10000;
	/** @type {Map<string, { prev: number, curr: number, windowStart: number }>} */
	const upgradeRateMap = new Map();
	// One-shot guard for the proxy-collapse advisory below. The per-IP upgrade
	// limit silently degrades to a single GLOBAL cap when the server sits behind
	// an address-rewriting proxy (docker userland-proxy, an L4 load balancer, a
	// non-XFF proxy) and ADDRESS_HEADER is unset: every client then shares one
	// gateway address, so the rate map has one key for the whole site.
	let warnedRateLimitProxyCollapse = false;

	// Upgrade admission control. Both layers opt-in via WebSocketOptions
	// (`upgradeAdmission: { maxConcurrent, perTickBudget }`); zero or unset
	// means disabled. State + queue live inside the factory closure.
	const admission = createUpgradeAdmission(wsOptions.upgradeAdmission);
	const ADMISSION_PER_TICK_BUDGET = wsOptions.upgradeAdmission?.perTickBudget ?? 0;

	// Content-negotiated rejection for over-capacity upgrades. Resolved once
	// here (or null when off); when null the gate emits today's bare 503.
	// On by default whenever the gate can reject (`maxConcurrent > 0`); the
	// escape is `waitingRoom: false`.
	const WAITING_ROOM = resolveWaitingRoom(wsOptions.upgradeAdmission);

	// Admission observability. Opt-in via the `metrics` option - a module path
	// (`websocket.metrics`) whose default export is a registry shaped like the
	// extensions `createMetrics()` (positional counter/gauge factories). The build
	// bundles it; the runtime imports it here (via the bridge) and also exposes it
	// on `platform.metrics` for a scrape route. Instruments resolve once; every
	// emit is optional-chained, so the disabled path (registry null) costs one
	// undefined check per site and the accept path allocates nothing.
	const METRICS = metricsRegistry;
	const mUpgradeAdmitted = containMetricInstrument(METRICS?.counter(
		'upgrade_admitted_total', 'WebSocket upgrades accepted'
	));
	const mUpgradeRejected = containMetricInstrument(METRICS?.counter(
		'upgrade_rejected_total', 'WebSocket upgrades rejected before open', ['reason']
	));
	const mPostureTransitions = containMetricInstrument(METRICS?.counter(
		'protection_posture_transitions_total', 'Protection posture level changes', ['from', 'to']
	));
	const gPostureState = containMetricInstrument(METRICS?.gauge(
		'protection_posture_state', 'Current protection posture (0 normal, 1 elevated, 2 siege)'
	));
	const gUpgradeInflight = containMetricInstrument(METRICS?.gauge(
		'upgrade_inflight', 'Upgrades currently in flight between admission and open'
	));
	const gQueueDepth = containMetricInstrument(METRICS?.gauge(
		'waiting_room_queue_depth', 'Clients currently polling the waiting room'
	));
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
		const reportStateHash = () => {
			/** @type {Record<string, number>} */
			const topicSeqsProjection = {};
			for (const [t, s] of maxSeenSeq) topicSeqsProjection[t] = s;
			const hash = computeStateHash({ topicSeqs: topicSeqsProjection });
			parentPort.postMessage({ type: 'state-hash', hash, threadId, intervalMs: STATE_HASH_INTERVAL_MS });
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
				console.warn(
					'[ws] protection posture %s -> %s rejected/s=%d pressure=%s',
					from, to,
					counters.activePosture !== null ? counters.activePosture.rejectedPerSecond : 0,
					counters.lastBasePressureReason
				);
			}
		});

	// Gauge sampling rides the existing 1 Hz pressure timer - no new timer.
	// Always assigned (hook or null) so a factory re-run replaces any previous
	// hook and a stale closure can never outlive its server.
	// Counting open fds is a directory read whose cost scales with the count
	// itself, so it rides every 5th sample (~5s) instead of every tick. Seeded
	// one below the modulus so the very first sample publishes a value.
	let fdSampleTick = 4;
	counters.metricsSampleHook = METRICS == null ? null : () => {
		const lvl = postureLevel();
		gPostureState?.set(lvl === 'siege' ? 2 : lvl === 'elevated' ? 1 : 0);
		gUpgradeInflight?.set(admission.inFlight);
		gQueueDepth?.set(queueDepthProbe !== null ? queueDepthProbe() : 0);
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
		// 1. Purge rate-limit entries whose entire two-window history has expired,
		//    then evict the least active entries if the map exceeds the cap.
		//    Two windows must elapse with no activity before an entry is stale  -
		//    after one window the previous slot still contributes to the estimate.
		if (UPGRADE_MAX_PER_WINDOW > 0) {
			const t = now();
			for (const [ip, entry] of upgradeRateMap) {
				if (t - entry.windowStart >= 2 * UPGRADE_WINDOW_MS) upgradeRateMap.delete(ip);
			}
			if (upgradeRateMap.size > MAX_RATE_ENTRIES) {
				const sorted = [...upgradeRateMap.entries()].sort(
					(a, b) => (a[1].prev + a[1].curr) - (b[1].prev + b[1].curr)
				);
				const excess = upgradeRateMap.size - MAX_RATE_ENTRIES;
				for (let i = 0; i < excess; i++) upgradeRateMap.delete(sorted[i][0]);
			}
		}
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

		app.post(authPath, (res, req) => {
			/** @type {Record<string, string>} */
			const authHeaders = {};
			req.forEach((k, v) => { authHeaders[k] = v; });
			const method = 'POST';
			const url = req.getUrl() + (req.getQuery() ? '?' + req.getQuery() : '');
			const clientIp = resolveClientIp(textDecoder.decode(res.getRemoteAddressAsText()), authHeaders);

			if (AUTH_PATH_REQUIRE_ORIGIN && !isAuthOriginAccepted(authHeaders, {
				allowedOrigins,
				hostHeader: host_header,
				protocolHeader: protocol_header,
				portHeader: port_header,
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

			const state = acquireState();
			res.onAborted(() => { state.aborted = true; });

			const contentLength = parseInt(authHeaders['content-length'], 10);
			if (!isNaN(contentLength) && contentLength > AUTH_BODY_LIMIT) {
				send413(res);
				releaseState(state);
				return;
			}

			const body = readBody(res, AUTH_BODY_LIMIT, state, isNaN(contentLength) ? -1 : contentLength);

			const base_origin = origin || get_origin(authHeaders);
			const request = new Request(base_origin + url, {
				method,
				headers: authHeaders,
				body,
				// @ts-expect-error
				duplex: 'half'
			});

			const cookies = createCookies(authHeaders['cookie']);

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

			Promise.resolve()
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
					if (state.aborted) return;
					if (err instanceof PayloadTooLargeError) {
						send413(res);
						return;
					}
					console.error('[adapter-uws] authenticate error:', err);
					if (!state.aborted) send500(res);
				})
				.finally(() => { releaseState(state); });
		});

		// Reject non-POST verbs on the auth path so GET/HEAD do not fall through
		// to the SSR catch-all (which would try to render a SvelteKit route).
		app.any(authPath, (res) => {
			res.cork(() => {
				res.writeStatus('405 Method Not Allowed');
				res.writeHeader('allow', 'POST');
				res.writeHeader('content-type', 'text/plain');
				res.end('Method Not Allowed');
			});
		});

		console.log(`WebSocket auth endpoint registered at ${authPath}`);
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

		app.get(WAITING_ROOM.admitCheckPath, (res) => {
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

	app.ws(WS_PATH, {
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
			const serveUpgradeRefusal = () => {
				if (WAITING_ROOM === null || isCursor) {
					// `waitingRoom: false` (or maxConcurrent unset): the exact
					// bare 503 - same status, single content-type header, same
					// body, no Retry-After.
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
					// Browser navigation: serve the self-polling holding page.
					const body = WAITING_ROOM.renderPage();
					res.cork(() => {
						res.writeStatus('200 OK');
						res.writeHeader('content-type', 'text/html; charset=utf-8');
						res.writeHeader('cache-control', 'no-store');
						res.end(body);
					});
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
			const acquired = isCursor ? admission.tryAcquireCursor() : admission.tryAcquire();
			if (!acquired) {
				// Count the over-capacity reject (and only this one) so the
				// posture's rolling reject rate reflects true gate pressure.
				if (counters.activePosture !== null) counters.activePosture.recordCapacityReject();
				mUpgradeRejected?.inc({ reason: isCursor ? 'cursor_lane' : 'over_capacity' });
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

			// Read everything synchronously - uWS req is stack-allocated
			/** @type {Record<string, string>} */
			const headers = {};
			req.forEach((key, value) => {
				headers[key] = value;
			});
			// Decode the client IP once. resolveClientIp applies the configured
			// proxy header (ADDRESS_HEADER / XFF_DEPTH) so rate limiting keys
			// on the real client address, not the proxy address.
			const clientIp = resolveClientIp(textDecoder.decode(res.getRemoteAddressAsText()), headers);

			// Rate limit upgrade requests per IP using a sliding window (0 = disabled).
			// Sliding window prevents a client from doubling their effective rate by
			// placing requests at the boundary between two fixed windows.
			if (UPGRADE_MAX_PER_WINDOW > 0) {
				const t = now();
				let rateEntry = upgradeRateMap.get(clientIp);
				if (!rateEntry) {
					rateEntry = { prev: 0, curr: 0, windowStart: t };
					upgradeRateMap.set(clientIp, rateEntry);
				} else {
					const elapsed = t - rateEntry.windowStart;
					if (elapsed >= 2 * UPGRADE_WINDOW_MS) {
						rateEntry.prev = 0;
						rateEntry.curr = 0;
						rateEntry.windowStart = t;
					} else if (elapsed >= UPGRADE_WINDOW_MS) {
						rateEntry.prev = rateEntry.curr;
						rateEntry.curr = 0;
						rateEntry.windowStart = t;
					}
				}
				// Sliding estimate: the previous window's count fades out linearly as
				// the current window progresses. At 0% elapsed, prev counts fully.
				// At 100% elapsed, prev contributes nothing and we rotate next time.
				const elapsed = t - rateEntry.windowStart;
				const estimate = rateEntry.prev * (1 - elapsed / UPGRADE_WINDOW_MS) + rateEntry.curr;
				if (estimate >= UPGRADE_MAX_PER_WINDOW) {
					// Per-IP rate-limit reject. Reported on its own counter, never
					// the over-capacity one, so an attack-driven 429 storm can
					// never escalate the protection posture toward siege.
					if (counters.activePosture !== null) counters.activePosture.recordRateLimitReject();
					mUpgradeRejected?.inc({ reason: 'ip_rate_limit' });
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
				rateEntry.curr++;
			}

			const secKey = req.getHeader('sec-websocket-key');
			const secProtocol = req.getHeader('sec-websocket-protocol');
			const secExtensions = req.getHeader('sec-websocket-extensions');

			// Origin validation - reject cross-origin WebSocket connections.
			// Requests without an Origin header are also rejected unless the
			// user supplied an upgrade hook that can authenticate non-browser
			// clients itself.
			if (!isOriginAllowed(headers['origin'], headers, {
				allowedOrigins,
				hostHeader: host_header,
				protocolHeader: protocol_header,
				portHeader: port_header,
				isTls: is_tls,
				hasUpgradeHook: !!wsModule.upgrade
			})) {
				mUpgradeRejected?.inc({ reason: 'bad_origin' });
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
				admission.admit(() => {
					if (fastPathAborted) return;
					res.cork(() => {
						res.upgrade({ remoteAddress: clientIp, [WS_REQUEST_ID_KEY]: wsRequestId }, secKey, secProtocol, secExtensions, context);
					});
					mUpgradeAdmitted?.inc();
					releaseInFlight();
				});
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
			try {
				upgradeHookResult = wsModule.upgrade({ headers, cookies, url, remoteAddress: clientIp, requestId: wsRequestId });
			} catch (err) {
				upgradeHookResult = Promise.reject(err);
			}
			Promise.resolve(upgradeHookResult)
				.then((result) => {
					clearTimer(timer);
					if (aborted || timedOut) return;
					if (result === false) {
						mUpgradeRejected?.inc({ reason: 'auth_rejected' });
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
					if (responseHeaders) maybeWarnSetCookieOnUpgrade(responseHeaders);
					admission.admit(() => {
						// Recheck after possible setImmediate defer: the client
						// may have hung up between admission and execution.
						if (aborted || timedOut) { releaseInFlight(); return; }
						res.cork(() => {
							if (responseHeaders) {
								// Write the switching-protocols status line BEFORE any
								// header. uWS emits an implicit "200 OK" on the first
								// writeHeader, and a 200 makes spec-compliant WebSocket
								// clients reject the handshake ("Unexpected server
								// response: 200"). res.upgrade() below tolerates the
								// pre-written 101 and appends Sec-WebSocket-Accept to it.
								res.writeStatus('101 Switching Protocols');
								for (const [hk, hv] of Object.entries(responseHeaders)) {
									if (Array.isArray(hv)) {
										for (const v of hv) res.writeHeader(hk, v);
									} else {
										res.writeHeader(hk, hv);
									}
								}
							}
							res.upgrade(
								ud,
								secKey,
								secProtocol,
								secExtensions,
								context
							);
						});
						mUpgradeAdmitted?.inc();
						releaseInFlight();
					});
				})
				.catch((err) => {
					clearTimer(timer);
					console.error('WebSocket upgrade error:', err);
					if (!aborted && !timedOut) {
						mUpgradeRejected?.inc({ reason: 'hook_error' });
						res.cork(() => {
							res.writeStatus('500 Internal Server Error');
							res.writeHeader('content-type', 'text/plain');
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
			userData[WS_PLATFORM] = wsPlatform;
			delete userData[WS_REQUEST_ID_KEY];
			assert(userData[WS_REQUEST_ID_KEY] === undefined, 'ws.request-id-leak', null);
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
					dispatchIngressFrame(ws, iud, message, iud[WS_PLATFORM]);
					return;
				}
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
					wsModule.message?.(ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] });
					return;
				}
				msg = parsed;
				if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
					const ref = hasRef(msg.ref) ? msg.ref : null;
					if (!isValidWireTopic(msg.topic, ALLOW_NON_ASCII_TOPICS)) {
						sendSubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE && msg.topic.charCodeAt(0) === 95 && msg.topic.charCodeAt(1) === 95) {
						sendSubscribeDenied(ws, msg.topic, ref, 'INVALID_TOPIC');
						return;
					}
					const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
					// The subscription slot is assigned a Set once at open and never
					// reassigned; a non-Set here is unrecoverable heap/dispatch corruption.
					// One instanceof guard, identical in cost to the assert it replaces.
					fatal(subs instanceof Set, 'subs.shape', null);
					const isNew = !subs.has(msg.topic);
					if (isNew && subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					const denial = await runUserSubscribeGate(ws, msg.topic);
					if (denial !== null) {
						sendSubscribeDenied(ws, msg.topic, ref, denial);
						return;
					}
					// Post-await re-check: a concurrent subscribe (single or batch)
					// may have raced through and already added the topic while
					// the user hook awaited. Idempotent ack and skip the
					// counters.totalSubscriptions++ to avoid double-counting.
					if (subs.has(msg.topic)) {
						sendSubscribed(ws, msg.topic, ref);
						return;
					}
					if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
						sendSubscribeDenied(ws, msg.topic, ref, 'RATE_LIMITED');
						return;
					}
					try { ws.subscribe(msg.topic); }
					catch { counters.closedWsAborts++; return; }
					subs.add(msg.topic);
					counters.totalSubscriptions++;
					// A topic already promoted to shared fan-out cohorts this new joiner
					// into the right cohort (announcing the server-wide id now) so the
					// next cohort-split publish reaches it. No-op for an ordinary topic.
					if (sharedTopics.has(msg.topic)) joinSharedCohort(ws, ws.getUserData(), msg.topic, sharedTopics.get(msg.topic));
					if (wsDebug) console.log('[ws] subscribe topic=%s', msg.topic);
					sendSubscribed(ws, msg.topic, ref);
					return;
				}
				if (msg.type === 'unsubscribe' && typeof msg.topic === 'string') {
					ws.unsubscribe(msg.topic);
					const udSubs = ws.getUserData()[WS_SUBSCRIPTIONS];
					assert(udSubs instanceof Set, 'subs.shape-unsubscribe', null);
					if (udSubs.delete(msg.topic)) {
						counters.totalSubscriptions--;
						assert(counters.totalSubscriptions >= 0, 'subs.total-negative', { totalSubscriptions: counters.totalSubscriptions });
					}
					// Drop the cohort memberships + release the shared wire-id ref for a
					// shared topic, so an unsubscribed client stops receiving its
					// cohort-split publishes. No-op for an ordinary topic.
					if (sharedTopics.has(msg.topic)) leaveSharedCohort(ws, ws.getUserData(), msg.topic);
					if (wsDebug) console.log('[ws] unsubscribe topic=%s', msg.topic);
					wsModule.unsubscribe?.(ws, msg.topic, { platform: ws.getUserData()[WS_PLATFORM] });
					return;
				}
				if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
					// Sent by the client store on reconnect to resubscribe all topics
					// in a single message instead of N individual subscribe messages.
					// Cap at 256 topics  - the client only sends what it was subscribed to.
					const topics = msg.topics.slice(0, 256);
					const ref = hasRef(msg.ref) ? msg.ref : null;
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
						if (!ALLOW_SYSTEM_TOPIC_SUBSCRIBE && typeof topic === 'string' &&
							topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
							sendSubscribeDenied(ws, topic, ref, 'INVALID_TOPIC');
							continue;
						}
						valid.push(topic);
					}

					// Pass 2: gather denial decisions. If a batch hook is exported,
					// call it once (typically backed by a single DB auth query) and
					// use its decisions. Otherwise fall back to the per-topic
					// `subscribe` hook for parity with single-subscribe behaviour.
					// Both paths are awaited so async hooks (the idiomatic style for
					// hooks that touch a session store or DB) gate correctly.
					const batchDenials = await runSubscribeBatchHook(ws, valid);
					// When falling back to per-topic, run the hooks in parallel so
					// a slow async hook on N topics is one round-trip not N.
					const perTopicDenials = batchDenials === null && wsModule.subscribe
						? await Promise.all(valid.map((t) => runSubscribeHook(ws, t)))
						: null;

					let subscribed = 0;
					for (let i = 0; i < valid.length; i++) {
						const topic = valid[i];
						const subs = userData[WS_SUBSCRIPTIONS];
						const denial = batchDenials !== null
							? (batchDenials[topic] ?? null)
							: (perTopicDenials !== null ? perTopicDenials[i] : null);
						if (denial !== null) {
							sendSubscribeDenied(ws, topic, ref, denial);
							continue;
						}
						// Post-await re-check: idempotent ack on race with another
						// concurrent subscribe.
						if (subs.has(topic)) {
							sendSubscribed(ws, topic, ref);
							continue;
						}
						if (subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
							sendSubscribeDenied(ws, topic, ref, 'RATE_LIMITED');
							continue;
						}
						try { ws.subscribe(topic); }
						catch { counters.closedWsAborts++; continue; }
						subs.add(topic);
						counters.totalSubscriptions++;
						subscribed++;
						if (sharedTopics.has(topic)) joinSharedCohort(ws, userData, topic, sharedTopics.get(topic));
						sendSubscribed(ws, topic, ref);
					}
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
								lastSeenSeqs: msg.lastSeenSeqs,
								lastSeenEpochs,
								platform: ws.getUserData()[WS_PLATFORM]
							});
						} catch (err) {
							console.error('[ws] resume hook threw:', err);
						}
					}
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
			}
			// Delegate everything else to the user's handler (if provided).
			// `msg` is the JSON-parsed envelope when the prefix matched + parsed
			// to an object + no control type matched; otherwise undefined.
			wsModule.message?.(ws, { data: message, isBinary, msg, platform: ws.getUserData()[WS_PLATFORM] });
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
					try { entry.reject(new Error('connection closed')); } catch {}
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
				wsModule.close?.(ws, ctx);
			} finally {
				counters.totalSubscriptions -= subscriptions.size;
				assert(counters.totalSubscriptions >= 0, 'subs.total-negative', { totalSubscriptions: counters.totalSubscriptions });
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
		sendPingsAutomatically: wsOptions.sendPingsAutomatically,
		compression: typeof wsOptions.compression === 'number'
			? wsOptions.compression
			: wsOptions.compression
				? uWS.SHARED_COMPRESSOR
				: uWS.DISABLED
	});

	console.log(`WebSocket endpoint registered at ${WS_PATH}`);
	if (WS_PATH !== '/ws') {
		console.log(`Client must match: connect({ path: '${WS_PATH}' })`);
	}

	startPressureSampling(wsOptions.pressure);
}

// Health check endpoint (before catch-all so it never hits SSR). This is a
// LIVENESS probe: it reports 200 whenever the process is up, INCLUDING during a
// graceful drain - so a k8s liveness probe never restarts a pod mid-shutdown.
if (HEALTH_CHECK_PATH) {
	app.get(HEALTH_CHECK_PATH, (res) => {
		res.cork(() => {
			res.writeStatus('200 OK').end('OK');
		});
	});
}

// Readiness endpoint (before catch-all so it never hits SSR). This is a
// READINESS probe, distinct from liveness: it reports 200 when ready and 503
// once graceful shutdown has begun, so a fronting load balancer stops routing
// NEW traffic to a draining instance while its in-flight requests finish. Keep
// it separate from `healthCheckPath` so a single endpoint is never used for
// both purposes (a readiness 503 must NOT trip a liveness probe into a restart).
if (READINESS_CHECK_PATH) {
	app.get(READINESS_CHECK_PATH, (res) => {
		if (isDraining()) {
			res.cork(() => {
				res.writeStatus('503 Service Unavailable').end('draining');
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
	app.any(ADMIN_PATH + '/*', handleAdminRequest);
	console.log(`Admin route registered at ${ADMIN_PATH}/*`);
}

// Register HTTP handler (after WS so the WS route takes priority)
app.any('/*', handleRequest);

// - In-flight request tracking -------------------------------------------


// - Exports -----------------------------------------------------------------


