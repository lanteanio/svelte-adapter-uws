import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPresence } from '../src/plugins/presence/server.js';
import { encodePresence } from '../src/plugins/presence/codec.js';
import { mockWs, mockPlatform } from './_helpers.js';
import { WS_SUBSCRIPTIONS, MAX_SUBSCRIPTIONS_PER_CONNECTION } from '../src/runtime/utils.js';

describe('presence plugin - server', () => {
	let presence;
	let platform;

	beforeEach(() => {
		presence = createPresence({
			key: 'id',
			select: (userData) => ({ id: userData.id, name: userData.name })
		});
		platform = mockPlatform();
	});

	describe('createPresence', () => {
		it('returns a presence tracker with the expected API', () => {
			expect(typeof presence.join).toBe('function');
			expect(typeof presence.leave).toBe('function');
			expect(typeof presence.sync).toBe('function');
			expect(typeof presence.list).toBe('function');
			expect(typeof presence.count).toBe('function');
			expect(typeof presence.clear).toBe('function');
			expect(typeof presence.hooks.subscribe).toBe('function');
			expect(typeof presence.hooks.close).toBe('function');
		});

		it('works with default options', () => {
			const p = createPresence();
			expect(typeof p.join).toBe('function');
		});
	});

	describe('select() validation', () => {
		it('throws TypeError when select returns a string', () => {
			const p = createPresence({ select: () => 'alice' });
			const ws = mockWs({ id: '1' });
			expect(() => p.join(ws, 'room', mockPlatform())).toThrow(TypeError);
			expect(() => p.join(ws, 'room', mockPlatform())).toThrow('must return a plain object');
		});

		it('throws TypeError when select returns a number', () => {
			const p = createPresence({ select: () => 42 });
			const ws = mockWs({ id: '1' });
			expect(() => p.join(ws, 'room', mockPlatform())).toThrow('must return a plain object');
		});

		it('throws TypeError when select returns null', () => {
			const p = createPresence({ select: () => null });
			const ws = mockWs({ id: '1' });
			expect(() => p.join(ws, 'room', mockPlatform())).toThrow('must return a plain object');
		});

		it('throws TypeError when select returns undefined', () => {
			const p = createPresence({ select: () => undefined });
			const ws = mockWs({ id: '1' });
			expect(() => p.join(ws, 'room', mockPlatform())).toThrow('must return a plain object');
		});

		it('accepts a plain object from select', () => {
			const p = createPresence({ select: (ud) => ({ id: ud.id }) });
			const ws = mockWs({ id: '1' });
			expect(() => p.join(ws, 'room', mockPlatform())).not.toThrow();
		});
	});

	describe('join', () => {
		it('adds user to presence and sends state snapshot to joining client', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			// Should send full snapshot to the joining client
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__presence:room');
			expect(platform.sent[0].event).toBe('state');
			expect(platform.sent[0].data).toEqual({
				'1': { id: '1', name: 'Alice' }
			});

			// Diff publishes the join to the topic. The joining ws is
			// subscribed by then, but the client's presence store is
			// idempotent on receiving its own join.
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
			expect(platform.published[0].data).toEqual({
				joins: { '1': { id: '1', name: 'Alice' } },
				leaves: {}
			});
		});

		it('subscribes ws to the internal presence topic', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			expect(ws.isSubscribed('__presence:room')).toBe(true);
		});

		it('broadcasts diff for new users', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });

			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.join(ws2, 'room', platform);
			presence.flushDiffs();

			// Should publish a diff carrying Bob's join
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0]).toEqual({
				topic: '__presence:room',
				event: 'diff',
				data: { joins: { '2': { id: '2', name: 'Bob' } }, leaves: {} }
			});

			// Should send full snapshot to Bob
			expect(platform.sent).toHaveLength(1);
			expect(Object.keys(platform.sent[0].data)).toHaveLength(2);
		});

		it('coalesces multiple joins in one tick into a single diff', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			const ws3 = mockWs({ id: '3', name: 'Carol' });

			presence.join(ws1, 'room', platform);
			presence.join(ws2, 'room', platform);
			presence.join(ws3, 'room', platform);
			presence.flushDiffs();

			const diffs = platform.published.filter(p => p.event === 'diff');
			expect(diffs).toHaveLength(1);
			expect(diffs[0].data.joins).toEqual({
				'1': { id: '1', name: 'Alice' },
				'2': { id: '2', name: 'Bob' },
				'3': { id: '3', name: 'Carol' }
			});
			expect(diffs[0].data.leaves).toEqual({});
		});

		// Pins the structural property the prior queueMicrotask defer got
		// wrong: uWS dispatches each WS message as its own JS task and N-API
		// drains microtasks at the C++/JS boundary between tasks, so a
		// microtask-deferred flush fires BEFORE the next socket's handler runs
		// and cross-socket coalescing is impossible at the microtask level.
		// setTimeout(0) lands in libuv's timers phase, which fires only after
		// the poll phase has dispatched every ready socket message in the
		// current iteration - so joins arriving in separate JS tasks (the
		// production shape) still collapse into one diff. Mirrors the
		// cross-task-boundary regression test for cursor's always-tick (0.5.6).
		it('cross-task-boundary joins coalesce into one diff per topic', async () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (u) => ({ id: u.id })
			});
			const COUNT = 50;
			for (let i = 0; i < COUNT; i++) {
				p.join(mockWs({ id: 'joiner-' + i }), 'room', platform);
				await Promise.resolve(); // crosses microtask boundary like uWS dispatches
			}
			vi.advanceTimersByTime(16);

			const diffs = platform.published.filter((pp) => pp.event === 'diff' && pp.topic === '__presence:room');
			expect(diffs).toHaveLength(1);
			expect(Object.keys(diffs[0].data.joins)).toHaveLength(COUNT);

			vi.useRealTimers();
		});

		it('is idempotent - same ws + topic does nothing', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			const publishCount = platform.published.length;
			const sentCount = platform.sent.length;

			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			expect(platform.published.length).toBe(publishCount);
			expect(platform.sent.length).toBe(sentCount);
		});

		it('ignores __-prefixed topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, '__presence:room', platform);
			presence.flushDiffs();

			expect(platform.published).toHaveLength(0);
			expect(platform.sent).toHaveLength(0);
			expect(presence.count('__presence:room')).toBe(0);
		});

		it('tracks multiple topics independently', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room-a', platform);
			presence.join(ws, 'room-b', platform);

			expect(presence.count('room-a')).toBe(1);
			expect(presence.count('room-b')).toBe(1);
		});

		it('uses select function to filter userData', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id })
			});
			const ws = mockWs({ id: '1', name: 'Alice', secret: 'token123' });
			p.join(ws, 'room', platform);

			// Secret should not appear in the sent data
			const stateData = platform.sent[0].data;
			expect(stateData['1']).toEqual({ id: '1' });
			expect(stateData['1'].secret).toBeUndefined();
		});
	});

	describe('multi-tab dedup', () => {
		it('same key, two connections = one presence entry', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '1', name: 'Alice' });

			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			presence.join(ws2, 'room', platform);
			presence.flushDiffs();

			// Should NOT publish a diff (same user, different tab, same data)
			expect(platform.published).toHaveLength(0);

			// Count should still be 1
			expect(presence.count('room')).toBe(1);
			expect(presence.list('room')).toHaveLength(1);
		});

		it('closing one tab keeps user present', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '1', name: 'Alice' });

			presence.join(ws1, 'room', platform);
			presence.join(ws2, 'room', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			presence.leave(ws1, platform);
			presence.flushDiffs();

			// Should NOT publish a diff (other tab still open)
			expect(platform.published).toHaveLength(0);
			expect(presence.count('room')).toBe(1);
		});

		it('closing last tab publishes diff with leaves', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '1', name: 'Alice' });

			presence.join(ws1, 'room', platform);
			presence.join(ws2, 'room', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			presence.leave(ws1, platform);
			presence.leave(ws2, platform);
			presence.flushDiffs();

			// NOW the diff should carry the leave
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
			expect(platform.published[0].data).toEqual({
				joins: {},
				leaves: { '1': { id: '1', name: 'Alice' } }
			});
			expect(presence.count('room')).toBe(0);
		});

		it('publishes a join in the diff when a returning user rejoins with changed data', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			// Second connection with updated name
			const ws2 = mockWs({ id: '1', name: 'Alice Renamed' });
			presence.join(ws2, 'room', platform);
			presence.flushDiffs();

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0]).toEqual({
				topic: '__presence:room',
				event: 'diff',
				data: { joins: { '1': { id: '1', name: 'Alice Renamed' } }, leaves: {} }
			});

			// The stored data should reflect the new value
			expect(presence.list('room')).toEqual([{ id: '1', name: 'Alice Renamed' }]);
		});

		it('does not publish a diff when a returning user rejoins with identical data', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			// Second connection with identical data
			const ws2 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws2, 'room', platform);
			presence.flushDiffs();

			expect(platform.published).toHaveLength(0);
		});

		it('does not publish a diff when data keys are in a different order', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice', role: 'admin' });
			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			// Same values, different key insertion order
			const ws2 = mockWs({ id: '1', role: 'admin', name: 'Alice' });
			presence.join(ws2, 'room', platform);
			presence.flushDiffs();

			expect(platform.published).toHaveLength(0);
		});

		it('detects changes in nested objects on rejoin', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, prefs: { theme: userData.theme } })
			});
			const ws1 = mockWs({ id: '1', theme: 'light' });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', theme: 'dark' });
			p.join(ws2, 'room', platform);
			p.flushDiffs();

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
			expect(platform.published[0].data.joins['1'].prefs.theme).toBe('dark');
		});

		it('does not publish a diff when nested objects are equal', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, prefs: { theme: userData.theme } })
			});
			const ws1 = mockWs({ id: '1', theme: 'light' });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', theme: 'light' });
			p.join(ws2, 'room', platform);
			p.flushDiffs();

			expect(platform.published).toHaveLength(0);
		});

		it('does not throw when selected data contains non-serializable values', () => {
			const bigintPresence = createPresence({
				key: 'id',
				select: (userData) => userData
			});
			const ws1 = mockWs({ id: '1', score: BigInt(42) });
			const ws2 = mockWs({ id: '1', score: BigInt(42) });
			bigintPresence.join(ws1, 'room', platform);
			bigintPresence.flushDiffs();
			platform.published.length = 0;
			expect(() => bigintPresence.join(ws2, 'room', platform)).not.toThrow();
			bigintPresence.flushDiffs();
			expect(platform.published).toHaveLength(0); // same BigInt value, no update
		});

		it('does not blow the stack on cyclic data', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => userData
			});
			const cyclic = { id: '1', name: 'Alice' };
			cyclic.self = cyclic;
			const ws1 = mockWs(cyclic);
			p.join(ws1, 'room', platform);
			platform.published.length = 0;

			const cyclic2 = { id: '1', name: 'Alice' };
			cyclic2.self = cyclic2;
			const ws2 = mockWs(cyclic2);
			expect(() => p.join(ws2, 'room', platform)).not.toThrow();
		});

		it('does not false-positive when equal data reuses the same subobject', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => userData
			});
			const shared = { x: 1, y: 2 };
			const ws1 = mockWs({ id: '1', a: shared, b: shared });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const shared2 = { x: 1, y: 2 };
			const ws2 = mockWs({ id: '1', a: shared2, b: shared2 });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published).toHaveLength(0);
		});

		it('compares Date values by time, not reference', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, joined: userData.joined })
			});
			const ws1 = mockWs({ id: '1', joined: new Date('2025-01-01') });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', joined: new Date('2025-01-01') });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published).toHaveLength(0);
		});

		it('detects different Date values on rejoin', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, joined: userData.joined })
			});
			const ws1 = mockWs({ id: '1', joined: new Date('2025-01-01') });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', joined: new Date('2025-06-15') });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
		});

		it('compares Set values by content, not reference', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, roles: userData.roles })
			});
			const ws1 = mockWs({ id: '1', roles: new Set(['admin', 'user']) });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', roles: new Set(['admin', 'user']) });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published).toHaveLength(0);
		});

		it('detects different Set values on rejoin', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, roles: userData.roles })
			});
			const ws1 = mockWs({ id: '1', roles: new Set(['admin']) });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', roles: new Set(['admin', 'moderator']) });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
		});

		it('compares Map values by content, not reference', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, settings: userData.settings })
			});
			const ws1 = mockWs({ id: '1', settings: new Map([['theme', 'dark']]) });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.published.length = 0;

			const ws2 = mockWs({ id: '1', settings: new Map([['theme', 'dark']]) });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published).toHaveLength(0);
		});
	});

	describe('leave', () => {
		it('removes user from all topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room-a', platform);
			presence.join(ws, 'room-b', platform);

			presence.leave(ws, platform);

			expect(presence.count('room-a')).toBe(0);
			expect(presence.count('room-b')).toBe(0);
		});

		it('broadcasts a diff with leaves for each topic', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room-a', platform);
			presence.join(ws, 'room-b', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			presence.leave(ws, platform);
			presence.flushDiffs();

			const diffs = platform.published.filter(e => e.event === 'diff');
			expect(diffs).toHaveLength(2);
			expect(diffs.map(d => d.topic).sort()).toEqual([
				'__presence:room-a',
				'__presence:room-b'
			]);
			for (const d of diffs) {
				expect(d.data.joins).toEqual({});
				expect(d.data.leaves['1']).toEqual({ id: '1', name: 'Alice' });
			}
		});

		it('is safe to call for unknown ws', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			// Should not throw
			presence.leave(ws, platform);
			presence.flushDiffs();
			expect(platform.published).toHaveLength(0);
		});

		it('cleans up empty topic maps', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.leave(ws, platform);

			// Internal state should be cleaned up
			expect(presence.list('room')).toEqual([]);
		});
	});

	describe('sync', () => {
		it('sends state snapshot without joining', async () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const wsObserver = mockWs({ id: 'admin', name: 'Admin' });

			presence.join(ws1, 'room', platform);
			platform.sent.length = 0;

			await presence.sync(wsObserver, 'room', platform);

			// Should send snapshot to observer
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('state');
			expect(platform.sent[0].data).toEqual({
				'1': { id: '1', name: 'Alice' }
			});

			// Observer should be subscribed to presence updates
			expect(wsObserver.isSubscribed('__presence:room')).toBe(true);

			// But observer should NOT be in the presence list
			expect(presence.count('room')).toBe(1);
			expect(presence.list('room')[0].name).toBe('Alice');
		});

		it('sends empty snapshot for unknown topics', async () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			await presence.sync(ws, 'nonexistent', platform);

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('state');
			expect(platform.sent[0].data).toEqual({});
		});

		it('keeps an observer subscribed after a co-resident participant role leaves (dual-role teardown)', async () => {
			// One socket is BOTH a participant (join) and a sync-observer (sync) of
			// the same topic. Dropping the participant role must NOT evict the
			// observer's tap subscription - otherwise its roster freezes with the
			// departed user still shown.
			const dual = mockWs({ id: 'dual', name: 'Dual' });
			presence.join(dual, 'room', platform);
			await presence.sync(dual, 'room', platform);
			expect(dual.isSubscribed('__presence:room')).toBe(true);

			// Leave the participant role (the real-topic unsubscribe path).
			presence.hooks.unsubscribe(dual, 'room', { platform });

			// Still subscribed as an observer -> still receives roster diffs.
			expect(dual.isSubscribed('__presence:room')).toBe(true);
			expect(presence.count('room')).toBe(0); // participant role is gone
		});

		it('denies a presence-snapshot for a topic the client cannot subscribe to (authz, no roster leak)', async () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);

			const attacker = mockWs({ id: 'a' });
			const denyPlatform = { ...mockPlatform(), checkSubscribe: async (_ws, topic) => (topic === 'room' ? 'FORBIDDEN' : null) };
			await presence.sync(attacker, 'room', denyPlatform);

			expect(attacker.isSubscribed('__presence:room')).toBe(false); // not subscribed
			expect(denyPlatform.sent).toHaveLength(0); // roster not leaked

			// An authorized topic still works.
			await presence.sync(attacker, 'lobby', denyPlatform);
			expect(attacker.isSubscribed('__presence:lobby')).toBe(true);
		});

		it('refuses the presence-snapshot observer subscribe at the per-connection subscription cap', async () => {
			// The snapshot handshake subscribes the socket to __presence:{topic}
			// via trackedSubscribe, which never consulted the wire-enforced
			// MAX_SUBSCRIPTIONS_PER_CONNECTION cap - one connection could
			// accumulate unbounded subscriptions through this lane. The cap is
			// now enforced centrally in trackedSubscribe; the handshake fails
			// silently, exactly like its other gate failures.
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);
			platform.reset();

			const attacker = mockWs({ id: 'a' });
			const subs = new Set();
			for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) subs.add('filler:' + i);
			attacker.getUserData()[WS_SUBSCRIPTIONS] = subs;

			await presence.sync(attacker, 'room', platform);

			expect(attacker.isSubscribed('__presence:room')).toBe(false); // cap refused
			expect(subs.size).toBe(MAX_SUBSCRIPTIONS_PER_CONNECTION); // registry unchanged
			expect(platform.sent).toHaveLength(0); // no roster snapshot emitted
		});

		it('presence-snapshot observer subscribe works below the cap', async () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);

			const attacker = mockWs({ id: 'a' });
			attacker.getUserData()[WS_SUBSCRIPTIONS] = new Set(['existing']);
			await presence.sync(attacker, 'room', platform);

			expect(attacker.isSubscribed('__presence:room')).toBe(true);
			expect(attacker.getUserData()[WS_SUBSCRIPTIONS].has('__presence:room')).toBe(true);
		});
	});

	describe('list / count', () => {
		it('returns current users', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });

			presence.join(ws1, 'room', platform);
			presence.join(ws2, 'room', platform);

			expect(presence.list('room')).toEqual([
				{ id: '1', name: 'Alice' },
				{ id: '2', name: 'Bob' }
			]);
			expect(presence.count('room')).toBe(2);
		});

		it('returns empty for unknown topics', () => {
			expect(presence.list('nonexistent')).toEqual([]);
			expect(presence.count('nonexistent')).toBe(0);
		});

		it('returns copies - mutating list() results does not affect internal state', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			const list1 = presence.list('room');
			list1[0].name = 'Hacked';
			list1[0].injected = true;

			const list2 = presence.list('room');
			expect(list2[0].name).toBe('Alice');
			expect(list2[0].injected).toBeUndefined();
		});

		it('deeply isolates nested objects from internal state', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, meta: { role: userData.role } })
			});
			const ws = mockWs({ id: '1', role: 'admin' });
			p.join(ws, 'room', platform);

			const list1 = p.list('room');
			list1[0].meta.role = 'hacked';

			const list2 = p.list('room');
			expect(list2[0].meta.role).toBe('admin');
		});

		it('does not throw when data contains non-cloneable values', () => {
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, callback: userData.callback })
			});
			const ws = mockWs({ id: '1', callback: () => {} });
			p.join(ws, 'room', platform);

			expect(() => p.list('room')).not.toThrow();
			const list = p.list('room');
			expect(list).toHaveLength(1);
			expect(list[0].id).toBe('1');
		});
	});

	describe('clear', () => {
		it('resets all state', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			presence.clear();

			expect(presence.count('room')).toBe(0);
			expect(presence.list('room')).toEqual([]);
		});
	});

	describe('hooks', () => {
		it('exposes subscribe, unsubscribe, and close functions', () => {
			expect(typeof presence.hooks.subscribe).toBe('function');
			expect(typeof presence.hooks.unsubscribe).toBe('function');
			expect(typeof presence.hooks.close).toBe('function');
		});

		it('hooks.subscribe calls join for regular topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, 'room', { platform });

			expect(presence.count('room')).toBe(1);
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('state');
		});

		it('hooks.subscribe sends current snapshot for __presence: topics', async () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			const wsObserver = mockWs({ id: 'obs', name: 'Observer' });
			presence.hooks.subscribe(wsObserver, '__presence:room', { platform });
			await vi.waitFor(() => expect(platform.sent).toHaveLength(1));

			// Should send the snapshot
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__presence:room');
			expect(platform.sent[0].event).toBe('state');
			expect(platform.sent[0].data).toEqual({
				'1': { id: '1', name: 'Alice' }
			});

			// Should subscribe to the topic
			expect(wsObserver.isSubscribed('__presence:room')).toBe(true);

			// Observer should NOT be in the presence list
			expect(presence.count('room')).toBe(1);
		});

		it('hooks.subscribe sends empty snapshot for __presence: with no users', async () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, '__presence:empty', { platform });
			await vi.waitFor(() => expect(platform.sent).toHaveLength(1));

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('state');
			expect(platform.sent[0].data).toEqual({});
		});

		it('hooks.subscribe ignores other __-prefixed topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, '__replay:room', { platform });

			// Should still call join (which skips __ topics internally)
			expect(presence.count('__replay:room')).toBe(0);
			expect(platform.sent).toHaveLength(0);
		});

		it('hooks.unsubscribe removes from a single topic', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room-a', platform);
			presence.join(ws, 'room-b', platform);
			presence.flushDiffs();
			platform.reset();

			presence.hooks.unsubscribe(ws, 'room-a', { platform });
			presence.flushDiffs();

			expect(presence.count('room-a')).toBe(0);
			expect(presence.count('room-b')).toBe(1);
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
			expect(platform.published[0].topic).toBe('__presence:room-a');
			expect(platform.published[0].data.leaves['1']).toEqual({ id: '1', name: 'Alice' });
		});

		it('hooks.unsubscribe ignores __-prefixed topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			presence.hooks.unsubscribe(ws, '__presence:room', { platform });

			expect(presence.count('room')).toBe(1);
		});

		it('hooks.unsubscribe is safe for unknown ws', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			expect(() => presence.hooks.unsubscribe(ws, 'room', { platform })).not.toThrow();
		});

		it('hooks.close calls leave', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.hooks.close(ws, { platform });
			presence.flushDiffs();

			expect(presence.count('room')).toBe(0);
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('diff');
			expect(platform.published[0].data.leaves['1']).toEqual({ id: '1', name: 'Alice' });
		});

		it('destructured hooks work correctly', () => {
			const { subscribe, unsubscribe, close } = presence.hooks;

			const ws = mockWs({ id: '1', name: 'Alice' });
			subscribe(ws, 'room', { platform });
			expect(presence.count('room')).toBe(1);

			unsubscribe(ws, 'room', { platform });
			expect(presence.count('room')).toBe(0);
		});
	});

	describe('no key field in data', () => {
		it('generates unique ID per connection', () => {
			const p = createPresence({
				select: (userData) => ({ name: userData.name })
			});
			const ws1 = mockWs({ name: 'Alice' });
			const ws2 = mockWs({ name: 'Bob' });

			p.join(ws1, 'room', platform);
			p.join(ws2, 'room', platform);

			// Each connection should be separate since no 'id' in data
			expect(p.count('room')).toBe(2);
		});

		it('no auth (empty userData) still works', () => {
			const p = createPresence();
			const ws1 = mockWs({});
			const ws2 = mockWs({});

			p.join(ws1, 'room', platform);
			p.join(ws2, 'room', platform);

			// Each connection tracked separately
			expect(p.count('room')).toBe(2);
		});
	});

	describe('default select is identity-only', () => {
		it('copies only the stable configured key across JSON join, list, and state paths', () => {
			const p = createPresence({ key: 'id', heartbeat: 0 });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				medicalDiagnosis: 'private',
				rawHeaders: ['authorization', 'Bearer secret', 'cookie', 'sid=secret'],
				profile: { avatar: 'a.png', sessionToken: 'inner-secret' },
				primaryKey: 'ordinary-identifier'
			});

			p.join(ws, 'room', platform);
			p.flushDiffs();

			expect(platform.sent[0].data['1']).toEqual({ id: '1' });
			expect(platform.published[0].data.joins['1']).toEqual({ id: '1' });
			expect(p.list('room')).toEqual([{ id: '1' }]);
			const wire = JSON.stringify(platform.sent) + JSON.stringify(platform.published);
			expect(wire).not.toContain('private');
			expect(wire).not.toContain('Bearer secret');
			expect(wire).not.toContain('sid=secret');
			expect(wire).not.toContain('inner-secret');
			expect(wire).not.toContain('ordinary-identifier');
		});

		it('uses a structurally safe configured key and rejects non-scalar identity values', () => {
			const byUserKey = createPresence({ key: 'userKey', heartbeat: 0 });
			byUserKey.join(mockWs({ userKey: 42, name: 'Ada' }), 'room', platform);
			expect(byUserKey.list('room')).toEqual([{ userKey: 42 }]);

			const p = createPresence({ heartbeat: 0 });
			const id = { toJSON: () => 'secret-id' };
			p.join(mockWs({ id, name: 'Alice' }), 'other', platform);
			const state = platform.sent.at(-1).data;
			const fallbackKey = Object.keys(state)[0];
			expect(fallbackKey.startsWith('__conn:')).toBe(true);
			expect(state[fallbackKey]).toEqual({});
			expect(JSON.stringify(state)).not.toContain('secret-id');
		});

		it('explicit select remains an intentional policy override', () => {
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id, name: ud.name, medicalDiagnosis: ud.medicalDiagnosis })
			});
			p.join(mockWs({ id: '1', name: 'Alice', medicalDiagnosis: 'shared-by-policy' }), 'room', platform);

			expect(platform.sent[0].data['1']).toEqual({
				id: '1',
				name: 'Alice',
				medicalDiagnosis: 'shared-by-policy'
			});
		});

		it('returns a plain object and a per-connection key when identity is absent', () => {
			const p = createPresence({ heartbeat: 0 });
			expect(() => p.join(mockWs({}), 'room', platform)).not.toThrow();
			const state = platform.sent[0].data;
			const onlyKey = Object.keys(state)[0];
			expect(onlyKey.startsWith('__conn:')).toBe(true);
			expect(state[onlyKey]).toEqual({});
		});
	});

	describe('diff throttle', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('bounds topic-wide publishes at the secure 16 ms default', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0
			});
			const ws = mockWs({ id: '1' });
			p.join(ws, 'room', platform);
			p.flushDiffs();
			platform.reset();

			p.update(ws, 'room', { n: 1 }, platform);
			vi.advanceTimersByTime(15);
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
			vi.advanceTimersByTime(1);
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(1);

			p.update(ws, 'room', { n: 2 }, platform);
			vi.advanceTimersByTime(15);
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(2);
			p.clear();
		});

		it('lets heartbeat observe pending state and manual flush cancels the delayed publish', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 5,
				topicThrottle: 20
			});
			const ws = mockWs({ id: '1' });
			p.join(ws, 'room', platform);
			p.flushDiffs();
			platform.reset();

			p.update(ws, 'room', { mood: 'calm' }, platform);
			vi.advanceTimersByTime(5);
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
			expect(platform.published.find((e) => e.event === 'heartbeat').data['1'].mood).toBe('calm');

			p.flushDiffs();
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(1);
			vi.advanceTimersByTime(15);
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(1);
			p.clear();
		});

		it('rejects invalid topicThrottle values', () => {
			expect(() => createPresence({ topicThrottle: -1 })).toThrow('topicThrottle must be a non-negative number');
			expect(() => createPresence({ topicThrottle: NaN })).toThrow('topicThrottle must be a non-negative number');
		});
	});

	describe('heartbeat', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('publishes heartbeat events at the configured interval', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 5000
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room', platform);
			platform.reset();

			vi.advanceTimersByTime(5000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(1);
			expect(heartbeats[0].topic).toBe('__presence:room');
			expect(heartbeats[0].data).toEqual({ '1': { id: '1', name: 'Alice' } });

			p.clear();
		});

		it('heartbeat payload is a {userKey: data} map of every active user', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 5000
			});

			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			p.join(ws1, 'room', platform);
			p.join(ws2, 'room', platform);
			platform.reset();

			vi.advanceTimersByTime(5000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(1);
			expect(heartbeats[0].data).toEqual({
				'1': { id: '1', name: 'Alice' },
				'2': { id: '2', name: 'Bob' }
			});

			p.clear();
		});

		it('publishes heartbeats for all topics', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 5000
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room-a', platform);
			p.join(ws, 'room-b', platform);
			platform.reset();

			vi.advanceTimersByTime(5000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(2);
			const topics = heartbeats.map(h => h.topic).sort();
			expect(topics).toEqual(['__presence:room-a', '__presence:room-b']);

			p.clear();
		});

		it('does not publish heartbeats when heartbeat is explicitly 0', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 0
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room', platform);
			platform.reset();

			vi.advanceTimersByTime(60000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(0);

			p.clear();
		});

		it('publishes heartbeats at the 30 s default when no `heartbeat` option is passed', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name })
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room', platform);
			platform.reset();

			vi.advanceTimersByTime(29999);
			expect(platform.published.filter(e => e.event === 'heartbeat')).toHaveLength(0);

			vi.advanceTimersByTime(1);
			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(1);
			expect(heartbeats[0].data).toEqual({ '1': { id: '1', name: 'Alice' } });

			p.clear();
		});

		it('rejects non-numeric / negative heartbeat at construction', () => {
			expect(() => createPresence({ heartbeat: -1 })).toThrow('non-negative');
			expect(() => createPresence({ heartbeat: NaN })).toThrow('non-negative');
		});

		it('clear() stops the heartbeat timer', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 5000
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room', platform);
			platform.reset();

			p.clear();
			vi.advanceTimersByTime(10000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(0);
		});

		it('heartbeat does not include users who have left', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 5000
			});

			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			p.join(ws1, 'room', platform);
			p.join(ws2, 'room', platform);
			p.leave(ws2, platform);
			platform.reset();

			vi.advanceTimersByTime(5000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(1);
			expect(heartbeats[0].data).toEqual({ '1': { id: '1', name: 'Alice' } });

			p.clear();
		});

		it('heartbeat restarts after clear and re-join', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name }),
				heartbeat: 5000
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room', platform);
			p.clear();
			platform.reset();

			// Re-join after clear - should restart heartbeat
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			p.join(ws2, 'lobby', platform);
			platform.reset();

			vi.advanceTimersByTime(5000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(1);
			expect(heartbeats[0].topic).toBe('__presence:lobby');

			p.clear();
		});
	});

	describe('deepEqual edge cases', () => {
		it('compares Sets correctly', () => {
			const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, s: ud.s }) });
			const platform = mockPlatform();

			const ws1 = mockWs({ id: '1', s: new Set([1, 2]) });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.reset();

			const ws2 = mockWs({ id: '1', s: new Set([1, 2]) });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(0);

			platform.reset();
			const ws3 = mockWs({ id: '1', s: new Set([1, 3]) });
			p.join(ws3, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(1);
		});

		it('compares Maps correctly', () => {
			const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, m: ud.m }) });
			const platform = mockPlatform();

			const ws1 = mockWs({ id: '1', m: new Map([['a', 1]]) });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.reset();

			const ws2 = mockWs({ id: '1', m: new Map([['a', 1]]) });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(0);

			platform.reset();
			const ws3 = mockWs({ id: '1', m: new Map([['a', 2]]) });
			p.join(ws3, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(1);
		});

		it('compares arrays correctly', () => {
			const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, a: ud.a }) });
			const platform = mockPlatform();

			const ws1 = mockWs({ id: '1', a: [1, 2, 3] });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.reset();

			const ws2 = mockWs({ id: '1', a: [1, 2, 3] });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(0);

			platform.reset();
			const ws3 = mockWs({ id: '1', a: [1, 2, 4] });
			p.join(ws3, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(1);
		});

		it('handles circular references without infinite loop', () => {
			const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, ...ud.obj }) });
			const platform = mockPlatform();

			const a = { x: 1 };
			a.self = a;
			const ws1 = mockWs({ id: '1', obj: a });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.reset();

			const b = { x: 1 };
			b.self = b;
			const ws2 = mockWs({ id: '1', obj: b });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(0);
		});

		it('detects mismatched types (array vs object)', () => {
			const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, v: ud.v }) });
			const platform = mockPlatform();

			const ws1 = mockWs({ id: '1', v: [1, 2] });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.reset();

			const ws2 = mockWs({ id: '1', v: { 0: 1, 1: 2 } });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(1);
		});

		it('detects Set vs Map mismatches', () => {
			const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, v: ud.v }) });
			const platform = mockPlatform();

			const ws1 = mockWs({ id: '1', v: new Set([1]) });
			p.join(ws1, 'room', platform);
			p.flushDiffs();
			platform.reset();

			const ws2 = mockWs({ id: '1', v: new Map([[1, true]]) });
			p.join(ws2, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'diff')).toHaveLength(1);
		});
	});

	describe('caps', () => {
		it('rejects invalid connection/topic caps', () => {
			expect(() => createPresence({ maxConnections: 0 })).toThrow('maxConnections must be a positive integer');
			expect(() => createPresence({ maxTopics: -1 })).toThrow('maxTopics must be a positive integer');
			expect(() => createPresence({ maxTopicsPerConnection: 0 })).toThrow('maxTopicsPerConnection must be a positive integer');
		});

		it('evicts oldest connection state when at maxConnections', () => {
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				maxConnections: 2
			});
			const platform = mockPlatform();
			p.join(mockWs({ id: 'A' }), 'room', platform);
			p.join(mockWs({ id: 'B' }), 'room', platform);
			// Adding the third connection evicts the oldest wsTopics entry.
			p.join(mockWs({ id: 'C' }), 'room', platform);
			// Eviction releases the topic-level entry too. Leaving it behind
			// orphaned durable update fields in every future heartbeat because a
			// later close could no longer find the wsTopics bookkeeping.
			expect(p.count('room')).toBe(2);
			expect(p.list('room').map((u) => u.id)).toEqual(['B', 'C']);
		});

		it('caps presence topics per connection before retaining state', () => {
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0,
				maxTopicsPerConnection: 2,
				maxFieldsBytes: 1024,
				maxTotalFieldsBytes: 100
			});
			const ws = mockWs({ id: 'A' });

			p.join(ws, 'a', platform);
			p.join(ws, 'b', platform);
			p.join(ws, 'c', platform);
			p.update(ws, 'a', { blob: 'a'.repeat(80) }, platform);
			p.update(ws, 'b', { blob: 'b'.repeat(80) }, platform);
			p.update(ws, 'c', { blob: 'c'.repeat(80) }, platform);
			p.flushDiffs();

			expect(p.count('a')).toBe(1);
			expect(p.count('b')).toBe(1);
			expect(p.count('c')).toBe(0);
			expect(ws.isSubscribed('__presence:a')).toBe(true);
			expect(ws.isSubscribed('__presence:b')).toBe(true);
			expect(ws.isSubscribed('__presence:c')).toBe(false);
			// The per-topic cap and the membership cap compose into an aggregate
			// upper bound; a third full-budget entry cannot be retained.
			expect(p.list('a')[0].blob).toBe('a'.repeat(80));
			expect(p.list('b')[0].blob).toBe('b'.repeat(80));
		});

		it('evicts oldest topic when at maxTopics', () => {
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				maxTopics: 2
			});
			const platform = mockPlatform();
			p.join(mockWs({ id: 'A' }), 'a', platform);
			p.join(mockWs({ id: 'B' }), 'b', platform);
			// Adding 'c' evicts 'a' (oldest insertion order).
			p.join(mockWs({ id: 'C' }), 'c', platform);
			expect(p.count('a')).toBe(0);
			expect(p.count('b')).toBe(1);
			expect(p.count('c')).toBe(1);
		});
	});
});

