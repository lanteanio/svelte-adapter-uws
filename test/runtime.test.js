import { describe, it, expect, afterEach } from 'vitest';
import {
	now,
	monotonicNow,
	wallEpoch,
	randomFloat,
	randomU32,
	randomUuid,
	randomBytes,
	setTimer,
	setIntervalTimer,
	setImmediateTimer,
	clearTimer,
	clearIntervalTimer,
	microtask,
	effectiveTimeZone,
	setRuntimeEnv,
	resetRuntimeEnv,
	getRuntimeEnv
} from '../files/runtime.js';

// Every test that swaps the active environment must restore the native one,
// otherwise a leaked virtual clock would poison the rest of the suite.
afterEach(() => {
	resetRuntimeEnv();
});

describe('default helpers bind to native primitives', () => {
	it('now() returns a wall-clock-equivalent epoch ms (cached ~1s precision)', () => {
		const wall = Date.now();
		const got = now();
		expect(typeof got).toBe('number');
		// Cached at 1Hz, so it may trail real wall time by up to ~1s.
		expect(Math.abs(wall - got)).toBeLessThan(2000);
	});

	it('monotonicNow() is a forward-only epoch ms close to wall time', () => {
		const a = monotonicNow();
		const b = monotonicNow();
		expect(typeof a).toBe('number');
		expect(b).toBeGreaterThanOrEqual(a);
		expect(Math.abs(Date.now() - a)).toBeLessThan(2000);
	});

	it('wallEpoch() returns the exact wall clock', () => {
		const before = Date.now();
		const got = wallEpoch();
		const after = Date.now();
		expect(got).toBeGreaterThanOrEqual(before);
		expect(got).toBeLessThanOrEqual(after);
	});

	it('randomFloat() returns a number in [0, 1)', () => {
		for (let i = 0; i < 1000; i++) {
			const f = randomFloat();
			expect(f).toBeGreaterThanOrEqual(0);
			expect(f).toBeLessThan(1);
		}
	});

	it('randomU32() returns an unsigned 32-bit integer', () => {
		for (let i = 0; i < 1000; i++) {
			const u = randomU32();
			expect(Number.isInteger(u)).toBe(true);
			expect(u).toBeGreaterThanOrEqual(0);
			expect(u).toBeLessThanOrEqual(0xffffffff);
		}
	});

	it('randomUuid() returns a v4-shaped UUID string', () => {
		const id = randomUuid();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(randomUuid()).not.toBe(id);
	});

	it('randomBytes(n) returns a Buffer of length n', () => {
		const buf = randomBytes(16);
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect(buf.length).toBe(16);
	});

	it('setTimer/clearTimer wrap setTimeout/clearTimeout', async () => {
		await new Promise((resolve) => {
			const h = setTimer(resolve, 1);
			expect(h).toBeDefined();
		});
		// A cleared timer never fires.
		let fired = false;
		const h2 = setTimer(() => { fired = true; }, 1);
		clearTimer(h2);
		await new Promise((r) => setTimeout(r, 20));
		expect(fired).toBe(false);
	});

	it('setIntervalTimer/clearIntervalTimer wrap setInterval/clearInterval', async () => {
		let ticks = 0;
		await new Promise((resolve) => {
			const h = setIntervalTimer(() => {
				ticks++;
				if (ticks >= 2) {
					clearIntervalTimer(h);
					resolve();
				}
			}, 1);
		});
		expect(ticks).toBeGreaterThanOrEqual(2);
	});

	it('setImmediateTimer wraps setImmediate', async () => {
		await new Promise((resolve) => {
			setImmediateTimer(resolve);
		});
	});

	it('microtask wraps queueMicrotask', async () => {
		let ran = false;
		await new Promise((resolve) => {
			microtask(() => { ran = true; resolve(); });
		});
		expect(ran).toBe(true);
	});

	it('effectiveTimeZone() defaults to undefined (real local TZ)', () => {
		expect(effectiveTimeZone()).toBeUndefined();
	});
});

