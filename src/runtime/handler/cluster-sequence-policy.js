import { workerData } from 'node:worker_threads';
import { assertStampableSeq } from '../utils/epoch.js';

export const CLUSTER_SEQUENCE_ERROR =
	'clustered publish requires { seq: false } (or null) or { seq: <positive integer number or bigint>, relay: false }; per-worker counters and the multi-origin built-in relay cannot preserve one monotonic topic sequence';

// Not a clustered rule, and not an arity rule either. `stampSeq` returns a
// caller-supplied numeric seq verbatim, and the batch calls it once PER ENTRY
// with one shared options object, so a numeric seq stamps every entry with the
// same number on a single worker exactly as it does in a cluster. A client that
// received only part of that batch then reports the shared number as its
// watermark, and the resume dedup floor discards the whole batch on gap-fill -
// including entries it never received. That silent gap is the outcome the seq
// lane exists to prevent.
//
// One number for N entries is a category error on the batch whatever the array
// happens to hold - including one entry, and including none. Accepting it at
// count 1 would make the contract depend on the runtime length of an array: a
// call that works while a tick produces one update starts throwing the day it
// produces two. An authoritative number belongs on EACH ENTRY - `{ data, seq }`
// - which is the one spelling that honours one-seq-per-entry when the numbers
// come from a cluster authority rather than the local counter.
export const BATCH_SEQUENCE_ERROR =
	'publishWireBatch cannot take a numeric seq: one options object cannot carry one-seq-per-entry, so every entry would be stamped with the same value - a client that received only part of the batch reports it as a watermark and the resume floor then discards the rest. Put the seq on each entry instead ({ data, seq }, each an integer >= 1; in a multi-worker runtime with { seq: false, relay: false }), or use { seq: false }. { seq: true } keeps the single-worker counter, which already increments per entry';

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
 * The values form is the primitive and the options form delegates to it, so
 * the rule cannot drift between the two spellings. The hot publish lanes call
 * the values form with fields they read ONCE: an options object with a
 * stateful `seq` accessor must not be able to answer this check with one
 * value and hand the stamp another - accepted, stamped, and relayed is the
 * exact combination the check exists to refuse.
 *
 * Speaks the same table as `stampSeq`, spelling for spelling: `false` and
 * `null` are the no-seq forms and make no monotonic promise; a positive
 * integer `number` or `bigint` is the external authority and demands
 * `relay: false`; `true` and absent are the per-worker counter, which a
 * cluster refuses. The two modules must agree on SPELLINGS - a spelling the
 * stamp accepts and this gate refuses (or the reverse) is the drift both
 * tables exist to prevent.
 *
 * Whether an accepted spelling's VALUE can be carried is not asked here. A
 * number or bigint past the double space's safe-integer range is a legitimate
 * authority spelling that the stamp then refuses on magnitude
 * ({@link import('../utils/epoch.js').explicitSeqValue}). Answering it here
 * would hand that caller this module's topology message, which names relay
 * settings and worker counters and would send them looking in the wrong
 * place; letting the stamp answer gets them the magnitude message instead.
 *
 * @param {boolean | number | bigint | null | undefined} seq
 * @param {boolean | undefined} relay
 * @param {any} [data]
 */
export function clusterSequenceValuesAccepted(seq, relay, data = workerData) {
	if (data === workerData ? !MULTI_WORKER_RUNTIME : !hasMultipleWorkers(data)) return true;
	if (seq === false || seq === null) return true;
	if (typeof seq === 'bigint') return seq >= 1n && relay === false;
	return Number.isInteger(seq) && /** @type {number} */ (seq) >= 1 && relay === false;
}

/** @param {boolean | number | undefined} seq @param {boolean | undefined} relay @param {any} [data] */
export function assertClusterSequenceAuthorityValues(seq, relay, data = workerData) {
	if (!clusterSequenceValuesAccepted(seq, relay, data)) throw new Error(CLUSTER_SEQUENCE_ERROR);
}

/** @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options @param {any} [data] */
export function clusterSequenceAccepted(options, data = workerData) {
	return clusterSequenceValuesAccepted(options?.seq, options?.relay, data);
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
 * The remaining spellings are held to the stamp's own table here, at the call
 * gate, rather than in the stamping loop the batch reaches later: that loop
 * runs after the batch has taken its egress decision, so a string seq was
 * answered with a silent `false` under an armed ceiling and threw only once
 * load dropped. Numeric first, because a number IS stampable and would pass -
 * what it must earn is the batch's own refusal, which names the per-entry
 * spelling that replaces it.
 *
 * @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options
 * @param {any} [data]
 */
export function assertBatchSequenceAuthority(options, data = workerData) {
	assertClusterSequenceAuthority(options, data);
	if (typeof options?.seq === 'number' || typeof options?.seq === 'bigint') {
		// TypeError, like every seq-VALUE refusal (stampSeq's numeric arm, the
		// per-entry pre-pass): the caller handed a value the surface cannot
		// take. The topology asserts above and below stay plain Errors - they
		// refuse a deployment shape, not a value.
		throw new TypeError(BATCH_SEQUENCE_ERROR);
	}
	assertStampableSeq(options?.seq);
}

// A batch ENTRY carrying an explicit seq is the per-entry twin of
// `publishWire({ seq: N })`, and takes the same clustered rule for the same
// reason: the number came from an external ordered allocator, so the external
// source must also be the fan-out - the built-in relay is multi-origin and
// cannot preserve one monotonic topic order. `relay: false` is the observable
// proof it is off. On a multi-worker runtime the batch's own options already
// had to say `{ seq: false }` to get past the call-level gate above, so the
// clustered spelling of an authoritative batch is `{ seq: false, relay: false }`
// plus a seq on each entry - options renounce the counter, entries carry the
// authority. Checked once per batch, in the pre-pass, BEFORE anything is
// stamped or fanned out, so it composes with whole-batch-or-nothing rather
// than throwing mid-delivery.
export const BATCH_ENTRY_SEQUENCE_ERROR =
	'clustered publishWireBatch entries carrying an explicit seq require { seq: false, relay: false }: the seq came from an external allocator, and the built-in multi-origin relay cannot preserve one monotonic topic sequence for it';

/** @param {{ seq?: boolean | number, relay?: boolean } | null | undefined} options @param {any} [data] */
export function assertBatchEntrySequenceAuthority(options, data = workerData) {
	if (data === workerData ? !MULTI_WORKER_RUNTIME : !hasMultipleWorkers(data)) return;
	if (options?.relay === false) return;
	throw new Error(BATCH_ENTRY_SEQUENCE_ERROR);
}
