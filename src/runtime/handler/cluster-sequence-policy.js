import { workerData } from 'node:worker_threads';

export const CLUSTER_SEQUENCE_ERROR =
	'clustered publish requires { seq: false } or { seq: <positive integer>, relay: false }; per-worker counters and the multi-origin built-in relay cannot preserve one monotonic topic sequence';

export const CLUSTER_SEQUENCE_BATCH_ERROR =
	'clustered publishWireBatch with multiple entries requires { seq: false }; publish entries individually with externally authoritative seq values when replay ordering is required';

/** @param {any} [data] */
export function hasMultipleWorkers(data = workerData) {
	return Number.isInteger(data?.totalWorkers) && data.totalWorkers > 1;
}

// The topology is immutable for the worker's lifetime, so the per-publish
// guards read one hoisted boolean instead of re-deriving it on the hot path.
const MULTI_WORKER_RUNTIME = hasMultipleWorkers();

/**
 * A sequenced clustered frame is safe only when an external ordered source
 * allocated the seq AND fans the frame to every process. `relay:false` is the
 * observable proof that the adapter's unordered multi-origin relay is not also
 * being used. An unsequenced frame makes no monotonic promise and is safe too.
 *
 * @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options
 * @param {any} [data]
 */
export function clusterSequenceAccepted(options, data = workerData) {
	if (data === workerData ? !MULTI_WORKER_RUNTIME : !hasMultipleWorkers(data)) return true;
	if (options?.seq === false) return true;
	return Number.isInteger(options?.seq) && options.seq >= 1 && options?.relay === false;
}

/** @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options @param {any} [data] */
export function assertClusterSequenceAuthority(options, data = workerData) {
	if (!clusterSequenceAccepted(options, data)) throw new Error(CLUSTER_SEQUENCE_ERROR);
}

/**
 * A single numeric option repeated over N entries would stamp N identical seqs.
 * The existing batch surface has no per-entry numeric authority, so in a
 * multi-worker process its multi-entry spelling is deliberately unsequenced.
 *
 * @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options
 * @param {number} count
 * @param {any} [data]
 */
export function assertClusterSequenceBatchAuthority(options, count, data = workerData) {
	assertClusterSequenceAuthority(options, data);
	if (hasMultipleWorkers(data) && count > 1 && typeof options?.seq === 'number') {
		throw new Error(CLUSTER_SEQUENCE_BATCH_ERROR);
	}
}