/**
 * A platform that ALSO exposes publishWire / sendWire (production / dev /
 * test-server shape) so the presence plugin's binary routing fires. Records
 * which path each call took, so a test can assert binary vs JSON.
 */
function binaryMockPlatform() {
	const p = {
		published: [],
		sent: [],
		publishedWire: [],
		sentWire: [],
		publish(topic, event, data) { p.published.push({ topic, event, data }); return true; },
		send(ws, topic, event, data) { p.sent.push({ ws, topic, event, data }); return 1; },
		checkSubscribe: async () => null,
		publishWire(topic, event, data, codec, options) { p.publishedWire.push({ topic, event, data, codec, options }); return true; },
		sendWire(ws, topic, event, data, codec, options) { p.sentWire.push({ ws, topic, event, data, codec, options }); return 1; },
		reset() { p.published.length = p.sent.length = p.publishedWire.length = p.sentWire.length = 0; }
	};
	return p;
}

const encodeFrame = (obj) => new TextEncoder().encode(JSON.stringify(obj));

describe('presence plugin - binary wire', () => {
	it('routes state / diff / heartbeat through publishWire / sendWire when the platform supports it', () => {
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, name: ud.name }), heartbeat: 0 });
		const platform = binaryMockPlatform();
		const ws = mockWs({ id: '1', name: 'Alice' });

		presence.join(ws, 'room', platform);
		presence.flushDiffs();

		// state went out via sendWire (not send), carrying the presence codec.
		expect(platform.sent).toHaveLength(0);
		expect(platform.sentWire).toHaveLength(1);
		expect(platform.sentWire[0].event).toBe('state');
		expect(platform.sentWire[0].data).toEqual({ '1': { id: '1', name: 'Alice' } });
		expect(platform.sentWire[0].codec.capability).toBe('presence.protocol:1');

		// diff went out via publishWire (not publish), exactly once.
		expect(platform.published).toHaveLength(0);
		expect(platform.publishedWire).toHaveLength(1);
		expect(platform.publishedWire[0].event).toBe('diff');
		expect(platform.publishedWire[0].data).toEqual({ joins: { '1': { id: '1', name: 'Alice' } }, leaves: {} });
	});

	it('emits a heartbeat through publishWire', async () => {
		vi.useFakeTimers();
		try {
			const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), heartbeat: 1000 });
			const platform = binaryMockPlatform();
			presence.join(mockWs({ id: '1' }), 'room', platform);
			presence.flushDiffs();
			platform.reset();

			vi.advanceTimersByTime(1000);

			const beats = platform.publishedWire.filter((m) => m.event === 'heartbeat');
			expect(beats).toHaveLength(1);
			expect(beats[0].data).toEqual({ '1': { id: '1' } });
			expect(beats[0].codec.capability).toBe('presence.protocol:1');
			presence.clear();
		} finally {
			vi.useRealTimers();
		}
	});

	it('binary:false forces JSON even on a publishWire-capable platform', () => {
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), binary: false });
		const platform = binaryMockPlatform();
		presence.join(mockWs({ id: '1' }), 'room', platform);
		presence.flushDiffs();

		// Everything went the JSON way; the wire methods were never touched.
		expect(platform.publishedWire).toHaveLength(0);
		expect(platform.sentWire).toHaveLength(0);
		expect(platform.sent[0].event).toBe('state');
		expect(platform.published[0].event).toBe('diff');
	});

	it('falls back to JSON on a platform without publishWire / sendWire (the mock)', () => {
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }) });
		const platform = mockPlatform(); // no publishWire / sendWire
		presence.join(mockWs({ id: '1' }), 'room', platform);
		presence.flushDiffs();
		expect(platform.sent[0].event).toBe('state');
		expect(platform.published[0].event).toBe('diff');
	});

	it('opts into compression (compress: true) on its wire calls - presence is low-frequency', () => {
		// Presence frames are infrequent, so they ask the framework to compress
		// them (a cheap bandwidth win). The framework only acts on this when a
		// compressor is configured; the high-frequency cursor path does NOT opt in.
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }) });
		const platform = binaryMockPlatform();
		presence.join(mockWs({ id: '1' }), 'room', platform);   // sends state via sendWire
		presence.flushDiffs();                                   // broadcasts diff via publishWire

		expect(platform.sentWire.every((m) => m.options && m.options.compress === true)).toBe(true);
		expect(platform.publishedWire.every((m) => m.options && m.options.compress === true)).toBe(true);
	});

	it('the binary state path carries only the default identity field', () => {
		const presence = createPresence();
		const platform = binaryMockPlatform();
		presence.join(mockWs({
			id: '1',
			name: 'Alice',
			medicalDiagnosis: 'private',
			rawHeaders: ['authorization', 'Bearer secret', 'cookie', 'sid=secret'],
			avatar: new Uint8Array(8)
		}), 'room', platform);
		presence.flushDiffs();

		const state = platform.sentWire.find((m) => m.event === 'state');
		const entry = state.data['1'];
		expect(entry).toEqual({ id: '1' });
		const payload = encodePresence(state.event, state.data);
		const wire = Buffer.from(payload).toString('latin1');
		expect(wire).not.toContain('private');
		expect(wire).not.toContain('Bearer secret');
		expect(wire).not.toContain('sid=secret');
	});

	it('multi-tab dedup: the encoded roster carries each key once regardless of tab count', () => {
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, name: ud.name }) });
		const platform = binaryMockPlatform();
		// Two connections, same user key '7'.
		presence.join(mockWs({ id: '7', name: 'Sam' }), 'room', platform);
		presence.join(mockWs({ id: '7', name: 'Sam' }), 'room', platform);
		presence.flushDiffs();

		// The second tab is a count bump, not a second roster entry: the wire
		// carries key '7' exactly once on the state snapshot.
		const lastState = platform.sentWire.filter((m) => m.event === 'state').at(-1);
		expect(Object.keys(lastState.data)).toEqual(['7']);
	});
});

