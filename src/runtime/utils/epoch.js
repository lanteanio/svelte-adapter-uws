import { now, randomU32, randomUuid } from '../runtime.js';

/**
 * Per-process generation for the in-memory per-topic seq space.
 *
 * Latched once, on first read, and constant for the life of the worker. It
 * changes only across a process restart - which is exactly when the in-memory
 * seq counters (the map a publisher mutates via `nextTopicSeq`) reset to 1. A
 * reconnecting client presents the generation it last saw; a server that
 * presents a different one is serving a freshly reset seq space, and the
 * client must re-read from scratch instead of trusting its old offsets.
 *
 * A single worker shares this one value across every topic. A backend whose
 * seq authority can reset per topic independently (a separate store) overrides
 * the carried value per topic without changing the wire shape.
 *
 * An OPAQUE token, not a timestamp. It is a random 32-bit integer from the
 * seam's RNG, and the ONLY comparison the wire cares about is equality across
 * a reconnect: any two consecutive boots differ (a 2^-32 collision with the
 * immediately-previous value is the sole failure mode, and it degrades to one
 * missed reset, not corruption). A wall-clock epoch would have distinguished
 * restarts just as well, but it also handed every unauthenticated client the
 * process start time - uptime, deploy timing, and a correlation fingerprint
 * across sockets behind a load balancer - so the token carries no time. Never
 * persisted; a fresh process is a fresh seq space. Latching on first read
 * (rather than at module import) lets a controlled simulation that has seeded
 * the RNG latch a reproducible value after `resetProcessEpoch()`.
 *
 * @returns {number}
 */
let _processEpoch;
export function processEpoch() {
	if (_processEpoch === undefined) _processEpoch = randomU32();
	return _processEpoch;
}

/** Clear the latched generation so the next read re-latches. Simulation use only. */
export function resetProcessEpoch() { _processEpoch = undefined; }

/**
 * Per-topic epoch overrides, layered over the process generation.
 *
 * A topic's epoch normally IS the process generation: every in-memory seq
 * counter resets together, so one token describes them all. An override exists
 * for the case where ONE topic's history can no longer be served from a
 * client-held offset while the process lives on - a confirmed relay loss: the
 * frames are gone, delivered sequences have already stepped past them, and any
 * offset taken before the loss would gap-fill from beyond frames its holder
 * never received. Minting a new epoch for that topic makes every such offset
 * die at its next resume through the ordinary epoch-mismatch answer, for
 * opted-in and plain clients alike, using machinery every client already
 * implements. The mint is worker-local and needs to be nothing more: each
 * worker's generation is its own random latch, so the losing worker's answer
 * is the only one a pre-loss offset could still match, and the repudiation
 * lasts as long as the override below does.
 *
 * The map is bounded: relay losses are rare, but nothing should grow without a
 * ceiling. At the cap the oldest override is dropped - reads then fall back to
 * the process generation, which for a long-dead loss window is the honest
 * degradation (an offset old enough to outlive the cap has usually cycled
 * through a resume, and the cap is far above any plausible concurrent count).
 */
const TOPIC_EPOCH_OVERRIDE_MAX = 4096;
/** @type {Map<string, number>} */
const _topicEpochs = new Map();

/**
 * The epoch for one topic: its override when a loss minted one, else the
 * process generation. This is the single read authority - the per-connection
 * platform's `topicEpoch`, the subscribe ack, and every resume compare route
 * through it.
 * @param {string} topic
 * @returns {number}
 */
export function topicEpochValue(topic) {
	const override = _topicEpochs.get(topic);
	return override !== undefined ? override : processEpoch();
}

/**
 * Install a topic's minted epoch. Re-installing refreshes the entry's
 * recency, so the cap always evicts the longest-undisturbed override.
 * @param {string} topic
 * @param {number} epoch
 * @returns {void}
 */
export function overrideTopicEpoch(topic, epoch) {
	if (_topicEpochs.delete(topic) === false && _topicEpochs.size >= TOPIC_EPOCH_OVERRIDE_MAX) {
		const oldest = _topicEpochs.keys().next().value;
		if (oldest !== undefined) _topicEpochs.delete(oldest);
	}
	_topicEpochs.set(topic, epoch);
}

/** Clear every topic override. Simulation and harness use only. */
export function resetTopicEpochs() { _topicEpochs.clear(); }

/**
 * Allocate the next monotonic sequence number for a topic, mutating
 * `seqMap` in place. The first call for a topic returns 1; subsequent
 * calls return the previous value plus one. Each topic has an
 * independent counter.
 *
 * Pure with respect to inputs other than the supplied map. Suitable
 * for unit tests that pass a fresh map per case.
 *
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @returns {number}
 */
export function nextTopicSeq(seqMap, topic) {
	const next = (seqMap.get(topic) ?? 0) + 1;
	seqMap.set(topic, next);
	return next;
}

