import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createUpgradeAdmission, resolveWaitingRoom } from '../src/runtime/utils.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/runtime/runtime.js';

function controlledRuntime() {
	let nowMs = 100;
	const immediates = [];
	setRuntimeEnv({
		clock: { monotonic: () => nowMs },
		timers: {
			setImmediate(callback) {
				immediates.push(callback);
				return callback;
			}
		}
	});
	return {
		advance(ms) { nowMs += ms; },
		runImmediate() {
			const callback = immediates.shift();
			if (callback) callback();
		},
		get scheduled() { return immediates.length; }
	};
}

afterEach(() => {
	resetRuntimeEnv();
});

describe('bounded upgrade deferral', () => {
	it('derives a finite default whenever pacing is enabled', () => {
		const admission = createUpgradeAdmission({ perTickBudget: 1 });
		expect(admission.maxDeferred).toBeGreaterThan(0);
		expect(Number.isSafeInteger(admission.maxDeferred)).toBe(true);
	});

	it('rejects overflow without retaining or invoking the callback', () => {
		const runtime = controlledRuntime();
		const order = [];
		const admission = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 2 });

		expect(admission.admit(() => order.push('sync'))).toBe(true);
		expect(admission.admit(() => order.push('queued-1'))).toBe(false);
		expect(admission.admit(() => order.push('queued-2'))).toBe(false);
		expect(admission.admit(() => order.push('overflow'))).toBeNull();

		expect(order).toEqual(['sync']);
		expect(admission.deferredDepth).toBe(2);
		expect(admission.deferredRejectedTotal).toBe(1);
		expect(runtime.scheduled).toBe(1);
	});

	it('reports live oldest age and clears it when the queue drains', () => {
		const runtime = controlledRuntime();
		const admission = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 1 });
		admission.admit(() => {});
		admission.admit(() => {});

		expect(admission.deferredOldestAgeMs).toBe(0);
		runtime.advance(37);
		expect(admission.deferredOldestAgeMs).toBe(37);
		runtime.runImmediate();
		expect(admission.deferredDepth).toBe(0);
		expect(admission.deferredOldestAgeMs).toBe(0);
	});

	it('notifies an exporter after enqueue, overflow, and drain', () => {
		const runtime = controlledRuntime();
		const states = [];
		const admission = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 1 });
		admission.setDeferredObserver((depth, oldestAgeMs, rejectedTotal) => {
			states.push([depth, oldestAgeMs, rejectedTotal]);
		});
		admission.admit(() => {});
		admission.admit(() => {});
		runtime.advance(9);
		admission.admit(() => {});
		runtime.runImmediate();

		expect(states).toEqual([
			[0, 0, 0],
			[1, 0, 0],
			[1, 9, 1],
			[0, 0, 1]
		]);
	});

	it('preserves FIFO order when the bounded ring wraps', () => {
		const runtime = controlledRuntime();
		const order = [];
		const admission = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 2 });

		admission.admit(() => order.push(0));
		admission.admit(() => order.push(1));
		admission.admit(() => order.push(2));
		runtime.runImmediate();
		expect(order).toEqual([0, 1]);
		expect(admission.admit(() => order.push(3))).toBe(false);
		runtime.runImmediate();
		runtime.runImmediate();

		expect(order).toEqual([0, 1, 2, 3]);
		expect(admission.deferredDepth).toBe(0);
	});

	it('supports an explicit zero queue and validates its ceiling', () => {
		const admission = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 0 });
		let calls = 0;
		expect(admission.admit(() => { calls++; })).toBe(true);
		expect(admission.admit(() => { calls++; })).toBeNull();
		expect(calls).toBe(1);
		expect(admission.deferredDepth).toBe(0);

		for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, '2', null]) {
			expect(() => createUpgradeAdmission({ perTickBudget: 1, maxDeferred: value }))
				.toThrow('upgradeAdmission.maxDeferred must be a non-negative safe integer');
		}
	});

	it('reports capacity until both the current tick and deferred queue are full', () => {
		const runtime = controlledRuntime();
		const admission = createUpgradeAdmission({ perTickBudget: 1, maxDeferred: 1 });
		expect(admission.hasCapacity()).toBe(true);
		admission.admit(() => {});
		expect(admission.hasCapacity()).toBe(true);
		admission.admit(() => {});
		expect(admission.hasCapacity()).toBe(false);
		runtime.runImmediate();
		expect(admission.hasCapacity()).toBe(true);
	});

	it('enables the default waiting room when bounded pacing can shed', () => {
		expect(resolveWaitingRoom({ perTickBudget: 1 })).not.toBeNull();
		expect(resolveWaitingRoom({ perTickBudget: 1, waitingRoom: false })).toBeNull();
	});

	it('uses no front-removing array operation in the queue implementation', () => {
		const source = readFileSync(new URL('../src/runtime/utils/upgrade-admission.js', import.meta.url), 'utf8');
		const start = source.indexOf('export function createUpgradeAdmission');
		const end = source.indexOf('export const WS_CONNECTION_PERMIT_KEY', start);
		expect(source.slice(start, end)).not.toContain('.shift(');
	});
});