describe('presence plugin - hooks.message (reconnect snapshot)', () => {
	it('routes {type:"presence-snapshot", topic} through sync and replies with state', () => {
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id, name: ud.name }) });
		const platform = binaryMockPlatform();

		// Populate a roster from another connection so there is state to reply with.
		presence.join(mockWs({ id: '1', name: 'Alice' }), 'room', platform);
		presence.flushDiffs();
		platform.reset();

		// A reconnecting observer asks for the snapshot.
		const ws = mockWs({ id: '2', name: 'Bob' });
		const handled = presence.hooks.message(ws, { data: encodeFrame({ type: 'presence-snapshot', topic: 'room' }), platform });

		return vi.waitFor(() => {
			expect(handled).toBe(true);
			expect(platform.sentWire).toHaveLength(1);
			expect(platform.sentWire[0].ws).toBe(ws);
			expect(platform.sentWire[0].event).toBe('state');
			expect(platform.sentWire[0].data).toEqual({ '1': { id: '1', name: 'Alice' } });
		});
	});

	it('accepts a pre-parsed envelope via ctx.msg (adapter direct-hook wiring)', () => {
		// The adapter passes the parsed envelope as `msg` (raw bytes in `data`).
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }) });
		const platform = binaryMockPlatform();
		presence.join(mockWs({ id: '1' }), 'room', platform);
		presence.flushDiffs();
		platform.reset();

		const handled = presence.hooks.message(mockWs({ id: '2' }), {
			data: encodeFrame({ type: 'presence-snapshot', topic: 'room' }),
			msg: { type: 'presence-snapshot', topic: 'room' },
			platform
		});
		expect(handled).toBe(true);
		return vi.waitFor(() => expect(platform.sentWire.filter((m) => m.event === 'state')).toHaveLength(1));
	});

	it('accepts an already-parsed object as ctx.data (onUnhandled / onJsonMessage wiring)', () => {
		// svelte-realtime's onJsonMessage and the demo's onUnhandled pass the parsed
		// object as `data` - the shape that the raw-bytes-only version silently dropped.
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }) });
		const platform = binaryMockPlatform();
		presence.join(mockWs({ id: '1' }), 'room', platform);
		presence.flushDiffs();
		platform.reset();

		const handled = presence.hooks.message(mockWs({ id: '2' }), {
			data: { type: 'presence-snapshot', topic: 'room' },
			platform
		});
		expect(handled).toBe(true);
		return vi.waitFor(() => expect(platform.sentWire.filter((m) => m.event === 'state')).toHaveLength(1));
	});

	it('ignores frames it does not own (returns undefined)', () => {
		const presence = createPresence();
		const platform = binaryMockPlatform();
		const ws = mockWs({ id: '1' });

		expect(presence.hooks.message(ws, { data: encodeFrame({ type: 'cursor', topic: 'room' }), platform })).toBeUndefined();
		expect(presence.hooks.message(ws, { data: encodeFrame({ type: 'presence-snapshot' }), platform })).toBeUndefined(); // no topic
		expect(presence.hooks.message(ws, { data: new TextEncoder().encode('not json{'), platform })).toBeUndefined();
		expect(platform.sentWire).toHaveLength(0);
		expect(platform.sent).toHaveLength(0);
	});

	it('replies with JSON state on a platform without sendWire', () => {
		const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }) });
		const platform = mockPlatform();
		presence.join(mockWs({ id: '1' }), 'room', platform);
		presence.flushDiffs();
		platform.reset();

		presence.hooks.message(mockWs({ id: '2' }), { data: encodeFrame({ type: 'presence-snapshot', topic: 'room' }), platform });
		return vi.waitFor(() => {
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('state');
		});
	});
});

