/**
 * Resolve which pressure signal (if any) is firing for a given sample.
 *
 * Precedence is fixed: MEMORY beats CPU_QUOTA beats PSI beats PUBLISH_RATE
 * beats SUBSCRIBERS. Memory is the most urgent signal because the worker is
 * approaching OOM. CPU_QUOTA comes next: a quota-throttled container is not
 * merely contended, it is periodically STOPPED by the scheduler - the most
 * actionable external cause (raise the quota). PSI follows: kernel-observed
 * stall time is a sharper overload read than any process-local proxy.
 * Publish rate is next because CPU saturation cascades fastest; subscriber
 * ratio comes last because heavy fan-out degrades gracefully.
 *
 * Any threshold may be `false` to disable that signal entirely. A signal
 * fires when the corresponding sample value is greater than or equal to
 * its threshold. The kernel-sourced sample fields (`psiCpuSome10`,
 * `psiMemoryFull10`, `psiIoFull10`, `cpuThrottledRatio`) are simply absent
 * on hosts without the source, which never fires the comparison - the
 * non-Linux path is byte-identical.
 *
 * Pure: no I/O, no globals. Suitable for unit tests.
 *
 * @param {{ heapUsedRatio: number, publishRate: number, subscriberRatio: number, psiCpuSome10?: number, psiMemoryFull10?: number, psiIoFull10?: number, cpuThrottledRatio?: number }} sample
 * @param {{ memoryHeapUsedRatio: number | false, publishRatePerSec: number | false, subscriberRatio: number | false, psiCpuSome?: number | false, psiMemoryFull?: number | false, psiIoFull?: number | false, cpuThrottledRatio?: number | false }} thresholds
 * @returns {'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI'}
 */
export function computePressureReason(sample, thresholds) {
	if (
		thresholds.memoryHeapUsedRatio !== false &&
		sample.heapUsedRatio >= thresholds.memoryHeapUsedRatio
	) {
		return 'MEMORY';
	}
	if (
		thresholds.cpuThrottledRatio !== undefined && thresholds.cpuThrottledRatio !== false &&
		sample.cpuThrottledRatio !== undefined &&
		sample.cpuThrottledRatio >= thresholds.cpuThrottledRatio
	) {
		return 'CPU_QUOTA';
	}
	if (
		(thresholds.psiCpuSome !== undefined && thresholds.psiCpuSome !== false &&
			sample.psiCpuSome10 !== undefined && sample.psiCpuSome10 >= thresholds.psiCpuSome) ||
		(thresholds.psiMemoryFull !== undefined && thresholds.psiMemoryFull !== false &&
			sample.psiMemoryFull10 !== undefined && sample.psiMemoryFull10 >= thresholds.psiMemoryFull) ||
		(thresholds.psiIoFull !== undefined && thresholds.psiIoFull !== false &&
			sample.psiIoFull10 !== undefined && sample.psiIoFull10 >= thresholds.psiIoFull)
	) {
		return 'PSI';
	}
	if (
		thresholds.publishRatePerSec !== false &&
		sample.publishRate >= thresholds.publishRatePerSec
	) {
		return 'PUBLISH_RATE';
	}
	if (
		thresholds.subscriberRatio !== false &&
		sample.subscriberRatio >= thresholds.subscriberRatio
	) {
		return 'SUBSCRIBERS';
	}
	return 'NONE';
}

/**
 * Layer the capacity-pressure reason on top of an already-computed pressure
 * reason. `CAPACITY` surfaces only when the protection posture is engaged
 * (`elevated` or `siege`) and no higher-urgency reason is already active.
 * `MEMORY` is the only reason that outranks it (the worker is near OOM - that
 * wins); for any other base reason `CAPACITY` takes precedence because
 * over-capacity admission is the more actionable upgrade-layer signal.
 *
 * Pure: no I/O, no globals. Keeping it separate leaves `computePressureReason`
 * a single-responsibility precedence function and makes this trivially
 * testable. When the posture is `normal` the base reason passes through
 * untouched, so the zero-config path is byte-identical.
 *
 * @param {'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI'} reason base reason
 * @param {'normal' | 'elevated' | 'siege'} protection live posture level
 * @returns {'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY'}
 */
export function applyCapacityReason(reason, protection) {
	if (reason === 'MEMORY') return 'MEMORY';
	if (protection === 'elevated' || protection === 'siege') return 'CAPACITY';
	return reason;
}

