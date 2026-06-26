import { now, wallEpoch, randomUuid } from '../runtime.js';

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
 * Read through the seam's wall clock so two boots almost never collide; the
 * low-order millisecond bits are enough to distinguish consecutive restarts,
 * and the value only ever has to differ from the immediately-previous boot for
 * the mismatch detection to fire. Never persisted - a fresh process is, by
 * definition, a fresh seq space. Latching on first read (rather than at module
 * import) lets a controlled simulation that has installed a virtual clock latch a
 * reproducible value after `resetProcessEpoch()`.
 *
 * @returns {number}
 */
let _processEpoch;
export function processEpoch() {
	if (_processEpoch === undefined) _processEpoch = wallEpoch();
	return _processEpoch;
}

/** Clear the latched generation so the next read re-latches. Simulation use only. */
export function resetProcessEpoch() { _processEpoch = undefined; }

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
