// The primary's bookkeeping for cluster metrics collection, factored out of
// the is_primary branch of index.js so it is drivable in a unit test without
// spawning worker threads - the same reasoning as worker-watchdog.js, and the
// same division of labour: this module decides, index.js does the I/O (the
// postMessage, the deadline timer).
//
// AT MOST ONE COLLECTION RUNS AT A TIME, cluster-wide. That is the load-bearing
// property, not an optimisation. Coalescing inside each worker cannot provide
// it: the guard is module state in a worker thread, so N workers each admit one
// collection and each fans out to all N workers - N squared collect messages
// and N squared serializations, from N concurrent requests to a scrape route
// that the README's own example leaves unauthenticated. Since the primary is
// also the cross-worker publish relay, that amplification lands on the thread
// whose latency every WebSocket client depends on.
//
// So a request that arrives while a collection is open JOINS it rather than
// starting another. That is also simply correct: two scrapes microseconds apart
// want the same answer, and giving them the same one is cheaper and more
// consistent than collecting twice.

import { SIGNALS_BY_NAME } from './observability-manifest.js';

/**
 * @typedef {object} Collection
 * @property {Array<{ worker: any, id: string }>} requesters Workers awaiting
 *   this result, each with its OWN correlation id - a joining worker generated
 *   its own and will not recognise anyone else's.
 * @property {Array<{ worker: number, samples: any[] }>} reports
 * @property {number} expected The CONFIGURED worker count, not the live ready
 *   roster. A worker that is down or restarting is exactly what an operator
 *   needs to see, and counting only live workers would report a shrunken
 *   cluster as complete.
 * @property {number} answered How many workers replied at all. Every reply is
 *   retained in `reports`, including an empty one, so the merge can separately
 *   decide whether its required factories and sampled gauges are complete.
 * @property {number} pending How many are still owed.
 * @property {any} timer Deadline handle, owned by the caller.
 */

/**
 * @returns {{
 *   begin(requester: any, id: string, targets: number): Collection | null,
 *   join(requester: any, id: string): boolean,
 *   note(threadId: number, samples: unknown): boolean,
 *   missed(): boolean,
 *   retire(threadId: number): void,
 *   retiredReport(): { worker: string, samples: Array<{ name: string, labels: Record<string, string>, value: number }> } | null,
 *   take(): Collection | null,
 *   active(): Collection | null
 * }}
 */
