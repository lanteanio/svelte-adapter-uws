// Shared mutable state for the handler runtime, gathered into one module so every
// split handler sub-module imports the SAME singleton bindings. Collections are
// 'export const' (mutated in place - the binding is never reassigned, so ESM's
// read-only live-binding rule does not bite). Reassigned scalars live on the
// 'counters' holder object, mutated via property access - NEVER 'export let',
// which would hand importers a frozen snapshot of the value at import time.

import { createCapCounts } from '../wire.js';
import { now, processMonotonicNow } from '../runtime.js';

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
 *
 * A maximum only ever reveals a lost TAIL. A lost INTERIOR frame moves no
 * maximum at all, and is caught by `originStreams` below instead.
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

/**
 * Per-(topic, origin) contiguity tracking for streams received over the
 * cross-worker relay - the state behind the interior-gap half of the
 * convergence hash.
 *
 * `maxSeenSeq` folds only each topic's HIGHEST seq, which catches a lost TAIL
 * (this worker's max lags its siblings') but is blind to a lost INTERIOR frame:
 * a worker that saw [2,3] and one that saw [1,2,3] both report max 3 and hash
 * identical. Contiguity is what distinguishes them.
 *
 * What is checked here is the relay ORDINAL each sending worker stamps on its
 * outbound frames (see handler/relay.js), NOT the publish seq. Only the ordinal
 * is dense on the path being audited: a publish seq skips numbers over the relay
 * whenever a topic is also published locally-only (`{ relay: false }` for an
 * external pub/sub source, or the game lane), and interleaves meaninglessly when
 * an explicit `{ seq: n }` authority stamps it from several workers at once.
 * The ordinal counts one thing - frames this origin handed to the relay for this
 * topic - so a hole in it is a dropped frame and nothing else. It also covers
 * `{ seq: false }` topics, which carry no seq to compare at all.
 *
 * Keyed by the origin's thread id, because each worker stamps its own 1-based
 * ordinal space.
 *
 * Unlike the maxima, a hole here is decidable by the worker that finds it: the
 * ordinal is dense at the origin by construction, so a worker holding 1 that
 * receives 3 KNOWS 2 was sent and never arrived. It needs no sibling to tell it
 * so, which is why a confirmed hole is REPORTED rather than folded into the
 * voted convergence hash. Voting on a self-evident fact would be worse than
 * useless: the publishing worker never receives its own frames, so it can hold
 * no view of the stream at all, and a loss that hit every receiver would make
 * the one worker that lost nothing the odd one out.
 *
 * `above` is allocated lazily (null while the stream is contiguous, the common
 * case) and `holeSince` is 0 when there is no open hole, so a healthy stream
 * costs one small object per (topic, origin).
 * @type {Map<string, Map<number, { w: number, hi: number, above: Set<number> | null, aboveMax: number, aboveRanges: Array<[number, number]>, holeSince: number }>>}
 */
export const originStreams = new Map();

/**
 * Whether the relay-contiguity tracker is running. Off unless the cross-worker
 * reporter is configured (`stateHashIntervalMs`), since nothing would ever read
 * what it tracks - so a default deployment pays one boolean test on the relay
 * receive path and allocates nothing. A holder, not `export let`, so the write
 * (handler.js, at reporter install) reaches the read site in lifecycle.js.
 * @type {{ enabled: boolean }}
 */
export const streamTracking = { enabled: false };

/**
 * Process-monotonic instant at which this worker wired its relay listeners, i.e.
 * the point from which a sibling's publish was owed to it. `Infinity` until then,
 * so a stream can never be judged to have started after we attached before we
 * actually have - an unattached or single-process worker classifies every first
 * sighting as a legitimate mid-stream join and reports no gaps.
 *
 * A holder, not `export let`, so the write (runtime/index.js, via the handler's
 * `markRelayAttached`) is visible to the read site in this module.
 * @type {{ at: number }}
 */
export const relayAttach = { at: Infinity };

/**
 * Latch the relay-attach instant. Called once per worker, from the site that
 * wires the relay listeners. Idempotent: the FIRST attach wins, because a later
 * one would move the boundary forward and re-classify already-tracked streams.
 * @returns {void}
 */
export function markRelayAttached() {
	if (relayAttach.at === Infinity) relayAttach.at = processMonotonicNow();
}