/**
 * Graduated protection posture over the 1 Hz pressure signal. Three working
 * levels (`normal | elevated | siege`); an explicit `pin` freezes the level for
 * incident response or testing, otherwise the level resolves from the live
 * signal. It owns no timer: `.tick` is driven by the existing pressure sampler,
 * once per sample.
 *
 * Escalation is fast, relaxation is slow (asymmetric dwell), so the level
 * cannot flap around a threshold.
 *
 * The reject accounting is deliberately minimal: a single decayed integer that
 * counts only the over-capacity (maxConcurrent) reject. It is never a per-IP
 * structure, so it cannot itself be grown into a DoS vector. The per-IP
 * rate-limit reject feeds a separate, intentionally inert counter - it is an
 * attack signal, not a capacity signal, and must never drive escalation.
 *
 * @param {{
 *   admission: { maxConcurrent: number },
 *   getThresholds: () => { sampleIntervalMs?: number },
 *   pin?: 'normal' | 'elevated' | 'siege',
 *   onTransition?: (from: 'normal' | 'elevated' | 'siege', to: 'normal' | 'elevated' | 'siege') => void
 * }} cfg
 *   admission: the live admission gate; its `maxConcurrent` is the per-sample
 *     admit ceiling and the basis for the over-capacity escalation threshold.
 *   getThresholds: resolver for the live pressure thresholds (read lazily so the
 *     posture always reflects the gate's current settings).
 *   pin: when set, freezes the level; `.tick` then only runs the reject decay.
 *   onTransition: observer fired once per level change, after the machine has
 *     settled on the new level. A pinned machine never changes level, so it
 *     never fires. Exceptions are contained; a throwing observer cannot wedge
 *     the machine.
 * @returns {{
 *   readonly level: 'normal' | 'elevated' | 'siege',
 *   readonly rejectedPerSecond: number,
 *   recordCapacityReject(): void,
 *   recordRateLimitReject(): void,
 *   tick(snapshot: { active: boolean }): void
 * }}
 */
export function createPosture(cfg) {
	// Dwell lengths in SAMPLES (the sampler is ~1 Hz, so 5 samples ~= 5s).
	// Escalate fast, relax slow: the relax dwell is the hysteresis band.
	const ESCALATE_ELEVATED_SAMPLES = 5;   // normal -> elevated
	const ESCALATE_SIEGE_SAMPLES = 10;     // elevated -> siege
	const RELAX_SAMPLES = 10;              // any downward step (the longer dwell)

	const admission = cfg.admission;
	const pin = cfg.pin === 'normal' || cfg.pin === 'elevated' || cfg.pin === 'siege'
		? cfg.pin
		: null;
	const onTransition = typeof cfg.onTransition === 'function' ? cfg.onTransition : null;

	let level = pin !== null ? pin : 'normal';
	// Single decayed integer. Counts ONLY the maxConcurrent reject (the true
	// over-capacity signal). NOT the per-IP rate-limit rejects, NOT a per-IP
	// map, so it can never itself be a DoS vector. Incremented at the reject
	// site; folded into a rolling rate once per tick.
	let rejectAccum = 0;
	let rejectedPerSecond = 0;
	// A separate, intentionally inert counter for the per-IP rate-limit reject.
	// It exists so the reject site has somewhere to report without touching the
	// capacity rate; nothing reads it for escalation. Kept bounded by the same
	// decay so it never grows without limit.
	let rateLimitAccum = 0;
	// Asymmetric dwell counters. Each advances at most once per tick.
	let activeRun = 0;     // consecutive samples with snapshot.active
	let overCapRun = 0;    // consecutive samples with the over-capacity reject rate
	let quietRun = 0;      // consecutive calm samples (for relaxation)

	// elevated -> siege fires when over-capacity rejects run at >= 2x what the
	// gate admits per sample, sustained across the siege dwell. Derived from the
	// ceiling, never a magic number. With no ceiling (0) the gate never emits the
	// maxConcurrent reject, so the threshold is Infinity and siege is unreachable
	// via auto resolution (a pinned siege still works).
	function siegeRejectRate() {
		const ceiling = (admission && admission.maxConcurrent) || 0;
		return ceiling > 0 ? ceiling * 2 : Infinity;
	}

	return {
		/** Live working level. Property read. */
		get level() { return level; },
		/**
		 * Rolling over-capacity reject rate: the decayed per-second value plus
		 * any rejects accumulated since the last tick, so a fresh burst is
		 * visible immediately and a quiet period decays it back toward zero. A
		 * single integer; never a per-IP structure.
		 */
		get rejectedPerSecond() { return rejectAccum + rejectedPerSecond; },

		/**
		 * Increment at the maxConcurrent reject site. One integer add, no
		 * argument, so there is no per-IP key to record.
		 */
		recordCapacityReject() { rejectAccum++; },

		/**
		 * Increment at the per-IP rate-limit reject site. Deliberately separate
		 * from the capacity rate so an attack-driven 429 storm can never push
		 * the posture toward siege.
		 */
		recordRateLimitReject() { rateLimitAccum++; },

		/**
		 * Advance the machine exactly once per pressure sample. `snapshot` is the
		 * just-folded pressure snapshot (its `active` flag already set for this
		 * sample). Pure level math plus the reject-rate decay; no I/O.
		 *
		 * @param {{ active: boolean }} snapshot
		 */
		tick(snapshot) {
			// Capture this sample's fresh over-capacity rejects before folding,
			// then roll them into a 1s rate and decay. A burst in one window
			// still half-counts in the next, so a single-sample spike neither
			// sticks nor instantly vanishes. Integer halving keeps it
			// allocation-free and bounded.
			const freshRejects = rejectAccum;
			rejectedPerSecond = rejectAccum + (rejectedPerSecond >> 1);
			rejectAccum = 0;
			rateLimitAccum = 0;

			// A pinned level freezes the machine; only the decay above runs.
			if (pin !== null) return;

			const prev = level;

			const active = snapshot != null && snapshot.active === true;
			// Escalation tracks this sample's FRESH over-capacity rejects against
			// the per-sample ceiling, so the threshold means exactly what it says:
			// twice the admit rate per sample. The longer siege dwell - not a
			// rolling decay tail - is what keeps a single momentary spike from
			// climbing to siege.
			const overCapacity = freshRejects >= siegeRejectRate();
			// Relaxation tracks FRESH activity: once new pressure and new
			// over-capacity rejects both stop, the quiet dwell begins counting
			// immediately rather than waiting out the reject-rate decay tail.
			const calm = !active && freshRejects === 0;

			activeRun = active ? activeRun + 1 : 0;
			overCapRun = overCapacity ? overCapRun + 1 : 0;
			quietRun = calm ? quietRun + 1 : 0;

			if (level === 'normal') {
				if (activeRun >= ESCALATE_ELEVATED_SAMPLES) {
					level = 'elevated';
					overCapRun = 0;
					quietRun = 0;
				}
			} else if (level === 'elevated') {
				if (overCapRun >= ESCALATE_SIEGE_SAMPLES) {
					level = 'siege';
					quietRun = 0;
				} else if (quietRun >= RELAX_SAMPLES) {
					level = 'normal';
					activeRun = 0;
				}
			} else { // siege
				if (quietRun >= RELAX_SAMPLES) {
					// Step down one level at a time; the next quiet dwell relaxes
					// further. Never jumps siege -> normal in a single dwell.
					level = 'elevated';
					quietRun = 0;
					overCapRun = 0;
				}
			}

			// Notify after the machine has settled so the observer reads a
			// consistent level. Contained: an observer failure must never
			// stall the posture (it guards the upgrade path).
			if (level !== prev && onTransition !== null) {
				try {
					onTransition(prev, level);
				} catch (err) {
					console.error('[ws] posture transition observer threw:', err);
				}
			}
		}
	};
}

