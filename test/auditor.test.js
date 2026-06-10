import { describe, it, expect, vi } from 'vitest';
import { createConsistencyAuditor } from '../files/auditor.js';
import { checkSubscriptionBookkeeping } from '../files/invariants.js';

// A snapshot factory that always reports the same (possibly broken) state, so a
// seeded violation surfaces deterministically. `total` keeps the round-robin
// window from advancing past a single population.
function constantSnapshot(snap) {
	return () => ({ ...snap, total: (snap.connections || []).length });
}

describe('createConsistencyAuditor', () => {
	it('rejects a missing snapshot or assert function', () => {
		expect(() => createConsistencyAuditor({ assert: () => {} })).toThrow(/snapshot/);
		expect(() => createConsistencyAuditor({ snapshot: () => ({}) })).toThrow(/assert/);
	});

	it('requires a fatal sink when hardCategories is set', () => {
		expect(() => createConsistencyAuditor({
			snapshot: () => ({}),
			assert: () => {},
			hardCategories: ['subs.shape']
		})).toThrow(/fatal/);
	});

	it('surfaces a seeded invariant violation through the soft assert by default', () => {
		const softAssert = vi.fn();
		const auditor = createConsistencyAuditor({
			snapshot: constantSnapshot({ connections: [{ id: 1, subscribed: ['a'], bookkeeping: null }] }),
			assert: softAssert
		});
		const violations = auditor.runOnce();
		expect(violations).toEqual([{ category: 'subs.shape', context: { ws: 1 } }]);
		expect(softAssert).toHaveBeenCalledTimes(1);
		expect(softAssert).toHaveBeenCalledWith(false, 'subs.shape', { ws: 1 });
		expect(auditor.stats.violations).toBe(1);
		expect(auditor.stats.fatals).toBe(0);
	});

	it('does not fire on a clean snapshot', () => {
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		const auditor = createConsistencyAuditor({
			snapshot: constantSnapshot({ connections: [{ id: 1, subscribed: ['a'], bookkeeping: ['a'] }] }),
			assert: softAssert,
			fatal: fatalFn
		});
		expect(auditor.runOnce()).toEqual([]);
		expect(softAssert).not.toHaveBeenCalled();
		expect(fatalFn).not.toHaveBeenCalled();
	});

	it('keeps a hard-tier violation soft on its first observation and escalates on persistence', () => {
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		const auditor = createConsistencyAuditor({
			snapshot: constantSnapshot({ connections: [{ id: 1, subscribed: ['a'], bookkeeping: null }] }),
			assert: softAssert,
			fatal: fatalFn,
			hardCategories: ['subs.shape']
		});
		// First audit: soft (could be a transient race), counter only.
		auditor.runOnce();
		expect(softAssert).toHaveBeenCalledTimes(1);
		expect(fatalFn).not.toHaveBeenCalled();
		// Second audit: same violation persisted, escalate to the hard sink.
		auditor.runOnce();
		expect(fatalFn).toHaveBeenCalledTimes(1);
		expect(fatalFn).toHaveBeenCalledWith(false, 'subs.shape', { ws: 1 });
		expect(auditor.stats.fatals).toBe(1);
	});

	it('does not escalate when the violation heals before the next audit', () => {
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		let broken = true;
		const auditor = createConsistencyAuditor({
			snapshot: () => broken
				? { connections: [{ id: 1, subscribed: ['a'], bookkeeping: null }], total: 1 }
				: { connections: [{ id: 1, subscribed: ['a'], bookkeeping: ['a'] }], total: 1 },
			assert: softAssert,
			fatal: fatalFn,
			hardCategories: ['subs.shape']
		});
		auditor.runOnce();        // observed broken once (soft)
		broken = false;
		auditor.runOnce();        // healed: clears the persistence memory
		broken = true;
		auditor.runOnce();        // broken again, but first observation after heal -> soft
		expect(fatalFn).not.toHaveBeenCalled();
		expect(softAssert).toHaveBeenCalledTimes(2);
	});

	it('advances a round-robin window so a bounded snapshot eventually covers everything', () => {
		const offsets = [];
		const auditor = createConsistencyAuditor({
			snapshot: ({ offset, limit }) => {
				offsets.push(offset);
				expect(limit).toBe(2);
				return { connections: [], total: 5 };
			},
			assert: () => {},
			maxPerTick: 2
		});
		// total 5, window 2 -> offsets 0,2,4 then wrap to 0.
		auditor.runOnce();
		auditor.runOnce();
		auditor.runOnce();
		auditor.runOnce();
		expect(offsets).toEqual([0, 2, 4, 0]);
	});

	it('runs the shared predicate set by default', () => {
		const softAssert = vi.fn();
		const auditor = createConsistencyAuditor({
			snapshot: constantSnapshot({
				totalSubscriptions: -1,
				connections: [{ id: 1, subscribed: ['a'], bookkeeping: ['a'] }]
			}),
			assert: softAssert,
			predicates: [checkSubscriptionBookkeeping, (snap) => snap.totalSubscriptions < 0
				? { category: 'subs.total-negative', context: { totalSubscriptions: snap.totalSubscriptions } }
				: null]
		});
		const v = auditor.runOnce();
		expect(v.map((x) => x.category)).toEqual(['subs.total-negative']);
	});
});
