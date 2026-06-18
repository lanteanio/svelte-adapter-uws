// Cross-worker state-hash divergence detector for the cluster primary.
//
// Each worker periodically reports a structural hash of its delivered-seq map
// (see handler/state.js maxSeenSeq + invariants.js computeStateHash). Under a
// reliable in-process relay every live worker should fold to the SAME hash at
// rest; a worker that fell behind (a relay frame delivered to some workers but
// not it) reports a different hash. This module buckets the reports the primary
// receives and decides when a bucket of reports proves a divergence.
//
// Why a PRIMARY-assigned epoch: a worker's own wall clock can skew from the
// others', so the worker cannot label its report with a bucket the primary can
// reliably group on. Instead the primary stamps each report with its OWN
// monotonic-clock epoch on receipt (floor(monotonicNow / epochMs)); reports that
// arrive in the same primary epoch window are compared together. Each worker
// jitters only its FIRST report then reports on a fixed period, and the primary
// sizes the bucket width (passed per report, from the worker's advertised
// interval) to comfortably exceed that period, so one reporting round from every
// live worker reliably lands in one bucket.
//
// A bucket is only judged once EVERY currently-live worker has reported into it
// (so a worker that has not yet reported never reads as a phantom divergence),
// and judged at most once (so a single divergence is not re-counted as later
// reports trickle in). Stale buckets are pruned to bound memory.
//
// Pure with respect to the injected clock: no raw Date.now / timers. The caller
// passes the live thread-id set on each record so the detector never holds a
// reference to the supervisor's worker map.

/**
 * @typedef {{
 *   epoch: number,
 *   majorityHash: number,
 *   hashesByThread: Record<number, number>,
 *   minorityThreadIds: number[]
 * }} StateDivergence
 */

/**
 * @param {{ epochMs: number, monotonicNow: () => number, maxBuckets?: number }} opts
 */
export function createStateHashDetector(opts) {
	const defaultEpochMs = opts.epochMs > 0 ? opts.epochMs : 1;
	const monotonicNow = opts.monotonicNow;
	// Keep a small ring of recent epochs so a slow straggler report does not grow
	// the map without bound; an epoch older than this many buckets is dropped.
	const maxBuckets = opts.maxBuckets && opts.maxBuckets > 0 ? opts.maxBuckets : 8;

	/** @type {Map<number, { hashes: Map<number, number>, judged: boolean }>} epoch -> reports */
	const buckets = new Map();

	function pruneOlderThan(currentEpoch) {
		if (buckets.size <= maxBuckets) return;
		const cutoff = currentEpoch - maxBuckets;
		for (const epoch of buckets.keys()) {
			if (epoch < cutoff) buckets.delete(epoch);
		}
	}

	/**
	 * Record one worker's reported hash, stamped with the primary's current
	 * epoch. Returns a divergence descriptor when this report completes a bucket
	 * (every live worker has now reported into it) AND the hashes disagree;
	 * otherwise null. A completed-and-agreeing bucket marks itself judged and
	 * returns null. A bucket that completes with a single hash never fires.
	 *
	 * @param {number} threadId
	 * @param {number} hash
	 * @param {number[]} liveThreadIds - the thread ids of every currently-live worker
	 * @param {number} [epochMs] - bucket width for THIS report, so the primary can
	 *   size it to the worker's advertised interval; falls back to the constructor value
	 * @returns {StateDivergence | null}
	 */
	function record(threadId, hash, liveThreadIds, epochMs) {
		const width = epochMs > 0 ? epochMs : defaultEpochMs;
		const epoch = Math.floor(monotonicNow() / width);
		let bucket = buckets.get(epoch);
		if (!bucket) { bucket = { hashes: new Map(), judged: false }; buckets.set(epoch, bucket); }
		bucket.hashes.set(threadId, hash);
		pruneOlderThan(epoch);

		if (bucket.judged) return null;
		// Only judge once every CURRENTLY-live worker has a report in this bucket.
		// A worker that died mid-window is no longer in liveThreadIds, so its
		// absence does not stall the comparison; a worker not yet reported keeps
		// the bucket open.
		for (const id of liveThreadIds) {
			if (!bucket.hashes.has(id)) return null;
		}
		bucket.judged = true;

		// Compare only the live workers' hashes (a dead worker's stale report in
		// the bucket must not be treated as a divergent group).
		/** @type {Map<number, number[]>} hash -> thread ids */
		const byHash = new Map();
		for (const id of liveThreadIds) {
			const h = bucket.hashes.get(id);
			let ids = byHash.get(h);
			if (!ids) { ids = []; byHash.set(h, ids); }
			ids.push(id);
		}
		if (byHash.size <= 1) return null; // converged

		// Canonical grouping: largest group is the majority (the convergent
		// reference); on a size tie the group whose largest thread id is bigger
		// sorts last, so the pick is deterministic. The minority is every thread
		// NOT in the majority group.
		const groups = [...byHash].map(([h, ids]) => {
			const sorted = ids.slice().sort((a, b) => a - b);
			return { hash: h, ids: sorted, max: sorted[sorted.length - 1] };
		});
		groups.sort((a, b) => (b.ids.length - a.ids.length) || (a.max - b.max));
		const majority = groups[0];

		/** @type {Record<number, number>} */
		const hashesByThread = {};
		const minorityThreadIds = [];
		for (const id of liveThreadIds) {
			const h = bucket.hashes.get(id);
			hashesByThread[id] = h;
			if (h !== majority.hash) minorityThreadIds.push(id);
		}
		minorityThreadIds.sort((a, b) => a - b);

		return { epoch, majorityHash: majority.hash, hashesByThread, minorityThreadIds };
	}

	/** Drop a worker's pending presence from open buckets (called on worker exit). */
	function forget(threadId) {
		for (const bucket of buckets.values()) bucket.hashes.delete(threadId);
	}

	return { record, forget, get size() { return buckets.size; } };
}
