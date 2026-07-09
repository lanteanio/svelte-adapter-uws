import { parentPort } from 'node:worker_threads';
import { setTimer } from '../runtime.js';
import { encodePublishFrame, encodePublishBatchedFrame } from '../relay-ring.js';

/** @type {Array<{topic: string, envelope: string, compress?: boolean, seq?: number | null, capability?: string, event?: string, data?: any}> | null} */
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
 */
export function batchRelay(topic, envelope, compress, seq, capability, event, data) {
	if (!relayBatch) {
		relayBatch = [];
		relayTimer = setTimer(() => {
			relayTimer = null;
			const batch = relayBatch;
			relayBatch = null;
			if (!batch) return;
			if (ringWriter !== null) {
				// Ring path: each message is encoded to bytes ONCE here; the
				// primary forwards the framed bytes verbatim (no clone, no
				// parse) and only receiving workers decode. One notify wakes
				// the primary for the whole batch.
				let wroteAny = false;
				for (const m of batch) {
					let frame;
					try {
						frame = encodePublishFrame(m.topic, m.envelope, m.compress, m.seq, m.capability, m.event, m.data);
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
				parentPort.postMessage({ type: 'publish-batch', messages: batch });
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
 * @param {Array<any>} events
 * @param {boolean} compress
 */
export function relayBatched(events, compress) {
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