/**
 * How many ordinals above an open hole the buffer retains. Bounds what one lost
 * frame behind a live publisher can hold. Not a tuning knob.
 *
 * At the cap the buffer keeps the `MAX_PENDING_ABOVE` SMALLEST ordinals seen: an
 * arrival below the current maximum evicts that maximum. The report boundary is
 * the LOWEST arrival above the hole, so keeping the smallest is what makes that
 * boundary exact - everything between the watermark and it genuinely never came.
 * Simply refusing arrivals once full leaves a larger ordinal defining the
 * boundary while smaller ones that DID arrive go unrecorded, and the report then
 * names delivered frames as lost.
 *
 * Eviction never forgets that a frame ARRIVED for re-baselining purposes - that
 * is what `hi` is for, and the drain resumes from `hi` rather than from the
 * buffer. What it does cost is auditing: ordinals evicted above the reported hole
 * are no longer individually checkable, so a second loss inside the same window
 * is folded into the first report rather than counted. The reported `count` is
 * therefore frames PROVEN lost - a lower bound, not a total.
 */
export const MAX_PENDING_ABOVE = 64;

/**
 * How long an open hole must persist before it counts as a real drop.
 *
 * A hole means a higher ordinal arrived while a lower one is still missing. Both
 * relay channels are FIFO per origin (the ring is a byte ring; postMessage is an
 * ordered port), so the only way a hole fills later is the rare mixed-channel
 * case - a frame whose ring encode threw falls back to postMessage while its
 * batch-mates ride the ring - and that resolves within the same process in
 * microseconds. Anything still missing an order of magnitude beyond any
 * plausible in-process reorder is gone, not late.
 *
 * Confirmation is by TIME rather than by pending count so a drop is reported on
 * a quiet topic just as it is on a busy one; the count only bounds memory.
 */
export const GAP_CONFIRM_MS = 1000;

/**
 * Retain a delivered ordinal that no longer fits in `above` as one of a bounded
 * set of sorted, merged ranges. A busy damaged stream is normally one ascending
 * range, however many frames it carries, so this preserves exact contiguity
 * without returning to an unbounded per-frame Set.
 *
 * At the range cap we keep the LOWEST ranges: only the first delivered ordinal
 * above the watermark defines the currently reportable hole. Losses beyond all
 * retained ranges remain part of the documented lower-bound trade once a stream
 * has exceeded both bounds.
 * @param {Array<[number, number]>} ranges
 * @param {number} ord
 */
function retainAboveRange(ranges, ord) {
	let i = 0;
	while (i < ranges.length && ranges[i][1] + 1 < ord) i++;
	if (i < ranges.length && ord >= ranges[i][0] - 1 && ord <= ranges[i][1] + 1) {
		if (ord < ranges[i][0]) ranges[i][0] = ord;
		if (ord > ranges[i][1]) ranges[i][1] = ord;
		while (i + 1 < ranges.length && ranges[i + 1][0] <= ranges[i][1] + 1) {
			ranges[i][1] = Math.max(ranges[i][1], ranges[i + 1][1]);
			ranges.splice(i + 1, 1);
		}
		return;
	}
	if (ranges.length < MAX_PENDING_ABOVE) {
		ranges.splice(i, 0, [ord, ord]);
	} else if (i < ranges.length) {
		// Keep the closest ranges; the last one is furthest from today's hole.
		ranges.splice(i, 0, [ord, ord]);
		ranges.pop();
	}
}

/** @param {Array<[number, number]>} ranges @param {number} ord */
function aboveRangesContain(ranges, ord) {
	for (let i = 0; i < ranges.length; i++) {
		if (ord < ranges[i][0]) return false;
		if (ord <= ranges[i][1]) return true;
	}
	return false;
}

/**
 * Fold one relayed frame's ordinal into the (topic, origin) stream tracker.
 *
 * The classification that matters is the FIRST sighting of a stream, where an
 * ordinal above 1 is ambiguous: this worker either joined a stream already in
 * flight (nothing was owed to it) or was attached and lost the prefix. `birth`
 * (the origin's instant of stamping ordinal 1) against `attachedAt` (ours)
 * decides it - both readings on the process-shared timeline, so the comparison
 * is exact rather than skewed by each thread's own wall-clock anchor. Ties go to
 * the benign reading: an equal birth and attach baselines rather than reports.
 *
 * Thereafter it is plain contiguity: the next ordinal advances the watermark and
 * drains anything buffered above it, a lower one is a duplicate, and a higher
 * one opens a hole.
 *
 * Pure with respect to inputs other than the supplied map (mirrors
 * `recordSeen`), and `nowFn` is called ONLY when a hole opens - never on the
 * contiguous path - so a healthy relay pays no clock read per frame.
 *
 * @param {Map<string, Map<number, { w: number, hi: number, above: Set<number> | null, aboveMax: number, aboveRanges: Array<[number, number]>, holeSince: number }>>} streams
 * @param {string} topic
 * @param {number} origin - the publishing worker's thread id
 * @param {number} ord - the origin's per-topic relay ordinal for this frame
 * @param {number} birth - origin's process-monotonic instant of this stream's ordinal 1
 * @param {number} attachedAt - our process-monotonic relay-attach instant
 * @param {() => number} nowFn - process-monotonic clock, read lazily
 * @returns {void}
 */
