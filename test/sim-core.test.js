import { describe, it, expect, afterEach } from 'vitest';
import { setTimer, setIntervalTimer, clearTimer, clearIntervalTimer, microtask, setRuntimeEnv, resetRuntimeEnv, now as runtimeNow } from '../src/runtime/runtime.js';
import { createSeededRng, createScheduler, createFaultEngine, FIXED_EPOCH } from '../src/runtime/sim-core.js';

afterEach(() => resetRuntimeEnv());

describe('createSeededRng', () => {
	it('is deterministic for a given seed and diverges across seeds', () => {
		const a = createSeededRng('seed-a');
		const b = createSeededRng('seed-a');
		const c = createSeededRng('seed-b');
		const seqA = Array.from({ length: 16 }, () => a.float());
		const seqB = Array.from({ length: 16 }, () => b.float());
		const seqC = Array.from({ length: 16 }, () => c.float());
		expect(seqA).toEqual(seqB);
		expect(seqA).not.toEqual(seqC);
		for (const x of seqA) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
	});

	it('produces RFC-4122 v4-shaped uuids deterministically', () => {
		const a = createSeededRng('u');
		const b = createSeededRng('u');
		const id = a.uuid();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(a.uuid()).not.toBe(id); // stream advances
		expect(b.uuid()).toBe(id);     // same seed, same first draw
	});

	it('fills bytes from the stream', () => {
		const r = createSeededRng('bytes');
		const buf = r.bytes(8);
		expect(buf).toBeInstanceOf(Uint8Array);
		expect(buf.length).toBe(8);
		expect(createSeededRng('bytes').bytes(8)).toEqual(buf);
	});
});

describe('createScheduler - three-phase boundary', () => {
	it('drains microtasks before the timers phase (setTimeout(0) is not a microtask)', async () => {
		const sched = createScheduler();
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const log = [];
		microtask(() => log.push('micro'));
		setTimer(() => log.push('timer'), 0);
		await sched.run();
		expect(log).toEqual(['micro', 'timer']);
	});

	it('coalesces a synchronous burst of setTimeout(0) into one timers batch, after microtasks', async () => {
		const sched = createScheduler();
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const order = [];
		setTimer(() => order.push('t1'), 0);
		microtask(() => order.push('m'));
		setTimer(() => order.push('t2'), 0);
		await sched.run();
		expect(order).toEqual(['m', 't1', 't2']);
	});

	it('a setTimeout(0) scheduled from inside a microtask still lands in a later timers phase', async () => {
		const sched = createScheduler();
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const order = [];
		microtask(() => {
			order.push('m');
			setTimer(() => order.push('t-from-m'), 0);
			microtask(() => order.push('m2'));
		});
		await sched.run();
		// both microtasks drain before the timer fires
		expect(order).toEqual(['m', 'm2', 't-from-m']);
	});

	it('setImmediate fires in the check phase, after the timers batch', async () => {
		const sched = createScheduler();
		const env = sched.buildEnv(createSeededRng('x'));
		setRuntimeEnv(env, { force: true });
		const order = [];
		env.timers.setImmediate(() => order.push('immediate'));
		setTimer(() => order.push('timer'), 0);
		await sched.run();
		expect(order).toEqual(['timer', 'immediate']);
	});
});

describe('createScheduler - event-loop fidelity', () => {
	it('drains a pending setImmediate before advancing the clock to a future timer', async () => {
		const sched = createScheduler({ startEpoch: 0 });
		const env = sched.buildEnv(createSeededRng('x'));
		setRuntimeEnv(env, { force: true });
		const order = [];
		setTimer(() => order.push(['timer', sched.now()]), 100);
		env.timers.setImmediate(() => order.push(['immediate', sched.now()]));
		await sched.run();
		// Node runs the queued setImmediate (at the current time) before the loop
		// advances to the 100ms timer - never the inverse.
		expect(order).toEqual([['immediate', 0], ['timer', 100]]);
	});

	it('drains microtasks after each timer callback, not after the whole batch', async () => {
		const sched = createScheduler({ startEpoch: 0 });
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const order = [];
		setTimer(() => { order.push('T1'); Promise.resolve().then(() => order.push('micro-after-T1')); }, 0);
		setTimer(() => { order.push('T2'); Promise.resolve().then(() => order.push('micro-after-T2')); }, 0);
		await sched.run();
		expect(order).toEqual(['T1', 'micro-after-T1', 'T2', 'micro-after-T2']);
	});

	it('defers a setTimeout(0) armed inside a timers-phase callback to a later round', async () => {
		const sched = createScheduler({ startEpoch: 0 });
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const order = [];
		setTimer(() => { order.push('A'); setTimer(() => order.push('A-inner'), 0); }, 0);
		setTimer(() => order.push('B'), 0);
		await sched.run({ onStep: () => order.push('round-end') });
		const firstRoundEnd = order.indexOf('round-end');
		expect(order.slice(0, firstRoundEnd)).toEqual(['A', 'B']); // A and B share the first batch
		expect(order.indexOf('A-inner')).toBeGreaterThan(firstRoundEnd); // A-inner deferred to a later round
	});

	it('a 0ms interval repeats across rounds rather than degrading to a one-shot', async () => {
		const sched = createScheduler({ startEpoch: 0 });
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		let count = 0;
		const h = setIntervalTimer(() => { count++; if (count >= 3) clearIntervalTimer(h); }, 0);
		await sched.run({ maxSteps: 100 });
		expect(count).toBe(3);
	});
});

