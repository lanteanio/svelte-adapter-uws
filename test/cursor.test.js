import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCursor } from '../plugins/cursor/server.js';

/**
 * Create a mock WebSocket.
 * @param {Record<string, any>} userData
 */
function mockWs(userData = {}) {
	return {
		getUserData: () => userData
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

describe('cursor plugin - server', () => {
	let cursors;
	let platform;

	beforeEach(() => {
		vi.useRealTimers();
		cursors = createCursor({
			throttle: 100,
			select: (userData) => ({ id: userData.id, name: userData.name })
		});
		platform = mockPlatform();
	});

	describe('createCursor', () => {
		it('returns a cursor tracker with the expected API', () => {
			expect(typeof cursors.update).toBe('function');
			expect(typeof cursors.remove).toBe('function');
			expect(typeof cursors.list).toBe('function');
			expect(typeof cursors.clear).toBe('function');
		});

		it('works with default options', () => {
			const c = createCursor();
			expect(typeof c.update).toBe('function');
		});

		it('throws on negative throttle', () => {
			expect(() => createCursor({ throttle: -1 })).toThrow('non-negative');
		});

		it('throws on non-function select', () => {
			expect(() => createCursor({ select: 'bad' })).toThrow('function');
		});
	});

	describe('update - basic', () => {
		it('first update broadcasts immediately', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			cursors.update(ws, 'canvas', { x: 10, y: 20 }, platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].topic).toBe('__cursor:canvas');
			expect(platform.published[0].event).toBe('update');
			expect(platform.published[0].data).toEqual({
				key: expect.any(String),
				user: { id: '1', name: 'Alice' },
				data: { x: 10, y: 20 }
			});
		});

		it('uses select to extract user info', () => {
			const c = createCursor({
				throttle: 0,
				select: (ud) => ({ id: ud.id })
			});
			const ws = mockWs({ id: '1', name: 'Alice', secret: 'token' });
			c.update(ws, 'room', { x: 0, y: 0 }, platform);

			expect(platform.published[0].data.user).toEqual({ id: '1' });
			expect(platform.published[0].data.user.secret).toBeUndefined();
		});

		it('without select, broadcasts full userData', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', role: 'admin' });
			c.update(ws, 'room', { x: 5, y: 5 }, platform);

			expect(platform.published[0].data.user).toEqual({ id: '1', role: 'admin' });
		});
	});

	describe('update - throttle', () => {
		it('second update within throttle window is not broadcast immediately', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0, y: 0 }, platform); // immediate
			expect(platform.published).toHaveLength(1);
			platform.reset();

			vi.advanceTimersByTime(50); // still within 100ms window
			cursors.update(ws, 'canvas', { x: 10, y: 10 }, platform);
			expect(platform.published).toHaveLength(0); // throttled
		});

		it('trailing edge fires after throttle window', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0, y: 0 }, platform); // immediate
			platform.reset();

			vi.advanceTimersByTime(50);
			cursors.update(ws, 'canvas', { x: 10, y: 10 }, platform); // sets trailing timer

			vi.advanceTimersByTime(50); // timer fires
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data.data).toEqual({ x: 10, y: 10 });
		});

		it('trailing edge sends latest data, not intermediate', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0, y: 0 }, platform); // immediate
			platform.reset();

			vi.advanceTimersByTime(30);
			cursors.update(ws, 'canvas', { x: 5, y: 5 }, platform);
			vi.advanceTimersByTime(30);
			cursors.update(ws, 'canvas', { x: 99, y: 99 }, platform);

			vi.advanceTimersByTime(40); // timer fires
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data.data).toEqual({ x: 99, y: 99 });
		});

		it('update after throttle window passes broadcasts immediately', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0, y: 0 }, platform);
			platform.reset();

			vi.advanceTimersByTime(100);
			cursors.update(ws, 'canvas', { x: 50, y: 50 }, platform);
			expect(platform.published).toHaveLength(1); // immediate, new window
		});

		it('throttle: 0 broadcasts every update', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });

			c.update(ws, 'canvas', { x: 0, y: 0 }, platform);
			c.update(ws, 'canvas', { x: 1, y: 1 }, platform);
			c.update(ws, 'canvas', { x: 2, y: 2 }, platform);

			expect(platform.published).toHaveLength(3);
		});
	});

	describe('update - multiple topics', () => {
		it('same ws can have cursor state on different topics', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });

			c.update(ws, 'canvas-a', { x: 1 }, platform);
			c.update(ws, 'canvas-b', { x: 2 }, platform);

			expect(platform.published).toHaveLength(2);
			expect(platform.published[0].topic).toBe('__cursor:canvas-a');
			expect(platform.published[1].topic).toBe('__cursor:canvas-b');
		});

		it('throttle is per-user per-topic', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas-a', { x: 0 }, platform);
			cursors.update(ws, 'canvas-b', { x: 0 }, platform);
			expect(platform.published).toHaveLength(2); // both immediate (different topics)
		});

		it('different connections have independent throttle', () => {
			vi.useFakeTimers();
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });

			cursors.update(ws1, 'canvas', { x: 0 }, platform);
			cursors.update(ws2, 'canvas', { x: 0 }, platform);
			expect(platform.published).toHaveLength(2); // both immediate (different users)
		});
	});

	describe('remove', () => {
		it('removes ws from all topics and broadcasts removal', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });

			c.update(ws, 'canvas-a', { x: 1 }, platform);
			c.update(ws, 'canvas-b', { x: 2 }, platform);
			platform.reset();

			c.remove(ws, platform);

			const removes = platform.published.filter(e => e.event === 'remove');
			expect(removes).toHaveLength(2);
			expect(removes.map(r => r.topic).sort()).toEqual([
				'__cursor:canvas-a',
				'__cursor:canvas-b'
			]);
		});

		it('is safe to call for unknown ws', () => {
			const ws = mockWs({ id: '1' });
			expect(() => cursors.remove(ws, platform)).not.toThrow();
			expect(platform.published).toHaveLength(0);
		});

		it('cleans up empty topic maps', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });

			c.update(ws, 'canvas', { x: 1 }, platform);
			c.remove(ws, platform);

			expect(c.list('canvas')).toEqual([]);
		});

		it('clears pending trailing-edge timers', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0, y: 0 }, platform); // immediate
			platform.reset();

			vi.advanceTimersByTime(50);
			cursors.update(ws, 'canvas', { x: 10, y: 10 }, platform); // sets timer

			cursors.remove(ws, platform); // should clear timer

			vi.advanceTimersByTime(100);
			// Only the remove event, no trailing update
			const updates = platform.published.filter(e => e.event === 'update');
			expect(updates).toHaveLength(0);
		});
	});

	describe('list', () => {
		it('returns current cursor positions for a topic', () => {
			const c = createCursor({
				throttle: 0,
				select: (ud) => ({ id: ud.id, name: ud.name })
			});
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });

			c.update(ws1, 'canvas', { x: 10, y: 20 }, platform);
			c.update(ws2, 'canvas', { x: 30, y: 40 }, platform);

			const list = c.list('canvas');
			expect(list).toHaveLength(2);
			expect(list[0]).toEqual({
				key: expect.any(String),
				user: { id: '1', name: 'Alice' },
				data: { x: 10, y: 20 }
			});
		});

		it('returns empty array for unknown topic', () => {
			expect(cursors.list('nonexistent')).toEqual([]);
		});

		it('reflects latest stored data even if not yet broadcast', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0 }, platform);
			vi.advanceTimersByTime(50);
			cursors.update(ws, 'canvas', { x: 99 }, platform); // throttled, not broadcast yet

			const list = cursors.list('canvas');
			expect(list[0].data).toEqual({ x: 99 });
		});
	});

	describe('clear', () => {
		it('resets all state', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });

			c.update(ws, 'canvas', { x: 1 }, platform);
			c.clear();

			expect(c.list('canvas')).toEqual([]);
		});

		it('clears all pending timers', () => {
			vi.useFakeTimers();
			const ws = mockWs({ id: '1', name: 'Alice' });

			cursors.update(ws, 'canvas', { x: 0 }, platform);
			platform.reset();

			vi.advanceTimersByTime(50);
			cursors.update(ws, 'canvas', { x: 10 }, platform); // sets timer

			cursors.clear();

			vi.advanceTimersByTime(100);
			expect(platform.published).toHaveLength(0); // timer was cleared
		});
	});
});
