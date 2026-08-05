import { parentPort, threadId } from 'node:worker_threads';
import { processMonotonicNow, setTimer } from '../runtime.js';
import { streamTracking } from './state.js';
import { encodePublishFrame, encodePublishBatchedFrame } from '../relay-ring.js';

/**
 * Per-topic outbound relay streams: what this worker has handed to the relay.
 *
 * `ord` counts the frames sent for a topic and `birth` is when the first one was
 * sent. Together with this worker's thread id they let a RECEIVER check the
 * stream for holes (see handler/state.js `recordOriginStream`) - the frames it
 * should have received from us, numbered densely, plus the instant the stream
 * began so it can tell "I lost the prefix" from "this was already running before
 * I attached".
 *
 * Why a separate counter rather than reusing the publish seq: the seq is not
 * dense over THIS path. A topic also published locally-only (`{ relay: false }`,
 * or the game lane) advances the seq without sending anything, so a receiver
 * would see a jump and cry wolf; an explicit `{ seq: n }` authority interleaves
 * values from several workers, so per-origin contiguity is meaningless; and a
 * `{ seq: false }` topic has no number at all. This counter has exactly one
 * meaning - frames we relayed for this topic - so a hole in it is a lost frame
 * and never anything else.
 *
 * One entry per relayed topic, and `birth` is read once when the entry is
 * created, so the steady-state cost is a single map lookup per relayed publish.
 * @type {Map<string, { ord: number, birth: number }>}
 */
const relayStreams = new Map();

/**
 * Allocate this worker's next relay ordinal for `topic`, opening the stream (and
 * dating it) on first use.
 *
 * MUST be called at the moment the frame is handed to the wire, never when it is
 * queued. The two senders here reach the wire on different schedules - batchRelay
 * defers a tick, relayBatched goes out synchronously - so allocating at queue
 * time would let a batch published AFTER a single publish carry LOWER ordinals
 * and arrive first, which reads to the receiver as a hole that never fills.
 * Allocating at the wire makes ordinal order and arrival order the same order by
 * construction, for every sender and every schedule.
 *
 * Returns null when nothing will read the numbering (every worker in a cluster
 * runs one config, so a receiver would discard it), which keeps both the map and
 * the 20 bytes per frame out of the default deployment entirely.
 * @param {string} topic
 * @returns {{ ord: number, birth: number } | null}
 */
function nextRelayOrdinal(topic) {
	if (!streamTracking.enabled) return null;
	let st = relayStreams.get(topic);
	if (st === undefined) {
		st = { ord: 0, birth: processMonotonicNow() };
		relayStreams.set(topic, st);
	}
	st.ord++;
	return st;
}

/** @type {Array<{topic: string, envelope: string, compress?: boolean, seq?: number | null, capability?: string, event?: string, data?: any, origin?: number, ord?: number, birth?: number}> | null} */
let relayBatch = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let relayTimer = null;

/**
 * The shared-memory ring writer toward the primary, when the cluster runs with
 * the relay ring enabled (see runtime/index.js). Null -> every relay rides
 * postMessage exactly as before.
 * @type {import('../relay-ring.js').RingWriter | null}
 */
let ringWriter = null;

/** Wired once at worker startup by runtime/index.js. */
export function setRelayRingWriter(writer) {
	ringWriter = writer;
}

/**
 * Largest serialized envelope this worker will hand to the cluster relay, and
 * the sink that reports a refusal. Infinity -> no ceiling, which is the shape
 * every deployment had before this existed.
 *
 * WHY THE SENDER OWNS THIS. The ring's own ceilings describe a PEER's failure to
 * drain, so they cannot also police the size of what is being sent - that was
 * the conflation which let one large publish quarantine every healthy sibling at
 * once. Size is a property of the frame, known here, identical for every peer;
 * deciding it once at the sender is also the only way every peer gets the SAME
 * answer, so no sibling is left silently one frame behind the others.
 *
 * It is deliberately checked ABOVE the ring/postMessage split: `CLUSTER_RELAY_RING_KB=0`
 * is a documented configuration, and it must not forfeit the ceiling.
 * @type {number}
 */
let maxRelayEnvelopeBytes = Infinity;

/** @type {((lane: 'publish' | 'batched', topic: string, bytes: number, limit: number) => void) | null} */
let onRelayFrameRefused = null;

/**
 * Wired once at worker startup by runtime/index.js, alongside the ring writer.
 * The refusal sink is injected rather than imported because this module has no
 * access to the metrics registry the handler builds.
 * @param {number} bytes
 * @param {((lane: 'publish' | 'batched', topic: string, bytes: number, limit: number) => void) | null} [onRefused]
 */
export function setRelayFrameCeiling(bytes, onRefused) {
	maxRelayEnvelopeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : Infinity;
	onRelayFrameRefused = onRefused ?? null;
}

/** A refusal is never silent: the publish reached local subscribers, the cluster did not. */
function refuseRelayFrame(lane, topic, bytes) {
	try { onRelayFrameRefused?.(lane, topic, bytes, maxRelayEnvelopeBytes); } catch { /* never break a publish */ }
}

