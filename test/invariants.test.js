import { describe, it, expect } from 'vitest';
import {
	checkSubscriptionBookkeeping,
	checkTotalSubscriptions,
	checkTopicsHaveSubscribers,
	runInvariants,
	defaultInvariants
} from '../src/runtime/invariants.js';

describe('checkSubscriptionBookkeeping', () => {
	it('returns null when every connection agrees', () => {
		const snap = {
			connections: [
				{ id: 1, subscribed: ['a', 'b'], bookkeeping: ['a', 'b'] },
				{ id: 2, subscribed: [], bookkeeping: [] }
			]
		};
		expect(checkSubscriptionBookkeeping(snap)).toBeNull();
	});

	it('returns null for a missing connections list (partial snapshot)', () => {
		expect(checkSubscriptionBookkeeping({})).toBeNull();
		expect(checkSubscriptionBookkeeping(null)).toBeNull();
	});

	it('flags subs.shape when bookkeeping is not an array', () => {
		const snap = { connections: [{ id: 7, subscribed: ['a'], bookkeeping: null }] };
		expect(checkSubscriptionBookkeeping(snap)).toEqual({ category: 'subs.shape', context: { ws: 7 } });
	});

	it('flags subs.bookkeeping on a size mismatch', () => {
		const snap = { connections: [{ id: 3, subscribed: ['a', 'b'], bookkeeping: ['a'] }] };
		expect(checkSubscriptionBookkeeping(snap)).toEqual({
			category: 'subs.bookkeeping',
			context: { ws: 3, bookkeeping: 1, subscribed: 2 }
		});
	});

	it('flags subs.bookkeeping.missing when a bookkeeping topic is absent from subscribed', () => {
		const snap = { connections: [{ id: 9, subscribed: ['a', 'x'], bookkeeping: ['a', 'b'] }] };
		expect(checkSubscriptionBookkeeping(snap)).toEqual({
			category: 'subs.bookkeeping.missing',
			context: { ws: 9, topic: 'b' }
		});
	});

	it('returns the first violation only', () => {
		const snap = {
			connections: [
				{ id: 1, subscribed: ['a'], bookkeeping: ['a'] },
				{ id: 2, subscribed: ['a'], bookkeeping: null },
				{ id: 3, subscribed: [], bookkeeping: ['z'] }
			]
		};
		expect(checkSubscriptionBookkeeping(snap)).toEqual({ category: 'subs.shape', context: { ws: 2 } });
	});
});

describe('checkTotalSubscriptions', () => {
	it('is a no-op when the counter is absent', () => {
		expect(checkTotalSubscriptions({ connections: [] })).toBeNull();
	});

	it('flags a negative total', () => {
		expect(checkTotalSubscriptions({ totalSubscriptions: -1 })).toEqual({
			category: 'subs.total-negative',
			context: { totalSubscriptions: -1 }
		});
	});

	it('flags a total that disagrees with the summed bookkeeping', () => {
		const snap = {
			totalSubscriptions: 5,
			connections: [
				{ id: 1, subscribed: ['a'], bookkeeping: ['a'] },
				{ id: 2, subscribed: ['b', 'c'], bookkeeping: ['b', 'c'] }
			]
		};
		expect(checkTotalSubscriptions(snap)).toEqual({
			category: 'subs.total-mismatch',
			context: { totalSubscriptions: 5, summed: 3, connections: 2 }
		});
	});

	it('reports how many contributing registries a close had already settled', () => {
		// The sum alone cannot separate a membership charged twice from a closed
		// connection still sitting in the live set - both raise summed against an
		// unchanged total. `settled` is what tells them apart, so it rides on the
		// violation rather than being left to whoever reads the number later.
		const base = {
			totalSubscriptions: 2,
			connections: [
				{ id: 1, subscribed: ['a'], bookkeeping: ['a'] },
				{ id: 2, subscribed: ['b'], bookkeeping: ['b'] },
				{ id: 3, subscribed: ['c'], bookkeeping: ['c'] }
			]
		};
		expect(checkTotalSubscriptions({ ...base, settled: 1 })).toEqual({
			category: 'subs.total-mismatch',
			context: { totalSubscriptions: 2, summed: 3, connections: 3, settled: 1 }
		});
		// Zero is an answer, not an absence: it rules the leak out and points at
		// the memberships instead, so it must survive onto the violation.
		expect(checkTotalSubscriptions({ ...base, settled: 0 }).context.settled).toBe(0);
		// A caller that cannot answer omits the field rather than reporting a zero
		// it did not measure.
		expect('settled' in checkTotalSubscriptions(base).context).toBe(false);
	});

	it('passes when the total equals the summed bookkeeping', () => {
		const snap = {
			totalSubscriptions: 3,
			connections: [
				{ id: 1, subscribed: ['a'], bookkeeping: ['a'] },
				{ id: 2, subscribed: ['b', 'c'], bookkeeping: ['b', 'c'] }
			]
		};
		expect(checkTotalSubscriptions(snap)).toBeNull();
	});
});

describe('checkTopicsHaveSubscribers', () => {
	it('is a no-op when topicCounts is absent', () => {
		expect(checkTopicsHaveSubscribers({})).toBeNull();
	});

	it('passes when every topic has a positive count', () => {
		expect(checkTopicsHaveSubscribers({ topicCounts: { a: 1, b: 4 } })).toBeNull();
	});

	it('flags a leaked zero-count topic', () => {
		expect(checkTopicsHaveSubscribers({ topicCounts: { a: 1, b: 0 } })).toEqual({
			category: 'topic.zero-subscribers',
			context: { topic: 'b', count: 0 }
		});
	});
});

describe('runInvariants', () => {
	it('collects one violation per failing predicate (default set)', () => {
		const snap = {
			totalSubscriptions: -2,
			topicCounts: { a: 0 },
			connections: [{ id: 1, subscribed: ['a'], bookkeeping: null }]
		};
		const out = runInvariants(snap);
		const categories = out.map((v) => v.category).sort();
		expect(categories).toEqual(['subs.shape', 'subs.total-negative', 'topic.zero-subscribers']);
	});

	it('returns an empty array on a clean snapshot', () => {
		const snap = {
			totalSubscriptions: 1,
			topicCounts: { a: 1 },
			connections: [{ id: 1, subscribed: ['a'], bookkeeping: ['a'] }]
		};
		expect(runInvariants(snap)).toEqual([]);
	});

	it('honours a custom predicate list', () => {
		const snap = { connections: [{ id: 1, subscribed: [], bookkeeping: null }] };
		expect(runInvariants(snap, [checkTotalSubscriptions])).toEqual([]);
		expect(runInvariants(snap, [checkSubscriptionBookkeeping])).toHaveLength(1);
	});

	it('defaultInvariants is the documented ordered set', () => {
		expect(defaultInvariants).toEqual([
			checkSubscriptionBookkeeping,
			checkTotalSubscriptions,
			checkTopicsHaveSubscribers
		]);
	});
});
