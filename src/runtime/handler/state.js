// Shared mutable state for the handler runtime, gathered into one module so every
// split handler sub-module imports the SAME singleton bindings. Collections are
// 'export const' (mutated in place - the binding is never reassigned, so ESM's
// read-only live-binding rule does not bite). Reassigned scalars live on the
// 'counters' holder object, mutated via property access - NEVER 'export let',
// which would hand importers a frozen snapshot of the value at import time.

import { createCapCounts } from '../wire.js';
import { now } from '../runtime.js';

/** Pooled HttpResponse abort-flag objects, reused to avoid per-request allocation. @type {{ aborted: boolean }[]} */
export const statePool = [];

/** Cache of pre-built JSON envelope prefixes, keyed topic\0event. @type {Map<string, string>} */
export const envelopePrefixCache = new Map();

/** In-memory static file cache, keyed by URL path (StaticEntry values). @type {Map<string, any>} */
export const staticCache = new Map();

/** Prerendered paths whose canonical URL has a trailing slash. @type {Set<string>} */
export const prerenderedDirStyle = new Set();

/** Live WebSocket connections (for fan-out walks, pressure sampling, shutdown). @type {Set<import('uWebSockets.js').WebSocket<any>>} */
export const wsConnections = new Set();

/** Per-topic monotonic broadcast sequence numbers, stamped into each envelope. @type {Map<string, number>} */
export const topicSeqs = new Map();

/**
 * Per-topic highest delivered sequence number this worker has OBSERVED, whether
 * it stamped the publish locally or received the originator's pre-stamped frame
 * over the cross-worker relay. Unlike `topicSeqs` (which only the publishing
 * worker advances), every worker that receives a relayed frame advances this for
 * the topic, so under a reliable in-process relay every worker converges to the
 * same value per topic. A worker that fell behind (a relay frame delivered to
 * some workers but not this one) holds a lower value, which a structural hash
 * over this map surfaces as a cross-worker divergence. A topic only ever
 * published with seq stamping disabled never enters this map and is excluded
 * from the comparison.
 * @type {Map<string, number>}
 */
export const maxSeenSeq = new Map();

/**
 * Record an observed `seq` for `topic` into a max-seen map, keeping the highest.
 * Used on the relay RECEIVE path, where frames can arrive out of order across
 * the worker `postMessage` boundary, so the monotone-max guard is required (a
 * blind overwrite could move the value backward and fabricate a divergence). The
 * local publish path already holds the freshly stamped (monotonic) seq, so it
 * sets `maxSeenSeq` directly without this guard. A non-number `seq` (a frame
 * relayed for a `{ seq: false }` topic) is ignored, so such topics never enter
 * the map on any worker.
 *
 * Pure with respect to inputs other than the supplied map (mirrors
 * `nextTopicSeq`), so a unit test can pass a fresh map per case.
 *
 * @param {Map<string, number>} seenMap
 * @param {string} topic
 * @param {number} seq
 * @returns {void}
 */
export function recordSeen(seenMap, topic, seq) {
	if (typeof seq !== 'number') return;
	const prev = seenMap.get(topic);
	if (prev === undefined || seq > prev) seenMap.set(topic, seq);
}

/** Per-topic publish counters for runaway-publisher detection (sampled + reset each pressure tick). @type {Map<string, { m: number, b: number }>} */
export const topicPublishStats = new Map();

/**
 * Active resume-cutover live-frame buffers, keyed by topic. A connection that is
 * gap-filling a topic on subscribe (recover offset) registers a buffer here for
 * the duration of the async resume hook: every fan-out site that would deliver a
 * live frame to that topic appends it here too (see `captureResumeFrame`), so a
 * publish that lands DURING the resume await - after the backend read, before the
 * connection is subscribed to live - is held instead of lost, then flushed in
 * order once live membership is installed. Empty (size 0) in the overwhelming
 * common case; every fan-out site guards on `resumeBuffers.size > 0` first so an
 * idle server pays a single size check. A synchronous (in-memory) resume never
 * yields a macrotask, so its buffer stays empty and the flush is a no-op - the
 * window only ever captures anything behind an async (network-backed) resume.
 * @type {Map<string, Set<{ frames: { seq: number | null, envelope: string, compress: boolean }[], overflow: boolean }>>}
 */
export const resumeBuffers = new Map();

/**
 * Hard cap on frames held per resume buffer, so a hung resume behind a high-rate
 * publisher cannot grow one without bound. On overflow the buffer stops
 * appending and marks itself so the cutover tells the client to cold-rehydrate
 * (a clean gap signal) rather than deliver a silently partial tail.
 */
const MAX_RESUME_BUFFERED_FRAMES = 4096;

/**
 * Append a live frame to every open resume buffer for `topic`. Called from each
 * fan-out site (local publish, cross-worker relay receive) AFTER its guard has
 * confirmed `resumeBuffers.size > 0`, so the common path never reaches here.
 * @param {string} topic
 * @param {number | null} seq
 * @param {string} envelope
 * @param {boolean} compress
 * @returns {void}
 */
export function captureResumeFrame(topic, seq, envelope, compress) {
	const set = resumeBuffers.get(topic);
	if (set === undefined) return;
	for (const b of set) {
		if (b.frames.length >= MAX_RESUME_BUFFERED_FRAMES) { b.overflow = true; continue; }
		b.frames.push({ seq, envelope, compress });
	}
}

/**
 * Topics that have been published through a `shared: true` wire codec, mapped to the
 * codec's capability. A topic enters on its FIRST shared publish (which also
 * migrates the topic's current subscribers into cohorts); the subscribe path reads
 * this so a LATER joiner of an already-shared topic is dual-subscribed into the right
 * cohort at subscribe time, and the close path reads it to release each shared
 * topic's wire-id reference. Per worker (one process/worker per module instance),
 * which is all the single-instance fan-out needs: a client only ever talks to its
 * home worker, so each worker's cohort topics + wire-ids are self-consistent.
 * @type {Map<string, string>}
 */
