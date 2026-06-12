import { describe, it, expect } from 'vitest';
import { createPredictor } from '../plugins/smooth/predict.js';
import { createSharedRandom } from '../plugins/smooth/random.js';
import { createSeededRng } from '../sim.js';

// The predictor is pure: every time reading is a caller-supplied monotonic
// millisecond argument, so nothing here needs fake timers.

/** Pure positional apply: the canonical correctly-written command handler. */
function moveApply(s, c) {
	return { x: s.x + c.dx, y: s.y + c.dy };
}

const out = { x: 0, y: 0 };

describe('createPredictor - zero-divergence path', () => {
	it('in-order acks matching the prediction leave it unchanged and drain the window', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		let server = { x: 0, y: 0 };
		const cmds = [
			{ dx: 1, dy: 0 },
			{ dx: 0, dy: 2 },
			{ dx: -3, dy: 1 },
			{ dx: 5, dy: 5 }
		];
		const ids = cmds.map((c, i) => p.command(c, 100 + i * 16));
		expect(ids).toEqual([1, 2, 3, 4]);
		expect(p.predicted).toEqual({ x: 3, y: 8 });
		expect(p.windowSize).toBe(4);

		for (let i = 0; i < cmds.length; i++) {
			server = moveApply(server, cmds[i]);
			const beforeAck = p.predicted;
			const r = p.ack(ids[i], server, 200 + i * 16);
			expect(r.divergence).toBe(0);
			expect(r.sentMono).toBe(100 + i * 16);
			// The replayed prediction equals the old one: nothing visible.
			expect(p.predicted).toEqual(beforeAck);
			expect(p.base).toBe(server);
			expect(p.renderInto(out, 200 + i * 16)).toBe(false);
			expect(out).toEqual({ x: p.predicted.x, y: p.predicted.y });
		}
		expect(p.windowSize).toBe(0);
		expect(p.lastAckedId).toBe(4);
		expect(p.predicted).toEqual(server);
	});
});

