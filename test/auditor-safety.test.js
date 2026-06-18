import { describe, it, expect, vi } from 'vitest';
import { createConsistencyAuditor } from '../src/runtime/auditor.js';
import { buildConnectionAuditSnapshot } from '../src/runtime/audit-snapshot.js';
import { WS_SUBSCRIPTIONS, WS_SESSION_ID } from '../src/runtime/utils.js';

// The production hardCategories: only a corrupt subscription slot can ever kill a
// worker, and only when it persists. This is the safe-by-default proof.
const PROD_HARD = ['subs.shape'];

function fakeWs(id, subs) {
	const ud = { [WS_SESSION_ID]: id, [WS_SUBSCRIPTIONS]: subs };
	return { getUserData() { return ud; } };
}

function prodSnapshotOf(connSet, totalSubscriptions) {
	return ({ offset, limit }) => buildConnectionAuditSnapshot({
		connections: connSet,
		subscriptionsKey: WS_SUBSCRIPTIONS,
		sessionIdKey: WS_SESSION_ID,
		totalSubscriptions,
		offset,
		limit
	});
}

describe('consistency auditor - safe by default (healthy worker never killed)', () => {
	it('never escalates to fatal on a healthy population across many audit passes', () => {
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		const conns = new Set();
		for (let i = 0; i < 50; i++) conns.add(fakeWs('c' + i, new Set(['room', 'lobby'])));
		const auditor = createConsistencyAuditor({
			snapshot: prodSnapshotOf(conns, 100), // 50 conns * 2 subs = 100, the cap accountant agrees
			assert: softAssert,
			fatal: fatalFn,
			hardCategories: PROD_HARD
		});
		for (let pass = 0; pass < 25; pass++) auditor.runOnce();
		expect(softAssert).not.toHaveBeenCalled();
		expect(fatalFn).not.toHaveBeenCalled();
		expect(auditor.stats.violations).toBe(0);
		expect(auditor.stats.fatals).toBe(0);
	});

	it('a healthy snapshot whose totalSubscriptions counter dips to a transient negative routes SOFT, never fatal', () => {
		// subs.total-negative is deliberately NOT a hard category: a concurrent-close
		// dip must never kill a recoverable worker. It logs (soft) and surfaces in
		// the counter instead.
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		const conns = new Set([fakeWs('c0', new Set())]);
		const auditor = createConsistencyAuditor({
			snapshot: prodSnapshotOf(conns, -1), // momentary negative
			assert: softAssert,
			fatal: fatalFn,
			hardCategories: PROD_HARD
		});
		auditor.runOnce();
		auditor.runOnce();
		expect(fatalFn).not.toHaveBeenCalled();
		expect(softAssert).toHaveBeenCalled();
		expect(softAssert.mock.calls.every((c) => c[1] === 'subs.total-negative')).toBe(true);
	});

	it('a corrupt subscription slot is soft on the first audit and escalates only on persistence', () => {
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		const conns = new Set([fakeWs('corrupt', 'not-a-set')]);
		const auditor = createConsistencyAuditor({
			snapshot: prodSnapshotOf(conns, 0),
			assert: softAssert,
			fatal: fatalFn,
			hardCategories: PROD_HARD
		});
		// Pass 1: could be a transient race -> soft only.
		auditor.runOnce();
		expect(softAssert).toHaveBeenCalledTimes(1);
		expect(softAssert).toHaveBeenCalledWith(false, 'subs.shape', { ws: 'corrupt' });
		expect(fatalFn).not.toHaveBeenCalled();
		// Pass 2: same corruption persisted -> hard tier (worker restart in prod).
		auditor.runOnce();
		expect(fatalFn).toHaveBeenCalledTimes(1);
		expect(fatalFn).toHaveBeenCalledWith(false, 'subs.shape', { ws: 'corrupt' });
		expect(auditor.stats.fatals).toBe(1);
	});

	it('a corruption that heals before the next audit never escalates', () => {
		const softAssert = vi.fn();
		const fatalFn = vi.fn();
		const broken = new Set([fakeWs('c0', 'not-a-set')]);
		// Healthy: an empty subscription Set so the full-window cap accountant
		// (totalSubscriptions 0) agrees with the summed bookkeeping (0) - the only
		// thing under test here is that the corruption healed, not the accountant.
		const healthy = new Set([fakeWs('c0', new Set())]);
		let live = broken;
		const auditor = createConsistencyAuditor({
			snapshot: ({ offset, limit }) => buildConnectionAuditSnapshot({
				connections: live,
				subscriptionsKey: WS_SUBSCRIPTIONS,
				sessionIdKey: WS_SESSION_ID,
				totalSubscriptions: 0,
				offset,
				limit
			}),
			assert: softAssert,
			fatal: fatalFn,
			hardCategories: PROD_HARD
		});
		auditor.runOnce();      // broken once (soft)
		live = healthy;
		auditor.runOnce();      // healed: clears persistence memory, no violation
		live = broken;
		auditor.runOnce();      // broken again but first-after-heal -> soft, not fatal
		expect(fatalFn).not.toHaveBeenCalled();
		expect(softAssert).toHaveBeenCalledTimes(2);
	});
});