describe('presence plugin - field-level update + transient', () => {
	let presence;
	let platform;

	beforeEach(() => {
		presence = createPresence({
			key: 'id',
			select: (ud) => ({ id: ud.id, name: ud.name }),
			transient: ['typing', 'selection'],
			heartbeat: 0
		});
		platform = mockPlatform();
	});

	const lastDiff = () => {
		const diffs = platform.published.filter((e) => e.event === 'diff');
		return diffs.length ? diffs[diffs.length - 1].data : null;
	};

	it('exposes update() on the tracker', () => {
		expect(typeof presence.update).toBe('function');
	});

	it('emits a field-level diff carrying only the changed field', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		presence.update(ws, 'room', { typing: true }, platform);
		presence.flushDiffs();

		expect(platform.published).toHaveLength(1);
		expect(platform.published[0]).toEqual({
			topic: '__presence:room',
			event: 'diff',
			data: { joins: {}, leaves: {}, updates: { '1': { typing: true } } }
		});
	});

	it('no-ops when the field value is unchanged', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		presence.update(ws, 'room', { typing: true }, platform);
		presence.flushDiffs();
		platform.reset();

		presence.update(ws, 'room', { typing: true }, platform); // same value
		presence.flushDiffs();
		expect(platform.published).toHaveLength(0);
	});

	it('no-ops for a connection not present on the topic', () => {
		const ws = mockWs({ id: '1', name: 'Alice' }); // never joined
		presence.update(ws, 'room', { typing: true }, platform);
		presence.flushDiffs();
		expect(platform.published).toHaveLength(0);
	});

	it('coalesces multiple updates in one tick into one diff (union of changed fields)', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		presence.update(ws, 'room', { typing: true }, platform);
		presence.update(ws, 'room', { selection: { start: 1, end: 5 } }, platform);
		presence.flushDiffs();

		expect(platform.published).toHaveLength(1);
		expect(lastDiff().updates).toEqual({ '1': { typing: true, selection: { start: 1, end: 5 } } });
	});

	it('collapses an update into a same-tick join (one join diff, transient excluded, no updates)', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.update(ws, 'room', { typing: true }, platform); // same tick as the join
		presence.flushDiffs();

		const diff = lastDiff();
		expect(diff.joins).toEqual({ '1': { id: '1', name: 'Alice' } }); // no typing in the join
		expect(diff.updates).toBeUndefined();
	});

	it('drops an update that collapses with a same-tick leave', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		presence.update(ws, 'room', { typing: true }, platform);
		presence.leave(ws, platform); // same tick
		presence.flushDiffs();

		const diff = lastDiff();
		expect(diff.updates).toBeUndefined();
		expect(diff.leaves).toEqual({ '1': { id: '1', name: 'Alice' } });
	});

	it('excludes a transient field from the state snapshot a new subscriber receives', async () => {
		const ws1 = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws1, 'room', platform);
		presence.flushDiffs();
		presence.update(ws1, 'room', { typing: true }, platform);
		presence.flushDiffs();
		platform.reset();

		const observer = mockWs({ id: '9', name: 'Obs' });
		await presence.sync(observer, 'room', platform);
		const state = platform.sent.find((s) => s.event === 'state').data;
		expect(state['1']).toEqual({ id: '1', name: 'Alice' }); // NO typing
	});

	it('includes a non-transient update field in the state snapshot (durable)', async () => {
		const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), transient: ['typing'], heartbeat: 0 });
		const plat = mockPlatform();
		const ws = mockWs({ id: '1' });
		p.join(ws, 'room', plat);
		p.flushDiffs();
		p.update(ws, 'room', { status: 'away' }, plat); // not transient
		p.flushDiffs();
		plat.reset();

		const obs = mockWs({ id: '9' });
		await p.sync(obs, 'room', plat);
		const state = plat.sent.find((s) => s.event === 'state').data;
		expect(state['1']).toEqual({ id: '1', status: 'away' }); // durable field present
	});

	it('a pure join/leave deployment is unaffected: the diff stays { joins, leaves }', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		expect(lastDiff()).toEqual({ joins: { '1': { id: '1', name: 'Alice' } }, leaves: {} });
		expect('updates' in lastDiff()).toBe(false);
	});

	it('an update applies to the user, so a second tab sees it (per dedup key)', () => {
		const tabA = mockWs({ id: '1', name: 'Alice' });
		const tabB = mockWs({ id: '1', name: 'Alice' }); // same user, second tab
		presence.join(tabA, 'room', platform);
		presence.join(tabB, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		// Either tab can set the field; it targets the shared per-key user.
		presence.update(tabB, 'room', { typing: true }, platform);
		presence.flushDiffs();
		expect(lastDiff().updates).toEqual({ '1': { typing: true } });
	});
});

