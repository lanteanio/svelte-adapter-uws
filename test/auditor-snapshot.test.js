import { describe, it, expect } from 'vitest';
import { buildConnectionAuditSnapshot } from '../src/runtime/audit-snapshot.js';
import { WS_SUBSCRIPTIONS, WS_SESSION_ID } from '../src/runtime/utils.js';
import { checkSubscriptionBookkeeping, checkTotalSubscriptions } from '../src/runtime/invariants.js';

// A fake live connection: getUserData() returns the userData slots the builder
// reads. `throws: true` models a freed native handle (getUserData throws).
function fakeWs(id, subs, throws = false) {
	const ud = { [WS_SESSION_ID]: id, [WS_SUBSCRIPTIONS]: subs };
	return {
		getUserData() {
			if (throws) throw new Error('freed handle');
			return ud;
		}
	};
}

function build(connSet, { offset = 0, limit = 1000, totalSubscriptions = 0, isSettled } = {}) {
	return buildConnectionAuditSnapshot({
		connections: connSet,
		subscriptionsKey: WS_SUBSCRIPTIONS,
		sessionIdKey: WS_SESSION_ID,
		totalSubscriptions,
		offset,
		limit,
		isSettled
	});
}

describe('buildConnectionAuditSnapshot (prod bounded snapshot)', () => {
	it('reports the full population as total and never returns more than limit', () => {
		const conns = new Set();
		for (let i = 0; i < 10; i++) conns.add(fakeWs('id' + i, new Set(['t' + i])));
		const snap = build(conns, { offset: 0, limit: 4 });
		expect(snap.total).toBe(10);
		expect(snap.connections.length).toBe(4);
	});

	it('total equals the connection set size', () => {
		const conns = new Set();
		for (let i = 0; i < 3; i++) conns.add(fakeWs('id' + i, new Set()));
		expect(build(conns).total).toBe(3);
	});

	it('a positive offset returns the correct slice and the auditor window wraps over successive ticks', () => {
		const conns = new Set();
		for (let i = 0; i < 5; i++) conns.add(fakeWs('id' + i, new Set()));
		// limit 2: offset 0 -> id0,id1 ; offset 2 -> id2,id3 ; offset 4 -> id4
		expect(build(conns, { offset: 0, limit: 2 }).connections.map((c) => c.id)).toEqual(['id0', 'id1']);
		expect(build(conns, { offset: 2, limit: 2 }).connections.map((c) => c.id)).toEqual(['id2', 'id3']);
		expect(build(conns, { offset: 4, limit: 2 }).connections.map((c) => c.id)).toEqual(['id4']);
	});

	it('attaches totalSubscriptions ONLY when the window covers every connection', () => {
		const conns = new Set();
		for (let i = 0; i < 3; i++) conns.add(fakeWs('id' + i, new Set(['t'])));
		// Full window (offset 0, size <= limit): the cap accountant is attached.
		const full = build(conns, { offset: 0, limit: 1000, totalSubscriptions: 3 });
		expect(full.totalSubscriptions).toBe(3);
		// Partial window (size > limit): omitted, so the summed cross-check cannot
		// false-positive off a partial slice sum.
		const partial = build(conns, { offset: 0, limit: 2, totalSubscriptions: 3 });
		expect('totalSubscriptions' in partial).toBe(false);
		// Non-zero offset: also a partial pass, omitted.
		const offsetWindow = build(conns, { offset: 1, limit: 1000, totalSubscriptions: 3 });
		expect('totalSubscriptions' in offsetWindow).toBe(false);
	});

	it('skips a connection whose getUserData throws (freed handle) without throwing or reporting it', () => {
		const live = fakeWs('live', new Set(['a']));
		const freed = fakeWs('freed', new Set(['b']), true);
		const conns = new Set([live, freed]);
		const snap = build(conns);
		// total still counts the freed handle (it is in the set), but it is not
		// materialized into the window.
		expect(snap.total).toBe(2);
		expect(snap.connections.map((c) => c.id)).toEqual(['live']);
	});

	it('omits the cap accountant when a freed handle made the full-range window an incomplete census', () => {
		// The window asks for every connection and the population fits inside the
		// limit, so the old offset/limit test called this a full pass - but the
		// freed handle is skipped, and its close has NOT run, so the counter still
		// holds the membership the window cannot show. Attaching the counter here
		// hands checkTotalSubscriptions a short sum and fabricates a drift.
		const live = fakeWs('live', new Set(['a']));
		const freed = fakeWs('freed', new Set(['b']), true);
		const snap = build(new Set([live, freed]), { totalSubscriptions: 2 });
		expect(snap.total).toBe(2);
		expect(snap.connections.length).toBe(1);
		expect('totalSubscriptions' in snap).toBe(false);
		// The cross-check is what the omission protects, so pin the consequence
		// rather than the flag: with the counter attached this reported
		// subs.total-mismatch { totalSubscriptions: 2, summed: 1 }.
		expect(checkTotalSubscriptions(snap)).toBeNull();
	});

	it('still attaches the cap accountant when every connection materialized', () => {
		// The other side of the same condition: no skips, so the census is
		// complete and the cross-check must run - otherwise the fix above would
		// disable the accountant everywhere and nothing would notice.
		const conns = new Set([fakeWs('a', new Set(['t1'])), fakeWs('b', new Set(['t2']))]);
		const snap = build(conns, { totalSubscriptions: 2 });
		expect(snap.connections.length).toBe(2);
		expect(snap.totalSubscriptions).toBe(2);
		expect(checkTotalSubscriptions(snap)).toBeNull();
		// And a REAL drift still reports, so the guard did not blunt the signal.
		expect(checkTotalSubscriptions(build(conns, { totalSubscriptions: 5 })))
			.toEqual({ category: 'subs.total-mismatch', context: { totalSubscriptions: 5, summed: 2, connections: 2 } });
	});

	it('counts the settled registries in the window when the caller can answer', () => {
		// A connection the close path settled but left in the live set keeps
		// contributing topics the counter has already released. Counting them is
		// what separates that from a membership charged twice, since the two
		// produce the same sum.
		const live = fakeWs('live', new Set(['a']));
		const closed = fakeWs('closed', new Set(['b']));
		const settledSets = new WeakSet([closed.getUserData()[WS_SUBSCRIPTIONS]]);
		const snap = build(new Set([live, closed]), {
			totalSubscriptions: 1,
			isSettled: (subs) => settledSets.has(subs)
		});
		expect(snap.settled).toBe(1);
		expect(checkTotalSubscriptions(snap)).toEqual({
			category: 'subs.total-mismatch',
			context: { totalSubscriptions: 1, summed: 2, connections: 2, settled: 1 }
		});
	});

	it('omits the settled count when no predicate was supplied', () => {
		const conns = new Set([fakeWs('a', new Set(['t1']))]);
		expect('settled' in build(conns, { totalSubscriptions: 1 })).toBe(false);
	});

	it('yields null subscribed/bookkeeping for a non-Set subscription slot, so subs.shape fires', () => {
		const conns = new Set([fakeWs('broken', 'not-a-set')]);
		const snap = build(conns);
		expect(snap.connections[0].subscribed).toBeNull();
		expect(snap.connections[0].bookkeeping).toBeNull();
		expect(checkSubscriptionBookkeeping(snap)).toEqual({ category: 'subs.shape', context: { ws: 'broken' } });
	});

	it('reads subscribed and bookkeeping from the one Set, so a healthy connection passes the bookkeeping check', () => {
		const conns = new Set([fakeWs('ok', new Set(['room', 'lobby']))]);
		const snap = build(conns);
		expect(snap.connections[0].subscribed.sort()).toEqual(['lobby', 'room']);
		expect(snap.connections[0].bookkeeping.sort()).toEqual(['lobby', 'room']);
		expect(checkSubscriptionBookkeeping(snap)).toBeNull();
	});

	it('never attaches topicCounts (no native per-topic subscriber-count source in prod)', () => {
		const conns = new Set([fakeWs('id', new Set(['t']))]);
		const snap = build(conns);
		expect('topicCounts' in snap).toBe(false);
	});
});
