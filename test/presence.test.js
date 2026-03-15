import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPresence } from '../plugins/presence/server.js';

/**
 * Create a mock WebSocket that mimics the uWS/vite wrapper API.
 * @param {Record<string, any>} userData
 */
function mockWs(userData = {}) {
	const topics = new Set();
	return {
		getUserData: () => userData,
		subscribe: (topic) => { topics.add(topic); return true; },
		unsubscribe: (topic) => { topics.delete(topic); return true; },
		isSubscribed: (topic) => topics.has(topic),
		_topics: topics
	};
}

/**
 * Create a mock platform that records publish/send calls.
 */
function mockPlatform() {
	const p = {
		published: [],
		sent: [],
		publish(topic, event, data) {
			p.published.push({ topic, event, data });
			return true;
		},
		send(ws, topic, event, data) {
			p.sent.push({ ws, topic, event, data });
			return 1;
		},
		reset() {
			p.published.length = 0;
			p.sent.length = 0;
		}
	};
	return p;
}

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

	describe('join', () => {
		it('adds user to presence and sends list to joining client', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			// Should send full list to the joining client
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__presence:room');
			expect(platform.sent[0].event).toBe('list');
			expect(platform.sent[0].data).toEqual([
				{ key: '1', data: { id: '1', name: 'Alice' } }
			]);

			// Should NOT publish join (no other subscribers yet to see it)
			// Actually - it publishes join before subscribing the ws, so the
			// joining client doesn't see it, but pub/sub still fires.
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('join');
		});

		it('subscribes ws to the internal presence topic', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			expect(ws.isSubscribed('__presence:room')).toBe(true);
		});

		it('broadcasts join event for new users', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });

			presence.join(ws1, 'room', platform);
			platform.reset();

			presence.join(ws2, 'room', platform);

			// Should publish join for Bob
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0]).toEqual({
				topic: '__presence:room',
				event: 'join',
				data: { key: '2', data: { id: '2', name: 'Bob' } }
			});

			// Should send full list to Bob
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].data).toHaveLength(2);
		});

		it('is idempotent - same ws + topic does nothing', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);

			const publishCount = platform.published.length;
			const sentCount = platform.sent.length;

			presence.join(ws, 'room', platform);

			expect(platform.published.length).toBe(publishCount);
			expect(platform.sent.length).toBe(sentCount);
		});

		it('ignores __-prefixed topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, '__presence:room', platform);

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
			const listData = platform.sent[0].data;
			expect(listData[0].data).toEqual({ id: '1' });
			expect(listData[0].data.secret).toBeUndefined();
		});
	});

	describe('multi-tab dedup', () => {
		it('same key, two connections = one presence entry', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '1', name: 'Alice' });

			presence.join(ws1, 'room', platform);
			platform.published.length = 0;

			presence.join(ws2, 'room', platform);

			// Should NOT publish a join (same user, different tab)
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
			platform.published.length = 0;

			presence.leave(ws1, platform);

			// Should NOT publish leave (other tab still open)
			expect(platform.published).toHaveLength(0);
			expect(presence.count('room')).toBe(1);
		});

		it('closing last tab publishes leave', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '1', name: 'Alice' });

			presence.join(ws1, 'room', platform);
			presence.join(ws2, 'room', platform);
			platform.published.length = 0;

			presence.leave(ws1, platform);
			presence.leave(ws2, platform);

			// NOW leave should be published
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('leave');
			expect(presence.count('room')).toBe(0);
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

		it('broadcasts leave for each topic', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room-a', platform);
			presence.join(ws, 'room-b', platform);
			platform.published.length = 0;

			presence.leave(ws, platform);

			const leaves = platform.published.filter(e => e.event === 'leave');
			expect(leaves).toHaveLength(2);
			expect(leaves.map(l => l.topic).sort()).toEqual([
				'__presence:room-a',
				'__presence:room-b'
			]);
		});

		it('is safe to call for unknown ws', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			// Should not throw
			presence.leave(ws, platform);
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
		it('sends current list without joining', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const wsObserver = mockWs({ id: 'admin', name: 'Admin' });

			presence.join(ws1, 'room', platform);
			platform.sent.length = 0;

			presence.sync(wsObserver, 'room', platform);

			// Should send list to observer
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].data).toEqual([
				{ key: '1', data: { id: '1', name: 'Alice' } }
			]);

			// Observer should be subscribed to presence updates
			expect(wsObserver.isSubscribed('__presence:room')).toBe(true);

			// But observer should NOT be in the presence list
			expect(presence.count('room')).toBe(1);
			expect(presence.list('room')[0].name).toBe('Alice');
		});

		it('sends empty list for unknown topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.sync(ws, 'nonexistent', platform);

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].data).toEqual([]);
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
		it('exposes subscribe and close functions', () => {
			expect(typeof presence.hooks.subscribe).toBe('function');
			expect(typeof presence.hooks.close).toBe('function');
		});

		it('hooks.subscribe calls join for regular topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, 'room', { platform });

			expect(presence.count('room')).toBe(1);
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].event).toBe('list');
		});

		it('hooks.subscribe sends current list for __presence: topics', () => {
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws1, 'room', platform);
			platform.reset();

			const wsObserver = mockWs({ id: 'obs', name: 'Observer' });
			presence.hooks.subscribe(wsObserver, '__presence:room', { platform });

			// Should send the list
			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].topic).toBe('__presence:room');
			expect(platform.sent[0].event).toBe('list');
			expect(platform.sent[0].data).toEqual([
				{ key: '1', data: { id: '1', name: 'Alice' } }
			]);

			// Should subscribe to the topic
			expect(wsObserver.isSubscribed('__presence:room')).toBe(true);

			// Observer should NOT be in the presence list
			expect(presence.count('room')).toBe(1);
		});

		it('hooks.subscribe sends empty list for __presence: with no users', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, '__presence:empty', { platform });

			expect(platform.sent).toHaveLength(1);
			expect(platform.sent[0].data).toEqual([]);
		});

		it('hooks.subscribe ignores other __-prefixed topics', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.hooks.subscribe(ws, '__replay:room', { platform });

			// Should still call join (which skips __ topics internally)
			expect(presence.count('__replay:room')).toBe(0);
			expect(platform.sent).toHaveLength(0);
		});

		it('hooks.close calls leave', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			presence.join(ws, 'room', platform);
			platform.reset();

			presence.hooks.close(ws, { platform });

			expect(presence.count('room')).toBe(0);
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('leave');
		});

		it('destructured hooks work correctly', () => {
			const { subscribe, close } = presence.hooks;

			const ws = mockWs({ id: '1', name: 'Alice' });
			subscribe(ws, 'room', { platform });

			expect(presence.count('room')).toBe(1);

			close(ws, { platform });

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
});
