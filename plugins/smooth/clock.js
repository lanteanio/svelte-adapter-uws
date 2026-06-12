/**
 * Server-clock offset estimator.
 *
 * Maintains an estimate of the server's wall clock on a client, expressed as
 * an offset against the client's MONOTONIC clock, so that
 * `estServerNow(monotonicNow())` yields the server's current wall time. The
 * estimate is what render-in-the-past interpolation needs (a stable,
 * jitter-free time axis shared with the server's frame stamps) and what
 * server-compared command timestamps need (an absolute server-epoch value).
 *
 * Sampling model:
 *
 *   - Every server-stamped frame is a ONE-WAY sample: the stamp was written at
 *     send time and observed at `recvMono`, so `stamp - recvMono` equals the
 *     true offset MINUS that frame's downstream delay - always a lower bound.
 *     The maximum over recent samples therefore approaches the true offset
 *     from below, biased only by the fastest frame's transit time.
 *   - A request/reply pair (`seed`) additionally yields an UPPER bound from
 *     the send leg: `stamp - sendMono` equals the true offset PLUS the
 *     upstream delay. The target is clamped under the freshest upper bound
 *     while it is fresh, so a queue of slow frames can never push the
 *     estimate above what the round trip proved.
 *
 * The lower-bound maximum is kept in coarse time buckets and the maximum is
 * taken over the last few buckets, so the estimate tracks slow clock drift
 * instead of latching a months-old fastest sample.
 *
 * The APPLIED offset moves toward the target through a slew limiter: a small
 * bounded correction per unit of real time, so the time axis the render loop
 * reads never jumps (a jump would teleport every interpolated entity). The
 * first sample, and any divergence beyond `snapMs`, snaps instead - there is
 * nothing smooth about being a second off.
 *
 * Pure: no clocks, no timers, no imports. Every method takes the relevant
 * time reading as an argument, so the same code runs on the main thread, in
 * a worker, and under a deterministic simulation harness unchanged.
 *
 * @module svelte-adapter-uws/plugins/smooth/clock
 */

/**
 * @param {{ bucketMs?: number, buckets?: number, slewRate?: number, snapMs?: number, upperTtlMs?: number }} [options]
 *   `bucketMs` x `buckets` is the sliding window the lower-bound maximum is
 *   taken over (default 30s x 4). `slewRate` is the maximum applied-offset
 *   correction in ms per ms of monotonic time (default 0.05). `snapMs` is the
 *   divergence past which the applied offset snaps to the target instead of
 *   slewing (default 1000). `upperTtlMs` bounds how long a round-trip upper
 *   bound stays authoritative (default 300000).
 */
export function createServerClock(options = {}) {
	const bucketMs = options.bucketMs === undefined ? 30000 : options.bucketMs;
	const bucketCount = options.buckets === undefined ? 4 : options.buckets;
	const slewRate = options.slewRate === undefined ? 0.05 : options.slewRate;
	const snapMs = options.snapMs === undefined ? 1000 : options.snapMs;
	const upperTtlMs = options.upperTtlMs === undefined ? 300000 : options.upperTtlMs;

	// Lower-bound maxima per bucket; -Infinity marks an empty bucket. The
	// array is fixed-size and reused - nothing here allocates after creation.
	const buckets = new Float64Array(bucketCount).fill(-Infinity);
	let bucketBase = -1; // monotonic time the current bucket started, -1 = never
	let bucketIndex = 0;

	let upperBound = Infinity;
	let upperAtMono = -Infinity;

	let applied = 0;
	let hasApplied = false;
	let lastSlewMono = -Infinity;

	/** Rotate buckets forward so `mono` falls inside the current bucket. */
	function rotate(mono) {
		if (bucketBase < 0) {
			bucketBase = mono;
			return;
		}
		while (mono - bucketBase >= bucketMs) {
			bucketBase += bucketMs;
			bucketIndex = (bucketIndex + 1) % bucketCount;
			buckets[bucketIndex] = -Infinity;
		}
	}

	function target() {
		let max = -Infinity;
		for (let i = 0; i < bucketCount; i++) {
			if (buckets[i] > max) max = buckets[i];
		}
		if (max === -Infinity) return null;
		return max > upperBound ? upperBound : max;
	}

	return {
		/**
		 * Feed a one-way sample: a server wall-clock stamp observed at the
		 * given client-monotonic time. Cheap enough to call per frame.
		 * @param {number} serverT  server wall-clock ms
		 * @param {number} recvMono client monotonic ms at receipt
		 */
		sample(serverT, recvMono) {
			if (typeof serverT !== 'number' || !Number.isFinite(serverT)) return;
			if (typeof recvMono !== 'number' || !Number.isFinite(recvMono)) return;
			rotate(recvMono);
			const cand = serverT - recvMono;
			if (cand > buckets[bucketIndex]) buckets[bucketIndex] = cand;
			if (recvMono - upperAtMono > upperTtlMs) upperBound = Infinity;
		},

		/**
		 * Feed a round-trip sample: a server stamp produced between a request
		 * sent at `sendMono` and its reply received at `recvMono`. Records the
		 * recv-leg lower bound like {@link sample} and the send-leg upper bound.
		 * @param {number} serverT  server wall-clock ms
		 * @param {number} sendMono client monotonic ms when the request left
		 * @param {number} recvMono client monotonic ms when the reply arrived
		 */
		seed(serverT, sendMono, recvMono) {
			if (typeof serverT !== 'number' || !Number.isFinite(serverT)) return;
			if (typeof sendMono !== 'number' || !Number.isFinite(sendMono)) return;
			if (typeof recvMono !== 'number' || !Number.isFinite(recvMono) || recvMono < sendMono) return;
			this.sample(serverT, recvMono);
			upperBound = serverT - sendMono;
			upperAtMono = recvMono;
		},

		/**
		 * The estimated server wall time at the given client-monotonic reading,
		 * or `null` before the first sample. Advances the slew limiter, so call
		 * it with non-decreasing readings (one call per render frame).
		 * @param {number} monoNow
		 * @returns {number | null}
		 */
		estServerNow(monoNow) {
			const t = target();
			if (t === null) return hasApplied ? monoNow + applied : null;
			if (!hasApplied) {
				applied = t;
				hasApplied = true;
				lastSlewMono = monoNow;
				return monoNow + applied;
			}
			const diff = t - applied;
			if (diff > snapMs || diff < -snapMs) {
				applied = t;
			} else {
				const dt = monoNow - lastSlewMono;
				if (dt > 0) {
					const limit = dt * slewRate;
					applied += diff > limit ? limit : diff < -limit ? -limit : diff;
				}
			}
			lastSlewMono = monoNow;
			return monoNow + applied;
		},

		/** The currently applied offset (ms), or `null` before the first sample. */
		offset() {
			return hasApplied ? applied : null;
		},

		/** Forget everything (a reconnect may land on a different machine). */
		reset() {
			buckets.fill(-Infinity);
			bucketBase = -1;
			bucketIndex = 0;
			upperBound = Infinity;
			upperAtMono = -Infinity;
			applied = 0;
			hasApplied = false;
			lastSlewMono = -Infinity;
		}
	};
}
