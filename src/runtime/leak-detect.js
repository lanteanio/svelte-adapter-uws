// Pure trend kernel for resource-leak detection: given a numeric time series
// (successive samples of some bookkeeping size), decide whether it is growing
// monotonically - the signature of a close / unsubscribe / eviction path that
// stopped shedding entries. This module is the single source of truth for "what
// a leak looks like in a series", imported by the deterministic simulator (which
// samples structural Map/Set sizes after every step) and by the optional
// in-process growth auditor.
//
// It is DISTINCT from invariants.js / auditor.js, which check POINT-IN-TIME
// consistency of one snapshot. This kernel is a TIME-SERIES trend detector: it
// only ever sees a list of numbers and never learns the app shape.
//
// Like invariants.js this module is dependency-free and reads no clock / RNG /
// timer, so it is trivially deterministic and safe to import anywhere: identical
// input numbers always yield an identical report, byte-for-byte, which is what
// lets the simulator fold the report into its reproducer gate.
//
// The verdict is an AND vote, so a noisy or oscillating series is not mistaken
// for a leak:
//   1. least-squares slope over the post-warmup window  >  minSlope
//   2. monotonic (non-decreasing) fraction of the window  >=  minMonotonicFraction
//   3. total delta (last - first)  >  tolerance
//   4. coefficient of determination of that fit  >=  minRSquared
// A flat series fails (1) and (3); a sawtooth fails (2); a genuine ramp passes
// all of them.
//
// The fourth vote asks whether the line MEANS anything. Least squares fits a
// line through any cloud, and the line it finds through a flat noisy one tilts
// with wherever the window happens to start and stop - so a long enough series
// of a healthy resident set eventually produces a positive slope, a delta over
// any fixed tolerance, and a verdict of leaking. r-squared is the share of the
// series' own variance the fit accounts for: near 1 the samples really do lie on
// the line, near 0 the slope is an artifact of the sample the window took.
// Defaults to 0 so every existing caller's verdict is unchanged; the sustained
// resident-set lane sets it to 0.5.

/**
 * @typedef {object} GrowthReport
 * @property {string} [name] series label (set by the tracker; absent for a bare detectGrowth call)
 * @property {number} n number of samples ANALYZED (post-warmup window length)
 * @property {number} first first analyzed sample
 * @property {number} last last analyzed sample
 * @property {number} min minimum over the analyzed window
 * @property {number} max maximum over the analyzed window
 * @property {number} delta last - first
 * @property {number} slope least-squares slope over the analyzed window (per sample)
 * @property {number} monotonicFraction fraction of consecutive pairs that did not decrease, in [0,1]
 * @property {number} rSquared coefficient of determination of the least-squares
 *   fit over the analyzed window, in [0,1]. 1 for a window whose samples are all
 *   equal (a flat line explains a flat series exactly).
 * @property {boolean} leaking true only when every vote agrees
 * @property {string} reason stable machine-readable verdict tag
 */

/**
 * @typedef {object} GrowthOptions
 * @property {number} [warmup] leading samples to discard before analysis (a
 *   startup / fill transient). Default 0.
 * @property {number} [minSamples] minimum analyzed-window length below which the
 *   verdict short-circuits to not-leaking (`insufficient-samples`). Default 8.
 * @property {number} [tolerance] the delta (last - first) must EXCEED this to
 *   count; suppresses sub-threshold drift. Default 0.
 * @property {number} [minSlope] the least-squares slope must EXCEED this to
 *   count. Default 0 (any strictly-positive trend).
 * @property {number} [minMonotonicFraction] the non-decreasing fraction must be
 *   at least this to count. Default 0.9.
 * @property {number} [minRSquared] the fit's coefficient of determination must be
 *   at least this to count, which is what keeps a least-squares line through a
 *   noisy flat series from reading as a trend. Default 0 (fit quality ignored,
 *   so an existing caller's verdict does not move).
 */

const DEFAULT_WARMUP = 0;
const DEFAULT_MIN_SAMPLES = 8;
const DEFAULT_TOLERANCE = 0;
const DEFAULT_MIN_SLOPE = 0;
const DEFAULT_MIN_MONOTONIC_FRACTION = 0.9;
const DEFAULT_MIN_R_SQUARED = 0;

