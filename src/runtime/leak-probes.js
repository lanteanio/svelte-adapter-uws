// Probe factories for the resource-leak harness, plus the optional in-process
// growth auditor that rides a slow unref'd timer. Split out of leak-detect.js so
// that module stays a pure, dependency-free kernel: THIS module is the one that
// closes over live state (Map/Set sizes) and reaches the runtime seam for its
// timer. It mirrors audit-snapshot.js's posture - close over the live
// collections, read them once, bounded - against the trend kernel instead of the
// point-in-time predicates.
//
// EXCLUSION LIST (read before adding a probe). The trend kernel flags a series
// that grows monotonically, so it MUST only ever be fed a size that is expected
// to return to a baseline as connections come and go. NEVER probe a
// monotonic-by-DESIGN value, or the harness self-fires on healthy state:
//   - allocWireId's per-connection `next` counter (wire.js): increments forever.
//   - counters.nextRequestRef (handler/state.js): monotonic request-ref source.
//   - the VALUES inside topicSeqs / maxSeenSeq: per-topic broadcast sequence
//     numbers that only ever climb.
// The rule of thumb is baked into structuralResourceProbes: it reads a
// collection's `.size` (or a caller-supplied read function), never a stored
// counter value. topicSeqs.SIZE (topic cardinality) is a legitimate probe;
// topicSeqs's stored seq numbers are not.

import { now, randomFloat, setIntervalTimer, clearIntervalTimer } from './runtime.js';
import { createResourceTracker } from './leak-detect.js';

/**
 * Build a structural probe list over live collections. Each source is either a
 * Map/Set (probed by `.size`) or a `() => number` read function (for a derived
 * size, e.g. a sum across connections). Deterministic: `.size` and the caller's
 * read are pure reads of in-memory structure, so the same live state yields the
 * same numbers - safe to feed the reproducer gate.
 *
 * @param {Record<string, { size?: number } | (() => number)>} sources
 * @returns {Array<{ name: string, read: () => number }>}
 */
export function structuralResourceProbes(sources) {
	/** @type {Array<{ name: string, read: () => number }>} */
	const probes = [];
	if (!sources || typeof sources !== 'object') return probes;
	for (const name of Object.keys(sources)) {
		const src = sources[name];
		if (typeof src === 'function') {
			probes.push({ name, read: () => Number(src()) || 0 });
		} else {
			// A Map / Set / anything exposing a numeric `.size`.
			probes.push({ name, read: () => (src && typeof src.size === 'number' ? src.size : 0) });
		}
	}
	return probes;
}

