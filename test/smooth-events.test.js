import { describe, it, expect } from 'vitest';
import { createPredictor } from '../src/plugins/smooth/predict.js';
import { createSmoothAuthority } from '../src/plugins/smooth/server.js';
import { mockWs } from './_helpers.js';

// The discrete-event channel: ctx.emitEvent in the shared apply, suppressed on
// the predictor's reconciliation replays (firstTime gate) and always emitted by
// the authority (applies each command once), with a default <commandId>:<ordinal>
// correlation key minted identically on both sides.

/** Fire a 'shot' event on a firing command; move regardless. */
function fireApply(s, c, ctx) {
	if (c.fire) ctx.emitEvent('shot', { x: s.x, y: s.y, dir: c.dir });
	return { x: s.x + (c.dx || 0), y: s.y + (c.dy || 0) };
}

describe('predictor ctx.emitEvent', () => {
	it('emits on the optimistic command and drains the event with a <id>:<ordinal> key', () => {
		const p = createPredictor({ apply: fireApply, initial: { x: 0, y: 0 } });
		const id = p.command({ fire: true, dir: 'N', dx: 1 }, 100);
		expect(id).toBe(1);
		const events = p.drainEvents();
		expect(events).toEqual([{ type: 'shot', key: '1:0', data: { x: 0, y: 0, dir: 'N' }, id: 1, opts: null }]);
	});

	it('drainEvents clears: a second drain after one command is empty', () => {
		const p = createPredictor({ apply: fireApply, initial: { x: 0, y: 0 } });
		p.command({ fire: true }, 100);
		expect(p.drainEvents()).toHaveLength(1);
		expect(p.drainEvents()).toEqual([]);
	});

	it('does NOT re-emit on a reconciliation replay (the firstTime gate)', () => {
		const p = createPredictor({ apply: fireApply, initial: { x: 0, y: 0 } });
		p.command({ fire: true }, 100); // id 1
		p.drainEvents();
		p.command({ fire: true }, 116); // id 2, stays pending
		p.drainEvents();
		// Ack id 1: drops command 1, REPLAYS command 2 (a fire) with firstTime=false.
		p.ack(1, { x: 0, y: 0 }, 200);
		expect(p.drainEvents()).toEqual([]); // the replayed fire emitted nothing
	});

	it('assigns a fresh ordinal per emit within one command', () => {
		const apply = (s, c, ctx) => {
			ctx.emitEvent('a', { n: 1 });
			ctx.emitEvent('b', { n: 2 });
			return s;
		};
		const p = createPredictor({ apply, initial: {} });
		p.command({}, 100);
		expect(p.drainEvents().map((e) => e.key)).toEqual(['1:0', '1:1']);
	});

	it('an explicit opts.key overrides the default and is returned to the caller', () => {
		let returned;
		const apply = (s, c, ctx) => {
			returned = ctx.emitEvent('shot', { p: 1 }, { key: c.shotId });
			return s;
		};
		const p = createPredictor({ apply, initial: {} });
		p.command({ shotId: 'abc' }, 100);
		expect(returned).toBe('abc');
		expect(p.drainEvents()[0].key).toBe('abc');
	});

	it('emitEvent returns undefined and records nothing on a replay', () => {
		const seen = [];
		const apply = (s, c, ctx) => { seen.push(ctx.emitEvent('x', {})); return s; };
		const p = createPredictor({ apply, initial: {} });
		p.command({}, 100); // id 1, firstTime: returns a key
		p.command({}, 116); // id 2 pending
		p.ack(1, {}, 200);  // replays id 2: emitEvent returns undefined
		expect(seen[0]).toBe('1:0');
		expect(seen[seen.length - 1]).toBeUndefined();
	});
});

describe('authority ctx.emitEvent (drain events)', () => {
	it('returns events tagged with the owning ws and commanded:true', () => {
		const a = createSmoothAuthority({ apply: fireApply });
		const ws = mockWs();
		a.ensure('k', ws, { x: 5, y: 7 });
		a.enqueue('k', [{ id: 1, cmd: { fire: true, dir: 'E' } }]);
		const tick = a.drain();
		expect(tick.events).toEqual([
			{ type: 'shot', key: '1:0', data: { x: 5, y: 7, dir: 'E' }, id: 1, opts: null, ws, commanded: true }
		]);
	});

	it('carries no events on a tick with no emit', () => {
		const a = createSmoothAuthority({ apply: fireApply });
		const ws = mockWs();
		a.ensure('k', ws, { x: 0, y: 0 });
		a.enqueue('k', [{ id: 1, cmd: { dx: 1 } }]); // moves, does not fire
		expect(a.drain().events).toEqual([]);
	});

	it('tags each entity\'s events with its own ws and stamps each command id', () => {
		const a = createSmoothAuthority({ apply: fireApply });
		const wsA = mockWs();
		const wsB = mockWs();
		a.ensure('a', wsA, { x: 0, y: 0 });
		a.ensure('b', wsB, { x: 0, y: 0 });
		a.enqueue('a', [{ id: 10, cmd: { fire: true } }, { id: 11, cmd: { fire: true } }]);
		a.enqueue('b', [{ id: 7, cmd: { fire: true } }]);
		const tick = a.drain();
		const byWs = (w) => tick.events.filter((e) => e.ws === w).map((e) => e.key);
		expect(byWs(wsA)).toEqual(['10:0', '11:0']);
		expect(byWs(wsB)).toEqual(['7:0']);
	});
});

describe('cross-side correlation key parity', () => {
	it('the predictor and the authority mint the same key for the same command', () => {
		const cmd = { fire: true, dir: 'S', dx: 2 };
		const p = createPredictor({ apply: fireApply, initial: { x: 1, y: 1 } });
		const id = p.command(cmd, 100);
		const optimistic = p.drainEvents()[0];

		const a = createSmoothAuthority({ apply: fireApply });
		const ws = mockWs();
		a.ensure('k', ws, { x: 1, y: 1 });
		a.enqueue('k', [{ id, cmd }]);
		const authoritative = a.drain().events[0];

		expect(optimistic.key).toBe(authoritative.key);
		expect(optimistic.id).toBe(authoritative.id);
		expect(optimistic.data).toEqual(authoritative.data);
	});
});