describe('createPredictor - misprediction and correction', () => {
	it('an above-threshold divergence snaps the simulation and eases the pixels', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, smoothTimeMs: 100 });
		p.command({ dx: 10, dy: 0 }, 100);
		expect(p.predicted).toEqual({ x: 10, y: 0 });
		// The server disagrees: the command moved nothing.
		const r = p.ack(1, { x: 0, y: 0 }, 1000);
		expect(r.divergence).toBe(10);
		// Simulation truth snapped immediately - the next replay never builds
		// on the stale prediction.
		expect(p.predicted).toEqual({ x: 0, y: 0 });
		// The rendered position is continuous at ack time: still at the OLD
		// rendered point.
		expect(p.renderInto(out, 1000)).toBe(true);
		expect(out.x).toBeCloseTo(10);
		expect(out.y).toBeCloseTo(0);
		// Linear decay: halfway through smoothTimeMs half the offset remains.
		expect(p.renderInto(out, 1050)).toBe(true);
		expect(out.x).toBeCloseTo(5);
		expect(p.renderInto(out, 1075)).toBe(true);
		expect(out.x).toBeCloseTo(2.5);
		// At smoothTimeMs the correction has fully landed and decay reports done.
		expect(p.renderInto(out, 1100)).toBe(false);
		expect(out.x).toBe(0);
		expect(p.renderInto(out, 9999)).toBe(false);
		expect(out.x).toBe(0);
	});

	it('a re-correction during decay stays continuous from the rendered point', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, smoothTimeMs: 100 });
		p.command({ dx: 10, dy: 0 }, 0);
		p.command({ dx: 0, dy: 0 }, 10);
		p.ack(1, { x: 0, y: 0 }, 1000); // renders at 10, decaying toward 0
		p.renderInto(out, 1050); // halfway: rendered x = 5
		const renderedBefore = out.x;
		// Second misprediction: the server says command 2 moved to x 20.
		p.ack(2, { x: 20, y: 0 }, 1050);
		expect(p.predicted).toEqual({ x: 20, y: 0 });
		// The new offset spans from the previously RENDERED point, not from
		// the stale prediction - no visual jump at the moment of correction.
		p.renderInto(out, 1050);
		expect(out.x).toBeCloseTo(renderedBefore);
	});

	it('sub-threshold divergence snaps silently with no decay', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, errorThreshold: 1 });
		p.command({ dx: 10, dy: 0 }, 100);
		const r = p.ack(1, { x: 9.5, y: 0 }, 200);
		expect(r.divergence).toBeCloseTo(0.5);
		expect(p.predicted).toEqual({ x: 9.5, y: 0 });
		expect(p.renderInto(out, 200)).toBe(false);
		expect(out.x).toBe(9.5);
	});

	it('honors a computeError override', () => {
		// A metric that never reports divergence: even a gross positional
		// disagreement snaps silently.
		const silent = createPredictor({
			apply: moveApply,
			initial: { x: 0, y: 0 },
			computeError: () => 0
		});
		silent.command({ dx: 100, dy: 0 }, 0);
		const r = silent.ack(1, { x: 0, y: 0 }, 10);
		expect(r.divergence).toBe(0);
		expect(silent.renderInto(out, 10)).toBe(false);
		expect(out.x).toBe(0);

		// A custom-field metric reports through the ack result.
		const hp = createPredictor({
			apply: (s, c) => ({ hp: s.hp + c.d }),
			initial: { hp: 100 },
			computeError: (a, b) => Math.abs(b.hp - a.hp)
		});
		hp.command({ d: -10 }, 0);
		expect(hp.ack(1, { hp: 50 }, 10).divergence).toBe(40);
	});

	it('non-positional states never set a visual offset', () => {
		const p = createPredictor({
			apply: (s, c) => ({ hp: s.hp + c.d }),
			initial: { hp: 100 },
			computeError: (a, b) => Math.abs(b.hp - a.hp),
			smoothTimeMs: 100
		});
		p.command({ d: -10 }, 0);
		const r = p.ack(1, { hp: 50 }, 10);
		expect(r.divergence).toBe(40); // above the default threshold
		// No x/y to ease: no decay pending, the scratch reads NaN.
		expect(p.renderInto(out, 10)).toBe(false);
		expect(Number.isNaN(out.x)).toBe(true);
		expect(Number.isNaN(out.y)).toBe(true);
	});

	it('a flagged correction on a null or primitive state snaps without throwing', () => {
		const p = createPredictor({
			apply: () => null,
			initial: null,
			computeError: () => 99,
			smoothTimeMs: 100
		});
		p.command({}, 0);
		let r;
		expect(() => {
			r = p.ack(1, null, 10);
		}).not.toThrow();
		expect(r.divergence).toBe(99);
		expect(p.renderInto(out, 10)).toBe(false);
	});

	it('smoothTimeMs 0 corrects instantly with no decay frames', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, smoothTimeMs: 0 });
		p.command({ dx: 10, dy: 0 }, 100);
		const r = p.ack(1, { x: 0, y: 0 }, 200);
		expect(r.divergence).toBe(10);
		expect(p.predicted).toEqual({ x: 0, y: 0 });
		expect(p.renderInto(out, 200)).toBe(false);
		expect(out.x).toBe(0);
	});
});

describe('createPredictor - apply context', () => {
	it('firstTime is true exactly once per command across arbitrarily many replays', () => {
		const counts = new Map();
		const p = createPredictor({
			apply: (s, c, ctx) => {
				if (ctx.firstTime) counts.set(c.n, (counts.get(c.n) || 0) + 1);
				return { x: s.x + 1, y: 0 };
			},
			initial: { x: 0, y: 0 }
		});
		for (let n = 1; n <= 5; n++) p.command({ n }, n * 16);
		// Each ack replays the surviving tail; the tail commands are not first-time.
		p.ack(1, { x: 1, y: 0 }, 100);
		p.ack(2, { x: 2, y: 0 }, 116);
		p.ack(3, { x: 3, y: 0 }, 132);
		expect([...counts.values()]).toEqual([1, 1, 1, 1, 1]);
		expect(counts.size).toBe(5);
	});

	it('rng draws are id-seeded: initial prediction and replay agree exactly', () => {
		const p = createPredictor({
			apply: (s, c, ctx) => ({ x: s.x + ctx.rng.float(), y: 0 }),
			initial: { x: 0, y: 0 }
		});
		// The draw for command id N equals a shared generator reseeded to N.
		const ref = createSharedRandom();
		ref.reseed(1);
		const draw1 = ref.float();
		ref.reseed(2);
		const draw2 = ref.float();

		p.command({}, 0);
		expect(p.predicted.x).toBe(draw1);
		p.command({}, 16);
		expect(p.predicted.x).toBe(draw1 + draw2);

		// Replaying command 2 on the authoritative state redraws the SAME
		// value, so a correct apply converges bit-for-bit.
		const r = p.ack(1, { x: draw1, y: 0 }, 100);
		expect(r.divergence).toBe(0);
		expect(p.predicted.x).toBe(draw1 + draw2);
	});
});

