import { workerData } from 'node:worker_threads';

export const CLUSTER_SEQUENCE_ERROR =
	'clustered publish requires { seq: false } or { seq: <positive integer>, relay: false }; per-worker counters and the multi-origin built-in relay cannot preserve one monotonic topic sequence';

// Not a clustered rule, and not an arity rule either. `stampSeq` returns a
// caller-supplied numeric seq verbatim, and the batch calls it once PER ENTRY
// with one shared options object, so a numeric seq stamps every entry with the
// same number on a single worker exactly as it does in a cluster. A client that
// received only part of that batch then reports the shared number as its
// watermark, and the resume dedup floor discards the whole batch on gap-fill -
// including entries it never received. That silent gap is the outcome the seq
// lane exists to prevent.
//
// The batch surface carries ONE options object and has no per-entry numeric
// form, so a numeric seq is a category error on it whatever the array happens
// to hold - including one entry, and including none. Accepting it at count 1
// would make the contract depend on the runtime length of an array: a call that
// works while a tick produces one update starts throwing the day it produces
// two. A caller with an authoritative number per frame wants publishWire.
export const BATCH_SEQUENCE_ERROR =
	'publishWireBatch cannot take a numeric seq: the batch carries one options object and no per-entry sequence, so every entry would be stamped with the same value - a client that received only part of the batch reports it as a watermark and the resume floor then discards the rest. Use { seq: false }, or publish each entry through publishWire when each needs an externally authoritative seq';

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
 * The batch surface has no per-entry numeric authority, so a numeric seq is
 * refused on it outright - independent of topology AND of how many entries the
 * caller happens to be publishing, so the contract never changes shape with the
 * data. Callers deliberately pass no count: the refusal must not depend on one.
 *
 * @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options
 * @param {any} [data]
 */
export function assertBatchSequenceAuthority(options, data = workerData) {
	assertClusterSequenceAuthority(options, data);
	if (typeof options?.seq === 'number') {
		throw new Error(BATCH_SEQUENCE_ERROR);
	}
}
