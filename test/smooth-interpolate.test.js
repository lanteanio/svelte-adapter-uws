import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	SampleRing,
	createSmoother,
	SAMPLE_EMPTY,
	SAMPLE_ACTIVE,
	SAMPLE_SETTLED,
	FRESH_LIVE,
	FRESH_COASTING,
	FRESH_STALE
} from '../src/plugins/smooth/interpolate.js';

// Three surfaces resolve the interpolator's knobs independently - the smooth
// channel, the cursor handle, and the cursor render worker - and a knob that
// stops at any of them renders nothing while still validating and type
// checking. The wiring suites at the bottom drive each through its own real
// entry point, which needs the browser globals those entries look for
// installed before their modules load.
class ChannelSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	constructor(url) {
		this.url = url;
		this.readyState = ChannelSocket.CONNECTING;
		this.binaryType = 'blob';
		ChannelSocket._last = this;
		queueMicrotask(() => {
			if (this.readyState === ChannelSocket.CONNECTING) {
				this.readyState = ChannelSocket.OPEN;
				this.onopen?.();
			}
		});
	}
	send() {}
	close(code = 1000, reason = '') {
		this.readyState = ChannelSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
	emit(obj) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
}

globalThis.WebSocket = /** @type {any} */ (ChannelSocket);
globalThis.window = /** @type {any} */ ({
	location: { protocol: 'http:', host: 'localhost:5173' },
	devicePixelRatio: 1
});
globalThis.requestAnimationFrame = /** @type {any} */ ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = /** @type {any} */ ((h) => clearTimeout(h));

const { createSmoothChannel } = await import('../src/plugins/smooth/client.js');
const { cursor } = await import('../src/plugins/cursor/client.js');
const { attachCursorWorker } = await import('../src/plugins/cursor/cursor-worker.js');
const { setRuntimeEnv, resetRuntimeEnv } = await import('../src/client-runtime.js');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure modules: time is always an argument, so nothing here needs fake
// timers or the runtime clock.

const out = { x: 0, y: 0 };

/**
 * Resolved ring bounds. The ring takes ONE object rather than a positional
 * list, and its speed ceiling is per MILLISECOND while every public knob is
 * per second - so these tests name each field instead of passing bare
 * literals. `autoSnap` here matches what `createSmoother` builds by default.
 */
function boundsOf(over) {
	return { extrapolateMs: 250, snapGapMs: 500, snapSpeedPerMs: 0, autoSnap: true, ...over };
}

/** The shipped defaults, for the many cases that do not vary them. */
const RING = boundsOf();

/** An absolute ceiling written the way an app writes it, converted once. */
const perSecond = (unitsPerSec) => unitsPerSec / 1000;