export function recordOriginStream(streams, topic, origin, ord, birth, attachedAt, nowFn) {
	if (typeof ord !== 'number' || typeof origin !== 'number' || typeof birth !== 'number') return;
	let byOrigin = streams.get(topic);
	if (byOrigin === undefined) {
		byOrigin = new Map();
		streams.set(topic, byOrigin);
	}
	const st = byOrigin.get(origin);
	if (st === undefined) {
		if (ord > 1 && birth > attachedAt) {
			// We were already attached when this stream started, so ordinal 1 was
			// owed to us and never came: the prefix below `ord` is missing.
			byOrigin.set(origin, { w: 0, hi: ord, above: new Set([ord]), aboveMax: ord, aboveRanges: [], holeSince: nowFn() });
		} else {
			// The stream predates our attach (or this IS its head): whatever came
			// before was never ours to receive. Baseline here and track from now on.
			byOrigin.set(origin, { w: ord, hi: ord, above: null, aboveMax: -Infinity, aboveRanges: [], holeSince: 0 });
		}
		return;
	}
	if (ord > st.hi) st.hi = ord;
	if (ord <= st.w) return; // already covered: a duplicate or a late reorder below the watermark
	if (ord === st.w + 1) {
		st.w = ord;
		if (st.above !== null) {
			// This frame may plug the current hole. Drain both exact retained
			// ordinals and compact delivered ranges until the next real hole.
			for (;;) {
				while (st.above.delete(st.w + 1)) st.w++;
				const range = st.aboveRanges[0];
				if (range === undefined || range[0] !== st.w + 1) break;
				st.w = range[1];
				st.aboveRanges.shift();
			}
			if (st.above.size === 0 && st.aboveRanges.length === 0) {
				// Nothing known is outstanding, so resume from everything that has
				// actually arrived. This equals `hi` while the bounded summaries cover
				// the window; assigning it explicitly preserves the lower-bound policy
				// after both retention bounds have been exceeded.
				st.above = null;
				st.aboveMax = -Infinity;
				st.aboveRanges.length = 0;
				st.holeSince = 0;
				st.w = st.hi;
			} else {
				if (st.above.size === 0) st.aboveMax = -Infinity;
				// Anything still buffered sits behind a DIFFERENT hole, which only
				// became the blocking one just now: its age starts here, not at the
				// closed one's. Dating it from the older hole would confirm it early
				// enough to call a frame still in flight lost.
				st.holeSince = nowFn();
			}
		}
		return;
	}
	// A higher ordinal with at least one missing below it.
	// The two cache resets here are DEFENSIVE, not load-bearing: every path that
	// nulls `above` already resets them, so `above === null` implies the cache is
	// clean. Deleting them leaves the suite green, and that is expected rather than
	// a coverage hole - they exist so the invariant holds locally instead of by an
	// argument about three other call sites.
	if (st.above === null) { st.above = new Set(); st.aboveMax = -Infinity; st.aboveRanges.length = 0; }
	if (st.holeSince === 0) st.holeSince = nowFn();
	// The buffer keeps the N SMALLEST ordinals seen above the hole, because the
	// report boundary is the LOWEST arrival above it - everything between the
	// watermark and that lowest arrival is what never came. Simply dropping
	// arrivals once the buffer is full would leave a larger ordinal defining the
	// boundary while a smaller one that DID arrive went unrecorded, and the report
	// would then name delivered frames as lost: with a reorder deeper than the cap
	// and the high block first, one lost frame was reported as 98 and
	// `relay_gap_frames_total` incremented by 98.
	//
	// The scan is bounded by the cap and only runs on an already-damaged stream
	// that has exceeded it. The watermark is deliberately NOT moved here - that
	// would swallow the very frame we are waiting for if it arrives late.
	if (st.above.has(ord) || aboveRangesContain(st.aboveRanges, ord)) return;
	if (st.above.size < MAX_PENDING_ABOVE) {
		st.above.add(ord);
		if (ord > st.aboveMax) st.aboveMax = ord;
	} else if (ord < st.aboveMax) {
		// ORDER OF THE TWO TESTS IS A PERFORMANCE DECISION, not a semantic one - the
		// branch is entered on the same inputs either way. The numeric compare goes
		// first because it rejects the common post-drop shape (a stream still
		// arriving in order behind one missing frame, where every ordinal is above
		// the maximum) in one comparison. Putting the Set lookup first walks the
		// 64-entry buffer on every relayed frame for as long as the hole stays
		// open, which measured +126% against the previous policy.
		//
		// The duplicate test itself is load-bearing wherever it sits: re-adding a
		// value the buffer already holds would still evict the maximum, shrinking
		// the set by one and forgetting an ordinal that ARRIVED - the drain would
		// later stop on it and report it lost, which is the very class this
		// retention exists to close. Duplicate re-delivery is expected input here.
		//
		// The maximum is CACHED rather than rescanned per arrival; rescanning made
		// the same shape ~10x more expensive per relayed frame.
		const evicted = st.aboveMax;
		st.above.delete(evicted);
		st.above.add(ord);
		let m = -Infinity;
		for (const s of st.above) if (s > m) m = s;
		st.aboveMax = m;
		retainAboveRange(st.aboveRanges, evicted);
	} else {
		// Compact every delivered ordinal outside the exact buffer. Remembering
		// only the old scalar minimum prevented one false positive, but closing an
		// earlier reorder then erased a genuine later loss
		// (1,3..66,68..80,2 silently skipped 67).
		retainAboveRange(st.aboveRanges, ord);
	}
}