/**
 * Refuse a seq the wire cannot carry. One throw site shared by `stampSeq`'s
 * numeric arm and the batch's per-entry pre-pass, so the two spellings of the
 * same contract cannot drift apart in message or in meaning. Cold path: it is
 * only ever reached to throw, so the call costs nothing on a valid publish.
 *
 * @param {unknown} value
 * @returns {never}
 * @throws {TypeError} always
 */
export function throwInvalidSeq(value) {
	throw new TypeError(`publish seq must be a positive integer (>= 1), received ${String(value)}`);
}

/**
 * Resolve the sequence number to stamp on a publish, honoring an explicit
 * caller-supplied authority. Shared by every publish entry point so the
 * three-way resolution never drifts between them.
 *
 * Keyed STRICTLY on the `seq` option type so a legacy truthy `seq: true` keeps
 * its historical meaning (the in-memory counter, NOT numeric 1):
 *
 * - `options.seq` is a NUMBER: stamp that exact value and do NOT advance the
 *   in-memory per-worker counter. This is a cluster-authoritative seq a replay
 *   backend already allocated (a Redis Lua INCR, a Postgres CTE, or the
 *   in-memory buffer's own counter), so the broadcast wire seq and the replay
 *   seq occupy ONE space instead of diverging. Numeric seqs originate on
 *   different workers and interleave on arrival, so a caller that tracks a
 *   max-seen map must record them through the monotone-max guard
 *   (`recordSeen`), never a bare set - a bare set could regress the local max.
 * - `options.seq === false`: no seq. Returns null so the field is omitted from
 *   the envelope and the topic stays out of the cross-worker SEQUENCE comparison
 *   (it has no number to compare). Such a topic is still contiguity-checked over
 *   the relay, which numbers frames independently of the publish seq.
 * - absent, or any other truthy value: the in-memory per-worker counter. A
 *   topic already in the map advances by one, exactly as every prior release
 *   did. A topic NEW to the map starts at 1 for a caller that passes no
 *   `bound`, and at the bound's carried floor plus one for a caller that does
 *   - the registry may forget a topic, but the counter it hands out must
 *   never repeat a number a client has already seen.
 *
 * Pure with respect to inputs other than the supplied map (mirrors
 * `nextTopicSeq`), so a unit test can pass a fresh map per case.
 *
 * @param {{ seq?: boolean | number } | null | undefined} options
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @param {{ floorOf(topic: string): number, onInsert(topic: string): void } | undefined} [bound]
 * @returns {number | null}
 */
export function stampSeq(options, seqMap, topic, bound) {
	return stampSeqValue(options != null ? options.seq : undefined, seqMap, topic, bound);
}

/**
 * The value form of `stampSeq`, for callers that already hold the `seq`
 * option as a local. The hot publish lanes read each option field exactly
 * once, up front, so the value the cluster-authority check judged and the
 * value stamped here are the same read - a stateful accessor cannot answer
 * the check with `false` and hand the stamp a number. Same three-way
 * resolution, same validation, same counter semantics as the options form,
 * which delegates here so the rule cannot drift.
 *
 * @param {boolean | number | undefined} opt
 * @param {Map<string, number>} seqMap
 * @param {string} topic
 * @param {{ floorOf(topic: string): number, onInsert(topic: string): void } | undefined} [bound]
 * @returns {number | null}
 */
export function stampSeqValue(opt, seqMap, topic, bound) {
	if (opt === false) return null;
	if (typeof opt === 'number') {
		// An explicit seq is a cluster-authoritative value that must survive BOTH
		// the JSON envelope and the 0x03 binary frame and drive the client's resume
		// gap-fill, so it must be a positive integer. The binary frame reserves 0 as
		// its "no seq" sentinel (a stamped 0 would vanish for binary subscribers),
		// and a non-finite / negative / fractional value would emit invalid JSON,
		// diverge from the varint, and poison the monotone-max guard. The in-memory
		// counter and every shipped authority (Redis INCR) are 1-based; a 0-based
		// external source must offset by 1. Fail fast rather than corrupt the wire.
		if (Number.isInteger(opt) && opt >= 1) return opt;
		throwInvalidSeq(opt);
	}
	// The in-memory per-worker counter, inlined from `nextTopicSeq` rather than
	// called, so the common publish stays a single call frame (a wrapper call
	// measured a few percent on the isolated publish-resolution micro-bench).
	// Same increment semantics for a known topic: previous value plus one.
	const current = seqMap.get(topic);
	if (current !== undefined) {
		const next = current + 1;
		seqMap.set(topic, next);
		return next;
	}
	// A topic new to the map - the cold path. A caller holding a bound resumes
	// above any floor a prior eviction carried (the counter never goes
	// backward, so held client watermarks stay valid) and then lets the bound
	// enforce its cap; a bare-map caller keeps the historical first-call-is-1.
	const next = (bound !== undefined ? bound.floorOf(topic) : 0) + 1;
	seqMap.set(topic, next);
	if (bound !== undefined) bound.onInsert(topic);
	return next;
}