describe('setRuntimeEnv installs a virtual environment', () => {
	it('installs a fake clock whose now() returns a fixed number', () => {
		setRuntimeEnv({ clock: { now: () => 1234567890 } });
		expect(now()).toBe(1234567890);
	});

	it('a partial env overriding the clock leaves rng and timers native', () => {
		setRuntimeEnv({ clock: { now: () => 42 } });
		expect(now()).toBe(42);
		// rng still native: a float in [0, 1) and a real UUID.
		const f = randomFloat();
		expect(f).toBeGreaterThanOrEqual(0);
		expect(f).toBeLessThan(1);
		expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		// timers still native: setTimer returns a working handle.
		return new Promise((resolve) => {
			const h = setTimer(resolve, 1);
			expect(h).toBeDefined();
		});
	});

	it('overriding rng leaves clock and timers native', () => {
		let counter = 0;
		setRuntimeEnv({ rng: { float: () => 0.5, u32: () => (counter++) } });
		expect(randomFloat()).toBe(0.5);
		expect(randomU32()).toBe(0);
		expect(randomU32()).toBe(1);
		// clock still native.
		expect(Math.abs(Date.now() - wallEpoch())).toBeLessThan(2000);
	});

	it('installs a fake timezone via tz', () => {
		setRuntimeEnv({ tz: 'UTC' });
		expect(effectiveTimeZone()).toBe('UTC');
	});

	it('an absent tz key keeps the native default rather than clobbering it', () => {
		setRuntimeEnv({ clock: { now: () => 7 } });
		expect(effectiveTimeZone()).toBeUndefined();
	});

	it('returns the newly installed env', () => {
		const installed = setRuntimeEnv({ clock: { now: () => 99 } });
		expect(installed).toBe(getRuntimeEnv());
		expect(installed.clock.now()).toBe(99);
	});
});

describe('production guard', () => {
	const prior = process.env.NODE_ENV;
	afterEach(() => {
		if (prior === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = prior;
	});

	it('throws when NODE_ENV is production without force', () => {
		process.env.NODE_ENV = 'production';
		expect(() => setRuntimeEnv({ clock: { now: () => 1 } })).toThrow(/production/);
	});

	it('succeeds in production with { force: true }', () => {
		process.env.NODE_ENV = 'production';
		expect(() => setRuntimeEnv({ clock: { now: () => 2 } }, { force: true })).not.toThrow();
		expect(now()).toBe(2);
	});

	it('does not throw outside production', () => {
		process.env.NODE_ENV = 'test';
		expect(() => setRuntimeEnv({ clock: { now: () => 3 } })).not.toThrow();
		expect(now()).toBe(3);
	});
});

describe('resetRuntimeEnv restores native behavior', () => {
	it('restores the native clock after a swap', () => {
		setRuntimeEnv({ clock: { now: () => 0 } });
		expect(now()).toBe(0);
		resetRuntimeEnv();
		expect(Math.abs(Date.now() - now())).toBeLessThan(2000);
	});

	it('makes getRuntimeEnv report the native default again', () => {
		const nativeEnv = getRuntimeEnv();
		setRuntimeEnv({ clock: { now: () => 0 } });
		expect(getRuntimeEnv()).not.toBe(nativeEnv);
		resetRuntimeEnv();
		expect(getRuntimeEnv()).toBe(nativeEnv);
	});
});

describe('getRuntimeEnv reflects the active env', () => {
	it('returns the active environment object', () => {
		const env = getRuntimeEnv();
		expect(env.clock.now()).toBe(now());
		setRuntimeEnv({ clock: { now: () => 555 } });
		expect(getRuntimeEnv().clock.now()).toBe(555);
	});
});

describe('the active env stays a frozen object with a stable key shape', () => {
	it('the native default is frozen, top-level and per-group', () => {
		const env = getRuntimeEnv();
		expect(Object.isFrozen(env)).toBe(true);
		expect(Object.isFrozen(env.clock)).toBe(true);
		expect(Object.isFrozen(env.rng)).toBe(true);
		expect(Object.isFrozen(env.timers)).toBe(true);
	});

	it('a swapped env is frozen with the identical key shape (monomorphic)', () => {
		const before = getRuntimeEnv();
		const beforeKeys = Object.keys(before).sort();
		const beforeClockKeys = Object.keys(before.clock).sort();
		const beforeRngKeys = Object.keys(before.rng).sort();
		const beforeTimerKeys = Object.keys(before.timers).sort();

		setRuntimeEnv({ clock: { now: () => 1 } });
		const after = getRuntimeEnv();

		expect(Object.isFrozen(after)).toBe(true);
		expect(Object.isFrozen(after.clock)).toBe(true);
		expect(Object.isFrozen(after.rng)).toBe(true);
		expect(Object.isFrozen(after.timers)).toBe(true);

		expect(Object.keys(after).sort()).toEqual(beforeKeys);
		expect(Object.keys(after.clock).sort()).toEqual(beforeClockKeys);
		expect(Object.keys(after.rng).sort()).toEqual(beforeRngKeys);
		expect(Object.keys(after.timers).sort()).toEqual(beforeTimerKeys);
	});

	it('a frozen group rejects mutation in strict mode', () => {
		const env = getRuntimeEnv();
		expect(() => {
			'use strict';
			env.clock.now = () => 0;
		}).toThrow();
	});
});