/**
 * @param {string} topic
 * @param {string} envelope
 * @param {boolean} [compress] - Per-frame compress intent carried across the
 *   worker boundary so a relayed frame compresses on the receiving worker the
 *   same way it did locally. Absent (e.g. publishWire callers) -> uncompressed.
 * @param {number | null} [seq] - The stamped per-topic seq, carried as explicit
 *   metadata so the receiving worker advances its delivered-seq tracker without
 *   re-parsing the envelope string. Null/absent (a {seq:false} publish) leaves
 *   the topic out of the receiver's convergence comparison.
 * @param {string} [capability] - A wire codec's capability token, carried so a
 *   receiving worker with binary subscribers can re-derive the codec from its
 *   registry and re-encode binary locally instead of delivering the JSON envelope.
 *   Absent for a plain publish(), an unregistered codec, or a declined wire frame -
 *   the receiver then uses the envelope.
 * @param {string} [event] - The publish event name, for the receiver's re-encode.
 * @param {any} [data] - The raw publish payload (JSON-serializable by construction),
 *   for the receiver's re-encode. Absent -> the receiver uses the JSON envelope.
 *
 * The frame additionally carries this worker's identity and its per-topic relay
 * ordinal + stream birth, stamped at the flush below rather than by any caller:
 * every publish entry point funnels through this one function, and only the
 * sending worker can supply them (the primary forwards ring frames verbatim,
 * without ever parsing them, so it cannot stamp an origin on the way through).
 */
export function batchRelay(topic, envelope, compress, seq, capability, event, data) {
	if (!relayBatch) {
		relayBatch = [];
		relayTimer = setTimer(() => {
			relayTimer = null;
			const batch = relayBatch;
			relayBatch = null;
			if (!batch) return;
			// Number the frames at the wire, in the order they go out. Done for the
			// whole batch up front so both send paths below number identically.
			for (const m of batch) {
				const stream = nextRelayOrdinal(m.topic);
				if (stream !== null) {
					m.origin = threadId;
					m.ord = stream.ord;
					m.birth = stream.birth;
				}
			}
			// Frame admission, decided once for the whole relay and ABOVE the lane
			// split so both lanes inherit it. A refused message still reached this
			// worker's own subscribers; only the cross-worker copy is dropped, and
			// the ordinal it already took leaves a hole its receivers can see. One
			// comparison per message, allocating nothing unless something is over.
			let admitted = batch;
			if (maxRelayEnvelopeBytes !== Infinity) {
				let anyOver = false;
				for (const m of batch) {
					if (m.envelope.length > maxRelayEnvelopeBytes) { anyOver = true; break; }
				}
				if (anyOver) {
					admitted = [];
					for (const m of batch) {
						if (m.envelope.length > maxRelayEnvelopeBytes) {
							refuseRelayFrame('publish', m.topic, m.envelope.length);
							continue;
						}
						admitted.push(m);
					}
					if (admitted.length === 0) return;
				}
			}
			if (ringWriter !== null) {
				// Ring path: each message is encoded to bytes ONCE here; the
				// primary forwards the framed bytes verbatim (no clone, no
				// parse) and only receiving workers decode. One notify wakes
				// the primary for the whole batch.
				let wroteAny = false;
				for (const m of admitted) {
					let frame;
					try {
						frame = encodePublishFrame(m.topic, m.envelope, m.compress, m.seq, m.capability, m.event, m.data, m.origin, m.ord, m.birth);
					} catch {
						// Unreachable by construction (`data` produced the JSON
						// envelope, so it stringifies) - but a defensive fallback
						// must not silently drop a publish: ship this one via the
						// structured-clone path.
						parentPort.postMessage({ type: 'publish-batch', messages: [m] });
						continue;
					}
					ringWriter.write(frame);
					wroteAny = true;
				}
				if (wroteAny) ringWriter.notify();
			} else {
				parentPort.postMessage({ type: 'publish-batch', messages: admitted });
			}
		}, 0);
		if (relayTimer.unref) relayTimer.unref();
	}
	relayBatch.push({ topic, envelope, compress, seq, capability, event, data });
}

/**
 * Relay one wire-level batched publish (`platform.publishBatched`) to the
 * cluster: over the ring when enabled, else as the `publish-batched`
 * postMessage - the receiving worker dispatches it as one batch envelope
 * either way.
 *
 * The batch travels as ONE frame but carries N logical publishes, so each event
 * takes its own ordinal in ITS topic's stream: losing the frame is losing one
 * frame per topic represented in it, and each of those streams must show the
 * hole. Stamped in place - the array is built fresh per call by the caller and
 * is never read again after this returns.
 *
 * This path writes SYNCHRONOUSLY while batchRelay defers a tick, which is exactly
 * why both number their frames as they reach the wire: a batch published after a
 * single publish on the same topic overtakes it, and must carry the higher
 * ordinal to match.
 * @param {Array<any>} events
 * @param {boolean} compress
 */
export function relayBatched(events, compress) {
	for (let i = 0; i < events.length; i++) {
		const stream = nextRelayOrdinal(events[i].topic);
		if (stream === null) break;
		events[i].origin = threadId;
		events[i].ord = stream.ord;
		events[i].birth = stream.birth;
	}
	// The whole array travels as ONE frame, so the ceiling is measured over the
	// whole array and the refusal is wholesale - a batch cannot be half-relayed
	// without changing what a receiver dispatches. Above the lane split, for the
	// same reason as the single-publish path. These entries carry `env`, not
	// `envelope`: this lane relays the pre-built per-event envelopes exactly as
	// platform.publishBatched hands them over.
	if (maxRelayEnvelopeBytes !== Infinity) {
		let total = 0;
		for (let i = 0; i < events.length; i++) total += events[i].env.length;
		if (total > maxRelayEnvelopeBytes) {
			refuseRelayFrame('batched', events.length > 0 ? events[0].topic : '', total);
			return;
		}
	}
	if (ringWriter !== null) {
		let frame;
		try {
			frame = encodePublishBatchedFrame(events, compress);
		} catch {
			parentPort.postMessage({ type: 'publish-batched', events, compress });
			return;
		}
		ringWriter.write(frame);
		ringWriter.notify();
		return;
	}
	parentPort.postMessage({ type: 'publish-batched', events, compress });
}