export const sharedTopics = new Map();

/**
 * Coarse 1 Hz pressure snapshot exposed as platform.pressure. Mutated in place
 * by the sampler; read by the platform getter.
 * @type {{ active: boolean, value: number, subscriberRatio: number, publishRate: number, memoryMB: number, reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY', maxBufferedBytes: number, backpressuredConnections: number, psi: { cpuSome10: number, memoryFull10: number, ioFull10: number } | null, cpuThrottle: { throttledRatio: number, nrThrottledDelta: number } | null, topPublishers: { topic: string, messagesPerSec: number, bytesPerSec: number }[] }}
 */
export const pressureSnapshot = {
	active: false,
	value: 0,
	subscriberRatio: 0,
	publishRate: 0,
	memoryMB: 0,
	reason: 'NONE',
	maxBufferedBytes: 0,
	backpressuredConnections: 0,
	psi: null,
	cpuThrottle: null,
	topPublishers: []
};

/**
 * Wire-subscribe authorization policy. When `enabled`, a CLIENT-initiated
 * subscribe / subscribe-batch wire frame is honored only for a topic the
 * server already authorized for that connection (i.e. a prior
 * `platform.subscribe`, recorded in the connection's `WS_SUBSCRIPTIONS` set) -
 * unless the app exports an explicit `subscribe` / `subscribeBatch` hook, which
 * still decides. Server-initiated `platform.subscribe` / `platform.checkSubscribe`
 * are unaffected (they are the trusted authorization path). Off by default, so
 * the adapter's standalone "any client may subscribe to any topic" contract is
 * unchanged; a framework (svelte-realtime) or an app opts in. A holder object,
 * not `export let`, so a runtime enable in one module is visible to the wire
 * handler in another. @type {{ enabled: boolean }}
 */
export const subscribeAuth = { enabled: false };

/** platform.onPressure transition callbacks. @type {Set<(snapshot: typeof pressureSnapshot) => void>} */
export const pressureListeners = new Set();

/** platform.onPublishRate callbacks. @type {Set<(events: { topic: string, messagesPerSec: number, bytesPerSec: number }[]) => void>} */
export const publishRateListeners = new Set();

/** Throttle map for the default runaway-publisher console.warn (one per topic per minute). @type {Map<string, number>} */
export const lastPublishWarnAt = new Map();

/** Binary-wire (0x03) capability accounting + topic-id space, shared with the test/dev platforms via wire.js. */
export const capCounts = createCapCounts();

/** Bounded LRU cache for decoded URI pathnames (null = decode error). @type {Map<string, string | null>} */
export const decodeCache = new Map();

/**
 * Reassigned module-level scalars that are written and/or read across more than
 * one split handler module. They MUST live on a holder (not 'export let') so a
 * write in one module is visible to readers in another. Each field is documented
 * at its write/read sites in the handler sub-modules.
 */
export const counters = {
	// HTTP Date header string, rebuilt once/second by a setInterval (formats the runtime clock value).
	cachedDateHeader: new Date(now()).toUTCString(), // determinism-allow: formats the runtime clock value, not a clock read
	// Monotonic source for server-initiated request refs (scoped per connection at use).
	nextRequestRef: 1,
	// One-shot guard for the platform.sendTo async-filter warning.
	sendToAsyncWarned: false,
	// Publishes in the current pressure window (reset each sample).
	publishCountWindow: 0,
	// Live total subscriptions across all connections (for the subscriber-ratio pressure signal).
	totalSubscriptions: 0,
	// Worst per-connection send-gate saturation since the last sample (decayed each tick).
	leaseSaturationPeak: 0,
	// Count of best-effort ops aborted because the uWS socket had already closed (platform.closedWsAborts).
	closedWsAborts: 0,
	// Live protection posture (null until the upgrade handler instantiates one).
	activePosture: null,
	// Admission-gauge sampling hook, called by the 1 Hz sampler (null when no metrics registry).
	metricsSampleHook: null,
	// Posture-export push hook, called by the 1 Hz sampler (null when no export is configured).
	postureExportHook: null,
	// Live posture exporter (null when no export is configured); lifecycle closes it on shutdown.
	postureExporter: null,
	// Base (un-layered) pressure reason from the most recent sample (for the posture transition log).
	lastBasePressureReason: 'NONE',
	// In-flight SSR request count, for drain().
	inFlightCount: 0,
	// True once graceful shutdown has begun. The readiness route reports a 503
	// while this is set so a fronting load balancer drains this instance (the
	// process stays live; it is just no longer ready for NEW traffic). Lives on
	// the holder so the set site (lifecycle.js shutdown) and the read sites
	// (the readiness route) share the SAME reference across modules.
	draining: false,
	// The per-worker consistency auditor instance (null until the handler installs
	// one; null when disabled by interval 0). Lives on the holder so the install
	// site (handler.js) and the shutdown site (lifecycle.js) - distinct modules -
	// share the SAME reference. Mutated in place, never reassigned away, per the
	// holder-property pattern this module's header documents.
	consistencyAuditor: null,
	// The optional per-worker resource-growth trend auditor instance (null until
	// the handler installs one; null when disabled by interval 0, the default).
	// Same holder rationale as consistencyAuditor: the install site (handler.js)
	// and the shutdown site (lifecycle.js) are distinct modules and must share ONE
	// reference. Mutated in place, never reassigned away.
	resourceGrowthAuditor: null
};