describe('presence plugin - client presence-update message frame', () => {
	let presence;
	let platform;

	beforeEach(() => {
		presence = createPresence({
			key: 'id',
			select: (ud) => ({ id: ud.id, name: ud.name }),
			transient: ['typing', 'selection'],
			clientUpdateFields: ['typing', 'selection'],
			heartbeat: 0
		});
		platform = mockPlatform();
	});

	const lastDiff = () => {
		const diffs = platform.published.filter((e) => e.event === 'diff');
		return diffs.length ? diffs[diffs.length - 1].data : null;
	};

	it('routes an inbound presence-update frame to update() and broadcasts the field diff', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		const handled = presence.hooks.message(ws, {
			data: { type: 'presence-update', topic: 'room', fields: { typing: true } },
			platform
		});
		presence.flushDiffs();

		expect(handled).toBe(true);
		expect(lastDiff().updates).toEqual({ '1': { typing: true } });
	});

	it('resolves the frame from raw JSON bytes as well as a parsed object', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		const bytes = new TextEncoder().encode(
			JSON.stringify({ type: 'presence-update', topic: 'room', fields: { selection: { start: 1, end: 5 } } })
		);
		const handled = presence.hooks.message(ws, { data: bytes, platform });
		presence.flushDiffs();

		expect(handled).toBe(true);
		expect(lastDiff().updates).toEqual({ '1': { selection: { start: 1, end: 5 } } });
	});

	it('claims the frame but is a no-op for a connection that has not joined the topic', () => {
		const ws = mockWs({ id: '9', name: 'Nomad' }); // never joined
		const handled = presence.hooks.message(ws, {
			data: { type: 'presence-update', topic: 'room', fields: { typing: true } },
			platform
		});
		presence.flushDiffs();

		// update() self-gates on membership: the frame is claimed, but no diff fires.
		expect(handled).toBe(true);
		expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
	});

	it('ignores a malformed presence-update frame with no fields', () => {
		const ws = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws, 'room', platform);
		presence.flushDiffs();
		platform.reset();

		const handled = presence.hooks.message(ws, {
			data: { type: 'presence-update', topic: 'room' },
			platform
		});
		presence.flushDiffs();

		expect(handled).toBeUndefined();
		expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
	});

	it('accepts no client-owned fields when clientUpdateFields is omitted', () => {
		const failClosed = createPresence({ heartbeat: 0 });
		const ws = mockWs({ id: '1', name: 'Alice' });
		const nestedToJSON = vi.fn(() => { throw new Error('must not be serialized'); });
		const rawHeadersGetter = vi.fn(() => { throw new Error('must not be read'); });
		const fields = {
			status: 'away',
			profile: { medicalDiagnosis: 'private', toJSON: nestedToJSON }
		};
		Object.defineProperty(fields, 'rawHeaders', {
			enumerable: true,
			get: rawHeadersGetter
		});
		failClosed.join(ws, 'room', platform);
		failClosed.flushDiffs();
		platform.reset();

		const handled = failClosed.hooks.message(ws, {
			data: {
				type: 'presence-update',
				topic: 'room',
				fields
			},
			platform
		});
		failClosed.flushDiffs();

		expect(handled).toBe(true);
		expect(nestedToJSON).not.toHaveBeenCalled();
		expect(rawHeadersGetter).not.toHaveBeenCalled();
		expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
		expect(failClosed.list('room')).toEqual([{ id: '1' }]);
	});
});