describe('createScheduler - virtual clock', () => {
	it('advances the clock to a timer due time when nothing is due now', async () => {
		const sched = createScheduler({ startEpoch: 1000 });
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		let firedAt = -1;
		setTimer(() => { firedAt = sched.now(); }, 250);
		await sched.run();
		expect(firedAt).toBe(1250);
		expect(sched.now()).toBe(1250);
	});

	it('defaults the wall baseline to FIXED_EPOCH so timestamps reproduce', () => {
		const sched = createScheduler();
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		expect(runtimeNow()).toBe(FIXED_EPOCH);
	});

	it('fires nested timers in due-time order across virtual time', async () => {
		const sched = createScheduler({ startEpoch: 0 });
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const order = [];
		setTimer(() => { order.push(['a', sched.now()]); setTimer(() => order.push(['b', sched.now()]), 50); }, 100);
		setTimer(() => order.push(['c', sched.now()]), 120);
		await sched.run();
		expect(order).toEqual([['a', 100], ['c', 120], ['b', 150]]);
	});
});

describe('createScheduler - ref/unref termination', () => {
	it('terminates when only unref\'d timers remain', async () => {
		const sched = createScheduler();
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		const h = setIntervalTimer(() => {}, 1000);
		h.unref();
		const steps = await sched.run({ maxSteps: 100 });
		expect(steps).toBeLessThan(5); // did not spin to maxSteps
	});

	it('clearTimer prevents a pending timer from firing', async () => {
		const sched = createScheduler();
		setRuntimeEnv(sched.buildEnv(createSeededRng('x')), { force: true });
		let fired = false;
		const h = setTimer(() => { fired = true; }, 10);
		clearTimer(h);
		await sched.run();
		expect(fired).toBe(false);
	});
});

describe('createFaultEngine', () => {
	it('drops every frame at drop=1', () => {
		const eng = createFaultEngine({ rng: createSeededRng('f'), faults: { drop: 1 } });
		expect(eng.plan('hello')).toEqual([]);
	});

	it('duplicates every frame at duplicate=1', () => {
		const eng = createFaultEngine({ rng: createSeededRng('f'), faults: { duplicate: 1 } });
		const plan = eng.plan('hello');
		expect(plan.length).toBe(2);
		expect(plan[0].payload).toBe('hello');
		expect(plan[1].payload).toBe('hello');
	});

	it('passes frames through unchanged with no faults', () => {
		const eng = createFaultEngine({ rng: createSeededRng('f'), faults: {} });
		const plan = eng.plan('hello');
		expect(plan).toEqual([{ delayMs: 0, payload: 'hello' }]);
		expect(eng.active).toBe(false);
	});

	it('is deterministic for a given seed', () => {
		const mk = () => createFaultEngine({ rng: createSeededRng('s'), faults: { drop: 0.5, duplicate: 0.3, delayMs: [0, 100], reorder: 0.5 } });
		const a = mk();
		const b = mk();
		const plansA = Array.from({ length: 40 }, (_, i) => a.plan('frame-' + i));
		const plansB = Array.from({ length: 40 }, (_, i) => b.plan('frame-' + i));
		expect(plansA).toEqual(plansB);
	});

	it('corrupts a payload at corrupt=1, changing exactly the wire bytes', () => {
		const eng = createFaultEngine({ rng: createSeededRng('c'), faults: { corrupt: 1 } });
		const plan = eng.plan('hello world');
		expect(plan.length).toBe(1);
		expect(plan[0].payload).not.toBe('hello world');
		expect(plan[0].payload.length).toBe('hello world'.length);
	});
});
