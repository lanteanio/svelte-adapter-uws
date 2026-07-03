import { describe, it, expect } from 'vitest';
import { createSmoothAuthority } from '../src/plugins/smooth/server.js';
import { createSharedRandom } from '../src/plugins/smooth/random.js';
import { mockWs } from './_helpers.js';

// The authority is pure with respect to time and transport: the caller owns
// the tick cadence, so a test drives ticks by calling drain() directly.

/** Positional apply shared by the suites that assert on state values. */
function moveApply(s, c) {
	return { x: s.x + c.dx, y: s.y + c.dy };
}

/** An apply that records every application: order, firstTime, and rng draw. */
function recordingApply() {
	const calls = [];
	const apply = (s, c, ctx) => {
		calls.push({ cmd: c, firstTime: ctx.firstTime, draw: ctx.rng.float() });
		return { x: s.x + c.dx, y: s.y + c.dy };
	};
	return { apply, calls };
}

describe('createSmoothAuthority - ensure', () => {
	it('creates an entity with its initial state and a zero watermark', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		const ws = mockWs();
		const init = { x: 1, y: 2 };
		expect(a.ensure('k', ws, init)).toEqual({ state: init, lastAckedId: 0 });
		expect(a.size).toBe(1);
		expect(a.get('k').state).toBe(init);
	});

	it('re-ensure on the same socket is a no-op returning current state and watermark', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		const ws = mockWs();
		a.ensure('k', ws, { x: 0, y: 0 });
		a.enqueue('k', [{ id: 1, cmd: { dx: 1, dy: 0 } }, { id: 2, cmd: { dx: 1, dy: 0 } }]);
		a.drain();
		// The entity advanced; re-ensure must not reset or replace anything.
		const r = a.ensure('k', ws, { x: 999, y: 999 });
		expect(r.state).toEqual({ x: 2, y: 0 });
		expect(r.lastAckedId).toBe(2);
		// Queued-but-undrained commands also survive a same-socket re-ensure.
		a.enqueue('k', [{ id: 3, cmd: { dx: 5, dy: 0 } }]);
		a.ensure('k', ws, { x: 999, y: 999 });
		const tick = a.drain();
		expect(tick.acks).toHaveLength(1);
		expect(tick.acks[0].id).toBe(3);
		expect(tick.acks[0].state).toEqual({ x: 7, y: 0 });
	});

	it('re-ensure on a NEW socket keeps the state but resets the command stream', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		const ws1 = mockWs();
		const ws2 = mockWs();
		a.ensure('k', ws1, { x: 0, y: 0 });
		a.enqueue('k', [{ id: 1, cmd: { dx: 1, dy: 0 } }]);
		a.drain();
		a.enqueue('k', [{ id: 2, cmd: { dx: 1, dy: 0 } }]); // queued on the dying socket
		const r = a.ensure('k', ws2, { x: 999, y: 999 });
		// Authoritative state persists across the reconnect...
		expect(r.state).toEqual({ x: 1, y: 0 });
		// ...but the watermark resets (ids belong to the client stream) and
		// the stale queue is dropped.
		expect(r.lastAckedId).toBe(0);
		const tick = a.drain();
		expect(tick.acks).toEqual([]);
		expect(tick.updates).toEqual([]);
		// The fresh stream's ids are simply echoed.
		a.enqueue('k', [{ id: 1, cmd: { dx: 3, dy: 0 } }]);
		const tick2 = a.drain();
		expect(tick2.acks[0]).toMatchObject({ key: 'k', ws: ws2, id: 1, state: { x: 4, y: 0 } });
	});
});

describe('createSmoothAuthority - enqueue', () => {
	it('ignores unknown keys', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		expect(a.enqueue('ghost', [{ id: 1, cmd: {} }])).toBe(false);
		expect(a.drain().acks).toEqual([]);
	});

	it('rejects non-arrays and empty batches', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		expect(a.enqueue('k', [])).toBe(false);
		expect(a.enqueue('k', null)).toBe(false);
		expect(a.enqueue('k', { id: 1, cmd: {} })).toBe(false);
	});

	it('skips invalid ids and queues the rest', () => {
		const { apply, calls } = recordingApply();
		const a = createSmoothAuthority({ apply });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		expect(a.enqueue('k', [null, { id: 'x', cmd: {} }, { id: -1, cmd: {} }, { id: 1.5, cmd: {} }])).toBe(false);
		expect(a.enqueue('k', [{ id: 2.5, cmd: {} }, { id: 7, cmd: { dx: 1, dy: 1 } }])).toBe(true);
		const tick = a.drain();
		expect(calls).toHaveLength(1);
		expect(tick.acks[0].id).toBe(7);
	});

	it('drops oldest beyond queueCap', () => {
		const { apply, calls } = recordingApply();
		const a = createSmoothAuthority({ apply, queueCap: 2 });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		a.enqueue('k', [
			{ id: 1, cmd: { dx: 1, dy: 0, tag: 'one' } },
			{ id: 2, cmd: { dx: 1, dy: 0, tag: 'two' } },
			{ id: 3, cmd: { dx: 1, dy: 0, tag: 'three' } }
		]);
		const tick = a.drain();
		expect(calls.map((c) => c.cmd.tag)).toEqual(['two', 'three']);
		expect(tick.acks[0].id).toBe(3);
		expect(tick.acks[0].state).toEqual({ x: 2, y: 0 });
	});
});