describe('SampleRing', () => {
	it('returns EMPTY with no samples', () => {
		const r = new SampleRing();
		expect(r.sampleInto(100, out, RING)).toBe(SAMPLE_EMPTY);
	});

	it('interpolates the straddling pair analytically', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(100, 100, 50);
		expect(r.sampleInto(50, out, RING)).toBe(SAMPLE_ACTIVE);
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
		expect(r.sampleInto(90, out, RING)).toBe(SAMPLE_ACTIVE);
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
			expect(r.sampleInto(rt, out, RING)).toBe(SAMPLE_ACTIVE);
			expect(out.x).toBeGreaterThan(prev);
			expect(out.x).toBeCloseTo(rt); // constant 1px/ms motion
			prev = out.x;
		}
	});

	it('holds the oldest sample while the buffer is still ahead', () => {
		const r = new SampleRing();
		r.push(100, 7, 9);
		r.push(200, 50, 50);
		expect(r.sampleInto(40, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(7);
		expect(out.y).toBe(9);
	});

	it('extrapolates on the last velocity, then rests at the capped tip', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(100, 100, 0); // 1px/ms
		expect(r.sampleInto(150, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(150);
		// At the cap the motion stops and the status settles...
		expect(r.sampleInto(350, out, RING)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBeCloseTo(350);
		// ...and well past it the position never advances further.
		expect(r.sampleInto(5000, out, RING)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBeCloseTo(350);
	});

	it('a single sample holds its position and settles immediately', () => {
		const r = new SampleRing();
		r.push(100, 3, 4);
		expect(r.sampleInto(200, out, RING)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(3);
		expect(out.y).toBe(4);
	});

	it('snaps across a discontinuity instead of smearing', () => {
		// 1s between samples (view re-entry, idle resume): render times
		// inside the gap must jump to the newer side, not crawl across.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(1000, 500, 0);
		expect(r.sampleInto(400, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(500);
		expect(r.sampleInto(900, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(500);
	});

	it('snaps a teleport delivered on the ordinary cadence, with no bound configured', () => {
		// The defect, on the zero-config path: an entity moving at 1 unit/ms is
		// placed 5000 units away by the server, and the placement rides the
		// ordinary 16ms cadence, so the gap test above cannot see it. The pair
		// outruns the samples on both sides of it, which is what marks it.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 16, 0);
		r.push(32, 5032, 0); // placed
		r.push(48, 5048, 0); // and carrying on at its old speed
		expect(r.sampleInto(24, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(5032);
		expect(out.fresh).toBe(FRESH_LIVE);
	});

	it('leaves the same jump interpolating when the detector is turned off', () => {
		// `snapSpeedPerSec: 0` is the escape hatch: pure interpolation, which is
		// how this pipeline rendered before the detector existed.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 16, 0);
		r.push(32, 5032, 0);
		r.push(48, 5048, 0);
		expect(r.sampleInto(24, out, boundsOf({ autoSnap: false }))).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(2524);
	});

	it('needs a neighbour to compare with: a two-sample ring never guesses', () => {
		// An entity whose whole history is the pair itself has no evidence
		// either way, and inventing a verdict there would snap every entity's
		// first visible motion. It interpolates, exactly as before.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 5000, 0);
		expect(r.sampleInto(8, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(2500);
	});

	it('never reads the first pair of a ring as a jump', () => {
		// A ring whose history begins with motion that then stops: the moving
		// pair has nothing before it to be measured against, and calling it a
		// placement would drop the smoothing of every entity's first move after
		// a rebuild. Move 100 units, then stop.
		const r = new SampleRing();
		r.push(1000, 0, 0);
		r.push(1100, 100, 0);
		r.push(1200, 100, 0);
		expect(r.sampleInto(1050, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(50);
	});

	it('snaps a placement that is the newest pair there is', () => {
		// A server that places a resting entity sends nothing after it, so the
		// jump has no sample ahead of it and never will. The pair behind it is
		// the whole evidence, and it is enough.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 16, 0);
		r.push(32, 32, 0);
		r.push(48, 5032, 0);
		expect(r.sampleInto(40, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(5032);
	});

	it('keeps interpolating through a dead start and an abrupt stop', () => {
		// The two shapes closest to a jump in ordinary motion. A dead start has
		// a resting pair before it, a stop has one after it - each is saved by
		// the neighbour on its other side, which moves at the same speed.
		const start = new SampleRing();
		start.push(0, 0, 0);
		start.push(16, 0, 0); // parked
		start.push(32, 300, 0); // dead start
		start.push(48, 600, 0); // and continuing
		expect(start.sampleInto(40, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(450);

		const stop = new SampleRing();
		stop.push(0, 0, 0);
		stop.push(16, 300, 0);
		stop.push(32, 600, 0); // last moving pair
		stop.push(48, 600, 0); // stopped dead
		expect(stop.sampleInto(24, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(450);
	});

	it('keeps interpolating through hard acceleration', () => {
		// Ten times the previous pair's speed and sustained: the pair after it
		// contradicts the jump reading, so the burst renders as motion.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 16, 0);
		r.push(32, 816, 0); // 50 units/ms
		r.push(48, 1616, 0); // still 50 units/ms
		expect(r.sampleInto(24, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(416);
	});

	it('measures the jump on the true distance, not per axis', () => {
		// 300 across and 400 up is 500 of travel: each axis alone sits under
		// the 16ms budget of 320 units, the diagonal does not.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 300, 400);
		expect(r.sampleInto(8, out, boundsOf({ snapSpeedPerMs: perSecond(20_000) }))).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(300);
		expect(out.y).toBe(400);
	});

	it('leaves fast honest motion under the ceiling alone, across a dropped frame', () => {
		// 6 units/ms under a 20 units/ms ceiling. The pair spans three intervals
		// because a frame was lost, so it covers three times the usual ground -
		// the case a distance bound tuned for the steady cadence would snap on.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(48, 288, 0);
		expect(r.sampleInto(24, out, boundsOf({ snapSpeedPerMs: perSecond(20_000) }))).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(144);
	});

	it('an absolute ceiling decides on a pair the neighbours cannot judge', () => {
		// Two samples only, so the automatic test abstains - a topic that knows
		// its own scale still gets the snap it asked for.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 5000, 0);
		expect(r.sampleInto(8, out, boundsOf({ snapSpeedPerMs: perSecond(20_000) }))).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(5000);
	});

	it('does not extrapolate along a teleport implied velocity', () => {
		// Past the newest sample the jump's implied speed is fiction: without
		// the gate the entity flies on at teleport speed for the whole
		// extrapolation cap, the longest smear this pipeline can paint.
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(16, 16, 0);
		r.push(32, 5032, 0);
		expect(r.sampleInto(100, out, RING)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(5032);
		// Off, the same ring coasts 68 intervals further out.
		expect(r.sampleInto(100, out, boundsOf({ autoSnap: false }))).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeGreaterThan(25_000);
	});

	it('does not extrapolate across a discontinuity-sized last pair', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(1000, 500, 0);
		// The last pair spans 1000ms > snapGap: its "velocity" is fiction,
		// so past the newest sample the position holds rather than gliding.
		expect(r.sampleInto(1100, out, RING)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(500);
	});

	it('clamps a backward timestamp instead of corrupting the order', () => {
		const r = new SampleRing();
		r.push(100, 10, 0);
		r.push(50, 20, 0); // clock stepped back: clamped to 100
		// The zero-span pair has no velocity, so the newer sample wins and
		// the output settles immediately - no reverse motion, no corruption.
		expect(r.sampleInto(100, out, RING)).toBe(SAMPLE_SETTLED);
		expect(out.x).toBe(20);
	});

	it('overwrites oldest-first at capacity', () => {
		const r = new SampleRing();
		for (let i = 0; i < 40; i++) r.push(i * 10, i, 0);
		// Oldest surviving sample is i=8 (t=80): render times below it hold it.
		expect(r.sampleInto(0, out, RING)).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBe(8);
		expect(r.sampleInto(395, out, boundsOf({ snapGapMs: 9999 }))).toBe(SAMPLE_ACTIVE);
		expect(out.x).toBeCloseTo(39.5);
	});

	it('classifies freshness: live within samples, coasting within the cap, stale past it', () => {
		const r = new SampleRing();
		r.push(0, 0, 0);
		r.push(100, 100, 0); // 1px/ms
		// Interpolating between real samples: live.
		r.sampleInto(50, out, RING);
		expect(out.fresh).toBe(FRESH_LIVE);
		// Exactly at the newest sample (over === 0): still live.
		r.sampleInto(100, out, RING);
		expect(out.fresh).toBe(FRESH_LIVE);
		// Past the newest but within the 250ms extrapolation cap: coasting.
		r.sampleInto(200, out, RING);
		expect(out.fresh).toBe(FRESH_COASTING);
		// Past the cap (frozen on stale data): stale.
		r.sampleInto(400, out, RING);
		expect(out.fresh).toBe(FRESH_STALE);
	});

	it('reads live on the oldest-hold and straddle branches', () => {
		const r = new SampleRing();
		r.push(100, 7, 9);
		r.push(200, 50, 50);
		r.sampleInto(40, out, RING); // whole buffer ahead: hold oldest
		expect(out.fresh).toBe(FRESH_LIVE);
		r.sampleInto(150, out, RING); // straddle interpolation
		expect(out.fresh).toBe(FRESH_LIVE);
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

	it('detects a placement with no configuration, and honours 0 and a ceiling', () => {
		// Four frames on the arrival axis, 16ms apart: steady 1 unit/ms motion
		// with a 5000-unit placement in the middle of it.
		function drive(o) {
			const s = createSmoother(o);
			s.ingest(update('a', 0, 0), 1000);
			s.ingest(update('a', 16, 0), 1016);
			s.ingest(update('a', 5032, 0), 1032);
			s.ingest(update('a', 5048, 0), 1048);
			const rt = s.beginFrame(1124); // 1024: inside the placement pair
			s.sampleInto('a', rt, out);
			return out.x;
		}
		expect(drive(opts)).toBe(5032); // nothing configured: snapped
		expect(drive({ ...opts, snapSpeedPerSec: 'auto' })).toBe(5032);
		expect(drive({ ...opts, snapSpeedPerSec: 20_000 })).toBe(5032); // ceiling agrees
		expect(drive({ ...opts, snapSpeedPerSec: 0 })).toBeCloseTo(2524); // off: the slide
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

	it('resume ease renders from the last-drawn position, then settles on the new basis', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0, 1000), 0);
		s.ingest(update('a', 100, 0, 1100), 100);
		let rt = s.beginFrame(150);
		s.sampleInto('a', rt, out);
		const drawn = out.x; // straddle midpoint ~50
		const snap = s.renderedSnapshot();
		expect(snap.get('a').x).toBeCloseTo(drawn);
		// Rebuild on a far-away basis (x=1000) and arm the ease back into it.
		s.reset();
		s.ingest(update('a', 1000, 0, 5000), 200);
		s.armResumeEase(snap, 200);
		// First eased frame renders at (near) the old drawn position, not the basis.
		rt = s.beginFrame(250);
		s.sampleInto('a', rt, out);
		expect(out.x).toBeCloseTo(drawn, 0);
		expect(out.x).toBeLessThan(500); // decisively not snapped to 1000
		// After the ease window elapses on the render-time axis, it reaches the basis.
		rt = s.beginFrame(4000);
		s.sampleInto('a', rt, out);
		expect(out.x).toBeCloseTo(1000, 0);
	});

	it('resume ease with 0 duration snaps to the new basis (no overlay)', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 0, 0, 1000), 0);
		s.ingest(update('a', 100, 0, 1100), 100);
		let rt = s.beginFrame(150);
		s.sampleInto('a', rt, out);
		const snap = s.renderedSnapshot();
		s.reset();
		s.ingest(update('a', 1000, 0, 5000), 200);
		s.armResumeEase(snap, 0); // 0 = snap
		rt = s.beginFrame(250);
		s.sampleInto('a', rt, out);
		expect(out.x).toBeCloseTo(1000, 0);
	});

	it('a placement during a resync is snapped, not eased across the resume window', () => {
		// The resync path: the entity is drawn, the rings are rebuilt on a new
		// basis, and the ease is armed back into the old drawn position. When
		// the server moved the entity during the blackout, easing paints that
		// move across every frame of the window - a slower smear, same defect.
		function drive(o, basisX) {
			const s = createSmoother(o);
			s.ingest(update('a', 0, 0, 1000), 0);
			s.ingest(update('a', 100, 0, 1100), 100); // 1 unit/ms
			let rt = s.beginFrame(150);
			s.sampleInto('a', rt, out);
			const snap = s.renderedSnapshot();
			s.reset();
			s.ingest(update('a', basisX, 0, 5000), 200);
			s.armResumeEase(snap, 150);
			rt = s.beginFrame(250);
			s.sampleInto('a', rt, out);
			return out.x;
		}
		// 50 -> 5000 over 150ms is 33 units/ms against an entity that has never
		// exceeded 1: a placement. The first eased frame is already at the basis.
		expect(drive(opts, 5000)).toBe(5000);
		// The same resume for a basis the entity could plausibly have reached
		// still eases - this gate must not swallow the resume smoothing itself.
		expect(drive(opts, 700)).toBeLessThan(400);
		// And an explicit ceiling gates it too, on a slide the automatic test
		// would have allowed (5.6 units/ms, under 8x the entity's own speed).
		expect(drive({ ...opts, snapSpeedPerSec: 3000 }, 900)).toBe(900);
		// Turned off, the same placement smears across the window as before.
		expect(drive({ ...opts, snapSpeedPerSec: 0 }, 5000)).toBeLessThan(400);
	});

	it('an entity that was at rest snaps to a basis that disagrees with it', () => {
		// A resting entity emits no samples, so its peak honest speed is zero:
		// the two bases must agree about where it is, and a disagreement is the
		// server having placed it while the frames were away.
		const s = createSmoother(opts);
		s.ingest(update('a', 40, 0, 1000), 0);
		let rt = s.beginFrame(50);
		s.sampleInto('a', rt, out);
		expect(out.x).toBe(40);
		const snap = s.renderedSnapshot();
		expect(snap.get('a').perMs).toBe(0);
		s.reset();
		s.ingest(update('a', 900, 0, 5000), 100);
		s.armResumeEase(snap, 150);
		rt = s.beginFrame(150);
		s.sampleInto('a', rt, out);
		expect(out.x).toBe(900);
	});

	it('renderedSnapshot captures only drawn entities; a fresh entity is not eased', () => {
		const s = createSmoother(opts);
		s.ingest(update('a', 5, 5, 1000), 0);
		expect(s.renderedSnapshot().size).toBe(0); // ingested but never drawn
		let rt = s.beginFrame(50);
		s.sampleInto('a', rt, out);
		const snap = s.renderedSnapshot();
		expect(snap.has('a')).toBe(true);
		// Rebuild with a brand-new entity 'b' absent from the snapshot: arming
		// must skip it (nothing to ease from), so it renders at its true basis.
		s.reset();
		s.ingest(update('b', 900, 0, 5000), 100);
		s.armResumeEase(snap, 200);
		rt = s.beginFrame(150);
		s.sampleInto('b', rt, out);
		expect(out.x).toBeCloseTo(900, 0);
	});
});

describe('createSmoothChannel wiring', () => {
	let topicSeq = 0;

	/** A scripted transport: one sync reply with the viewer and one remote. */
	function makeTransport() {
		const name = 'si-' + topicSeq++;
		return {
			name,
			sendCommand() {},
			sync() {
				return Promise.resolve({
					topic: name,
					t: Date.now(),
					you: 'me',
					ack: 0,
					states: [
						{ key: 'me', state: { x: 0, y: 0 } },
						{ key: 'other', state: { x: 0, y: 0 } }
					]
				});
			}
		};
	}

	/**
	 * Drive a remote entity through steady motion with a 5000-unit placement in
	 * the middle of it, then collect every x the channel actually rendered.
	 * Frames are stamped at their arrival, so the server clock estimate is
	 * stable and the render time trails a fixed 250ms behind it - which walks
	 * it through every sample pair in turn, the placement one included. A
	 * second, stationary entity is fed at a fast cadence purely to keep the
	 * render loop painting: the loop paints on inbound frames, and a real
	 * deployment has them arriving continuously.
	 */
	async function renderedXs(extra) {
		const transport = makeTransport();
		const ch = createSmoothChannel({
			apply: (s) => s,
			initial: { x: 0, y: 0 },
			transport,
			interpolationMs: 250,
			...extra
		});
		await settle(30);
		const xs = [];
		ch.onFrame((_local, remote) => {
			const o = remote.get('other');
			if (o) xs.push(o.x);
		});
		const wireTopic = '__smooth:' + transport.name;
		const emit = (key, x) => ChannelSocket._last.emit({
			topic: wireTopic,
			event: 'update',
			data: { key, data: { x, y: 0 } },
			t: Date.now()
		});
		// 1 unit/ms at a 100ms cadence, placed 5000 units on the fourth frame.
		for (const x of [0, 100, 200, 5300, 5400, 5500, 5600, 5700]) {
			emit('other', x);
			for (let k = 0; k < 10; k++) {
				await settle(10);
				emit('filler', 0);
			}
		}
		ch.destroy();
		return xs;
	}

	it('renders a placement as a jump with nothing configured', async () => {
		const xs = await renderedXs();
		expect(xs.length).toBeGreaterThan(10);
		expect(xs.some((x) => x >= 5300)).toBe(true); // the placement was reached
		// and no frame ever painted the entity mid-flight across the map.
		expect(xs.filter((x) => x > 300 && x < 5300)).toEqual([]);
	});

	it('smears the same placement when the detector is turned off', async () => {
		const xs = await renderedXs({ snapSpeedPerSec: 0 });
		expect(xs.some((x) => x > 300 && x < 5300)).toBe(true);
	});

	it('rejects a malformed ceiling and accepts auto', () => {
		const base = { apply: (s) => s, initial: {}, transport: { sendCommand() {}, sync: async () => null } };
		expect(() => createSmoothChannel({ ...base, snapSpeedPerSec: -1 })).toThrow('snapSpeedPerSec');
		expect(() => createSmoothChannel({ ...base, snapSpeedPerSec: 'fast' })).toThrow('snapSpeedPerSec');
		const ch = createSmoothChannel({ ...base, snapSpeedPerSec: 'auto' });
		ch.destroy();
	});
});

describe('cursor handle wiring', () => {
	let realWorker;
	let realOffscreen;
	let posted;

	function mockCanvas() {
		return {
			width: 0,
			height: 0,
			clientWidth: 500,
			clientHeight: 500,
			transferControlToOffscreen: () => ({})
		};
	}

	beforeEach(() => {
		posted = [];
		realWorker = globalThis.Worker;
		realOffscreen = globalThis.OffscreenCanvas;
		globalThis.Worker = /** @type {any} */ (class {
			postMessage(msg) { posted.push(msg); }
			terminate() {}
		});
		globalThis.OffscreenCanvas = /** @type {any} */ (class {});
	});

	afterEach(() => {
		if (realWorker === undefined) delete globalThis.Worker;
		else globalThis.Worker = realWorker;
		if (realOffscreen === undefined) delete globalThis.OffscreenCanvas;
		else globalThis.OffscreenCanvas = realOffscreen;
	});

	/** Mount a canvas cursor and return the init message its worker received. */
	async function initFor(topic, smooth) {
		posted.length = 0;
		const handle = cursor(topic, { canvas: mockCanvas(), smooth });
		const unmount = handle.mount();
		await settle(10);
		const init = posted.find((m) => m.type === 'init');
		unmount();
		handle.destroy();
		return init;
	}

	it('sends the resolved knobs, including the detector, to the render worker', async () => {
		const init = await initFor('cw-default', true);
		expect(init).toBeDefined();
		expect(init.smooth).toEqual({
			delayMs: 'auto',
			extrapolateMs: 250,
			snapGapMs: 500,
			snapSpeedPerSec: 'auto'
		});
	});

	it('carries an explicit ceiling and an explicit off across the same boundary', async () => {
		expect((await initFor('cw-ceiling', { snapSpeedPerSec: 4000 })).smooth.snapSpeedPerSec).toBe(4000);
		expect((await initFor('cw-off', { snapSpeedPerSec: 0 })).smooth.snapSpeedPerSec).toBe(0);
	});

	it('rejects a malformed ceiling on the main thread, not inside the worker', () => {
		const canvas = mockCanvas();
		expect(() => cursor('cw-bad', { canvas, smooth: { snapSpeedPerSec: -1 } })).toThrow('snapSpeedPerSec');
		expect(() => cursor('cw-bad', { canvas, smooth: { snapSpeedPerSec: 'fast' } })).toThrow('snapSpeedPerSec');
	});
});

describe('cursor render worker wiring', () => {
	let sockets;
	let realWebSocket;

	class WorkerSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 0;
			this.sent = [];
			sockets.push(this);
		}
		send(s) { this.sent.push(s); }
		close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
		open() { this.readyState = 1; if (this.onopen) this.onopen(); }
		message(data) { if (this.onmessage) this.onmessage({ data }); }
	}

	function mock2dCtx() {
		return {
			ops: [],
			fillStyle: '#000',
			globalCompositeOperation: 'source-over',
			clearRect() {},
			beginPath() {},
			arc(...a) { this.ops.push(a); },
			fill() {},
			drawImage() {}
		};
	}

	let realRaf;

	beforeEach(() => {
		vi.useFakeTimers();
		// Route the client runtime's wall AND monotonic readers onto the faked
		// Date, so advancing timers moves the interpolation clock with them.
		setRuntimeEnv({ clock: { now: () => Date.now(), monotonic: () => Date.now() } });
		sockets = [];
		realWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = /** @type {any} */ (WorkerSocket);
		// A real worker scope has no rAF until an OffscreenCanvas is in play, and
		// the render loop then falls back to the 16ms timer. Take the timer path
		// here too: the zero-delay rAF the channel suite installs would fire many
		// frames at one faked instant, and the render time would not advance
		// between them.
		realRaf = globalThis.requestAnimationFrame;
		delete globalThis.requestAnimationFrame;
	});

	afterEach(() => {
		resetRuntimeEnv();
		vi.useRealTimers();
		globalThis.WebSocket = realWebSocket;
		globalThis.requestAnimationFrame = realRaf;
	});

	/**
	 * Drive a real worker over its real socket: steady 1-unit-per-ms motion
	 * with a 900-unit placement in the middle, then read the painted x of every
	 * frame the renderer produced.
	 */
	function paintedXs(smooth) {
		const ctx = mock2dCtx();
		const canvas = { width: 0, height: 0, getContext: (t) => (t === '2d' ? ctx : null) };
		const scope = { postMessage() {}, onmessage: null };
		const ctrl = attachCursorWorker(scope);
		ctrl.handleMessage({
			type: 'init',
			topic: 't',
			url: 'ws://test/ws',
			canvas,
			gpu: 'canvas2d',
			devicePixelRatio: 1,
			smooth: { delayMs: 550, extrapolateMs: 250, snapGapMs: 5000, ...smooth }
		});
		const sock = sockets[sockets.length - 1];
		sock.open();
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 20000, h: 20000, zoom: 1 } });
		sock.message(JSON.stringify({
			topic: '__cursor:t',
			event: 'catalog',
			data: [{ key: 'a', user: { name: 'Ada' } }]
		}));
		// Unstamped frames ride the arrival axis, which the faked clock makes
		// exact: four samples 200ms apart carrying 1-unit-per-ms motion, with a
		// 5000-unit placement in the third.
		for (const x of [0, 200, 5200, 5400]) {
			sock.message(JSON.stringify({ topic: '__cursor:t', event: 'update', data: { key: 'a', data: { x, y: 0 } } }));
			vi.advanceTimersByTime(200);
		}
		const seen = ctx.ops.length;
		vi.advanceTimersByTime(17 * 12);
		return ctx.ops.slice(seen).map((op) => op[0]);
	}

	it('detects a placement with nothing configured', () => {
		const xs = paintedXs();
		expect(xs.length).toBeGreaterThan(3);
		expect(xs.some((x) => x >= 916)).toBe(true);
		expect(xs.filter((x) => x > 16 && x < 916)).toEqual([]);
	});

	it('carries an explicit off across the worker boundary', () => {
		const xs = paintedXs({ snapSpeedPerSec: 0 });
		expect(xs.some((x) => x > 200 && x < 5200)).toBe(true);
	});
});
