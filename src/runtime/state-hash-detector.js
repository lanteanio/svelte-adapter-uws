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
 * @param {{ epochMs: number, monotonicNow: () => number, maxBuckets?: number, persistEpochs?: number }} opts
 */
export function createStateHashDetector(opts) {
	const defaultEpochMs = opts.epochMs > 0 ? opts.epochMs : 1;
	const monotonicNow = opts.monotonicNow;
	// Keep a small ring of recent epochs so a slow straggler report does not grow
	// the map without bound; an epoch older than this many buckets is dropped.
	const maxBuckets = opts.maxBuckets && opts.maxBuckets > 0 ? opts.maxBuckets : 8;
	// How many CONSECUTIVELY-JUDGED divergent epochs the active comparison must
	// accumulate before a divergence is returned. One epoch of disagreement can
	// be a boundary artifact - a report tick landing inside the skew window
	// where one worker has folded a frame its sibling receives a moment later,
	// or where an activity-window boundary crosses between two workers' ticks -
	// and a returned divergence can restart a worker, so a single epoch must
	// never fire. Judged-agreeing buckets reset the streak; epochs that never
	// complete (a worker joining or leaving) neither count nor reset.
	const persistEpochs = opts.persistEpochs && opts.persistEpochs > 0 ? opts.persistEpochs : 2;

	/** @type {Map<number, { hashes: Map<number, number>, judged: boolean }>} epoch -> reports */
	const buckets = new Map();
	/** Quiet-lane buckets, same shape, judged by the same rules. */
	const quietBuckets = new Map();
	// The active streak is keyed by WHICH workers disagree (the minority
	// partition), not by the hash values: a real standing fork keeps the same
	// minority while its hashes move with every publish, so value-keying would
	// never accumulate, while two unrelated single-epoch skew artifacts hit
	// different workers and must not add up to a restart.
	let divergentStreak = 0;
	/** @type {string | null} */
	let streakPartition = null;
	// The quiet lane gets the same persistence before its first report, so a
	// one-epoch classification-skew artifact (one worker ages a topic to quiet
	// a report round before its sibling) never logs at all.
	let quietStreak = 0;
	/** @type {string | null} */
	let quietStreakPartition = null;
	/** @type {string | null} last logged quiet-divergence signature, for dedup */
	let quietSignature = null;

	function pruneMap(map, currentEpoch) {
		if (map.size <= maxBuckets) return;
		const cutoff = currentEpoch - maxBuckets;
		for (const epoch of map.keys()) {
			if (epoch < cutoff) map.delete(epoch);
		}
	}

	/**
	 * Bucket one report and, when this report completes the epoch's bucket
	 * (every live worker present), judge it: null while incomplete or already
	 * judged, `{ divergence: null }` for a judged agreeing bucket, and a full
	 * descriptor for a judged disagreeing one. Shared by both lanes so the
	 * completion and majority rules cannot drift between them.
	 */
	function judge(map, threadId, hash, liveThreadIds, epochMs) {
		const width = epochMs > 0 ? epochMs : defaultEpochMs;
		const epoch = Math.floor(monotonicNow() / width);
		let bucket = map.get(epoch);
		if (!bucket) { bucket = { hashes: new Map(), judged: false }; map.set(epoch, bucket); }
		bucket.hashes.set(threadId, hash);
		pruneMap(map, epoch);

		if (bucket.judged) return null;
		// Only judge once every CURRENTLY-live worker has a report in this bucket.
		for (const id of liveThreadIds) {
			if (!bucket.hashes.has(id)) return null;
		}
		bucket.judged = true;

		/** @type {Map<number, number[]>} hash -> thread ids */
		const byHash = new Map();
		for (const id of liveThreadIds) {
			const h = bucket.hashes.get(id);
			let ids = byHash.get(h);
			if (!ids) { ids = []; byHash.set(h, ids); }
			ids.push(id);
		}
		if (byHash.size <= 1) return { divergence: null, epoch };

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

		return { divergence: { epoch, majorityHash: majority.hash, hashesByThread, minorityThreadIds }, epoch };
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
		const judged = judge(buckets, threadId, hash, liveThreadIds, epochMs);
		if (judged === null) return null;
		if (judged.divergence === null) {
			divergentStreak = 0;
			streakPartition = null;
			return null;
		}
		const partition = judged.divergence.minorityThreadIds.join(',');
		if (partition === streakPartition) divergentStreak++;
		else { divergentStreak = 1; streakPartition = partition; }
		if (divergentStreak < persistEpochs) return null;
		return judged.divergence;
	}

	/**
	 * The QUIET lane: same bucketing and majority rules over the hash of topics
	 * with no recent traffic. A disagreement here is expected life-cycle - a
	 * respawned worker legitimately holds none of its siblings' quiet history
	 * and, with nobody publishing those topics, can never learn it - so the
	 * caller must treat a returned descriptor as a LOG-ONLY diagnostic, never a
	 * restart trigger. Gated twice: the same minority partition must first
	 * persist for `persistEpochs` consecutive judged epochs (so a one-epoch
	 * classification-skew artifact never logs, and a changed partition re-earns
	 * its persistence), and then the (thread, hash) constellation is
	 * deduplicated - the same standing disagreement is returned once, a CHANGED
	 * constellation with the same persisted partition is returned immediately,
	 * and a judged agreement re-arms everything so a later re-divergence is
	 * reported.
	 *
	 * @param {number} threadId
	 * @param {number} hash
	 * @param {number[]} liveThreadIds
	 * @param {number} [epochMs]
	 * @returns {StateDivergence | null}
	 */
	function recordQuiet(threadId, hash, liveThreadIds, epochMs) {
		const judged = judge(quietBuckets, threadId, hash, liveThreadIds, epochMs);
		if (judged === null) return null;
		if (judged.divergence === null) {
			quietStreak = 0;
			quietStreakPartition = null;
			quietSignature = null;
			return null;
		}
		// Persistence first: quiet state is stable by definition (nothing is
		// publishing), so a real standing disagreement repeats identically next
		// epoch, while a one-epoch classification-skew artifact never returns.
		const partition = judged.divergence.minorityThreadIds.join(',');
		if (partition === quietStreakPartition) quietStreak++;
		else { quietStreak = 1; quietStreakPartition = partition; }
		if (quietStreak < persistEpochs) return null;
		// Then dedup by the full constellation, so the same standing fact is
		// reported once and a CHANGED one is reported again.
		const signature = Object.entries(judged.divergence.hashesByThread)
			.map(([id, h]) => id + ':' + h)
			.sort()
			.join(',');
		if (signature === quietSignature) return null;
		quietSignature = signature;
		return judged.divergence;
	}

	/** Drop a worker's pending presence from open buckets (called on worker exit). */
	function forget(threadId) {
		for (const bucket of buckets.values()) bucket.hashes.delete(threadId);
		for (const bucket of quietBuckets.values()) bucket.hashes.delete(threadId);
	}

	return { record, recordQuiet, forget, get size() { return buckets.size; } };
}