describe('createSmoothAuthority - drain', () => {
	it('applies queued commands in order with firstTime always true', () => {
		const { apply, calls } = recordingApply();
		const a = createSmoothAuthority({ apply });
		const ws = mockWs();
		a.ensure('k', ws, { x: 0, y: 0 });
		a.enqueue('k', [{ id: 1, cmd: { dx: 1, dy: 0, n: 1 } }, { id: 2, cmd: { dx: 2, dy: 0, n: 2 } }]);
		a.enqueue('k', [{ id: 3, cmd: { dx: 3, dy: 0, n: 3 } }]);
		const tick = a.drain();
		expect(calls.map((c) => c.cmd.n)).toEqual([1, 2, 3]);
		expect(calls.every((c) => c.firstTime === true)).toBe(true);
		// One ack per entity per tick, carrying the LAST applied id and the
		// final state - the owner's copy of truth.
		expect(tick.acks).toEqual([{ key: 'k', ws, id: 3, state: { x: 6, y: 0 } }]);
		expect(tick.updates).toEqual([{ key: 'k', state: { x: 6, y: 0 }, ws, commanded: true }]);
		expect(tick.idle).toBe(false);
	});

	it('reseeds the rng per command id: draws match across authorities and the client generator', () => {
		const first = recordingApply();
		const a = createSmoothAuthority({ apply: first.apply });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		a.enqueue('k', [{ id: 42, cmd: { dx: 0, dy: 0 } }, { id: 43, cmd: { dx: 0, dy: 0 } }]);
		a.drain();

		const second = recordingApply();
		const b = createSmoothAuthority({ apply: second.apply });
		b.ensure('other', mockWs(), { x: 0, y: 0 });
		b.enqueue('other', [{ id: 42, cmd: { dx: 0, dy: 0 } }, { id: 43, cmd: { dx: 0, dy: 0 } }]);
		b.drain();

		expect(second.calls.map((c) => c.draw)).toEqual(first.calls.map((c) => c.draw));
		// The draw is the id-seeded stream every side shares.
		const ref = createSharedRandom();
		ref.reseed(42);
		expect(first.calls[0].draw).toBe(ref.float());
		ref.reseed(43);
		expect(first.calls[1].draw).toBe(ref.float());
	});

	it('updates contain only entities whose state reference changed', () => {
		// An apply that moves only when the command says so, by returning the
		// same reference for a no-op - the documented "unchanged" signal.
		const apply = (s, c) => (c.move ? { x: s.x + 1, y: 0 } : s);
		const a = createSmoothAuthority({ apply });
		const ws1 = mockWs();
		const ws2 = mockWs();
		a.ensure('mover', ws1, { x: 0, y: 0 });
		a.ensure('idler', ws2, { x: 0, y: 0 });
		a.enqueue('mover', [{ id: 1, cmd: { move: true } }]);
		a.enqueue('idler', [{ id: 1, cmd: { move: false } }]);
		const tick = a.drain();
		// Both owners get their acknowledgement, only the mover broadcasts.
		expect(tick.acks.map((x) => x.key)).toEqual(['mover', 'idler']);
		expect(tick.updates.map((x) => x.key)).toEqual(['mover']);
	});

	it('drains multiple entities in insertion order within one tick', () => {
		const { apply, calls } = recordingApply();
		const a = createSmoothAuthority({ apply });
		a.ensure('a', mockWs(), { x: 0, y: 0 });
		a.ensure('b', mockWs(), { x: 0, y: 0 });
		a.enqueue('b', [{ id: 1, cmd: { dx: 0, dy: 0, who: 'b' } }]);
		a.enqueue('a', [{ id: 1, cmd: { dx: 0, dy: 0, who: 'a' } }]);
		const tick = a.drain();
		// Entity order is creation order, not enqueue order.
		expect(calls.map((c) => c.cmd.who)).toEqual(['a', 'b']);
		expect(tick.acks.map((x) => x.key)).toEqual(['a', 'b']);
	});
});

