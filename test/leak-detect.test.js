import { describe, it, expect } from 'vitest';
import {
	detectGrowth,
	createResourceTracker,
	assertNoResourceGrowth,
	LeakError
} from '../src/runtime/leak-detect.js';

// Build a series with a linear ramp of `m` points starting at `start` with a
// per-step increment of `step`.
function ramp(m, start = 0, step = 1) {
	const out = [];
	for (let i = 0; i < m; i++) out.push(start + i * step);
	return out;
}

describe('detectGrowth - the pure trend kernel', () => {
	it('does not flag a flat series (delta and slope votes fail)', () => {
		const r = detectGrowth(new Array(20).fill(5));
		expect(r.leaking).toBe(false);
		expect(r.delta).toBe(0);
		expect(r.slope).toBe(0);
		// A flat series is non-decreasing at every pair, but that gate alone must
		// not flag it - the delta gate is what saves the healthy steady state.
		expect(r.monotonicFraction).toBe(1);
		expect(r.reason).toBe('delta-within-tolerance');
	});

	it('flags a linear ramp (all three votes agree)', () => {
		const r = detectGrowth(ramp(20));
		expect(r.leaking).toBe(true);
		expect(r.reason).toBe('growth-detected');
		expect(r.slope).toBeGreaterThan(0);
		expect(r.monotonicFraction).toBe(1);
		expect(r.delta).toBe(19);
		expect(r.first).toBe(0);
		expect(r.last).toBe(19);
		expect(r.min).toBe(0);
		expect(r.max).toBe(19);
		expect(r.n).toBe(20);
	});

	it('does not flag a sawtooth / oscillating series (monotonic-fraction gate)', () => {
		// Rises then falls repeatedly around a flat baseline.
		const saw = [];
		for (let i = 0; i < 24; i++) saw.push(i % 2 === 0 ? 0 : 8);
		const r = detectGrowth(saw);
		expect(r.leaking).toBe(false);
		expect(r.monotonicFraction).toBeLessThan(0.9);
		expect(r.reason).toBe('non-monotonic');
	});

	it('warmup discards a pre-steady-state ramp so a settled series is not flagged', () => {
		// Rising fill transient (0..4) then a flat steady state at 5.
		const series = [1, 2, 3, 4, 5, ...new Array(12).fill(5)];
		// Without warmup the leading ramp makes the whole series read as growth.
		const withoutWarmup = detectGrowth(series);
		expect(withoutWarmup.leaking).toBe(true);
		// Discarding the transient leaves a flat window - not leaking.
		const withWarmup = detectGrowth(series, { warmup: 5 });
		expect(withWarmup.leaking).toBe(false);
		expect(withWarmup.delta).toBe(0);
		expect(withWarmup.n).toBe(12);
	});

	it('tolerance suppresses a sub-threshold total delta', () => {
		// A gentle ramp with a total delta of exactly 10 over the window.
		const series = ramp(11, 0, 1); // 0..10, delta 10
		expect(detectGrowth(series, { tolerance: 5 }).leaking).toBe(true);
		const suppressed = detectGrowth(series, { tolerance: 20 });
		expect(suppressed.leaking).toBe(false);
		expect(suppressed.reason).toBe('delta-within-tolerance');
	});

	it('minSlope suppresses a monotonic-but-nearly-flat series', () => {
		// Monotone non-decreasing but almost no rise: two steps up over a long run.
		const series = [...new Array(10).fill(0), ...new Array(10).fill(1)];
		expect(detectGrowth(series).leaking).toBe(true);
		const suppressed = detectGrowth(series, { minSlope: 1 });
		expect(suppressed.leaking).toBe(false);
		expect(suppressed.reason).toBe('slope-below-threshold');
	});

	it('short-circuits below minSamples', () => {
		const r = detectGrowth(ramp(4), { minSamples: 8 });
		expect(r.leaking).toBe(false);
		expect(r.reason).toBe('insufficient-samples');
		expect(r.n).toBe(4);
	});

	it('is deterministic: identical inputs give a byte-identical report', () => {
		const a = detectGrowth(ramp(16, 3, 2));
		const b = detectGrowth(ramp(16, 3, 2));
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe('createResourceTracker', () => {
	it('samples multiple series and analyzes each independently', () => {
		let flat = 5;
		let growing = 0;
		const tracker = createResourceTracker([
			{ name: 'flat', read: () => flat },
			{ name: 'growing', read: () => growing }
		]);
		for (let i = 0; i < 20; i++) { tracker.sample(); growing += 1; }
		expect(tracker.names()).toEqual(['flat', 'growing']);
		expect(tracker.series('flat')).toEqual(new Array(20).fill(5));
		const { metrics, leaks, leaking } = tracker.analyze();
		expect(leaking).toBe(true);
		expect(leaks.map((l) => l.name)).toEqual(['growing']);
		const byName = Object.fromEntries(metrics.map((m) => [m.name, m.leaking]));
		expect(byName).toEqual({ flat: false, growing: true });
	});

	it('accepts a Record<string, () => number> probe form', () => {
		let n = 0;
		const tracker = createResourceTracker({ n: () => n });
		for (let i = 0; i < 12; i++) { tracker.sample(); n++; }
		expect(tracker.analyze().leaking).toBe(true);
	});

	it('reset clears every series', () => {
		const tracker = createResourceTracker({ x: () => 1 });
		tracker.sample();
		tracker.sample();
		expect(tracker.series('x').length).toBe(2);
		tracker.reset();
		expect(tracker.series('x')).toEqual([]);
	});

	it('maxSamples bounds each series to a trailing window', () => {
		let n = 0;
		const tracker = createResourceTracker({ n: () => n }, { maxSamples: 5 });
		for (let i = 0; i < 20; i++) { tracker.sample(); n++; }
		const s = tracker.series('n');
		expect(s.length).toBe(5);
		// Only the most recent readings survive.
		expect(s).toEqual([15, 16, 17, 18, 19]);
	});
});

describe('assertNoResourceGrowth', () => {
	it('is a no-op when nothing leaks', () => {
		const tracker = createResourceTracker({ flat: () => 3 });
		for (let i = 0; i < 12; i++) tracker.sample();
		expect(() => assertNoResourceGrowth(tracker)).not.toThrow();
	});

	it('throws a LeakError carrying the offending reports on .leaks', () => {
		let n = 0;
		const tracker = createResourceTracker({ leaked: () => n });
		for (let i = 0; i < 16; i++) { tracker.sample(); n += 2; }
		let caught;
		try { assertNoResourceGrowth(tracker); } catch (err) { caught = err; }
		expect(caught).toBeInstanceOf(LeakError);
		expect(Array.isArray(caught.leaks)).toBe(true);
		expect(caught.leaks.length).toBe(1);
		expect(caught.leaks[0].name).toBe('leaked');
		expect(caught.leaks[0].leaking).toBe(true);
		expect(caught.message).toContain('leaked');
	});

	it('accepts an analyze result, a report array, and a single report', () => {
		let n = 0;
		const tracker = createResourceTracker({ leaked: () => n });
		for (let i = 0; i < 16; i++) { tracker.sample(); n += 2; }
		const result = tracker.analyze();
		expect(() => assertNoResourceGrowth(result)).toThrow(LeakError);
		expect(() => assertNoResourceGrowth(result.metrics)).toThrow(LeakError);
		expect(() => assertNoResourceGrowth(result.leaks[0])).toThrow(LeakError);
		// A single not-leaking report is accepted without throwing.
		const flat = detectGrowth(new Array(12).fill(1));
		expect(() => assertNoResourceGrowth(flat)).not.toThrow();
	});
});