describe('presence plugin - security hardening', () => {
	let platform;

	beforeEach(() => {
		platform = mockPlatform();
	});

	const lastDiff = () => {
		const diffs = platform.published.filter((e) => e.event === 'diff');
		return diffs.length ? diffs[diffs.length - 1].data : null;
	};

	describe('dedup key prototype-gadget names (roster ghost)', () => {
		it('joins a user whose id is "__proto__" under the fallback key - visible in every roster', () => {
			const presence = createPresence({ heartbeat: 0 }); // default select, key 'id'
			const victim = mockWs({ id: 'victim', name: 'Vera' });
			const ghost = mockWs({ id: '__proto__', name: 'Ghost' });

			presence.join(victim, 'room', platform);
			presence.join(ghost, 'room', platform);
			presence.flushDiffs();

			// Server-side truth: two distinct users.
			expect(presence.count('room')).toBe(2);
			// The ghost must be a visible own key in every roster frame, not the
			// object's prototype. The resolved key is refused, so the ghost rides
			// the per-connection fallback key (no cross-tab dedup).
			const state = platform.sent.find((s) => s.event === 'state' && s.ws === ghost).data;
			expect(Object.keys(state)).toContain('victim');
			expect(Object.keys(state).some((k) => k.startsWith('__conn:'))).toBe(true);
			// And the JSON wire form carries the ghost too (JSON.stringify only
			// emits own enumerable properties).
			const wireKeys = Object.keys(JSON.parse(JSON.stringify(state)));
			expect(wireKeys).toEqual(Object.keys(state));
			// The diff joins roster is null-prototype: no inherited __proto__ setter.
			const diff = lastDiff();
			expect(Object.getPrototypeOf(diff.joins)).toBeNull();
			expect(Object.getPrototypeOf(diff.leaves)).toBeNull();
		});

		it('refuses "constructor" and "prototype" as resolved keys the same way', () => {
			const presence = createPresence({ heartbeat: 0 });
			for (const id of ['constructor', 'prototype']) {
				const ws = mockWs({ id, name: 'N' });
				presence.join(ws, 'room-' + id, platform);
				const state = platform.sent.find((s) => s.event === 'state' && s.ws === ws).data;
				expect(Object.keys(state)).toHaveLength(1);
				expect(Object.keys(state)[0].startsWith('__conn:')).toBe(true);
				expect(presence.count('room-' + id)).toBe(1);
			}
		});

		it('a key field value that is not a gadget still dedups normally', () => {
			const presence = createPresence({ heartbeat: 0 });
			presence.join(mockWs({ id: '7', name: 'Sam' }), 'room', platform);
			presence.join(mockWs({ id: '7', name: 'Sam' }), 'room', platform);
			expect(presence.count('room')).toBe(1);
		});
	});

	describe('update() byte caps', () => {
		it('drops an update whose serialized fields exceed maxFieldsBytes (default 8192)', async () => {
			const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), heartbeat: 0 });
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.update(ws, 'room', { blob: 'A'.repeat(9000) }, platform);
			presence.flushDiffs();

			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
			// Nothing stored: a later snapshot carries the bare identity.
			const obs = mockWs({ id: '9' });
			await presence.sync(obs, 'room', platform);
			expect(platform.sent.find((s) => s.event === 'state').data['1']).toEqual({ id: '1' });
		});

		it('honors a custom maxFieldsBytes', () => {
			const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), heartbeat: 0, maxFieldsBytes: 64 });
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.update(ws, 'room', { typing: true }, platform); // ~16 bytes - under
			presence.update(ws, 'room', { blob: 'A'.repeat(100) }, platform); // over 64 - dropped
			presence.flushDiffs();

			expect(lastDiff().updates).toEqual({ '1': { typing: true } });
		});

		it('enforces the cumulative per-entry budget (maxTotalFieldsBytes) across frames', async () => {
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0,
				maxFieldsBytes: 1024,
				maxTotalFieldsBytes: 100
			});
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			// Each frame is under the per-frame cap; together they exceed the budget.
			presence.update(ws, 'room', { a: 'A'.repeat(60) }, platform); // stored (~63 bytes)
			presence.update(ws, 'room', { b: 'B'.repeat(60) }, platform); // would exceed 100 - dropped whole
			presence.flushDiffs();

			expect(lastDiff().updates).toEqual({ '1': { a: 'A'.repeat(60) } });
			const obs = mockWs({ id: '9' });
			await presence.sync(obs, 'room', platform);
			const data = platform.sent.find((s) => s.event === 'state').data['1'];
			expect(data.a).toBe('A'.repeat(60));
			expect(data.b).toBeUndefined();
		});

		it('charges a field name at its SERIALIZED size, not its raw size', async () => {
			// A control character is one byte raw and six once JSON-escaped, and the
			// escaped form is what is stored and re-broadcast on every snapshot and
			// heartbeat. Charging the raw name let a client buy roughly six times
			// the documented budget in retained, re-broadcast state while every
			// individual frame stayed under the per-frame cap.
			//
			// Each name here is one control character plus a digit. Raw that is 2
			// bytes, so the old charge was 2 + 2 framing + 1 value = 5, and ten of
			// them fit a 100-byte budget with room to spare. Serialized, the name is
			// 7 characters and 9 bytes with its quotes, so the real cost is 12 and the
			// budget is exhausted before the tenth. The character is built with
			// fromCharCode rather than an escape so the source file itself stays
			// plain ASCII.
			const ctl = String.fromCharCode(1);
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0,
				maxFieldsBytes: 1024,
				maxTotalFieldsBytes: 100
			});
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			for (let i = 0; i < 10; i++) {
				presence.update(ws, 'room', { [ctl + i]: 0 }, platform);
			}
			presence.flushDiffs();

			const obs = mockWs({ id: '9' });
			await presence.sync(obs, 'room', platform);
			const stored = platform.sent.find((s) => s.event === 'state').data['1'];
			const storedNames = Object.keys(stored).filter((k) => k !== 'id');
			const serializedBytes = storedNames.reduce(
				(sum, k) => sum + Buffer.byteLength(JSON.stringify(k)) + 2 + 1,
				0
			);

			expect(storedNames.length, 'a raw charge would have accepted all ten').toBeLessThan(10);
			expect(
				serializedBytes,
				'retained serialized state must stay within the documented budget'
			).toBeLessThanOrEqual(100);
		});

		it('shrinking an existing field refunds the budget', async () => {
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0,
				maxFieldsBytes: 1024,
				maxTotalFieldsBytes: 100
			});
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			presence.update(ws, 'room', { a: 'A'.repeat(60) }, platform);
			presence.update(ws, 'room', { a: 'x' }, platform); // shrink: frees ~60 bytes
			presence.update(ws, 'room', { b: 'B'.repeat(60) }, platform); // now fits
			presence.flushDiffs();

			const obs = mockWs({ id: '9' });
			await presence.sync(obs, 'room', platform);
			const data = platform.sent.find((s) => s.event === 'state' && s.ws === obs).data['1'];
			expect(data.a).toBe('x');
			expect(data.b).toBe('B'.repeat(60));
		});

		it('drops an unserializable (cyclic) fields blob without throwing', () => {
			const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), heartbeat: 0 });
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			const cyclic = { ok: 1 };
			cyclic.self = cyclic;
			expect(() => presence.update(ws, 'room', cyclic, platform)).not.toThrow();
			presence.flushDiffs();
			expect(platform.published.filter((e) => e.event === 'diff')).toHaveLength(0);
		});

		it('validates the new options like the existing caps', () => {
			expect(() => createPresence({ maxFieldsBytes: 0 })).toThrow('maxFieldsBytes must be a positive integer');
			expect(() => createPresence({ maxTotalFieldsBytes: -1 })).toThrow('maxTotalFieldsBytes must be a positive integer');
		});
	});

	describe('deepEqual depth cap (deep-nesting DoS)', () => {
		const deepArray = (depth, leaf) => {
			let v = leaf;
			for (let i = 0; i < depth; i++) v = [v];
			return v;
		};

		// THE DEPTH IS LOAD-BEARING, and too deep is as useless as too shallow.
		// Past roughly 4800 levels the serialization update() runs BEFORE it
		// compares overflows on its own and the update returns early; a raw frame
		// beyond the 8192-byte field cap is refused earlier still. Either way the
		// guard under test never executes, so a wrong-magnitude vector passes
		// against broken code. 4000 clears both of those gates (about 8060 frame
		// bytes, 8009 serialized).
		const DEPTH = 4000;

		it('drops a client field nested deeper than the cap, rather than storing it', async () => {
			// A byte cap does not bound depth: DEPTH here is about 8 KB, well
			// inside the default field cap, and roughly twice as deep as the
			// structuredClone limit the cluster relay serializes through. Stored,
			// it would terminate the worker on the next relayed publish - a much
			// worse outcome than a dropped frame, and one no byte cap can prevent.
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0,
				maxFieldsBytes: 100_000, // lift the byte cap so DEPTH is what decides
				maxTotalFieldsBytes: 1_000_000
			});
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			expect(() => {
				presence.update(ws, 'room', { sel: deepArray(DEPTH, 1) }, platform);
			}).not.toThrow();

			presence.flushDiffs();
			const obs = mockWs({ id: '9' });
			await presence.sync(obs, 'room', platform);
			const stored = platform.sent.find((s) => s.event === 'state' && s.ws === obs).data['1'];
			expect(
				stored.sel,
				'a value too deep to relay must never be stored, or the next publish kills the worker'
			).toBeUndefined();
		});

		it('still compares an ordinary nested value and counts it as changed', () => {
			// The counterpart: the depth guard must not have turned every nested
			// field into a silent drop. This depth is unremarkable and must be
			// stored, compared, and reported as a change.
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id }),
				heartbeat: 0
			});
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			const before = platform.published.filter((e) => e.event === 'diff').length;

			presence.update(ws, 'room', { sel: deepArray(8, 1) }, platform);
			presence.update(ws, 'room', { sel: deepArray(8, 2) }, platform);
			presence.flushDiffs();

			expect(
				platform.published.filter((e) => e.event === 'diff').length,
				'an ordinary nested value must still be processed'
			).toBeGreaterThan(before);
		});

		it('drops the same frame arriving as raw wire bytes', async () => {
			// The real entry point a client reaches, not the helper: the depth
			// guard has to sit where the frame lands, not only where a test calls
			// update() directly.
			const presence = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), heartbeat: 0 });
			const ws = mockWs({ id: '1' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			// Built as text: JSON.stringify of the live object is itself recursive.
			const frame = (leaf) =>
				new TextEncoder().encode(
					'{"type":"presence-update","topic":"room","fields":{"sel":' + '['.repeat(DEPTH) + leaf + ']'.repeat(DEPTH) + '}}'
				);
			expect(() => {
				presence.hooks.message(ws, { data: frame(1), platform });
			}).not.toThrow();

			presence.flushDiffs();
			const obs = mockWs({ id: '9' });
			await presence.sync(obs, 'room', platform);
			const stored = platform.sent.find((s) => s.event === 'state' && s.ws === obs).data['1'];
			expect(
				stored.sel,
				'a value too deep to relay must not be stored, however it arrived'
			).toBeUndefined();
		});
	});

	describe('reserved-field warning is bounded', () => {
		it('warns once for a finite reserved name, never twice', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const p = createPresence({ key: 'id', heartbeat: 0 });
				const ws = mockWs({ id: 'u-1' });
				p.join(ws, 'room', platform);
				p.update(ws, 'room', { role: 'admin' }, platform);
				p.update(ws, 'room', { role: 'owner' }, platform);
				const roleWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("'role'"));
				expect(roleWarnings).toHaveLength(1);
			} finally {
				warn.mockRestore();
			}
		});

		it('never warns for the unbounded credential-shaped name space', () => {
			// A hostile client can mint distinct matching names forever; warning
			// on those would drive an unbounded log and an unbounded dedup set
			// straight from the wire.
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const p = createPresence({ key: 'id', heartbeat: 0 });
				const ws = mockWs({ id: 'u-1' });
				p.join(ws, 'room', platform);
				for (let i = 0; i < 200; i++) {
					p.update(ws, 'room', { [`f${i}Token`]: 'x', [`__x${i}`]: 'y' }, platform);
				}
				expect(warn.mock.calls.filter((c) => String(c[0]).includes('presence.update()'))).toHaveLength(0);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe('default select input complexity', () => {
		it('does not throw on a pathologically nested userData', () => {
			let deep = {};
			const root = deep;
			for (let i = 0; i < 100_000; i++) { deep.n = {}; deep = deep.n; }
			const p = createPresence({ key: 'id', heartbeat: 0 });

			expect(() => p.join(mockWs({ id: 'u-1', bio: root }), 'room', platform)).not.toThrow();
			expect(p.list('room')[0].id).toBe('u-1');
		});

		it('does not project normally-nested profile data without an explicit select', () => {
			const p = createPresence({ key: 'id', heartbeat: 0 });
			p.join(mockWs({ id: 'u-1', a: { b: { c: { d: 'deep enough' } } } }), 'room', platform);
			expect(p.list('room')[0]).toEqual({ id: 'u-1' });
		});
	});

	describe('list() matches the wire snapshot', () => {
		it('includes durable update() fields, so SSR and the first snapshot agree', async () => {
			const p = createPresence({ key: 'id', heartbeat: 0 });
			const ws = mockWs({ id: 'u-1', name: 'Ada' });
			p.join(ws, 'room', platform);
			p.update(ws, 'room', { typing: true }, platform);
			p.flushDiffs();
			platform.reset();

			await p.sync(mockWs({ id: 'observer' }), 'room', platform);
			const snapshotEntry = platform.sent[0].data['u-1'];

			expect(p.list('room')[0]).toEqual(snapshotEntry);
			expect(p.list('room')[0].typing).toBe(true);
		});

		it('excludes transient fields, exactly as the snapshot does', () => {
			const p = createPresence({ key: 'id', heartbeat: 0, transient: ['typing'] });
			const ws = mockWs({ id: 'u-1', name: 'Ada' });
			p.join(ws, 'room', platform);
			p.update(ws, 'room', { typing: true, mood: 'calm' }, platform);
			p.flushDiffs();

			const entry = p.list('room')[0];
			expect(entry.typing).toBeUndefined();
			expect(entry.mood).toBe('calm');
		});

		it('still returns deep copies the caller cannot use to mutate plugin state', () => {
			const p = createPresence({ key: 'id', heartbeat: 0 });
			const ws = mockWs({ id: 'u-1' });
			p.join(ws, 'room', platform);
			p.update(ws, 'room', { nested: { n: 1 } }, platform);

			p.list('room')[0].nested.n = 999;
			expect(p.list('room')[0].nested.n).toBe(1);
		});
	});

	describe('a credential-shaped dedup key is never broadcast', () => {
		// The resolved dedup key is not just stored - it IS the roster map key
		// in every wire frame. Exempting it from the denylist so dedup keeps
		// working would publish the secret to every peer, twice over. The
		// denylist wins; the app is warned instead.

		it('drops a credential-shaped key field and warns instead of broadcasting it', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const p = createPresence({ key: 'sessionId', heartbeat: 0 });
				expect(warn.mock.calls.some((c) => String(c[0]).includes("key field 'sessionId'"))).toBe(true);

				p.join(mockWs({ sessionId: 'sess_SUPER_SECRET', name: 'Ada' }), 'room', platform);
				p.join(mockWs({ sessionId: 'sess_SUPER_SECRET', name: 'Ada' }), 'room', platform);

				// Dedup falls back to per-connection entries ...
				expect(p.count('room')).toBe(2);
				// ... and the secret appears nowhere: not in the entry, and not
				// as the roster key either.
				const frames = JSON.stringify(platform.sent) + JSON.stringify(platform.published) + JSON.stringify(p.list('room'));
				expect(frames.includes('sess_SUPER_SECRET')).toBe(false);
			} finally {
				warn.mockRestore();
			}
		});

		it('does not warn for an ordinary key field', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				createPresence({ key: 'id', heartbeat: 0 });
				createPresence({ key: 'userKey', heartbeat: 0 }); // an identifier, not a credential name
				expect(warn.mock.calls.some((c) => String(c[0]).includes('key field'))).toBe(false);
			} finally {
				warn.mockRestore();
			}
		});

		it('an explicit select is the escape hatch and is not second-guessed', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const p = createPresence({ key: 'sessionId', heartbeat: 0, select: (ud) => ({ sessionId: ud.sessionId }) });
				expect(warn.mock.calls.some((c) => String(c[0]).includes('key field'))).toBe(false);
				p.join(mockWs({ sessionId: 's-1' }), 'room', platform);
				p.join(mockWs({ sessionId: 's-1' }), 'room', platform);
				expect(p.count('room')).toBe(1);
			} finally {
				warn.mockRestore();
			}
		});

		it('a plain userKey is an identifier and dedups normally', () => {
			const p = createPresence({ key: 'userKey', heartbeat: 0 });
			p.join(mockWs({ userKey: 'u-42', name: 'Ada' }), 'room', platform);
			p.join(mockWs({ userKey: 'u-42', name: 'Ada' }), 'room', platform);

			expect(p.count('room')).toBe(1);
			expect(p.list('room')[0].userKey).toBe('u-42');
		});

		it('still reserves the key field against client updates', () => {
			const p = createPresence({ key: 'id', heartbeat: 0 });
			const ws = mockWs({ id: 'u-1', name: 'Ada' });
			p.join(ws, 'room', platform);
			p.flushDiffs();
			platform.reset();

			p.update(ws, 'room', { id: 'u-victim', typing: true }, platform);
			p.flushDiffs();

			const diff = platform.published.find((e) => e.event === 'diff');
			expect(diff.data.updates['u-1']).toEqual({ typing: true });
		});
	});

	describe('client update reserved-fields guard (identity impersonation)', () => {
		it('an explicit client allowlist cannot write unlisted identity or credential fields', async () => {
			const presence = createPresence({
				heartbeat: 0,
				select: (ud) => ({ id: ud.id, role: ud.role, name: ud.name }),
				clientUpdateFields: ['name', 'typing']
			});
			const ws = mockWs({ id: 'mallory', role: 'user', name: 'Mallory' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			const handled = presence.hooks.message(ws, {
				data: {
					type: 'presence-update',
					topic: 'room',
					fields: { role: 'admin', id: 'root', name: 'System', sessionToken: 'x', typing: true }
				},
				platform
			});
			presence.flushDiffs();

			expect(handled).toBe(true);
			// Only the non-reserved fields are broadcast.
			expect(lastDiff().updates).toEqual({ mallory: { name: 'System', typing: true } });
			// A late joiner's snapshot keeps the server-selected identity.
			platform.reset();
			await presence.sync(mockWs({ id: 'observer' }), 'room', platform);
			const wire = platform.sent.find((s) => s.event === 'state').data.mallory;
			expect(wire.id).toBe('mallory');
			expect(wire.role).toBe('user');
			expect(wire.name).toBe('System'); // name is not reserved - app choice
			expect(wire.sessionToken).toBeUndefined();
		});

		it('strips the custom dedup key field too', () => {
			const presence = createPresence({ key: 'userId', heartbeat: 0 });
			const ws = mockWs({ userId: 'u-1', name: 'A' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.update(ws, 'room', { userId: 'u-2', typing: true }, platform);
			presence.flushDiffs();

			expect(lastDiff().updates).toEqual({ 'u-1': { typing: true } });
		});

		it('clientUpdateFields allowlist accepts ONLY the listed fields', () => {
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id, name: ud.name }),
				heartbeat: 0,
				clientUpdateFields: ['typing', 'selection']
			});
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.update(ws, 'room', { typing: true, status: 'away', role: 'admin' }, platform);
			presence.flushDiffs();

			expect(lastDiff().updates).toEqual({ '1': { typing: true } });
		});

		it('clientUpdateFields is the escape hatch for a deliberately client-writable reserved name', () => {
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id, role: ud.role }),
				heartbeat: 0,
				clientUpdateFields: ['role']
			});
			const ws = mockWs({ id: '1', role: 'user' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.update(ws, 'room', { role: 'moderator' }, platform);
			presence.flushDiffs();

			expect(lastDiff().updates).toEqual({ '1': { role: 'moderator' } });
		});

		it('the documented self-update flow is unaffected (typing / selection / status pass)', () => {
			const presence = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id, name: ud.name }),
				transient: ['typing'],
				heartbeat: 0
			});
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			presence.update(ws, 'room', { typing: true, selection: { start: 1, end: 5 }, status: 'away' }, platform);
			presence.flushDiffs();

			expect(lastDiff().updates).toEqual({
				'1': { typing: true, selection: { start: 1, end: 5 }, status: 'away' }
			});
		});
	});
});
