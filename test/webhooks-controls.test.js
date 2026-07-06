// Unit tests for the in-process webhook delivery controls (plugins/webhooks/
// controls.js): the retry budget and the endpoint-ejection breaker. Time is
// driven through a fake monotonic clock installed via the runtime seam, so
// refill and reset are exercised deterministically with no real waiting.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';
import {
	createRetryBudget,
	createWebhookBreaker,
	WebhookCircuitOpenError
} from '../src/plugins/webhooks/server.js';

let clock;
beforeEach(() => {
	clock = 0;
	setRuntimeEnv({ clock: { monotonic: () => clock } });
});
afterEach(() => {
	resetRuntimeEnv();
});

describe('createRetryBudget', () => {
	it('validates its options', () => {
		expect(() => createRetryBudget({ capacity: 0 })).toThrow(/capacity/);
		expect(() => createRetryBudget({ refillPerSec: -1 })).toThrow(/refillPerSec/);
		expect(() => createRetryBudget({ maxKeys: 0 })).toThrow(/maxKeys/);
	});

	it('drains one token per take and denies when empty', () => {
		const b = createRetryBudget({ capacity: 2, refillPerSec: 0 });
		expect(b.take('k')).toBe(true);
		expect(b.take('k')).toBe(true);
		expect(b.take('k')).toBe(false);
		expect(b.tokensFor('k')).toBe(0);
	});

	it('refills continuously up to capacity over time', () => {
		const b = createRetryBudget({ capacity: 5, refillPerSec: 10 });
		for (let i = 0; i < 5; i++) expect(b.take('k')).toBe(true);
		expect(b.take('k')).toBe(false);
		clock += 300; // 0.3s * 10/s = 3 tokens
		expect(b.take('k')).toBe(true);
		expect(b.take('k')).toBe(true);
		expect(b.take('k')).toBe(true);
		expect(b.take('k')).toBe(false);
		clock += 100000; // long idle never exceeds capacity
		expect(b.tokensFor('k')).toBe(5);
	});

	it('keeps keys isolated', () => {
		const b = createRetryBudget({ capacity: 1, refillPerSec: 0 });
		expect(b.take('a')).toBe(true);
		expect(b.take('a')).toBe(false);
		expect(b.take('b')).toBe(true); // b's bucket is untouched by a
	});

	it('resets a key to full, or every key with no argument', () => {
		const b = createRetryBudget({ capacity: 1, refillPerSec: 0 });
		b.take('a'); b.take('b');
		b.reset('a');
		expect(b.take('a')).toBe(true);
		expect(b.take('b')).toBe(false);
		b.reset();
		expect(b.take('b')).toBe(true);
	});
});

describe('createWebhookBreaker', () => {
	it('validates its options', () => {
		expect(() => createWebhookBreaker({ failureThreshold: 0 })).toThrow(/failureThreshold/);
		expect(() => createWebhookBreaker({ resetMs: -1 })).toThrow(/resetMs/);
		expect(() => createWebhookBreaker({ maxKeys: 1.5 })).toThrow(/maxKeys/);
	});

	it('opens after the failure threshold and guard then throws', () => {
		const br = createWebhookBreaker({ failureThreshold: 3, resetMs: 1000 });
		expect(br.stateOf('k')).toBe('healthy');
		br.failure(new Error('x'), 'k');
		br.failure(new Error('x'), 'k');
		expect(() => br.guard('k')).not.toThrow(); // still healthy at 2 < 3
		br.failure(new Error('x'), 'k');
		expect(br.stateOf('k')).toBe('broken');
		expect(() => br.guard('k')).toThrow(WebhookCircuitOpenError);
	});

	it('a success resets the failure count before it opens', () => {
		const br = createWebhookBreaker({ failureThreshold: 2, resetMs: 1000 });
		br.failure(new Error('x'), 'k');
		br.success('k');
		br.failure(new Error('x'), 'k');
		expect(br.stateOf('k')).toBe('healthy'); // the success cleared the run
	});

	it('allows a single half-open probe after resetMs and closes on success', () => {
		const br = createWebhookBreaker({ failureThreshold: 1, resetMs: 1000 });
		br.failure(new Error('x'), 'k');
		expect(br.stateOf('k')).toBe('broken');
		clock += 500;
		expect(() => br.guard('k')).toThrow(WebhookCircuitOpenError); // window not elapsed
		clock += 500; // now at resetMs
		expect(() => br.guard('k')).not.toThrow(); // one probe allowed
		expect(br.stateOf('k')).toBe('probing');
		expect(() => br.guard('k')).toThrow(WebhookCircuitOpenError); // only one
		br.success('k');
		expect(br.stateOf('k')).toBe('healthy');
	});

	it('re-opens when the half-open probe fails, restarting the window', () => {
		const br = createWebhookBreaker({ failureThreshold: 1, resetMs: 1000 });
		br.failure(new Error('x'), 'k');
		clock += 1000;
		br.guard('k'); // probe allowed -> probing
		br.failure(new Error('x'), 'k'); // probe failed
		expect(br.stateOf('k')).toBe('broken');
		expect(() => br.guard('k')).toThrow(WebhookCircuitOpenError); // window restarted
		clock += 1000;
		expect(() => br.guard('k')).not.toThrow();
	});

	it('keeps keys isolated', () => {
		const br = createWebhookBreaker({ failureThreshold: 1, resetMs: 1000 });
		br.failure(new Error('x'), 'a');
		expect(br.stateOf('a')).toBe('broken');
		expect(br.stateOf('b')).toBe('healthy');
		expect(() => br.guard('b')).not.toThrow();
	});

	it('resets a key to healthy, or every key with no argument', () => {
		const br = createWebhookBreaker({ failureThreshold: 1, resetMs: 1000 });
		br.failure(new Error('x'), 'a');
		br.failure(new Error('x'), 'b');
		br.reset('a');
		expect(br.stateOf('a')).toBe('healthy');
		expect(br.stateOf('b')).toBe('broken');
		br.reset();
		expect(br.stateOf('b')).toBe('healthy');
	});
});