/**
 * Reduce a per-topic publish-stats Map (`topic -> { m, b }` where `m` is
 * messages-in-window and `b` is bytes-in-window) into per-second rates.
 * Returns the top 5 topics by message rate plus any topics that crossed
 * either threshold.
 *
 * Pure: no I/O, no globals, does not mutate the input. The caller is
 * responsible for clearing the source map after sampling.
 *
 * @param {Map<string, { m: number, b: number }>} stats
 * @param {number} intervalSec
 * @param {{ topicPublishRatePerSec: number | false, topicPublishBytesPerSec: number | false }} thresholds
 * @returns {{ topPublishers: { topic: string, messagesPerSec: number, bytesPerSec: number }[], overThreshold: { topic: string, messagesPerSec: number, bytesPerSec: number }[] }}
 */
export function computeTopPublishers(stats, intervalSec, thresholds) {
	const topicRates = [];
	const overThreshold = [];
	const msgThreshold = thresholds.topicPublishRatePerSec;
	const byteThreshold = thresholds.topicPublishBytesPerSec;
	for (const [topic, s] of stats) {
		const messagesPerSec = intervalSec > 0 ? s.m / intervalSec : 0;
		const bytesPerSec = intervalSec > 0 ? s.b / intervalSec : 0;
		const entry = { topic, messagesPerSec, bytesPerSec };
		topicRates.push(entry);
		const tooManyMsg = msgThreshold !== false && messagesPerSec >= msgThreshold;
		const tooManyBytes = byteThreshold !== false && bytesPerSec >= byteThreshold;
		if (tooManyMsg || tooManyBytes) overThreshold.push(entry);
	}
	topicRates.sort((a, b) => b.messagesPerSec - a.messagesPerSec);
	return { topPublishers: topicRates.slice(0, 5), overThreshold };
}