describe('createSmoothAuthority - onMissing and idle', () => {
	it('without onMissing an entity rests after one command-less tick', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		a.enqueue('k', [{ id: 1, cmd: { dx: 1, dy: 0 } }]);
		expect(a.drain().idle).toBe(false); // just applied: may still have motion
		const tick = a.drain();
		expect(tick.updates).toEqual([]);
		expect(tick.acks).toEqual([]);
		expect(tick.idle).toBe(true);
	});

	it('onMissing advances command-less ACTIVE entities until they signal rest', () => {
		let mode = 'glide';
		const onMissingCalls = [];
		const a = createSmoothAuthority({
			apply: moveApply,
			onMissing: (state, lastCommand) => {
				onMissingCalls.push({ state, lastCommand });
				if (mode === 'glide') return { x: state.x + 1, y: state.y };
				if (mode === 'rest-same') return state;
				return undefined;
			}
		});
		const ws = mockWs();
		a.ensure('k', ws, { x: 0, y: 0 });
		const lastCmd = { dx: 5, dy: 0 };
		a.enqueue('k', [{ id: 1, cmd: lastCmd }]);
		a.drain(); // applies the command: state x 5, entity active

		// Command-less ticks glide through onMissing: still updating, not idle.
		let tick = a.drain();
		expect(onMissingCalls).toHaveLength(1);
		expect(onMissingCalls[0].lastCommand).toBe(lastCmd);
		expect(tick.updates).toEqual([{ key: 'k', state: { x: 6, y: 0 }, ws, commanded: false }]);
		expect(tick.acks).toEqual([]); // no command, nothing to acknowledge
		expect(tick.idle).toBe(false);
		tick = a.drain();
		expect(tick.updates[0].state).toEqual({ x: 7, y: 0 });

		// Returning the same reference signals rest: no update, idle once all rest.
		mode = 'rest-same';
		tick = a.drain();
		expect(tick.updates).toEqual([]);
		expect(tick.idle).toBe(true);

		// A resting entity stops costing ticks: onMissing is not called again.
		const callsAfterRest = onMissingCalls.length;
		tick = a.drain();
		expect(onMissingCalls.length).toBe(callsAfterRest);
		expect(tick.idle).toBe(true);

		// A new command re-activates the entity and the glide resumes.
		mode = 'glide';
		a.enqueue('k', [{ id: 2, cmd: { dx: 1, dy: 0 } }]);
		expect(a.drain().idle).toBe(false);
		expect(a.drain().updates[0].state).toEqual({ x: 9, y: 0 });
	});

	it('onMissing returning undefined also signals rest', () => {
		let calls = 0;
		const a = createSmoothAuthority({
			apply: moveApply,
			onMissing: () => {
				calls++;
				return undefined;
			}
		});
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		a.enqueue('k', [{ id: 1, cmd: { dx: 1, dy: 0 } }]);
		a.drain();
		const tick = a.drain();
		expect(calls).toBe(1);
		expect(tick.updates).toEqual([]);
		expect(tick.idle).toBe(true);
	});

	it('an empty authority is idle', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		expect(a.drain()).toEqual({ updates: [], acks: [], events: [], idle: true });
	});
});

describe('createSmoothAuthority - removal and catalog', () => {
	it('remove drops one entity and reports whether it existed', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		expect(a.remove('k')).toBe(true);
		expect(a.remove('k')).toBe(false);
		expect(a.size).toBe(0);
		expect(a.get('k')).toBeUndefined();
	});

	it('removeWs drops every entity owned by the closing connection', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		const ws1 = mockWs();
		const ws2 = mockWs();
		a.ensure('a', ws1, { x: 0, y: 0 });
		a.ensure('b', ws1, { x: 0, y: 0 });
		a.ensure('c', ws2, { x: 0, y: 0 });
		expect(a.removeWs(ws1)).toEqual(['a', 'b']);
		expect(a.size).toBe(1);
		expect(a.get('c')).toBeDefined();
		expect(a.removeWs(ws1)).toEqual([]);
	});

	it('catalog lists every entity\'s authoritative state', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		a.ensure('a', mockWs(), { x: 1, y: 1 });
		a.ensure('b', mockWs(), { x: 2, y: 2 });
		a.enqueue('b', [{ id: 1, cmd: { dx: 1, dy: 0 } }]);
		a.drain();
		expect(a.catalog()).toEqual([
			{ key: 'a', state: { x: 1, y: 1 } },
			{ key: 'b', state: { x: 3, y: 2 } }
		]);
	});
});