describe('createPredictor - ack idempotency and sentMono', () => {
	it('duplicate and lower-id acks return null and change nothing', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 1, dy: 0 }, 0);
		p.command({ dx: 1, dy: 0 }, 16);
		p.command({ dx: 1, dy: 0 }, 32);
		expect(p.ack(2, { x: 2, y: 0 }, 100)).not.toBe(null);
		const snapshot = p.predicted;
		expect(p.ack(2, { x: 2, y: 0 }, 110)).toBe(null); // duplicate
		expect(p.ack(1, { x: 1, y: 0 }, 120)).toBe(null); // stale
		expect(p.predicted).toBe(snapshot);
		expect(p.windowSize).toBe(1);
		expect(p.lastAckedId).toBe(2);
	});

	it('out-of-order acks: a lower id after a higher one is ignored', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		for (let i = 0; i < 5; i++) p.command({ dx: 1, dy: 0 }, i * 16);
		expect(p.ack(5, { x: 5, y: 0 }, 100)).not.toBe(null);
		expect(p.ack(3, { x: 3, y: 0 }, 110)).toBe(null);
		expect(p.predicted).toEqual({ x: 5, y: 0 });
		expect(p.base).toEqual({ x: 5, y: 0 });
	});

	it('non-numeric ack ids are rejected', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 1, dy: 0 }, 0);
		expect(p.ack('1', { x: 1, y: 0 }, 10)).toBe(null);
		expect(p.ack(undefined, { x: 1, y: 0 }, 10)).toBe(null);
		expect(p.lastAckedId).toBe(0);
	});

	it('ack returns the acknowledged command\'s own sentMono', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 1, dy: 0 }, 100);
		p.command({ dx: 1, dy: 0 }, 200);
		p.command({ dx: 1, dy: 0 }, 300);
		// Acking 2 drops 1 and 2; the sample is command 2's send time, not 1's.
		expect(p.ack(2, { x: 2, y: 0 }, 400).sentMono).toBe(200);
		expect(p.ack(3, { x: 3, y: 0 }, 500).sentMono).toBe(300);
	});

	it('ack of an id that was never windowed reports sentMono undefined', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 1, dy: 0 }, 0);
		p.command({ dx: 1, dy: 0 }, 16);
		p.command({ dx: 1, dy: 0 }, 32);
		p.reset(); // window gone, ids preserved
		const id = p.command({ dx: 1, dy: 0 }, 48);
		expect(id).toBe(4);
		// Command 3 is from before the reset: it is not in the window, but its
		// id is above the watermark so the rebase still happens.
		const r = p.ack(3, { x: 7, y: 0 }, 100);
		expect(r.sentMono).toBeUndefined();
		expect(p.windowSize).toBe(1); // command 4 survives and replays
		expect(p.predicted).toEqual({ x: 8, y: 0 });
	});
});