/** Coerce a probe reading to a finite number; a non-finite reading counts as 0. */
function numify(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Least-squares fit of `y` against its own index 0..m-1, with the share of the
 * series' variance the fit explains.
 *
 * `rSquared` is 1 - (residual sum of squares / total sum of squares). A window
 * with no variance at all (every sample equal) has no residual either, and a
 * flat line describes it exactly, so that case is 1 rather than a division by
 * zero - the slope is 0 there and the other votes decide.
 *
 * Pure arithmetic over the sample values, so identical inputs give identical
 * floats. Returns a zero slope and a perfect fit for a window shorter than two
 * points: there is no line to fit and nothing for it to fail to explain.
 *
 * @param {number[]} y
 * @returns {{ slope: number, rSquared: number }}
 */
function leastSquaresFit(y) {
	const m = y.length;
	if (m < 2) return { slope: 0, rSquared: 1 };
	// Closed forms for x = 0..m-1: sumX = m(m-1)/2, sumXX = (m-1)m(2m-1)/6.
	const sumX = (m * (m - 1)) / 2;
	const sumXX = ((m - 1) * m * (2 * m - 1)) / 6;
	let sumY = 0;
	let sumXY = 0;
	for (let i = 0; i < m; i++) {
		sumY += y[i];
		sumXY += i * y[i];
	}
	const denom = m * sumXX - sumX * sumX;
	if (denom === 0) return { slope: 0, rSquared: 1 };
	const slope = (m * sumXY - sumX * sumY) / denom;
	const meanY = sumY / m;
	const intercept = meanY - (slope * sumX) / m;
	let residual = 0;
	let total = 0;
	for (let i = 0; i < m; i++) {
		const predicted = intercept + slope * i;
		residual += (y[i] - predicted) ** 2;
		total += (y[i] - meanY) ** 2;
	}
	if (total === 0) return { slope, rSquared: 1 };
	// Clamped at 0: a least-squares fit cannot do worse than the mean, so a
	// negative value here would be floating-point noise rather than a fit.
	return { slope, rSquared: Math.max(0, 1 - residual / total) };
}

/**
 * Detect monotonic growth in a numeric series. Pure and deterministic.
 *
 * @param {number[]} samples
 * @param {GrowthOptions} [opts]
 * @returns {GrowthReport}
 */
export function detectGrowth(samples, opts = {}) {
	const warmup = opts.warmup ?? DEFAULT_WARMUP;
	const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
	const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
	const minSlope = opts.minSlope ?? DEFAULT_MIN_SLOPE;
	const minMonotonicFraction = opts.minMonotonicFraction ?? DEFAULT_MIN_MONOTONIC_FRACTION;
	const minRSquared = opts.minRSquared ?? DEFAULT_MIN_R_SQUARED;

	const all = Array.isArray(samples) ? samples : [];
	const start = warmup > 0 ? Math.min(warmup, all.length) : 0;
	const window = start > 0 ? all.slice(start).map(numify) : all.map(numify);
	const m = window.length;

	if (m === 0) {
		return { n: 0, first: 0, last: 0, min: 0, max: 0, delta: 0, slope: 0, monotonicFraction: 1, rSquared: 1, leaking: false, reason: 'insufficient-samples' };
	}

	const first = window[0];
	const last = window[m - 1];
	let min = first;
	let max = first;
	let nonDecreasing = 0;
	for (let i = 0; i < m; i++) {
		const v = window[i];
		if (v < min) min = v;
		if (v > max) max = v;
		if (i > 0 && v >= window[i - 1]) nonDecreasing++;
	}
	const delta = last - first;
	const monotonicFraction = m > 1 ? nonDecreasing / (m - 1) : 1;

	if (m < minSamples) {
		return { n: m, first, last, min, max, delta, slope: 0, monotonicFraction, rSquared: 1, leaking: false, reason: 'insufficient-samples' };
	}

	const { slope, rSquared } = leastSquaresFit(window);

	const deltaVote = delta > tolerance;
	const monotonicVote = monotonicFraction >= minMonotonicFraction;
	const slopeVote = slope > minSlope;
	const fitVote = rSquared >= minRSquared;
	const leaking = deltaVote && monotonicVote && slopeVote && fitVote;

	// First failing gate names the reason so a not-leaking verdict is
	// explainable; a passing verdict is `growth-detected`. The fit is judged
	// last because it only matters once a slope has already been found worth
	// believing - reporting `fit-too-poor` for a series with no trend at all
	// would name the wrong thing.
	let reason;
	if (leaking) reason = 'growth-detected';
	else if (!deltaVote) reason = 'delta-within-tolerance';
	else if (!monotonicVote) reason = 'non-monotonic';
	else if (!slopeVote) reason = 'slope-below-threshold';
	else reason = 'fit-too-poor';

	return { n: m, first, last, min, max, delta, slope, monotonicFraction, rSquared, leaking, reason };
}

/**
 * Normalize the probe argument into an ordered list of `{ name, read }`.
 * Accepts an array of `{ name, read }` or a `Record<string, () => number>`.
 *
 * @param {Array<{ name: string, read: () => number }> | Record<string, () => number>} probes
 * @returns {Array<{ name: string, read: () => number }>}
 */
function normalizeProbes(probes) {
	if (Array.isArray(probes)) {
		return probes.map((p) => {
			if (!p || typeof p.name !== 'string' || typeof p.read !== 'function') {
				throw new Error('createResourceTracker: each probe must be { name: string, read: () => number }');
			}
			return { name: p.name, read: p.read };
		});
	}
	if (probes && typeof probes === 'object') {
		return Object.keys(probes).map((name) => {
			const read = probes[name];
			if (typeof read !== 'function') {
				throw new Error('createResourceTracker: a probe record value must be a () => number function (for `' + name + '`)');
			}
			return { name, read };
		});
	}
	throw new Error('createResourceTracker: probes must be an array of { name, read } or a Record<string, () => number>');
}

/**
 * A multi-series sampler over a fixed probe list. `sample()` reads every probe
 * once and appends to that probe's series; `analyze()` runs the trend kernel
 * over each series. `maxSamples` (optional) caps every series to its trailing N
 * readings so a long-running auditor stays bounded; omit it (the default) to
 * keep the full history, which the simulator wants for a whole-run analysis.
 *
 * @param {Array<{ name: string, read: () => number }> | Record<string, () => number>} probes
 * @param {{ maxSamples?: number }} [opts]
 * @returns {{
 *   sample(): void,
 *   series(name: string): number[],
 *   names(): string[],
 *   analyze(opts?: GrowthOptions): { metrics: GrowthReport[], leaks: GrowthReport[], leaking: boolean },
 *   reset(): void
 * }}
 */
export function createResourceTracker(probes, opts = {}) {
	const list = normalizeProbes(probes);
	const maxSamples = Number.isInteger(opts.maxSamples) && opts.maxSamples > 0 ? opts.maxSamples : 0;
	/** @type {Map<string, number[]>} */
	const seriesByName = new Map();
	for (const p of list) seriesByName.set(p.name, []);

	return {
		sample() {
			for (const p of list) {
				const s = seriesByName.get(p.name);
				s.push(numify(p.read()));
				// Trailing-window bound: drop the oldest reading once capped, so a
				// long-lived auditor trends recent history at fixed memory.
				if (maxSamples && s.length > maxSamples) s.shift();
			}
		},
		series(name) {
			const s = seriesByName.get(name);
			return s ? s.slice() : [];
		},
		names() {
			return list.map((p) => p.name);
		},
		analyze(analyzeOpts) {
			/** @type {GrowthReport[]} */
			const metrics = [];
			for (const p of list) {
				const report = detectGrowth(seriesByName.get(p.name), analyzeOpts);
				report.name = p.name;
				metrics.push(report);
			}
			const leaks = metrics.filter((r) => r.leaking);
			return { metrics, leaks, leaking: leaks.length > 0 };
		},
		reset() {
			for (const s of seriesByName.values()) s.length = 0;
		}
	};
}

/**
 * Thrown by `assertNoResourceGrowth` when at least one series is leaking. Carries
 * the offending reports on `.leaks` so a test can inspect which resource and by
 * how much.
 */
export class LeakError extends Error {
	/** @param {GrowthReport[]} leaks */
	constructor(leaks) {
		const detail = (leaks || [])
			.map((l) => (l.name || 'series') + ' (delta ' + l.delta + ', slope ' + l.slope.toFixed(4) + ')')
			.join('; ');
		super('resource growth detected: ' + detail);
		this.name = 'LeakError';
		/** @type {GrowthReport[]} */
		this.leaks = leaks || [];
	}
}

/**
 * Assert that nothing is leaking. Accepts a tracker (calls `analyze`), an
 * analyze RESULT (`{ leaks }`), an array of reports, or a single report. Throws
 * `LeakError` (with `.leaks`) when any series leaks; otherwise returns void.
 *
 * @param {any} trackerOrReport
 * @param {GrowthOptions} [opts]
 * @returns {void}
 */
export function assertNoResourceGrowth(trackerOrReport, opts) {
	/** @type {GrowthReport[]} */
	let leaks;
	if (trackerOrReport && typeof trackerOrReport.analyze === 'function') {
		leaks = trackerOrReport.analyze(opts).leaks;
	} else if (trackerOrReport && Array.isArray(trackerOrReport.leaks)) {
		leaks = trackerOrReport.leaks.filter((r) => r && r.leaking);
	} else if (Array.isArray(trackerOrReport)) {
		leaks = trackerOrReport.filter((r) => r && r.leaking);
	} else if (trackerOrReport && typeof trackerOrReport === 'object') {
		leaks = trackerOrReport.leaking ? [trackerOrReport] : [];
	} else {
		leaks = [];
	}
	if (leaks.length > 0) throw new LeakError(leaks);
}
