import { afterEach, expect, it } from 'vitest';
import { readReady, releaseReadAllowance } from '../src/runtime/handler/response-read.js';
import { readBodyUpTo } from '../src/runtime/handler/ssr-dedup.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/runtime/runtime.js';
import { createScheduler, createSeededRng } from '../src/runtime/sim-core.js';

afterEach(() => resetRuntimeEnv());

it('accepts custom immediate schedulers without a cancellation method', async () => {
	let callback;
	setRuntimeEnv({ timers: { setImmediate(fn) { callback = fn; return Object.freeze({ custom: true }); } } });
	const deferred = Promise.withResolvers();
	const active = readReady({ read: () => deferred.promise });
	await Promise.resolve();
	deferred.resolve({ done: true });
	expect(await active).toEqual({ done: true });
	expect(() => callback()).not.toThrow();
});

it('removes the deadline from the deterministic scheduler after a ready read', async () => {
	const scheduler = createScheduler();
	setRuntimeEnv(scheduler.buildEnv(createSeededRng(1)));
	const deferred = Promise.withResolvers();
	const active = readReady({ read: () => deferred.promise });
	await Promise.resolve();
	expect(scheduler.pending()).toBe(1);
	deferred.resolve({ done: true });
	expect(await active).toEqual({ done: true });
	expect(scheduler.pending()).toBe(0);
});

function checkQueue() {
	const waiting = new Map();
	let scheduled = 0, cleared = 0;
	setRuntimeEnv({ timers: {
		setImmediate(callback) { const handle = ++scheduled; waiting.set(handle, callback); return handle; },
		clearImmediate(handle) { cleared++; waiting.delete(handle); }
	} });
	return { waiting, get scheduled() { return scheduled; }, get cleared() { return cleared; } };
}

it('shares one deadline across late microtask settlements without renewing an expired prefix', async () => {
	const queue = checkQueue(), allowance = { spent: false };
	try {
		for (let i = 0; i < 3; i++) {
			const deferred = Promise.withResolvers();
			const active = readReady({ read: () => deferred.promise }, allowance);
			await Promise.resolve();
			expect(queue.waiting.size).toBe(1);
			deferred.resolve({ done: false, value: String(i) });
			expect(await active).toEqual({ done: false, value: String(i) });
			expect(allowance.spent).toBe(false);
		}
		expect(queue.scheduled).toBe(1);
		const pending = new Promise(() => {});
		const active = readReady({ read: () => pending }, allowance);
		await Promise.resolve();
		const [handle, expire] = queue.waiting.entries().next().value;
		queue.waiting.delete(handle); expire();
		expect((await active).pending).toBe(pending);
		expect(allowance.spent).toBe(true);
		expect((await readReady({ read: () => pending }, allowance)).pending).toBe(pending);
		expect(await readReady({ read: () => Promise.resolve({ done: true }) }, allowance)).toEqual({ done: true });
		expect(queue.scheduled).toBe(1);
	} finally { releaseReadAllowance(allowance); }
});

it('cancels a private deadline when its read rejects before the check phase', async () => {
	const queue = checkQueue(), deferred = Promise.withResolvers();
	const active = readReady({ read: () => deferred.promise });
	await Promise.resolve();
	expect(queue.waiting.size).toBe(1);
	deferred.reject(new Error('producer failed'));
	await expect(active).rejects.toThrow('producer failed');
	expect(queue.waiting.size).toBe(0);
	expect(queue.cleared).toBe(1);
});

it('cancels the shared deadline and unlocks an aborted reader even when source cancellation hangs', async () => {
	const queue = checkQueue(), state = {};
	const body = new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array([1])); },
		cancel() { return new Promise(() => {}); }
	});
	const active = readBodyUpTo(body, 100, state);
	for (let i = 0; i < 10 && queue.waiting.size === 0; i++) await Promise.resolve();
	expect(queue.waiting.size).toBe(1);
	state.cancelResponse();
	await active;
	expect(body.locked).toBe(false);
	expect(queue.waiting.size).toBe(0);
	expect(queue.cleared).toBe(1);
	expect(state.cancelResponse).toBeNull();
});