describe('createPredictor - overflow', () => {
	it('exceeding windowCap kills prediction; the next ack re-engages it', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, windowCap: 3 });
		expect(p.command({ dx: 1, dy: 0 }, 0)).toBe(1);
		expect(p.command({ dx: 1, dy: 0 }, 16)).toBe(2);
		expect(p.command({ dx: 1, dy: 0 }, 32)).toBe(3);
		expect(p.overflowed).toBe(false);
		// The window is full: the next command kills prediction.
		expect(p.command({ dx: 1, dy: 0 }, 48)).toBe(4);
		expect(p.overflowed).toBe(true);
		expect(p.windowSize).toBe(0);
		expect(p.predicted).toBe(p.base);
		// Ids keep increasing during overflow, but nothing predicts.
		expect(p.command({ dx: 1, dy: 0 }, 64)).toBe(5);
		expect(p.predicted).toBe(p.base);
		expect(p.windowSize).toBe(0);
		// The next acknowledgement snaps to the authoritative state with no
		// easing - the dropped window means there is nothing to be continuous
		// with - and prediction resumes.
		const server = { x: 5, y: 0 };
		const r = p.ack(5, server, 100);
		expect(r).toEqual({ divergence: 0, sentMono: undefined });
		expect(p.overflowed).toBe(false);
		expect(p.predicted).toBe(server);
		expect(p.renderInto(out, 100)).toBe(false);
		expect(out.x).toBe(5);
		p.command({ dx: 2, dy: 0 }, 116);
		expect(p.predicted).toEqual({ x: 7, y: 0 });
		expect(p.windowSize).toBe(1);
	});

	it('checkOverflow kills a window past its age bound without a new command', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, windowMaxAgeMs: 1000 });
		p.command({ dx: 1, dy: 0 }, 0);
		expect(p.checkOverflow(500)).toBe(false);
		expect(p.checkOverflow(1000)).toBe(false); // bound is strict
		expect(p.checkOverflow(1001)).toBe(true);
		expect(p.overflowed).toBe(true);
		expect(p.windowSize).toBe(0);
		expect(p.predicted).toBe(p.base);
		// Repeated checks stay killed.
		expect(p.checkOverflow(2000)).toBe(true);
	});

	it('a stale oldest entry kills prediction on the next command too', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, windowMaxAgeMs: 1000 });
		p.command({ dx: 1, dy: 0 }, 0);
		const id = p.command({ dx: 1, dy: 0 }, 2000);
		expect(id).toBe(2);
		expect(p.overflowed).toBe(true);
		expect(p.windowSize).toBe(0);
		// During overflow ids still advance and prediction stays dead.
		expect(p.command({ dx: 1, dy: 0 }, 2016)).toBe(3);
		expect(p.predicted).toBe(p.base);
	});

	it('checkOverflow with an empty window never kills', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, windowMaxAgeMs: 10 });
		expect(p.checkOverflow(1_000_000)).toBe(false);
		expect(p.overflowed).toBe(false);
	});
});

describe('createPredictor - sync and reset', () => {
	it('sync rebases state and watermark, clears window, offset, and overflow', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 }, windowCap: 2, smoothTimeMs: 100 });
		p.command({ dx: 10, dy: 0 }, 0);
		p.ack(1, { x: 0, y: 0 }, 10); // sets a decaying offset
		p.command({ dx: 1, dy: 0 }, 20);
		p.command({ dx: 1, dy: 0 }, 30);
		p.command({ dx: 1, dy: 0 }, 40); // kills: cap 2 exceeded
		expect(p.overflowed).toBe(true);

		const server = { x: 42, y: 7 };
		p.sync(server, 9);
		expect(p.predicted).toBe(server);
		expect(p.base).toBe(server);
		// The adopted watermark is clamped into this predictor's own issued
		// id space (ids 1-4 so far): a server entity that outlived a previous
		// view reports a foreign watermark that must never gate this stream.
		expect(p.lastAckedId).toBe(4);
		expect(p.windowSize).toBe(0);
		expect(p.overflowed).toBe(false);
		expect(p.renderInto(out, 50)).toBe(false);
		expect(out).toEqual({ x: 42, y: 7 });
		// Ids this predictor never issued cannot acknowledge its commands.
		expect(p.ack(9, server, 60)).toBe(null);
		// Its own next command reconciles normally.
		const next = p.command({ dx: 1, dy: 0 }, 60);
		expect(next).toBe(5);
		expect(p.ack(next, { x: 43, y: 7 }, 70)).not.toBe(null);
		expect(p.predicted).toEqual({ x: 43, y: 7 });
	});

	it('sync without a numeric watermark resets it to zero', () => {
		const p = createPredictor({ apply: moveApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 1, dy: 0 }, 0);
		p.ack(1, { x: 1, y: 0 }, 10);
		p.sync({ x: 0, y: 0 });
		expect(p.lastAckedId).toBe(0);
		p.sync({ x: 0, y: 0 }, -3);
		expect(p.lastAckedId).toBe(0);
	});

	it('reset forgets state and window but never reuses ids', () => {
		const initial = { x: 0, y: 0 };
		const p = createPredictor({ apply: moveApply, initial });
		expect(p.command({ dx: 1, dy: 0 }, 0)).toBe(1);
		expect(p.command({ dx: 1, dy: 0 }, 16)).toBe(2);
		p.reset();
		expect(p.predicted).toBe(initial);
		expect(p.base).toBe(initial);
		expect(p.windowSize).toBe(0);
		expect(p.lastAckedId).toBe(0);
		expect(p.command({ dx: 1, dy: 0 }, 32)).toBe(3);
		const replacement = { x: 9, y: 9 };
		p.reset(replacement);
		expect(p.predicted).toBe(replacement);
		expect(p.command({ dx: 1, dy: 0 }, 48)).toBe(4);
	});
});

