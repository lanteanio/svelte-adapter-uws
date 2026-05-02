import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPresence } from '../plugins/presence/server.js';
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
		it('adds user to presence and sends presence_state snapshot to joining client', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			presence.flushDiffs();

			// Should send full snapshot to the joining client
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__presence:room');
			expect(platform.sent[0].event).toBe('presence_state');
			expect(platform.sent[0].data).toEqual({
				'1': { id: '1', name: 'Alice' }
			});

			// Diff publishes the join to the topic. The joining ws is
			// subscribed by then, but the client's presence store is
			// idempotent on receiving its own join.
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('presence_diff');
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

		it('broadcasts presence_diff for new users', () => {
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
				event: 'presence_diff',
				data: { joins: { '2': { id: '2', name: 'Bob' } }, leaves: {} }
			});

			// Should send full snapshot to Bob
			expect(platform.sent).toHaveLength(1);
			expect(Object.keys(platform.sent[0].data)).toHaveLength(2);
		});

		it('coalesces multiple joins in one tick into a single presence_diff', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			const ws3 = mockWs({ id: '3', name: 'Carol' });

			presence.join(ws1, 'room', platform);
			presence.join(ws2, 'room', platform);
			presence.join(ws3, 'room', platform);
			presence.flushDiffs();

			const diffs = platform.published.filter(p => p.event === 'presence_diff');
			expect(diffs).toHaveLength(1);
			expect(diffs[0].data.joins).toEqual({
				'1': { id: '1', name: 'Alice' },
				'2': { id: '2', name: 'Bob' },
				'3': { id: '3', name: 'Carol' }
			});
			expect(diffs[0].data.leaves).toEqual({});
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

		it('closing last tab publishes presence_diff with leaves', () => {
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
			expect(platform.published[0].event).toBe('presence_diff');
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
				event: 'presence_diff',
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
			expect(platform.published[0].event).toBe('presence_diff');
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
			expect(platform.published[0].event).toBe('presence_diff');
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
			expect(platform.published[0].event).toBe('presence_diff');
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

		it('broadcasts a presence_diff with leaves for each topic', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room-a', platform);
			presence.join(ws, 'room-b', platform);
			presence.flushDiffs();
			platform.published.length = 0;

			presence.leave(ws, platform);
			presence.flushDiffs();

			const diffs = platform.published.filter(e => e.event === 'presence_diff');
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
		it('sends presence_state snapshot without joining', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const wsObserver = mockWs({ id: 'admin', name: 'Admin' });

			presence.join(ws1, 'room', platform);
			platform.sent.length = 0;

			presence.sync(wsObserver, 'room', platform);

			// Should send snapshot to observer
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('presence_state');
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
			expect(platform.sent[0].event).toBe('presence_state');
			expect(platform.sent[0].data).toEqual({});
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
			expect(platform.sent[0].event).toBe('presence_state');
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
			expect(platform.sent[0].event).toBe('presence_state');
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
			expect(platform.sent[0].event).toBe('presence_state');
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
			expect(platform.published[0].event).toBe('presence_diff');
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
			expect(platform.published[0].event).toBe('presence_diff');
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
			expect(heartbeats[0].data).toEqual(['1']);

			p.clear();
		});

		it('includes all active keys in heartbeat', () => {
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
			expect(heartbeats[0].data.sort()).toEqual(['1', '2']);

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

		it('does not publish heartbeats when heartbeat is 0 or omitted', () => {
			vi.useFakeTimers();
			const p = createPresence({
				key: 'id',
				select: (userData) => ({ id: userData.id, name: userData.name })
			});

			const ws = mockWs({ id: '1', name: 'Alice' });
			p.join(ws, 'room', platform);
			platform.reset();

			vi.advanceTimersByTime(60000);

			const heartbeats = platform.published.filter(e => e.event === 'heartbeat');
			expect(heartbeats).toHaveLength(0);

			p.clear();
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
			expect(heartbeats[0].data).toEqual(['1']);

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

			// Re-join after clear -- should restart heartbeat
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
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(0);

			platform.reset();
			const ws3 = mockWs({ id: '1', s: new Set([1, 3]) });
			p.join(ws3, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(1);
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
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(0);

			platform.reset();
			const ws3 = mockWs({ id: '1', m: new Map([['a', 2]]) });
			p.join(ws3, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(1);
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
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(0);

			platform.reset();
			const ws3 = mockWs({ id: '1', a: [1, 2, 4] });
			p.join(ws3, 'room', platform);
			p.flushDiffs();
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(1);
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
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(0);
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
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(1);
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
			expect(platform.published.filter(e => e.event === 'presence_diff')).toHaveLength(1);
		});
	});
});
