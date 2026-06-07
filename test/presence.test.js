import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPresence } from '../plugins/presence/server.js';
import { encodePresence } from '../plugins/presence/codec.js';
import { mockWs, mockPlatform } from './_helpers.js';

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
			vi.advanceTimersByTime(1);

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
		it('sends state snapshot without joining', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const wsObserver = mockWs({ id: 'admin', name: 'Admin' });

			presence.join(ws1, 'room', platform);
			platform.sent.length = 0;

			presence.sync(wsObserver, 'room', platform);

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

		it('sends empty snapshot for unknown topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.sync(ws, 'nonexistent', platform);

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('state');
			expect(platform.sent[0].data).toEqual({});
		});

		it('keeps an observer subscribed after a co-resident participant role leaves (dual-role teardown)', () => {
			// One socket is BOTH a participant (join) and a sync-observer (sync) of
			// the same topic. Dropping the participant role must NOT evict the
			// observer's tap subscription - otherwise its roster freezes with the
			// departed user still shown.
			const dual = mockWs({ id: 'dual', name: 'Dual' });
			presence.join(dual, 'room', platform);
			presence.sync(dual, 'room', platform);
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

		it('hooks.subscribe sends current snapshot for __presence: topics', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);
			presence.flushDiffs();
			platform.reset();

			const wsObserver = mockWs({ id: 'obs', name: 'Observer' });
			presence.hooks.subscribe(wsObserver, '__presence:room', { platform });

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

		it('hooks.subscribe sends empty snapshot for __presence: with no users', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, '__presence:empty', { platform });

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

	describe('default select strips known-sensitive fields (denylist)', () => {
		it('drops token / secret / password / auth / session / cookie / jwt / credential keys', () => {
			const p = createPresence({ key: 'id' });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				color: 'red',
				sessionToken: 'bearer-abc',
				PASSWORD: 'hunter2',
				apiSecret: 'shh',
				authHeader: 'Basic xxx',
				csrfCookie: 'c',
				idToken: 'jwt-xyz',
				userCredential: 'pkcs',
				role: 'admin'
			});

			p.join(ws, 'room', platform);
			p.flushDiffs();

			const stateData = platform.sent[0].data['1'];
			// id/name/color/role pass through (denylist allows non-matching keys)
			expect(stateData.id).toBe('1');
			expect(stateData.name).toBe('Alice');
			expect(stateData.color).toBe('red');
			expect(stateData.role).toBe('admin');
			// sensitive keys are stripped
			expect(stateData.sessionToken).toBeUndefined();
			expect(stateData.PASSWORD).toBeUndefined();
			expect(stateData.apiSecret).toBeUndefined();
			expect(stateData.authHeader).toBeUndefined();
			expect(stateData.csrfCookie).toBeUndefined();
			expect(stateData.idToken).toBeUndefined();
			expect(stateData.userCredential).toBeUndefined();
		});

		it('drops __-prefixed keys (defense against proto pollution + internal markers)', () => {
			const p = createPresence({ key: 'id' });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				__subscriptions: new Set(['room']),
				__remoteAddress: '203.0.113.1'
			});

			p.join(ws, 'room', platform);

			const stateData = platform.sent[0].data['1'];
			expect(stateData.id).toBe('1');
			expect(stateData.name).toBe('Alice');
			expect(stateData.__subscriptions).toBeUndefined();
			expect(stateData.__remoteAddress).toBeUndefined();
		});

		it('drops constructor and prototype as own properties', () => {
			const p = createPresence({ key: 'id' });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				constructor: 'evil',
				prototype: 'also evil'
			});

			p.join(ws, 'room', platform);

			const stateData = platform.sent[0].data['1'];
			expect(Object.prototype.hasOwnProperty.call(stateData, 'constructor')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(stateData, 'prototype')).toBe(false);
			expect(stateData.id).toBe('1');
			expect(stateData.name).toBe('Alice');
		});

		it('strips sensitive keys recursively (nested objects)', () => {
			const p = createPresence({ key: 'id' });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				profile: {
					avatar: 'a.png',
					sessionToken: 'inner-bearer',
					nested: { password: 'inner-secret', visible: 'ok' }
				}
			});

			p.join(ws, 'room', platform);

			const stateData = platform.sent[0].data['1'];
			expect(stateData.profile.avatar).toBe('a.png');
			expect(stateData.profile.sessionToken).toBeUndefined();
			expect(stateData.profile.nested.password).toBeUndefined();
			expect(stateData.profile.nested.visible).toBe('ok');
		});

		it('substitutes binary views with a length placeholder', () => {
			const p = createPresence({ key: 'id' });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				avatar: Buffer.from([0xde, 0xad, 0xbe, 0xef])
			});

			p.join(ws, 'room', platform);

			const stateData = platform.sent[0].data['1'];
			expect(stateData.avatar).toBe('[bytes: 4]');
		});

		it('walks arrays element-by-element', () => {
			const p = createPresence({ key: 'id' });
			const ws = mockWs({
				id: '1',
				name: 'Alice',
				tags: ['admin', { name: 'role', token: 'strip-me' }, 'beta']
			});

			p.join(ws, 'room', platform);

			const stateData = platform.sent[0].data['1'];
			expect(stateData.tags).toEqual(['admin', { name: 'role' }, 'beta']);
		});

		it('does not blow the stack on cyclic userData', () => {
			const p = createPresence({ key: 'id' });
			const ud = { id: '1', name: 'Alice' };
			ud.self = ud;
			const ws = mockWs(ud);

			expect(() => p.join(ws, 'room', platform)).not.toThrow();
			const stateData = platform.sent[0].data['1'];
			expect(stateData.id).toBe('1');
			expect(stateData.name).toBe('Alice');
		});

		it('explicit select still wins - default does not interfere', () => {
			const p = createPresence({
				key: 'id',
				select: (ud) => ({ id: ud.id, color: ud.color })
			});
			const ws = mockWs({ id: '1', name: 'Alice', color: 'red', sessionToken: 'bypassed-by-explicit' });

			p.join(ws, 'room', platform);

			// Explicit select: returns only what the user asked for, regardless of denylist
			expect(platform.sent[0].data['1']).toEqual({ id: '1', color: 'red' });
		});

		it('returns a plain object when userData is empty', () => {
			const p = createPresence();
			const ws = mockWs({});

			expect(() => p.join(ws, 'room', platform)).not.toThrow();
			const state = platform.sent[0].data;
			const onlyKey = Object.keys(state)[0];
			expect(onlyKey.startsWith('__conn:')).toBe(true);
			expect(state[onlyKey]).toEqual({});
		});

		it('opt-back-in pattern: select: (ud) => ud restores pre-this-default passthrough', () => {
			const p = createPresence({ key: 'id', select: (ud) => ud });
			const ws = mockWs({ id: '1', name: 'Alice', sessionToken: 'now-leaks' });

			p.join(ws, 'room', platform);

			expect(platform.sent[0].data['1'].sessionToken).toBe('now-leaks');
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
		it('rejects invalid maxConnections / maxTopics', () => {
			expect(() => createPresence({ maxConnections: 0 })).toThrow('maxConnections must be a positive integer');
			expect(() => createPresence({ maxTopics: -1 })).toThrow('maxTopics must be a positive integer');
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
			// All three users are still tracked in the topic-level map,
			// since eviction is connection-scoped (the per-ws bookkeeping)
			// not topic-scoped (the per-user roster).
			expect(p.count('room')).toBe(3);
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

	it('the binary path never carries denied / credential fields (select runs before encode)', () => {
		// Default select drops credential-looking keys and substitutes binary views;
		// the codec only ever sees post-select data, so nothing sensitive can reach
		// the wire even on the binary path.
		const presence = createPresence(); // default select (denylist)
		const platform = binaryMockPlatform();
		presence.join(mockWs({ id: '1', name: 'Alice', sessionToken: 'secret-abc', avatar: new Uint8Array(8) }), 'room', platform);
		presence.flushDiffs();

		const state = platform.sentWire.find((m) => m.event === 'state');
		const entry = state.data['1'];
		expect('sessionToken' in entry).toBe(false);
		expect(entry.avatar).toBe('[bytes: 8]');
		// And the actual encoded bytes carry no credential.
		const payload = encodePresence(state.event, state.data);
		expect(Buffer.from(payload).toString('latin1')).not.toContain('secret-abc');
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

		expect(handled).toBe(true);
		expect(platform.sentWire).toHaveLength(1);
		expect(platform.sentWire[0].ws).toBe(ws);
		expect(platform.sentWire[0].event).toBe('state');
		expect(platform.sentWire[0].data).toEqual({ '1': { id: '1', name: 'Alice' } });
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
		expect(platform.sentWire.filter((m) => m.event === 'state')).toHaveLength(1);
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
		expect(platform.sentWire.filter((m) => m.event === 'state')).toHaveLength(1);
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
		expect(platform.sent).toHaveLength(1);
		expect(platform.sent[0].event).toBe('state');
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

	it('excludes a transient field from the state snapshot a new subscriber receives', () => {
		const ws1 = mockWs({ id: '1', name: 'Alice' });
		presence.join(ws1, 'room', platform);
		presence.flushDiffs();
		presence.update(ws1, 'room', { typing: true }, platform);
		presence.flushDiffs();
		platform.reset();

		const observer = mockWs({ id: '9', name: 'Obs' });
		presence.sync(observer, 'room', platform);
		const state = platform.sent.find((s) => s.event === 'state').data;
		expect(state['1']).toEqual({ id: '1', name: 'Alice' }); // NO typing
	});

	it('includes a non-transient update field in the state snapshot (durable)', () => {
		const p = createPresence({ key: 'id', select: (ud) => ({ id: ud.id }), transient: ['typing'], heartbeat: 0 });
		const plat = mockPlatform();
		const ws = mockWs({ id: '1' });
		p.join(ws, 'room', plat);
		p.flushDiffs();
		p.update(ws, 'room', { status: 'away' }, plat); // not transient
		p.flushDiffs();
		plat.reset();

		const obs = mockWs({ id: '9' });
		p.sync(obs, 'room', plat);
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