/**
 * Take every hole that has now outlived the grace, reporting each exactly once.
 *
 * DRAINING, not projecting: a reported hole is consumed, and the stream
 * re-baselines at the highest ordinal that has ARRIVED and resumes clean
 * tracking. So one lost frame yields one report rather than a state the worker
 * restates on every tick forever, a later loss on the same stream is reported as
 * its own event, and nothing accumulates - the buffer is released at the report.
 *
 * Re-baselining skips auditing whatever arrived above the reported hole: past the
 * buffer cap the stream stopped recording which of those it got. That window is
 * bounded by the grace, and the stream is already known damaged inside it, so the
 * trade is deliberate - a second loss in the same window is folded into the first
 * report rather than invented out of frames that did arrive.
 *
 * Each entry names what was lost (`topic`, the `origin` that sent it, and the
 * missing ordinal range), which is the whole of the finding: the worker calling
 * this IS the worker that lost the frames. Nothing here is compared against
 * another worker, so a dead origin's stream, a late joiner's missing prefix, and
 * a restarted worker's empty map are all simply absent from the report rather
 * than a disagreement to resolve.
 *
 * @param {Map<string, Map<number, { w: number, hi: number, above: Set<number> | null, aboveMax: number, aboveRanges: Array<[number, number]>, holeSince: number }>>} streams
 * @param {number} nowMs - process-monotonic reading
 * @param {number} graceMs - see GAP_CONFIRM_MS
 * @returns {{ topic: string, origin: number, from: number, to: number, count: number }[]}
 */
export function takeConfirmedGaps(streams, nowMs, graceMs) {
	/** @type {{ topic: string, origin: number, from: number, to: number, count: number }[]} */
	const gaps = [];
	for (const [topic, byOrigin] of streams) {
		for (const [origin, st] of byOrigin) {
			if (st.holeSince === 0 || nowMs - st.holeSince < graceMs) continue;
			// The hole runs from the first ordinal we never saw up to the one below
			// the lowest that arrived above it.
			let lowestAbove = Infinity;
			for (const s of st.above) if (s < lowestAbove) lowestAbove = s;
			const from = st.w + 1;
			const lowestRanged = st.aboveRanges.length === 0 ? Infinity : st.aboveRanges[0][0];
			// The boundary is the lowest ARRIVAL above the hole: the exact-buffer
			// minimum or the first compact delivered range, whichever is lower.
			// Using the buffer alone lets a drained watermark cross a discarded
			// arrival and report a delivered ordinal as lost.
			const to = Math.min(lowestAbove, lowestRanged) - 1;
			// `to < from` means every ordinal between the watermark and the lowest
			// arrival above it turned out to have ARRIVED - the hole closed out of
			// order while the buffer was full. There is nothing to report, and an
			// inverted or zero-width range must never be emitted: consumers read
			// `count` into relay_gap_frames_total and a `[from, to]` span into an
			// operator-facing log line, and RESTART_ON_STATE_DIVERGENCE would restart
			// a worker that lost nothing.
			if (to >= from) gaps.push({ topic, origin, from, to, count: to - from + 1 });
			// Resume from what ARRIVED, not from what the buffer still held.
			st.w = st.hi;
			st.above = null;
			st.aboveMax = -Infinity;
			st.aboveRanges.length = 0;
			st.holeSince = 0;
		}
	}
	return gaps;
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
 * still decides. Server-initiated `platform.subscribe` is unaffected (it is the
 * trusted authorization path); `platform.checkSubscribe` with
 * `{ requireGrant: true }` - the mode presence.sync / cursor.snapshot use -
 * additionally requires grant-set membership while this is enabled, so those
 * snapshot lanes enforce the same conjunction as the wire gate. Off by default, so
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