describe('createSmoothAuthority - inject (ctx.applyTo / server-initiated commands)', () => {
	/** Apply that handles both client moves and server-injected damage. */
	const combatApply = (s, c) =>
		c.damage !== undefined ? { ...s, hp: s.hp - c.damage } : { ...s, x: s.x + (c.dx || 0), y: s.y + (c.dy || 0) };

	it('returns false for an unknown key', () => {
		const a = createSmoothAuthority({ apply: combatApply });
		expect(a.inject('nobody', { damage: 10 })).toBe(false);
	});

	it('applies a server command as a non-commanded update with NO ack (a still victim)', () => {
		const a = createSmoothAuthority({ apply: combatApply });
		const ws = mockWs();
		a.ensure('v', ws, { x: 0, y: 0, hp: 100 });
		expect(a.inject('v', { damage: 25 })).toBe(true);
		const tick = a.drain();
		expect(tick.acks).toEqual([]); // the victim never sent it -> no acknowledgement
		expect(tick.updates).toHaveLength(1);
		expect(tick.updates[0]).toMatchObject({ key: 'v', ws, commanded: false }); // owner receives it
		expect(tick.updates[0].state.hp).toBe(75);
		expect(a.get('v').state.hp).toBe(75);
	});

	it('carries the final state in the ack when the victim also commanded this tick, and includes the owner in the update', () => {
		const a = createSmoothAuthority({ apply: combatApply });
		const ws = mockWs();
		a.ensure('v', ws, { x: 0, y: 0, hp: 100 });
		a.enqueue('v', [{ id: 1, cmd: { dx: 10, dy: 0 } }]); // the victim moves
		a.inject('v', { damage: 30 }); // and is hit on the same tick
		const tick = a.drain();
		expect(tick.acks).toHaveLength(1);
		expect(tick.acks[0]).toMatchObject({ id: 1, state: { x: 10, y: 0, hp: 70 } }); // move + damage, no flicker
		expect(tick.updates).toHaveLength(1);
		expect(tick.updates[0].commanded).toBe(false); // owner included because it was injected into
		expect(tick.updates[0].state).toEqual({ x: 10, y: 0, hp: 70 });
	});

	it('routes events emitted inside a server command to the owner (commanded:false)', () => {
		const apply = (s, c, ctx) => {
			if (c.damage === undefined) return s;
			const hp = s.hp - c.damage;
			if (hp <= 0) ctx.emitEvent('death', { by: 'server' });
			return { ...s, hp };
		};
		const a = createSmoothAuthority({ apply });
		const ws = mockWs();
		a.ensure('v', ws, { hp: 10 });
		a.inject('v', { damage: 99 });
		const tick = a.drain();
		expect(tick.events).toHaveLength(1);
		expect(tick.events[0]).toMatchObject({ type: 'death', ws, commanded: false });
	});

	it('does not bump lastAckedId (the victim never sent the injected command)', () => {
		const a = createSmoothAuthority({ apply: combatApply });
		const ws = mockWs();
		a.ensure('v', ws, { hp: 100 });
		a.enqueue('v', [{ id: 7, cmd: { dx: 1, dy: 0 } }]);
		a.drain();
		a.inject('v', { damage: 5 });
		a.drain();
		expect(a.get('v').lastAckedId).toBe(7); // unchanged by the injection
	});

	it('drops the oldest injection past the queue cap', () => {
		const a = createSmoothAuthority({ apply: combatApply, queueCap: 2 });
		const ws = mockWs();
		a.ensure('v', ws, { hp: 100 });
		a.inject('v', { damage: 1 });
		a.inject('v', { damage: 2 });
		a.inject('v', { damage: 4 }); // evicts the damage:1
		const tick = a.drain();
		expect(tick.updates[0].state.hp).toBe(94); // 100 - 2 - 4
	});

	it('a tick with neither a command nor an injection is unchanged (OFF path)', () => {
		const a = createSmoothAuthority({ apply: combatApply });
		a.ensure('v', mockWs(), { x: 0, y: 0, hp: 100 });
		const tick = a.drain();
		expect(tick).toEqual({ updates: [], acks: [], events: [], idle: true });
	});
});

