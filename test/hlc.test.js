import { describe, it, expect, afterEach } from 'vitest';
import { createHlc } from '../src/runtime/utils.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';

// The hybrid logical clock the platform projects as `platform.hlc()`. These
// drive its wall component through a controlled runtime clock so the
// non-decreasing + logical-tiebreaker contract is exercised deterministically.
// Every case that swaps the runtime clock restores the native one afterward.
afterEach(() => {
	resetRuntimeEnv();
});

describe('hybrid logical clock', () => {
	it('returns the {wall, logical, nodeId} shape', () => {
		const hlc = createHlc();
		const stamp = hlc();
		expect(typeof stamp.wall).toBe('number');
		expect(typeof stamp.logical).toBe('number');
		expect(typeof stamp.nodeId).toBe('string');
		expect(stamp.nodeId.length).toBeGreaterThan(0);
	});

	it('resets logical to 0 and advances wall when the clock moves forward', () => {
		let clock = 1000;
		setRuntimeEnv({ clock: { now: () => clock } });
		const hlc = createHlc();

		const first = hlc();
		expect(first.wall).toBe(1000);
		expect(first.logical).toBe(0);

		clock = 1001;
		const second = hlc();
		expect(second.wall).toBe(1001);
		expect(second.logical).toBe(0);

		clock = 5000;
		const third = hlc();
		expect(third.wall).toBe(5000);
		expect(third.logical).toBe(0);
	});

	it('bumps logical (wall held) on same-millisecond reads', () => {
		setRuntimeEnv({ clock: { now: () => 2000 } });
		const hlc = createHlc();

		const a = hlc();
		const b = hlc();
		const c = hlc();
		expect(a).toEqual({ wall: 2000, logical: 0, nodeId: a.nodeId });
		expect(b).toEqual({ wall: 2000, logical: 1, nodeId: a.nodeId });
		expect(c).toEqual({ wall: 2000, logical: 2, nodeId: a.nodeId });
	});

	it('holds wall and bumps logical when the clock steps backward', () => {
		let clock = 3000;
		setRuntimeEnv({ clock: { now: () => clock } });
		const hlc = createHlc();

		const a = hlc();
		expect(a.wall).toBe(3000);
		expect(a.logical).toBe(0);

		// Clock steps backward (NTP correction, VM pause). wall must not regress.
		clock = 2500;
		const b = hlc();
		expect(b.wall).toBe(3000);
		expect(b.logical).toBe(1);

		clock = 2999;
		const c = hlc();
		expect(c.wall).toBe(3000);
		expect(c.logical).toBe(2);

		// Once the clock passes the held wall, wall advances and logical resets.
		clock = 3001;
		const d = hlc();
		expect(d.wall).toBe(3001);
		expect(d.logical).toBe(0);
	});

	it('produces a strictly increasing (wall, logical) order across mixed reads', () => {
		let clock = 0;
		setRuntimeEnv({ clock: { now: () => clock } });
		const hlc = createHlc();

		const seq = [];
		// advance, hold, hold, advance, backward, advance
		clock = 10; seq.push(hlc());
		clock = 10; seq.push(hlc());
		clock = 10; seq.push(hlc());
		clock = 20; seq.push(hlc());
		clock = 5; seq.push(hlc());
		clock = 21; seq.push(hlc());

		for (let i = 1; i < seq.length; i++) {
			const prev = seq[i - 1];
			const cur = seq[i];
			const ordered = cur.wall > prev.wall || (cur.wall === prev.wall && cur.logical > prev.logical);
			expect(ordered).toBe(true);
		}
	});

	it('keeps a stable nodeId across every call from one instance', () => {
		const hlc = createHlc();
		const id = hlc().nodeId;
		for (let i = 0; i < 50; i++) {
			expect(hlc().nodeId).toBe(id);
		}
	});

	it('derives nodeId from the injectable runtime RNG (a seeded run reproduces it)', () => {
		setRuntimeEnv({ rng: { uuid: () => 'abcdef01-2345-6789-abcd-ef0123456789' } });
		const a = createHlc()();
		const b = createHlc()();
		// Both instances read the same seeded uuid, so the short nodeId matches.
		expect(a.nodeId).toBe('abcdef01');
		expect(b.nodeId).toBe('abcdef01');
	});

	it('two instances can hold independent state but share a seeded identity', () => {
		let clock = 100;
		setRuntimeEnv({ clock: { now: () => clock }, rng: { uuid: () => 'feedface-0000-0000-0000-000000000000' } });
		const hlcA = createHlc();
		const hlcB = createHlc();

		const a1 = hlcA();
		clock = 100;
		const b1 = hlcB();
		// Same nodeId (seeded), each tracks its own logical counter.
		expect(a1.nodeId).toBe('feedface');
		expect(b1.nodeId).toBe('feedface');
		expect(a1.logical).toBe(0);
		expect(b1.logical).toBe(0);

		const a2 = hlcA();
		expect(a2.logical).toBe(1);
		// hlcB untouched in between, so its next same-ms read is logical 1 too.
		const b2 = hlcB();
		expect(b2.logical).toBe(1);
	});
});
