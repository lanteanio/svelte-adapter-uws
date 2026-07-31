// Unit tests for the in-process webhook delivery controls (plugins/webhooks/
// controls.js): the first-attempt admission gate, the retry budget and the
// endpoint-ejection breaker. Time is driven through a fake monotonic clock
// installed via the runtime seam, so refill and reset are exercised
// deterministically with no real waiting.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';
import {
	createWebhookAdmission,
	createRetryBudget,
	createWebhookBreaker,
	WebhookCircuitOpenError,
	WebhookAdmissionDeniedError
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

describe('createWebhookAdmission', () => {
	it('validates its options', () => {
		expect(() => createWebhookAdmission({ capacity: 0 })).toThrow(/capacity/);
		expect(() => createWebhookAdmission({ refillPerSec: -1 })).toThrow(/refillPerSec/);
		expect(() => createWebhookAdmission({ maxKeys: 0 })).toThrow(/maxKeys/);
	});

	it('drains one token per take and denies when the origin is over its allowance', () => {
		const a = createWebhookAdmission({ capacity: 2, refillPerSec: 0 });
		expect(a.take('https://a.example')).toBe(true);
		expect(a.take('https://a.example')).toBe(true);
		expect(a.take('https://a.example')).toBe(false);
		expect(a.tokensFor('https://a.example')).toBe(0);
	});

	it('refills continuously up to capacity over time', () => {
		const a = createWebhookAdmission({ capacity: 5, refillPerSec: 10 });
		for (let i = 0; i < 5; i++) expect(a.take('o')).toBe(true);
		expect(a.take('o')).toBe(false);
		clock += 300; // 0.3s * 10/s = 3 tokens
		expect(a.take('o')).toBe(true);
		expect(a.take('o')).toBe(true);
		expect(a.take('o')).toBe(true);
		expect(a.take('o')).toBe(false);
		clock += 100000; // long idle never exceeds capacity
		expect(a.tokensFor('o')).toBe(5);
	});

	it('keeps origins isolated', () => {
		const a = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
		expect(a.take('https://a.example')).toBe(true);
		expect(a.take('https://a.example')).toBe(false);
		expect(a.take('https://b.example')).toBe(true);
	});

	it('resets a destination to full, or every destination with no argument', () => {
		const a = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
		a.take('a'); a.take('b');
		a.reset('a');
		expect(a.take('a')).toBe(true);
		expect(a.take('b')).toBe(false);
		a.reset();
		expect(a.take('b')).toBe(true);
	});

	it('does not hand a drained destination its allowance back when new keys arrive', () => {
		// The bypass this closes: a control that reclaims slots in insertion
		// order pushes the drained destination out of the map, and the next take
		// recreates it full. Naming throwaway destinations then costs nothing and
		// buys a fresh allowance.
		const a = createWebhookAdmission({ capacity: 1, refillPerSec: 0, maxKeys: 2 });
		expect(a.take('victim')).toBe(true);
		expect(a.take('victim')).toBe(false);
		expect(a.take('filler')).toBe(true);
		for (let i = 0; i < 50; i++) a.take('junk-' + i);
		expect(a.take('victim')).toBe(false);
		expect(a.tokensFor('victim')).toBe(0);
	});

	it('refuses a destination it has no slot to account for, rather than admitting it untracked', () => {
		const a = createWebhookAdmission({ capacity: 1, refillPerSec: 0, maxKeys: 2 });
		expect(a.take('a')).toBe(true);
		expect(a.take('b')).toBe(true);
		expect(a.take('c')).toBe(false); // both slots are mid-spend
		expect(a.take('d')).toBe(false);
	});

	it('reclaims a slot once its bucket has refilled to full, which changes nothing for that key', () => {
		const a = createWebhookAdmission({ capacity: 2, refillPerSec: 1, maxKeys: 2 });
		a.take('a'); a.take('a'); // a drained
		a.take('b'); a.take('b'); // b drained
		expect(a.take('c')).toBe(false);
		clock += 5000; // both refill to full, so dropping them is state-neutral
		expect(a.take('c')).toBe(true);
		expect(a.tokensFor('c')).toBe(1);
		// a was reclaimed while full, so it starts full again - the same tokens it
		// would have had, not an allowance handed back.
		expect(a.tokensFor('a')).toBe(2);
	});

	it('does not create or reclaim a slot just because tokensFor asked', () => {
		// Reading a destination's allowance is observability, so it must not be
		// able to take the last slot, evict the drained destination occupying it,
		// or report a number that only became true by asking.
		const a = createWebhookAdmission({ capacity: 1, refillPerSec: 0, maxKeys: 1 });
		expect(a.take('a')).toBe(true); // the one slot, now drained
		expect(a.tokensFor('unknown')).toBe(1); // spent nothing, holds no slot
		expect(a.tokensFor('a')).toBe(0);
		expect(a.take('a')).toBe(false);
	});

	it('carries a distinguishable code so a caller can requeue rather than dead-letter', () => {
		const err = new WebhookAdmissionDeniedError('https://a.example');
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(err.message).toContain('https://a.example');
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

	it('does not let an ejected key back in when new keys arrive', () => {
		// Same bypass as the token buckets: reclaiming slots in insertion order
		// forgets the ejection record, so an endpoint the breaker threw out is
		// readmitted by naming keys nobody cares about.
		const br = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000, maxKeys: 2 });
		br.failure(new Error('x'), 'ejected');
		br.failure(new Error('x'), 'other');
		for (let i = 0; i < 50; i++) br.guard('junk-' + i); // untracked, never ejected
		expect(br.stateOf('ejected')).toBe('broken');
		expect(() => br.guard('ejected')).toThrow(WebhookCircuitOpenError);
	});

	it('reports an untracked key as healthy without taking a slot for it', () => {
		// The twin of the tokensFor rule: reading a key's state is observability,
		// so polling it over keys the breaker has never seen must leave the tracked
		// ejections and the free slots exactly as they were.
		const br = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000, maxKeys: 2 });
		br.failure(new Error('x'), 'ejected');
		for (let i = 0; i < 50; i++) expect(br.stateOf('unknown-' + i)).toBe('healthy');
		expect(br.stateOf('ejected')).toBe('broken');
		// The second slot was never spent on an observability call, so a real key
		// that starts failing is still tracked and still ejected.
		br.failure(new Error('x'), 'late');
		expect(br.stateOf('late')).toBe('broken');
	});

	it('reclaims the slot of a key that carries no failure record', () => {
		const br = createWebhookBreaker({ failureThreshold: 2, resetMs: 60000, maxKeys: 2 });
		br.guard('idle'); // healthy, nothing recorded
		br.failure(new Error('x'), 'shaky'); // one failure short of ejection
		br.failure(new Error('x'), 'fresh'); // takes idle's slot, not shaky's
		br.failure(new Error('x'), 'fresh');
		expect(br.stateOf('fresh')).toBe('broken');
		br.failure(new Error('x'), 'shaky');
		expect(br.stateOf('shaky')).toBe('broken'); // its first failure was kept
	});
});