describe('createSmoothAuthority - ctx.key (attribution)', () => {
	/** Apply that records the key each application saw. */
	function keyedApply() {
		const seen = [];
		const apply = (s, c, ctx) => {
			seen.push({ key: ctx.key, n: c.n });
			return { x: s.x + 1 };
		};
		return { apply, seen };
	}

	it('names the entity whose command is being applied, per entity within one drain', () => {
		const { apply, seen } = keyedApply();
		const a = createSmoothAuthority({ apply });
		a.ensure('alice', mockWs(), { x: 0 });
		a.ensure('bob', mockWs(), { x: 0 });
		a.enqueue('alice', [{ id: 1, cmd: { n: 1 } }, { id: 2, cmd: { n: 2 } }]);
		a.enqueue('bob', [{ id: 1, cmd: { n: 3 } }]);
		a.drain();
		expect(seen).toEqual([
			{ key: 'alice', n: 1 },
			{ key: 'alice', n: 2 },
			{ key: 'bob', n: 3 }
		]);
	});

	it('server-injected commands see the victim key too', () => {
		const { apply, seen } = keyedApply();
		const a = createSmoothAuthority({ apply });
		a.ensure('victim', mockWs(), { x: 0 });
		a.inject('victim', { n: 9 });
		a.drain();
		expect(seen).toEqual([{ key: 'victim', n: 9 }]);
	});
});

describe('createSmoothAuthority - server entities (ensure active + set)', () => {
	const glide = (s) => ({ x: s.x + 1, y: s.y });

	it('ensure with { active: true } lets onMissing drive an entity that never saw a command', () => {
		const a = createSmoothAuthority({ apply: moveApply, onMissing: glide });
		a.ensure('npc', { server: true }, { x: 0, y: 0 }, { active: true });
		const tick = a.drain();
		expect(tick.updates).toHaveLength(1);
		expect(tick.updates[0]).toMatchObject({ key: 'npc', state: { x: 1, y: 0 }, commanded: false });
		expect(tick.acks).toHaveLength(0); // a server entity never acknowledges
		expect(tick.idle).toBe(false); // still gliding: the caller keeps ticking
	});

	it('the default ensure stays inactive (a joined-but-idle client costs no onMissing calls)', () => {
		const calls = [];
		const a = createSmoothAuthority({ apply: moveApply, onMissing: (s) => { calls.push(1); return { ...s }; } });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		expect(a.drain()).toEqual({ updates: [], acks: [], events: [], idle: true });
		expect(calls).toHaveLength(0);
	});

	it('set replaces the state, wakes onMissing, and leaves the next drain baseline clean', () => {
		const a = createSmoothAuthority({ apply: moveApply, onMissing: glide });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		// Post-drain server logic teleports the entity; the caller broadcasts it.
		expect(a.set('k', { x: 100, y: 0 })).toBe(true);
		expect(a.get('k').state).toEqual({ x: 100, y: 0 });
		// The next drain treats the set state as the baseline (no duplicate update
		// for the set itself) and onMissing continues FROM it (woken).
		const tick = a.drain();
		expect(tick.updates).toHaveLength(1);
		expect(tick.updates[0].state).toEqual({ x: 101, y: 0 });
	});

	it('set on a resting entity re-rests in one tick when onMissing holds position', () => {
		const a = createSmoothAuthority({ apply: moveApply, onMissing: (s) => s });
		a.ensure('k', mockWs(), { x: 0, y: 0 });
		a.set('k', { x: 5, y: 0 });
		const tick = a.drain(); // onMissing returns the same ref -> rest again
		expect(tick.updates).toHaveLength(0);
		expect(tick.idle).toBe(true);
	});

	it('set on an unknown key is ignored', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		expect(a.set('ghost', { x: 1 })).toBe(false);
	});

	it('set never touches the queue, watermark, or lastCommand', () => {
		const a = createSmoothAuthority({ apply: moveApply });
		const ws = mockWs();
		a.ensure('k', ws, { x: 0, y: 0 });
		a.enqueue('k', [{ id: 7, cmd: { dx: 1, dy: 0 } }]);
		a.drain();
		a.set('k', { x: 50, y: 0 });
		expect(a.get('k').lastAckedId).toBe(7);
		a.enqueue('k', [{ id: 8, cmd: { dx: 1, dy: 0 } }]);
		const tick = a.drain();
		expect(tick.acks[0]).toMatchObject({ id: 8, state: { x: 51, y: 0 } }); // applies on the SET state
	});
});
