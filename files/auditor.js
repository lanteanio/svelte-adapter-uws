// In-process consistency auditor: a per-worker background check that runs the
// shared invariant predicates against a snapshot of live state on a slow,
// unref'd timer. It NEVER runs on the hot path (publish / send / subscribe /
// close); the only cost those paths pay is the bookkeeping they already do.
// The timer fires every few seconds, builds a BOUNDED snapshot (a round-robin
// window over connections and topics so a worker with a million topics still
// audits a fixed slice per tick), runs the predicates, and routes any violation
// to the soft `assert` by default.
//
// Soft tier is the default: a violation logs + increments the assertion counter
// but does not throw or terminate. A small set of predicates may be marked hard
// (`hardCategories`), in which case a violation that PERSISTS across two
// consecutive audits of the same window escalates to `fatal`. The persistence
// gate avoids terminating on a transient race (an in-flight close that the next
// tick will have settled); a genuine structural corruption does not heal, so it
// trips on the second observation.
//
// The clock, RNG (for jitter), and timer are all read through the runtime seam,
// so a seeded harness drives the auditor on its virtual clock and the simulator
// can run the same predicates after every step instead of on a timer.

import { now, randomFloat, setIntervalTimer, clearIntervalTimer } from './runtime.js';
import { runInvariants, defaultInvariants } from './invariants.js';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_PER_TICK = 1000;
// Jitter spreads worker audit ticks so a cohort started together does not pile
// every audit into the same instant (thundering herd on the metrics sink).
const DEFAULT_JITTER_MS = 1000;

/**
 * @typedef {{ category: string, context: unknown }} Violation
 * @typedef {(window: { offset: number, limit: number }) => (import('./invariants.js').StateSnapshot & { total?: number })} SnapshotFn
 */

/**
 * Create a consistency auditor.
 *
 * @param {object} opts
 * @param {SnapshotFn} opts.snapshot - builds a bounded snapshot for the given
 *   round-robin window. `connections` / `topicCounts` should cover the window;
 *   `totalSubscriptions` (a single counter read) should be the full value, and
 *   `total` (optional) is the population size used to advance the window.
 * @param {(cond: unknown, category: string, context?: object) => void} opts.assert
 *   the soft-tier sink (logs + counter, throws only in test).
 * @param {(cond: unknown, category: string, context?: object) => void} [opts.fatal]
 *   the hard-tier sink (logs + counter + deferred termination). Required only
 *   if `hardCategories` is non-empty.
 * @param {Array<(snap: any) => Violation | null>} [opts.predicates] - the
 *   predicate list; defaults to the shared `defaultInvariants`.
 * @param {Iterable<string>} [opts.hardCategories] - categories that escalate to
 *   `fatal` when a violation persists across two consecutive audits.
 * @param {number} [opts.intervalMs] - tick cadence (default 5000).
 * @param {number} [opts.maxPerTick] - max entities snapshotted per tick (default 1000).
 * @param {number} [opts.jitterMs] - max random jitter added to the interval (default 1000).
 */
export function createConsistencyAuditor(opts) {
	const snapshot = opts.snapshot;
	const assertFn = opts.assert;
	const fatalFn = opts.fatal;
	const predicates = opts.predicates || defaultInvariants;
	const hardCategories = new Set(opts.hardCategories || []);
	const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	const maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_PER_TICK;
	const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;

	if (typeof snapshot !== 'function') throw new Error('createConsistencyAuditor: snapshot must be a function');
	if (typeof assertFn !== 'function') throw new Error('createConsistencyAuditor: assert must be a function');
	if (hardCategories.size > 0 && typeof fatalFn !== 'function') {
		throw new Error('createConsistencyAuditor: fatal must be a function when hardCategories is set');
	}

	let timer = null;
	let offset = 0;
	let nextTickAt = 0;
	// Categories seen violated in the immediately-preceding audit, keyed by
	// `category` + serialised context, so the persistence gate only escalates a
	// hard violation that survives one full tick.
	let previousViolations = new Set();
	const stats = { ticks: 0, violations: 0, fatals: 0 };

	function violationKey(v) {
		let ctx;
		try { ctx = JSON.stringify(v.context ?? null); } catch { ctx = '?'; }
		return v.category + ':' + ctx;
	}

	/**
	 * Run one audit pass over the next round-robin window. Public so the
	 * simulator can drive it after every step (no timer there), and so a test
	 * can step it deterministically. Returns the violations observed this pass.
	 *
	 * @returns {Violation[]}
	 */
	function runOnce() {
		stats.ticks++;
		const snap = snapshot({ offset, limit: maxPerTick }) || {};
		const violations = runInvariants(snap, predicates);
		const currentKeys = new Set();
		for (const v of violations) {
			const key = violationKey(v);
			currentKeys.add(key);
			stats.violations++;
			if (hardCategories.has(v.category) && previousViolations.has(key)) {
				// Persisted across two consecutive audits: escalate to the hard tier.
				stats.fatals++;
				fatalFn(false, v.category, v.context ?? undefined);
			} else {
				// Soft tier (default): log + counter, no termination.
				assertFn(false, v.category, v.context ?? undefined);
			}
		}
		previousViolations = currentKeys;

		// Advance the round-robin window. `total` (when the snapshot reports it)
		// is the population size; wrap once the window passes the end so every
		// entity is eventually covered across successive ticks.
		const total = typeof snap.total === 'number' ? snap.total : 0;
		offset += maxPerTick;
		if (offset >= total) offset = 0;
		return violations;
	}

	/**
	 * Start the background timer. The interval is unref'd so it never holds the
	 * event loop open, and jittered per tick via the seam RNG. Idempotent: a
	 * second `start` while already running is a no-op.
	 */
	function start() {
		if (timer) return;
		nextTickAt = now() + intervalMs + Math.floor(randomFloat() * jitterMs);
		// A short fixed poll (1s) gates against the jittered target so each tick's
		// jitter is independent without re-arming a fresh timer every fire. The
		// poll itself is unref'd and does no work until the target time arrives.
		timer = setIntervalTimer(() => {
			if (now() < nextTickAt) return;
			runOnce();
			nextTickAt = now() + intervalMs + Math.floor(randomFloat() * jitterMs);
		}, Math.min(1000, intervalMs));
		if (timer && typeof timer.unref === 'function') timer.unref();
	}

	/** Stop the background timer. Idempotent. */
	function stop() {
		if (!timer) return;
		clearIntervalTimer(timer);
		timer = null;
	}

	return {
		start,
		stop,
		runOnce,
		/** Live counters (read-only): { ticks, violations, fatals }. */
		get stats() { return stats; }
	};
}
