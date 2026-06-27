import { parentPort } from 'node:worker_threads';
import { setTimer } from '../runtime.js';

/** @type {Array<{topic: string, envelope: string, compress?: boolean, seq?: number | null, capability?: string, event?: string, data?: any}> | null} */
let relayBatch = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let relayTimer = null;

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
			if (relayBatch) {
				parentPort.postMessage({ type: 'publish-batch', messages: relayBatch });
			}
			relayBatch = null;
		}, 0);
		if (relayTimer.unref) relayTimer.unref();
	}
	relayBatch.push({ topic, envelope, compress, seq, capability, event, data });
}
