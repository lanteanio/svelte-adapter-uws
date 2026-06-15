import { parentPort } from 'node:worker_threads';
import { setTimer } from '../runtime.js';

/** @type {Array<{topic: string, envelope: string}> | null} */
let relayBatch = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let relayTimer = null;

/**
 * @param {string} topic
 * @param {string} envelope
 * @param {boolean} [compress] - Per-frame compress intent carried across the
 *   worker boundary so a relayed frame compresses on the receiving worker the
 *   same way it did locally. Absent (e.g. publishWire callers) -> uncompressed.
 */
export function batchRelay(topic, envelope, compress) {
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
	relayBatch.push({ topic, envelope, compress });
}
