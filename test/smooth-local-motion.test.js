import { describe, it, expect } from 'vitest';
import { createPredictor } from '../src/plugins/smooth/predict.js';

// The predictor advances the local entity one command per simulation tick,
// but displays refresh faster than tick rate (a 120Hz panel over a 60Hz
// simulation renders every position twice). These tests pin the render-rate
// contract: between command applications the rendered position sweeps the
// last tick's motion across the measured command cadence, so a faster
// display samples forward motion on every frame instead of a stair-step -
// the stair-step reads as a velocity-proportional smear when the eye tracks
// the moving entity.

/** Pure positional apply: constant velocity per tick. */
function runApply(s, c) {
	return { x: s.x + c.dx, y: s.y + c.dy };
}

const out = { x: 0, y: 0 };

describe('local render motion between command ticks', () => {
	it('a double-rate display samples advancing positions, never a stair-step', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		// Commands every 16ms (the simulation tick), samples every 8ms (the
		// display frame): after the cadence is established, no two consecutive
		// frames may render the same position while the entity moves.
		const samples = [];
		let t = 0;
		for (let tick = 0; tick < 12; tick++) {
			p.command({ dx: 2, dy: 0 }, t);
			p.renderInto(out, t);
			samples.push(out.x);
			p.renderInto(out, t + 8);
			samples.push(out.x);
			t += 16;
		}
		// The first command has no cadence to sweep across; assert from the
		// second command on.
		for (let i = 3; i < samples.length; i++) {
			expect(samples[i]).toBeGreaterThan(samples[i - 1]);
		}
	});

	it('the rendered position is continuous across a command application', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 2, dy: 0 }, 0);
		p.command({ dx: 2, dy: 0 }, 16);
		p.renderInto(out, 32);
		const before = out.x;
		p.command({ dx: 2, dy: 0 }, 32);
		p.renderInto(out, 32);
		// The new sweep starts exactly where the old one was rendering.
		expect(out.x).toBeCloseTo(before, 10);
	});

	it('the sweep composes with a reconciliation correction without a jump', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 }, smoothTimeMs: 100 });
		const ids = [];
		ids.push(p.command({ dx: 2, dy: 0 }, 0));
		ids.push(p.command({ dx: 2, dy: 0 }, 16));
		ids.push(p.command({ dx: 2, dy: 0 }, 32));
		p.renderInto(out, 40);
		const before = out.x;
		// The server disagrees hard about command 1: divergence 10 exceeds the
		// threshold, the simulation snaps, the pixels must not.
		p.ack(ids[0], { x: -8, y: 0 }, 40);
		p.renderInto(out, 40);
		expect(out.x).toBeCloseTo(before, 10);
	});

	it('catch-up commands in one frame fold into a single continuous sweep', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 2, dy: 0 }, 0);
		p.command({ dx: 2, dy: 0 }, 16);
		p.renderInto(out, 48);
		const before = out.x;
		// A slow frame owes two ticks; both apply at the same instant.
		p.command({ dx: 2, dy: 0 }, 48);
		p.command({ dx: 2, dy: 0 }, 48);
		p.renderInto(out, 48);
		expect(out.x).toBeCloseTo(before, 10);
		expect(p.predicted.x).toBe(8);
		// The doubled distance sweeps out over the following window.
		p.renderInto(out, 48 + 8);
		const mid = out.x;
		expect(mid).toBeGreaterThan(before);
		p.renderInto(out, 48 + 200);
		expect(out.x).toBe(8);
	});

	it('sporadic commands render the prediction immediately, exactly as before', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 5, dy: 0 }, 0);
		expect(p.renderInto(out, 0)).toBe(false);
		expect(out.x).toBe(5);
		// Half a second later: no tick cadence exists, the move snaps.
		p.command({ dx: 5, dy: 0 }, 500);
		expect(p.renderInto(out, 500)).toBe(false);
		expect(out.x).toBe(10);
		p.command({ dx: 5, dy: 0 }, 1200);
		expect(p.renderInto(out, 1200)).toBe(false);
		expect(out.x).toBe(15);
	});

	it('reports motion in flight so the frame loop keeps painting, then settles', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 2, dy: 0 }, 0);
		p.command({ dx: 2, dy: 0 }, 16);
		// Mid-sweep: the caller must keep rendering.
		expect(p.renderInto(out, 20)).toBe(true);
		// Long after the window: the sweep has landed and the loop may idle.
		expect(p.renderInto(out, 200)).toBe(false);
		expect(out.x).toBe(4);
	});

	it('an idle-cadence command with no motion does not hold the frame loop open', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 0, dy: 0 }, 0);
		p.command({ dx: 0, dy: 0 }, 16);
		p.command({ dx: 0, dy: 0 }, 32);
		expect(p.renderInto(out, 36)).toBe(false);
		expect(out.x).toBe(0);
	});

	it('a full-state sync clears the sweep and renders the new basis at once', () => {
		const p = createPredictor({ apply: runApply, initial: { x: 0, y: 0 } });
		p.command({ dx: 2, dy: 0 }, 0);
		p.command({ dx: 2, dy: 0 }, 16);
		p.sync({ x: 100, y: 0 }, 2);
		expect(p.renderInto(out, 17)).toBe(false);
		expect(out.x).toBe(100);
	});

	it('non-positional states never sweep', () => {
		const p = createPredictor({ apply: (s, c) => ({ hp: s.hp + c.d }), initial: { hp: 100 } });
		p.command({ d: -10 }, 0);
		p.command({ d: -10 }, 16);
		expect(p.renderInto(out, 20)).toBe(false);
		expect(Number.isNaN(out.x)).toBe(true);
		expect(p.predicted.hp).toBe(80);
	});
});