describe('createPredictor - convergence under adversarial acking', () => {
	// A client predictor and a reference authoritative fold share one apply.
	// Acks are delivered with seeded drops, duplicates, and reorderings; after
	// the final in-order ack of the last command the prediction must equal the
	// authoritative fold exactly, whatever happened in between.
	const apply = (s, c, ctx) => ({
		x: s.x + c.dx + (ctx.rng.float() - 0.5),
		y: s.y + c.dy + (ctx.rng.float() - 0.5)
	});

	function runScenario(seed, { commands = 200, windowCap = 256, famine = null } = {}) {
		const rng = createSeededRng(seed);
		const p = createPredictor({ apply, initial: { x: 0, y: 0 }, windowCap, smoothTimeMs: 100 });
		let server = { x: 0, y: 0 };
		const serverRng = createSharedRandom();
		const serverCtx = { firstTime: true, rng: serverRng };
		const pendingAcks = [];
		const trajectory = [];
		let maxWindow = 0;
		let mono = 0;
		let lastId = 0;

		const note = () => {
			if (p.windowSize > maxWindow) maxWindow = p.windowSize;
		};

		for (let i = 1; i <= commands; i++) {
			mono += 16;
			const cmd = { dx: rng.int(5) - 2, dy: rng.int(5) - 2 };
			lastId = p.command(cmd, mono);
			note();
			// The authority folds every sent command in order, exactly once.
			serverRng.reseed(lastId);
			server = apply(server, cmd, serverCtx);
			pendingAcks.push({ id: lastId, state: server });

			const starved = famine && i >= famine[0] && i < famine[1];
			const deliveries = starved ? 0 : rng.int(3);
			for (let d = 0; d < deliveries && pendingAcks.length > 0; d++) {
				const idx = rng.int(pendingAcks.length); // reorder: any pending ack
				const a = pendingAcks[idx];
				pendingAcks.splice(idx, 1);
				const roll = rng.float();
				if (roll < 0.2) continue; // dropped on the wire
				p.ack(a.id, a.state, mono);
				note();
				if (roll < 0.4) p.ack(a.id, a.state, mono); // duplicated
				note();
			}
			trajectory.push([p.predicted.x, p.predicted.y, p.windowSize, p.lastAckedId, p.overflowed]);
		}

		// The final in-order ack of the last command always arrives.
		mono += 16;
		p.ack(lastId, server, mono);
		note();
		trajectory.push([p.predicted.x, p.predicted.y, p.windowSize, p.lastAckedId, p.overflowed]);
		return { p, server, trajectory, maxWindow };
	}

	it('converges to the authoritative fold for every seed', () => {
		for (const seed of ['conv-a', 'conv-b', 'conv-c', 'conv-d']) {
			const { p, server, maxWindow } = runScenario(seed);
			expect(p.predicted).toEqual(server);
			expect(p.windowSize).toBe(0);
			expect(p.overflowed).toBe(false);
			expect(maxWindow).toBeLessThanOrEqual(256);
		}
	});

	it('converges through an ack famine that overflows a small window', () => {
		const { p, server, trajectory, maxWindow } = runScenario('famine', {
			windowCap: 16,
			famine: [80, 140]
		});
		// The famine forced the kill...
		expect(trajectory.some((step) => step[4] === true)).toBe(true);
		// ...and the recovery still lands exactly on the authority.
		expect(p.predicted).toEqual(server);
		expect(p.windowSize).toBe(0);
		expect(p.overflowed).toBe(false);
		expect(maxWindow).toBeLessThanOrEqual(16);
	});

	it('the same seed reproduces the identical trajectory', () => {
		const a = runScenario('determinism-gate');
		const b = runScenario('determinism-gate');
		expect(b.trajectory).toEqual(a.trajectory);
		expect(b.server).toEqual(a.server);
	});
});
