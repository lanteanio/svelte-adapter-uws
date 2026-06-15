import { describe, it, expect } from 'vitest';
import {
	SampleRing,
	createSmoother,
	SAMPLE_EMPTY,
	SAMPLE_ACTIVE,
	SAMPLE_SETTLED
} from '../src/plugins/smooth/interpolate.js';

// Pure modules: time is always an argument, so nothing here needs fake
// timers or the runtime clock.

const out = { x: 0, y: 0 };

describe('SampleRing', () => {
	it('returns EMPTY with no samples', () => {
		const r = new SampleRing();
		expect(r.sampleInto(100, out, 250, 500)).toBe(SAMPLE_EMPTY);
	});

	it('interpolates the straddling pair analytically', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(100, 100, 50);
		expect(r.sampleInto(50, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(50);
		expect(out.y).toBeCloseTo(25);
	});

	it('straddles correctly at non-fixed intervals (not naive last-two)', () => {
		// Samples at 0 / 40 / 140: the position at render time 90 lies on the
		// 40->140 segment. A naive lerp toward the newest pair regardless of
		// the render time would misplace it; the straddle search pins it.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(40, 40, 0);
		r.push(140, 80, 0);
		expect(r.sampleInto(90, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(40 + ((90 - 40) / 100) * 40); // 60
	});

	it('survives a dropped frame: the straddle spans the gap continuously', () => {
		// Frames at 0 / 16 / (32 dropped) / 48. With the render time walking
		// through the gap there is always a straddling pair and the output
		// moves monotonically - no freeze, no jump.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 16, 0);
		r.push(48, 48, 0);
		let prev = -1;
		for (let rt = 0; rt <= 48; rt += 4) {
			expect(r.sampleInto(rt, out, 250, 500)).toBe(SAMPLE_ACTIVE);
			expect(out.x).toBeGreaterThan(prev);
			expect(out.x).toBeCloseTo(rt); // constant 1px/ms motion
			prev = out.x;
		}
	});

	it('holds the oldest sample while the buffer is still ahead', () => {
		const r = new SampleRing();
		r.push(100, 7, 9);
		r.push(200, 50, 50);
		expect(r.sampleInto(40, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(7);
		expect(out.y).toBe(9);
	});

	it('extrapolates on the last velocity, then rests at the capped tip', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(100, 100, 0); // 1px/ms
		expect(r.sampleInto(150, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(150);
		// At the cap the motion stops and the status settles...
		expect(r.sampleInto(350, out, 250, 500)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBeCloseTo(350);
		// ...and well past it the position never advances further.
		expect(r.sampleInto(5000, out, 250, 500)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBeCloseTo(350);
	});

	it('a single sample holds its position and settles immediately', () => {
		const r = new SampleRing();
		r.push(100, 3, 4);
		expect(r.sampleInto(200, out, 250, 500)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(3);
		expect(out.y).toBe(4);
	});

	it('snaps across a discontinuity instead of smearing', () => {
		// 1s between samples (view re-entry, idle resume): render times
		// inside the gap must jump to the newer side, not crawl across.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(1000, 500, 0);
		expect(r.sampleInto(400, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(500);
		expect(r.sampleInto(900, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(500);
	});

	it('does not extrapolate across a discontinuity-sized last pair', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(1000, 500, 0);
		// The last pair spans 1000ms > snapGap: its "velocity" is fiction,
		// so past the newest sample the position holds rather than gliding.
		expect(r.sampleInto(1100, out, 250, 500)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(500);
	});

	it('clamps a backward timestamp instead of corrupting the order', () => {
		const r = new SampleRing();
		r.push(100, 10, 0);
		r.push(50, 20, 0); // clock stepped back: clamped to 100
		// The zero-span pair has no velocity, so the newer sample wins and
		// the output settles immediately - no reverse motion, no corruption.
		expect(r.sampleInto(100, out, 250, 500)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(20);
	});

	it('overwrites oldest-first at capacity', () => {
		const r = new SampleRing();
		for (let i = 0; i < 40; i++) r.push(i * 10, i, 0);
		// Oldest surviving sample is i=8 (t=80): render times below it hold it.
		expect(r.sampleInto(0, out, 250, 500)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(8);
		expect(r.sampleInto(395, out, 250, 9999)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(39.5);
	});
});

describe('createSmoother', () => {
	const opts = { delayMs: 100, extrapolateMs: 250, snapGapMs: 500 };

	function update(key, x, y, t) {
		const e = { event: 'update', data: { key, data: { x, y } } };
		if (t !== undefined) e.t = t;
		return e;
	}

	it('builds rings from stamped events on the server time axis', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0, 5000), 100);
		s.ingest(update('a', 100, 0, 5100), 200);
		// Clock candidates: 4900 from both samples. Render frame at mono 300:
		// estimated server now = 5200, render time = 5100.
		const rt = s.beginFrame(300);
		expect(rt).toBeCloseTo(5100);
		expect(s.sampleInto('a', rt, out)).not.toBe(SAMPLE_EMPTY);
		expect(out.x).toBeCloseTo(100);
	});

	it('falls back to the arrival axis when frames carry no stamp', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0), 1000);
		s.ingest(update('a', 50, 0), 1100);
		const rt = s.beginFrame(1150);
		expect(rt).toBeCloseTo(1050);
		s.sampleInto('a', rt, out);
		expect(out.x).toBeCloseTo(25);
	});

	it('bulk events share one stamp across entries', () => {
		const s = createSmoother(opts);
		s.ingest({ event: 'bulk', data: [
			{ key: 'a', data: { x: 1, y: 2 } },
			{ key: 'b', data: { x: 3, y: 4 } }
		], t: 9000 }, 50);
		const rt = s.beginFrame(60);
		expect(s.sampleInto('a', rt, out)).not.toBe(SAMPLE_EMPTY);
		expect(s.sampleInto('b', rt, out)).not.toBe(SAMPLE_EMPTY);
		expect(s.size).toBe(2);
	});

	it('remove drops the ring; compact drops keys absent from the live set', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0, 1000), 0);
		s.ingest(update('b', 0, 0, 1000), 0);
		s.ingest({ event: 'remove', data: { key: 'a' } }, 10);
		expect(s.size).toBe(1);
		s.compact(new Map()); // expiry swept everything
		expect(s.size).toBe(0);
	});

	it('a time event seeds the clock (round trip when sendMono is known)', () => {
		const s = createSmoother(opts);
		s.ingest({ event: 'time', data: { t: 7000 } }, 120, 100);
		expect(s.clock.offset()).toBe(null); // applied only on first frame
		const rt = s.beginFrame(200);
		// Upper bound 7000 - 100 = 6900; lower 7000 - 120 = 6880.
		expect(rt).toBeGreaterThanOrEqual(200 + 6880 - 100);
		expect(rt).toBeLessThanOrEqual(200 + 6900 - 100);
	});

	it('motionPending tracks un-played motion across frames', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0, 1000), 0);
		s.ingest(update('a', 100, 0, 1100), 100);
		let rt = s.beginFrame(150);
		s.sampleInto('a', rt, out);
		expect(s.motionPending).toBe(true); // straddling or buffered
		// Far in the future every ring has long settled past the cap.
		rt = s.beginFrame(100_000);
		s.sampleInto('a', rt, out);
		expect(s.motionPending).toBe(false);
	});

	it('the auto delay tracks the measured stamp interval within bounds', () => {
		const s = createSmoother({ delayMs: 'auto', extrapolateMs: 250, snapGapMs: 500 });
		// 16ms stamps: the target collapses to the 32ms floor over time.
		let mono = 0;
		for (let i = 0; i < 200; i++) {
			s.ingest(update('a', i, 0, 10_000 + i * 16), mono);
			mono += 16;
		}
		s.beginFrame(mono);
		expect(s.delay).toBeGreaterThanOrEqual(32);
		expect(s.delay).toBeLessThan(60);
	});

	it('reset forgets rings, clock, and interval state', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0, 1000), 0);
		s.beginFrame(50);
		s.reset();
		expect(s.size).toBe(0);
		expect(s.clock.offset()).toBe(null);
		expect(s.sampleInto('a', 0, out)).toBe(SAMPLE_EMPTY);
	});

	it('ignores malformed events and non-numeric positions', () => {
		const s = createSmoother(opts);
		s.ingest(null, 0);
		s.ingest({ event: 'update', data: null }, 0);
		s.ingest(update('a', 'x', 0, 1000), 0);
		s.ingest({ event: 'update', data: { key: 5, data: { x: 1, y: 1 } } }, 0);
		s.ingest({ event: 'time', data: { t: 'soon' } }, 0);
		expect(s.size).toBe(0);
	});
});
