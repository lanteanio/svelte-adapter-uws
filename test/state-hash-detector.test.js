import { describe, it, expect } from 'vitest';
import { createStateHashDetector } from '../src/runtime/state-hash-detector.js';

// The primary's divergence detector, exercised in-process with an injectable
// monotonic clock and a synthetic live-worker set - no real threads. It buckets
// worker hash reports by the primary's own epoch, judges a bucket once every
// live worker has reported into it, and names the minority group on a mismatch.

function fakeClock(start = 0) {
	let t = start;
	return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

describe('createStateHashDetector', () => {
	it('does not judge until every live worker has reported into the epoch', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2, 3];
		expect(d.record(1, 100, live)).toBeNull();
		expect(d.record(2, 100, live)).toBeNull();
		// third worker still missing -> no verdict
		expect(d.record(3, 100, live)).toBeNull(); // now complete AND equal -> no divergence
	});

	it('returns null when all live workers agree', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2];
		expect(d.record(1, 777, live)).toBeNull();
		expect(d.record(2, 777, live)).toBeNull();
	});

	it('flags the minority worker when one hash disagrees', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2, 3];
		expect(d.record(1, 500, live)).toBeNull();
		expect(d.record(2, 500, live)).toBeNull();
		const div = d.record(3, 999, live); // worker 3 is behind
		expect(div).not.toBeNull();
		expect(div.majorityHash).toBe(500);
		expect(div.minorityThreadIds).toEqual([3]);
		expect(div.hashesByThread).toEqual({ 1: 500, 2: 500, 3: 999 });
	});

	it('judges a bucket at most once (no re-count as later reports arrive)', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2];
		expect(d.record(1, 1, live)).toBeNull();
		const first = d.record(2, 2, live); // completes the bucket, diverges
		expect(first).not.toBeNull();
		// A duplicate/late report in the SAME epoch must not re-fire.
		expect(d.record(1, 1, live)).toBeNull();
		expect(d.record(2, 2, live)).toBeNull();
	});

	it('buckets by the PRIMARY clock, so skewed-arrival reports in different epochs do not cross-compare', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2];
		// worker 1 reports in epoch 0
		expect(d.record(1, 100, live)).toBeNull();
		// time advances into epoch 1 before worker 2 reports -> different bucket,
		// neither bucket is complete, so no false divergence from the skew.
		clock.advance(1500);
		expect(d.record(2, 999, live)).toBeNull();
	});

	it('groups reports landing in the same epoch window even with a small jitter', () => {
		const clock = fakeClock(0);
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2, 3];
		expect(d.record(1, 5, live)).toBeNull();
		clock.advance(200); // still epoch 0
		expect(d.record(2, 5, live)).toBeNull();
		clock.advance(300); // still epoch 0
		const div = d.record(3, 6, live); // completes epoch 0, diverges
		expect(div).not.toBeNull();
		expect(div.minorityThreadIds).toEqual([3]);
	});

	it('does not stall when a worker died mid-window (it is no longer live)', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		// Worker 3 reported, then died: it is dropped from the live set, and its
		// stale report must not be compared as a divergent group either.
		expect(d.record(1, 42, [1, 2, 3])).toBeNull();
		expect(d.record(3, 999, [1, 2, 3])).toBeNull();
		d.forget(3);
		// Now only 1 and 2 are live; worker 2's matching report completes the bucket.
		const verdict = d.record(2, 42, [1, 2]);
		expect(verdict).toBeNull(); // 1 and 2 agree; the dead worker's 999 is ignored
	});

	it('picks the smaller group as the minority and names every off-majority thread', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2, 3, 4];
		expect(d.record(1, 10, live)).toBeNull();
		expect(d.record(2, 10, live)).toBeNull();
		expect(d.record(3, 10, live)).toBeNull();
		const div = d.record(4, 20, live); // 3 vs 1 split
		expect(div.majorityHash).toBe(10);
		expect(div.minorityThreadIds).toEqual([4]);
	});

	it('on a two-way even split names a deterministic minority (numerically-larger id group)', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2, 3, 4];
		d.record(1, 100, live);
		d.record(2, 100, live);
		d.record(3, 200, live);
		const div = d.record(4, 200, live); // 2 vs 2
		expect(div).not.toBeNull();
		// majority = the group whose largest id is smaller (1,2); minority = (3,4)
		expect(div.majorityHash).toBe(100);
		expect(div.minorityThreadIds).toEqual([3, 4]);
	});

	it('bounds memory: old epoch buckets are pruned', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now, maxBuckets: 3 });
		// Report into many distinct epochs without ever completing them.
		for (let e = 0; e < 50; e++) {
			clock.set(e * 1000);
			d.record(1, e, [1, 2]); // never completes (worker 2 never reports)
		}
		expect(d.size).toBeLessThanOrEqual(4); // maxBuckets window, not 50
	});
});

// The divergence ACTION (terminate the minority) is gated by an env flag in the
// primary; the gating itself is index.js wiring, but the DECISION inputs are the
// detector's output. These assert that a clean cluster yields no action input at
// all (so the gate is never even consulted on a healthy asymmetric run - the
// no-false-positive guarantee the naive per-worker design would have failed).
describe('detector produces no action on a healthy (converged) cluster', () => {
	it('never returns a divergence across many converged epochs', () => {
		const clock = fakeClock();
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2, 3];
		let fired = 0;
		for (let round = 0; round < 20; round++) {
			clock.set(round * 1000 + 1);
			const h = 1000 + round; // every worker reports the SAME hash this round
			for (const id of live) { if (d.record(id, h, live)) fired++; }
		}
		expect(fired).toBe(0);
	});
});

describe('epoch width sized to the reporting interval (the bug fix)', () => {
	it('honors a per-record epoch width passed by the primary', () => {
		const clock = fakeClock(0);
		const d = createStateHashDetector({ epochMs: 1000, monotonicNow: clock.now });
		const live = [1, 2];
		// A 4000ms width passed per record groups t=0 and t=3000 into one epoch,
		// where the constructor's 1000ms width would have split them apart.
		expect(d.record(1, 7, live, 4000)).toBeNull();
		clock.advance(3000);
		const div = d.record(2, 9, live, 4000);
		expect(div).not.toBeNull();
		expect(div.minorityThreadIds).toEqual([2]);
	});

	it('fixed-period reports at offset phases still complete a bucket when the width exceeds the period', () => {
		// Reporters fire on a FIXED period with only the FIRST fire jittered, so
		// their phases are offset but stable. The primary sizes the bucket to twice
		// the period, so a phase-offset round from every worker still lands in one
		// bucket and a real divergence is caught - the drift the old jittered-period
		// reporter caused (workers never sharing a bucket) cannot happen.
		const clock = fakeClock(0);
		const d = createStateHashDetector({ epochMs: 60000, monotonicNow: clock.now });
		const period = 1000, width = 2 * period, live = [1, 2];
		let div = null;
		const fire = (id, hash, t) => { clock.set(t); const r = d.record(id, hash, live, width); if (r) div = r; };
		fire(1, 100, 0);     // floor(0 / 2000) = epoch 0
		fire(2, 200, 900);   // floor(900 / 2000) = epoch 0 -> completes, diverges
		expect(div).not.toBeNull();
		expect(div.majorityHash).toBe(100);
		expect(div.minorityThreadIds).toEqual([2]);
	});
});