/**
 * Build a hybrid logical clock the platform projects as `platform.hlc()`.
 *
 * Each returned stamp is `{ wall, logical, nodeId }`:
 *
 * - `wall` is a NON-DECREASING wall-clock value in epoch milliseconds, read
 *   from the injectable runtime clock. When the clock advances, `wall` moves
 *   up and `logical` resets to `0`. When two stamps land in the same
 *   millisecond, or the clock steps backward, `wall` holds its previous value
 *   and `logical` increments instead. The `(wall, logical)` pair is therefore
 *   strictly increasing across calls even when the underlying clock is coarse
 *   or briefly regresses.
 * - `logical` is the same-millisecond / backward-step tiebreaker.
 * - `nodeId` is a short, stable per-process identity assigned once from the
 *   injectable runtime RNG (so a seeded harness reproduces it). In clustered
 *   mode it is effectively the worker identity.
 *
 * The returned function is intentionally cheap, but it is meant to be called
 * only when an event needs a causal stamp - not on every publish.
 *
 * @returns {() => { wall: number, logical: number, nodeId: string }}
 */
export function createHlc() {
	const nodeId = randomUuid().slice(0, 8);
	let lastWall = 0;
	let logical = 0;
	return function hlc() {
		const w = now();
		if (w > lastWall) {
			lastWall = w;
			logical = 0;
		} else {
			// Same millisecond or a backward clock step: hold the wall value
			// and advance the tiebreaker so the pair still increases.
			logical += 1;
		}
		return { wall: lastWall, logical, nodeId };
	};
}

/**
 * Complete a JSON envelope started by an `envelopePrefix` builder.
 *
 * Appends the JSON-encoded data and an optional `seq` field, plus the
 * closing brace. When `seq` is `null` or `undefined` the field is
 * omitted entirely so the wire shape matches the legacy
 * `{topic,event,data}` envelope verbatim. When `seq` is a number the
 * resulting envelope is `{topic,event,data,seq}`.
 *
 * An optional `jitterMs` stamps a `j` field carrying the de-herd WINDOW (not a
 * pre-rolled offset - one frame fans out to every subscriber, so a single rolled
 * value would defer them all identically and spread nothing). Each client rolls
 * its own delay in `[0, j)` before dispatching, so the receivers ramp instead of
 * spiking. Omitted (`null`/`undefined`) leaves the wire shape unchanged.
 *
 * No JSON.stringify on seq/jitter: numbers serialize identically via plain string
 * concatenation, saving a stringify call on the publish hot path. The no-jitter
 * tail is byte-identical to the legacy envelope.
 *
 * @param {string} prefix  output of envelopePrefix(topic, event)
 * @param {unknown} data
 * @param {number | null | undefined} seq
 * @param {number | null | undefined} [jitterMs]  de-herd window in ms
 * @returns {string}
 */
export function completeEnvelope(prefix, data, seq, jitterMs) {
	const body = prefix + JSON.stringify(data ?? null);
	const tail = jitterMs == null ? '}' : ',"j":' + jitterMs + '}';
	return seq == null ? body + tail : body + ',"seq":' + seq + tail;
}

/**
 * Complete a client-relay (`game` lane) envelope: the standard
 * `{topic, event, data, seq}` shape with the sender's client `id` echoed to the
 * other receivers when present, for input ordering / prediction-reconcile. `id`
 * is JSON-encoded so a string id (with quotes / unicode) is emitted safely; a
 * numeric id serializes to the same bytes a hand-rolled concat would. Absent
 * `id` (or `seq`) leaves that field off, so the frame stays a plain envelope.
 *
 * @param {string} prefix  output of envelopePrefix(topic, event)
 * @param {unknown} data
 * @param {number | null | undefined} seq
 * @param {number | string | null | undefined} id  the sender's client input id
 * @returns {string}
 */
export function completeGameEnvelope(prefix, data, seq, id) {
	const body = prefix + JSON.stringify(data ?? null);
	const seqTail = seq == null ? '' : ',"seq":' + seq;
	const idTail = id == null ? '' : ',"id":' + JSON.stringify(id);
	return body + seqTail + idTail + '}';
}

/**
 * Wrap an array of pre-built per-event envelope strings into a single
 * `{"type":"batch","events":[...]}` wire frame. Each input string is
 * a complete `{topic, event, data, seq?}` envelope as produced by
 * `completeEnvelope`. The output is the wire format
 * `platform.publishBatched` emits for clients that have advertised
 * the `'batch'` capability.
 *
 * Pure helper: pure string concatenation, no allocations beyond the
 * result string and the intermediate join. Cheap enough to live on
 * the publishBatched hot path.
 *
 * @param {string[]} eventEnvelopes
 * @returns {string}
 */
export function wrapBatchEnvelope(eventEnvelopes) {
	if (eventEnvelopes.length === 0) return '{"type":"batch","events":[]}';
	return '{"type":"batch","events":[' + eventEnvelopes.join(',') + ']}';
}
