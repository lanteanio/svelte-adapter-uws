import { describe, it, expect } from 'vitest';
import { buildConnectionAuditSnapshot } from '../src/runtime/audit-snapshot.js';
import { WS_SUBSCRIPTIONS, WS_SESSION_ID } from '../src/runtime/utils.js';
import { checkSubscriptionBookkeeping } from '../src/runtime/invariants.js';

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

function build(connSet, { offset = 0, limit = 1000, totalSubscriptions = 0 } = {}) {
	return buildConnectionAuditSnapshot({
		connections: connSet,
		subscriptionsKey: WS_SUBSCRIPTIONS,
		sessionIdKey: WS_SESSION_ID,
		totalSubscriptions,
		offset,
		limit
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