/** Length of an internal active-handle/request array, or 0 when unavailable. */
function activeCount(method) {
	const fn = typeof process !== 'undefined' ? process[method] : undefined;
	if (typeof fn !== 'function') return 0;
	try {
		const arr = fn.call(process);
		return Array.isArray(arr) ? arr.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Build a process-level probe list: heap / rss / external / arrayBuffers plus
 * active libuv handle and request counts. These readings are NON-DETERMINISTIC
 * (GC timing, allocator behaviour), so they are for the standalone real-server
 * harness ONLY - never fed into the simulator's reproducer gate. Pass
 * `{ forceGc: true }` (with node --expose-gc) to settle the heap before each
 * memory read so a transient allocation is not mistaken for a leak.
 *
 * @param {{ forceGc?: boolean }} [opts]
 * @returns {Array<{ name: string, read: () => number }>}
 */
export function processResourceProbes(opts = {}) {
	const forceGc = opts.forceGc === true;
	const readMem = (field) => () => {
		if (forceGc && typeof globalThis.gc === 'function') globalThis.gc();
		return process.memoryUsage()[field];
	};
	return [
		{ name: 'heapUsed', read: readMem('heapUsed') },
		{ name: 'rss', read: readMem('rss') },
		{ name: 'external', read: readMem('external') },
		{ name: 'arrayBuffers', read: readMem('arrayBuffers') },
		{ name: 'activeHandles', read: () => activeCount('_getActiveHandles') },
		{ name: 'activeRequests', read: () => activeCount('_getActiveRequests') }
	];
}

const DEFAULT_AUDIT_INTERVAL_MS = 30000;
const DEFAULT_WINDOW = 20;
const DEFAULT_JITTER_MS = 1000;

/**
 * Optional in-process resource-growth auditor. Mirrors createConsistencyAuditor's
 * shape (runOnce / start / stop / unref'd jittered timer) but drives the TREND
 * kernel over a bounded trailing window instead of the point-in-time predicates.
 *
 * OBSERVE-ONLY by contract: a suspected trend increments a metric (via `metrics`)
 * and/or calls `onGrowth(report)`; it NEVER throws and NEVER terminates. It is
 * meant to be opt-in (interval 0 = never installed) because a trend signal is
 * inherently probabilistic - the always-on structural guard is the deterministic
 * simulator, not production.
 *
 * @param {object} config
 * @param {Array<{ name: string, read: () => number }>} config.probes
 * @param {number} [config.intervalMs] tick cadence (default 30000).
 * @param {number} [config.window] trailing samples kept + analyzed (default 20).
 * @param {number} [config.jitterMs] max random jitter added per tick (default 1000).
 * @param {(report: import('./leak-detect.js').GrowthReport) => void} [config.onGrowth]
 *   called once per suspected series each tick (observe-only).
 * @param {{ inc?: (labels?: object) => void }} [config.metrics] optional counter;
 *   `.inc({ resource })` fires per suspected series.
 * @param {import('./leak-detect.js').GrowthOptions} [config.analyze] kernel opts.
 * @returns {{ start(): void, stop(): void, runOnce(): void, stats: { ticks: number, samples: number, suspected: number } }}
 */
export function createResourceGrowthAuditor(config = {}) {
	const probes = config.probes || [];
	const intervalMs = config.intervalMs ?? DEFAULT_AUDIT_INTERVAL_MS;
	const windowSize = config.window ?? DEFAULT_WINDOW;
	const jitterMs = config.jitterMs ?? DEFAULT_JITTER_MS;
	const onGrowth = typeof config.onGrowth === 'function' ? config.onGrowth : null;
	const metrics = config.metrics && typeof config.metrics.inc === 'function' ? config.metrics : null;
	// Default the minimum window to the smaller of the shipped kernel default and
	// the trailing window, so the auditor can flag before the window has filled to
	// its cap but never on a one- or two-sample fluke.
	const analyzeOpts = config.analyze || { minSamples: Math.min(8, windowSize) };

	const tracker = createResourceTracker(probes, { maxSamples: windowSize });
	const stats = { ticks: 0, samples: 0, suspected: 0 };

	let timer = null;
	let nextTickAt = 0;

	function runOnce() {
		stats.ticks++;
		tracker.sample();
		stats.samples++;
		const { leaks } = tracker.analyze(analyzeOpts);
		for (const report of leaks) {
			stats.suspected++;
			if (metrics) {
				try { metrics.inc({ resource: report.name }); } catch { /* observe-only: never throw */ }
			}
			if (onGrowth) {
				try { onGrowth(report); } catch { /* observe-only: never throw */ }
			}
		}
	}

	function start() {
		if (timer) return;
		nextTickAt = now() + intervalMs + Math.floor(randomFloat() * jitterMs);
		// A short fixed poll gates against the jittered target so each tick's jitter
		// is independent without re-arming a fresh timer per fire. Unref'd, so it
		// never holds the event loop open.
		timer = setIntervalTimer(() => {
			if (now() < nextTickAt) return;
			runOnce();
			nextTickAt = now() + intervalMs + Math.floor(randomFloat() * jitterMs);
		}, Math.min(1000, intervalMs));
		if (timer && typeof timer.unref === 'function') timer.unref();
	}

	function stop() {
		if (!timer) return;
		clearIntervalTimer(timer);
		timer = null;
	}

	return {
		start,
		stop,
		runOnce,
		get stats() { return stats; }
	};
}
