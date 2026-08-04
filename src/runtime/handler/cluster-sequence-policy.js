import { workerData } from 'node:worker_threads';

export const CLUSTER_SEQUENCE_ERROR =
	'clustered publish requires { seq: false } or { seq: <positive integer>, relay: false }; per-worker counters and the multi-origin built-in relay cannot preserve one monotonic topic sequence';

// Not a clustered rule. `stampSeq` returns a caller-supplied numeric seq
// verbatim, and publishWireBatch calls it once PER ENTRY with one shared
// options object, so a numeric seq stamps every entry with the same number on a
// single worker exactly as it does in a cluster. A client that received only
// part of that batch then reports the shared number as its watermark, and the
// resume dedup floor discards the whole batch on gap-fill - including entries it
// never received. That silent gap is the outcome the seq lane exists to prevent.
export const BATCH_SEQUENCE_ERROR =
	'publishWireBatch with more than one entry cannot take a numeric seq: it would stamp every entry with the same value, so a client that received only part of the batch reports it as a watermark and the resume floor then discards the rest. Use { seq: false }, or publish entries individually when each needs an externally authoritative seq';

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
	// A single-entry batch carrying an authoritative seq is unambiguous and stays
	// allowed - that is a deliberate allowance, not an oversight. Everything above
	// one entry is refused whatever the topology.
	if (count > 1 && typeof options?.seq === 'number') {
		throw new Error(BATCH_SEQUENCE_ERROR);
	}
}