export function createMetricsCollections() {
	/** @type {Collection | null} */
	let open = null;

	// The last report each live worker gave, and the accumulated monotone
	// counter/histogram totals of workers that have since exited.
	//
	// Without this, a respawned worker restarts its counters at zero and the
	// cluster sum DROPS by whatever that worker had accumulated. Prometheus
	// reads a decreasing counter as a reset and rate() spikes - so every worker
	// restart, which the restart supervisor exists to make routine, would print
	// a lie across every counter in the cluster. Carrying a dead worker's final
	// totals forward keeps the sum monotonic, which is the actual contract of a
	// counter.
	//
	// Counters and cumulative histogram buckets/count/sum are carried. A gauge
	// describes a live worker (its connections, its heap) and a dead one
	// contributes nothing to it.
	//
	// The residual is bounded and one-directional: activity between a worker's
	// last report and its death is not counted, so the total can lag by at most
	// one collection interval of one worker's traffic. It never decreases.
	/** @type {Map<number, any[]>} */
	const lastByThread = new Map();
	/** @type {Map<string, any>} */
	const retired = new Map();

	/**
	 * The cumulative samples of a report. Gauges are never carried forward from
	 * a worker that is absent: a gauge describes a live worker, and a stale
	 * connection count is a wrong number rather than a lagging one.
	 *
	 * @param {any[]} samples
	 */
	const cumulativeSamplesOf = (samples) => {
		const out = [];
		for (const sample of samples) {
			if (sample === null || typeof sample !== 'object') continue;
			const signal = SIGNALS_BY_NAME.get(sample.name);
			if (signal?.type === 'counter') {
				if (typeof sample.value !== 'number' || Number.isNaN(sample.value)) continue;
				out.push({
					name: sample.name,
					labels: sample.labels !== null && typeof sample.labels === 'object' ? sample.labels : {},
					value: sample.value
				});
			} else if (signal?.type === 'histogram' && sample.histogram !== null &&
				typeof sample.histogram === 'object' && Array.isArray(sample.histogram.buckets) &&
				Array.isArray(sample.histogram.counts)) {
				out.push({
					name: sample.name,
					labels: sample.labels !== null && typeof sample.labels === 'object' ? sample.labels : {},
					histogram: {
						buckets: sample.histogram.buckets.slice(),
						counts: sample.histogram.counts.slice(),
						count: sample.histogram.count,
						sum: sample.histogram.sum
					}
				});
			}
		}
		return out;
	};

	/** @param {Record<string, string>} labels */
	const keyOf = (name, labels) => {
		const keys = Object.keys(labels).sort();
		return name + '|' + keys.map((k) => k + '=' + labels[k]).join(',');
	};

	return {
		/**
		 * Open a collection awaiting `targets` reports, or null when one is
		 * already running (the caller should `join` instead).
		 */
		begin(requester, id, targetThreadIds) {
			if (open !== null) return null;
			const targets = new Set(targetThreadIds);
			open = {
				// The id the `metrics-collect` fan-out is stamped with. A report
				// carrying any other id belongs to a collection that has already
				// been answered, and must not be folded into this one.
				collectId: id,
				requesters: [{ worker: requester, id }],
				reports: [],
				// WHICH workers are owed, not merely how many. A count cannot say
				// who is missing, and knowing that is what lets a worker who misses
				// the deadline contribute its last known counters instead of
				// silently dropping out of the sum.
				targets,
				answeredThreads: new Set(),
				expected: targets.size,
				answered: 0,
				pending: targets.size,
				timer: null
			};
			return open;
		},

		/**
		 * Attach a late requester to the collection already in flight. Returns
		 * false when there is nothing to join.
		 *
		 * Keyed on the correlation id, not the worker: one worker coalesces its
		 * own concurrent callers locally, so a second request from the same
		 * worker carries a genuinely new id only when its previous collection
		 * has already settled, and both ids must be answered.
		 */
		join(requester, id) {
			if (open === null) return false;
			if (!open.requesters.some((r) => r.id === id)) open.requesters.push({ worker: requester, id });
			return true;
		},

		/**
		 * Record one worker's report. Empty samples mean that worker had nothing
		 * mirrored - it is counted as answered but contributes no series, so the
		 * gap between expected and reporting stays honest rather than being
		 * papered over.
		 *
		 * @returns {boolean} True when every asked worker has now answered.
		 */
		note(collectId, threadId, samples) {
			if (open === null) return false;
			// A worker blocked past the deadline drains its queued collect
			// requests late. Without these two guards its stale report lands in
			// whichever collection happens to be open: that worker is counted
			// twice, `pending` reaches zero before the workers that had not yet
			// answered, and their genuine reports are dropped - while `answered`
			// still equals `expected`, so every completeness signal reads healthy
			// on a document that double-counts one worker and omits another.
			// Accept only an exact match. Written as a positive test on purpose: a
			// "reject a mismatch" form would let any future report path that omits
			// the id restore the original defect with every completeness signal
			// still reading green.
			if (collectId !== open.collectId) return false;
			if (!open.targets.has(threadId)) return false;
			if (open.answeredThreads.has(threadId)) return false;
			open.answeredThreads.add(threadId);
			open.answered++;
			const reportSamples = Array.isArray(samples) ? samples : [];
			// Preserve even an empty report. The merge must be able to distinguish
			// "this worker answered with no initialized metric families" from "this
			// worker never answered"; collapsing both to absence made the global
			// reporting count claim completeness during worker warm-up.
			open.reports.push({ worker: threadId, samples: reportSamples });
			if (reportSamples.length > 0) {
				// Retained so this worker's counter totals survive its death.
				lastByThread.set(threadId, reportSamples);
			}
			open.pending--;
			return open.pending <= 0;
		},

		/**
		 * Fold an exited worker's final counter and histogram totals into the
		 * carried set, so cumulative families do not drop when its replacement
		 * starts from zero.
		 * Idempotent: a second call for the same thread has nothing left to fold.
		 */
		retire(threadId) {
			const samples = lastByThread.get(threadId);
			if (samples === undefined) return;
			lastByThread.delete(threadId);
			// A worker that dies inside the collection window has already been
			// pushed into the open collection's reports (Node delivers its
			// `message` before its `exit`). Folding those same totals into the
			// carried set while they are ALSO in the live reports counts them
			// twice for this scrape and once for every scrape after - so the
			// series would spike and then fall back, which is the counter
			// decrease this whole mechanism exists to prevent. Its live report
			// is withdrawn here so the value is carried exactly once.
			if (open !== null) {
				const at = open.reports.findIndex((r) => r.worker === threadId);
				if (at !== -1) open.reports.splice(at, 1);
			}
			for (const sample of cumulativeSamplesOf(samples)) {
				const key = keyOf(sample.name, sample.labels);
				const existing = retired.get(key);
				if (existing === undefined) {
					retired.set(key, sample);
				} else if (sample.histogram !== undefined && existing.histogram !== undefined) {
					for (let i = 0; i < existing.histogram.counts.length; i++) {
						existing.histogram.counts[i] += sample.histogram.counts[i];
					}
					existing.histogram.count += sample.histogram.count;
					existing.histogram.sum += sample.histogram.sum;
				} else {
					existing.value += sample.value;
				}
			}
		},

		/**
		 * The carried totals of every exited worker, as one extra report, or
		 * null when no worker has exited yet.
		 */
		retiredReport() {
			if (retired.size === 0) return null;
			return {
				worker: 'retired',
				samples: [...retired.values()].map((sample) => sample.histogram === undefined
					? { ...sample }
					: {
						...sample,
						histogram: {
							...sample.histogram,
							buckets: sample.histogram.buckets.slice(),
							counts: sample.histogram.counts.slice()
						}
					})
			};
		},

		/**
		 * Give up on one worker that can no longer answer (it died between the
		 * ready check and the send).
		 *
		 * @returns {boolean} True when nothing further is owed.
		 */
		missed(threadId) {
			if (open === null) return false;
			// Keyed, not a blind decrement: a worker that already answered must not
			// be counted off a second time, or `pending` reaches zero early and the
			// workers still owed are dropped from the document.
			if (threadId !== undefined) {
				if (!open.targets.has(threadId) || open.answeredThreads.has(threadId)) return false;
				open.answeredThreads.add(threadId);
			}
			open.pending--;
			return open.pending <= 0;
		},

		/**
		 * Remove and return the open collection, or null if there is none.
		 *
		 * Attaches `stale`: the last known cumulative counter/histogram totals of
		 * every worker that was
		 * asked and did not answer. Without it, a worker that merely misses the
		 * deadline - a long synchronous stretch, a major GC, no death involved -
		 * drops out of the sum entirely, and the cluster counter falls and then
		 * recovers. Prometheus reads that fall as a counter reset and charges the
		 * recovery as traffic that never happened. A per-worker counter never
		 * decreases, so re-using its previous total is monotone by construction:
		 * the document undercounts that worker for one scrape rather than
		 * erasing it.
		 */
		take() {
			const entry = open;
			open = null;
			if (entry === null) return null;
			const stale = [];
			for (const threadId of entry.targets) {
				if (entry.answeredThreads.has(threadId)) continue;
				const samples = lastByThread.get(threadId);
				if (samples === undefined) continue;
				for (const sample of cumulativeSamplesOf(samples)) stale.push(sample);
			}
			entry.stale = stale;
			return entry;
		},

		active() {
			return open;
		}
	};
}
