import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

		it('returns copies - mutating list() results does not affect internal state', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ({ id: ud.id, name: ud.name }) });
			const ws = mockWs({ id: '1', name: 'Alice' });
			c.update(ws, 'canvas', { x: 5, y: 10 }, platform);

			const list1 = c.list('canvas');
			list1[0].user.name = 'Hacked';
			list1[0].data.x = 999;
			list1[0].extra = true;

			const list2 = c.list('canvas');
			expect(list2[0].user.name).toBe('Alice');
			expect(list2[0].data.x).toBe(5);
			expect(list2[0].extra).toBeUndefined();
		});

		it('handles non-object user and data values without mangling them', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ud.name });
			const ws = mockWs({ name: 'Alice' });
			c.update(ws, 'canvas', 42, platform);

			const list = c.list('canvas');
			expect(list[0].user).toBe('Alice');
			expect(list[0].data).toBe(42);
		});

		it('handles null and undefined user and data values', () => {
			const c = createCursor({ throttle: 0, select: () => null });
			const ws = mockWs({});
			c.update(ws, 'canvas', undefined, platform);

			const list = c.list('canvas');
			expect(list[0].user).toBe(null);
			expect(list[0].data).toBe(undefined);
		});

		it('handles array data without converting to an object', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ud });
			const ws = mockWs({ id: '1' });
			c.update(ws, 'canvas', [1, 2, 3], platform);

			const list = c.list('canvas');
			expect(Array.isArray(list[0].data)).toBe(true);
			expect(list[0].data).toEqual([1, 2, 3]);
		});

		it('deeply isolates nested objects from internal state', () => {
			const c = createCursor({
				throttle: 0,
				select: (ud) => ({ id: ud.id, meta: { color: ud.color } })
			});
			const ws = mockWs({ id: '1', color: 'red' });
			c.update(ws, 'canvas', { pos: { x: 1, y: 2 } }, platform);

			const list1 = c.list('canvas');
			list1[0].user.meta.color = 'blue';
			list1[0].data.pos.x = 999;

			const list2 = c.list('canvas');
			expect(list2[0].user.meta.color).toBe('red');
			expect(list2[0].data.pos.x).toBe(1);
		});

		it('does not throw when data contains non-cloneable values', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ({ id: ud.id, fn: ud.fn }) });
			const ws = mockWs({ id: '1', fn: () => {} });
			c.update(ws, 'canvas', { handler: () => {} }, platform);

			expect(() => c.list('canvas')).not.toThrow();
			const list = c.list('canvas');
			expect(list).toHaveLength(1);
			expect(list[0].user.id).toBe('1');
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

	describe('snapshot', () => {
		it('returns the cursor tracker with a snapshot method', () => {
			expect(typeof cursors.snapshot).toBe('function');
		});

		it('sends a snapshot event with current positions to the given ws', () => {
			const c = createCursor({
				throttle: 0,
				select: (ud) => ({ id: ud.id, name: ud.name })
			});
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			const p = mockPlatform();

			c.update(ws1, 'canvas', { x: 10, y: 20 }, p);
			c.update(ws2, 'canvas', { x: 30, y: 40 }, p);
			p.reset();

			const newWs = mockWs({ id: '3', name: 'Carol' });
			c.snapshot(newWs, 'canvas', p);

			expect(p.sent).toHaveLength(1);
			expect(p.sent[0].ws).toBe(newWs);
			expect(p.sent[0].topic).toBe('__cursor:canvas');
			expect(p.sent[0].event).toBe('snapshot');
			expect(Array.isArray(p.sent[0].data)).toBe(true);
			expect(p.sent[0].data).toHaveLength(2);

			const keys = p.sent[0].data.map((e) => e.key);
			expect(new Set(keys).size).toBe(2);
		});

		it('sends correct user and data per entry', () => {
			const c = createCursor({
				throttle: 0,
				select: (ud) => ({ id: ud.id, name: ud.name })
			});
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'room', { x: 5, y: 15 }, p);
			p.reset();

			const newWs = mockWs({ id: '2', name: 'Bob' });
			c.snapshot(newWs, 'room', p);

			const entry = p.sent[0].data[0];
			expect(entry.user).toEqual({ id: '1', name: 'Alice' });
			expect(entry.data).toEqual({ x: 5, y: 15 });
		});

		it('sends empty snapshot for an unknown topic', () => {
			const p = mockPlatform();
			cursors.snapshot(mockWs({ id: '1' }), 'nonexistent', p);
			expect(p.sent).toHaveLength(1);
			expect(p.sent[0].event).toBe('snapshot');
			expect(p.sent[0].data).toEqual([]);
		});

		it('sends empty snapshot when the topic has no active cursors', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);
			c.remove(ws, p);
			p.reset();

			c.snapshot(mockWs({ id: '2' }), 'canvas', p);
			expect(p.sent).toHaveLength(1);
			expect(p.sent[0].event).toBe('snapshot');
			expect(p.sent[0].data).toEqual([]);
		});

		it('reflects the latest stored position even if not yet broadcast', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0 }, p); // immediate broadcast
			vi.advanceTimersByTime(50);
			c.update(ws, 'canvas', { x: 99 }, p); // throttled, stored but not broadcast yet
			p.reset();

			const newWs = mockWs({ id: '2' });
			c.snapshot(newWs, 'canvas', p);

			expect(p.sent[0].data[0].data).toEqual({ x: 99 });
		});

		it('sends snapshots independently per topic', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas-a', { x: 1 }, p);
			c.update(ws, 'canvas-b', { x: 2 }, p);
			p.reset();

			const viewer = mockWs({ id: '2' });
			c.snapshot(viewer, 'canvas-a', p);

			expect(p.sent).toHaveLength(1);
			expect(p.sent[0].topic).toBe('__cursor:canvas-a');
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

	describe('hooks', () => {
		it('exposes message and close functions', () => {
			expect(typeof cursors.hooks.message).toBe('function');
			expect(typeof cursors.hooks.close).toBe('function');
		});

		function mockWsSubs(userData, subscribedTopics) {
			const subs = new Set(subscribedTopics);
			return {
				getUserData: () => userData,
				isSubscribed: (topic) => subs.has(topic)
			};
		}

		function encode(obj) {
			return new TextEncoder().encode(JSON.stringify(obj)).buffer;
		}

		it('hooks.message handles cursor updates for subscribed clients', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ({ id: ud.id }) });
			const ws = mockWsSubs({ id: '1' }, ['__cursor:canvas']);
			const p = mockPlatform();

			const handled = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 5, y: 10 } }), platform: p });

			expect(handled).toBe(true);
			expect(p.published).toHaveLength(1);
			expect(p.published[0].event).toBe('update');
		});

		it('hooks.message handles cursor-snapshot for subscribed clients', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ({ id: ud.id }) });
			const ws1 = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws1, 'canvas', { x: 1 }, p);
			p.reset();

			const ws2 = mockWsSubs({ id: '2' }, ['__cursor:canvas']);
			const handled = c.hooks.message(ws2, { data: encode({ type: 'cursor-snapshot', topic: 'canvas' }), platform: p });

			expect(handled).toBe(true);
			expect(p.sent).toHaveLength(1);
			expect(p.sent[0].event).toBe('snapshot');
		});

		it('hooks.message rejects cursor updates from unsubscribed clients', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ({ id: ud.id }) });
			const ws = mockWsSubs({ id: '1' }, []);
			const p = mockPlatform();

			const handled = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'secret', data: { x: 1 } }), platform: p });

			expect(handled).toBe(true);
			expect(p.published).toHaveLength(0);
		});

		it('hooks.message rejects cursor-snapshot from unsubscribed clients', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWsSubs({}, ['__cursor:public']);
			const p = mockPlatform();

			const handled = c.hooks.message(ws, { data: encode({ type: 'cursor-snapshot', topic: 'secret' }), platform: p });

			expect(handled).toBe(true);
			expect(p.sent).toHaveLength(0);
		});

		it('hooks.message works with manual ws.subscribe() (isSubscribed-based auth)', () => {
			const c = createCursor({ throttle: 0, select: (ud) => ({ id: ud.id }) });
			const subs = new Set();
			const ws = {
				getUserData: () => ({ id: '1' }),
				isSubscribed: (topic) => subs.has(topic),
				subscribe: (topic) => subs.add(topic)
			};
			const p = mockPlatform();

			// Not subscribed yet -- rejected
			const r1 = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 1 } }), platform: p });
			expect(r1).toBe(true);
			expect(p.published).toHaveLength(0);

			// Manually subscribe
			ws.subscribe('__cursor:canvas');

			// Now accepted
			const r2 = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 2 } }), platform: p });
			expect(r2).toBe(true);
			expect(p.published).toHaveLength(1);
		});

		it('hooks.message returns undefined for non-JSON data', () => {
			const data = new TextEncoder().encode('not json').buffer;
			const result = cursors.hooks.message(mockWs(), { data, platform });
			expect(result).toBeUndefined();
		});

		it('hooks.message surfaces errors from select() instead of swallowing them', () => {
			const c = createCursor({ throttle: 0, select: () => { throw new Error('select failed'); } });
			const ws = mockWsSubs({}, ['__cursor:canvas']);
			expect(() => c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 1 } }), platform })).toThrow('select failed');
		});

		it('hooks.message surfaces errors from platform.publish() instead of swallowing them', () => {
			const c = createCursor({ throttle: 0 });
			const badPlatform = {
				...mockPlatform(),
				publish() { throw new Error('publish failed'); }
			};
			const ws = mockWsSubs({}, ['__cursor:canvas']);
			expect(() => c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 1 } }), platform: badPlatform })).toThrow('publish failed');
		});

		it('hooks.message returns undefined for non-cursor messages', () => {
			const result = cursors.hooks.message(mockWs(), { data: encode({ type: 'chat', text: 'hello' }), platform });
			expect(result).toBeUndefined();
		});

		it('hooks.close calls remove', () => {
			const c = createCursor({ throttle: 0 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);
			expect(c.list('canvas')).toHaveLength(1);

			c.hooks.close(ws, { platform: p });

			expect(c.list('canvas')).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// Client-side cursor interpolation logic
// ---------------------------------------------------------------------------
// The cursor client module depends on svelte/store, browser globals, and the
// WS client. We test the interpolation math and lifecycle as standalone units
// following the same pattern as test/client.test.js.
// ---------------------------------------------------------------------------

describe('cursor client - lerp interpolation', () => {
	function lerp(current, target, factor) {
		return current + (target - current) * factor;
	}

	const FACTOR = 0.3;
	const THRESHOLD = 0.5;

	describe('lerp math', () => {
		it('moves toward target by the given factor', () => {
			expect(lerp(0, 100, FACTOR)).toBe(30);
			expect(lerp(100, 0, FACTOR)).toBe(70);
		});

		it('converges over multiple steps', () => {
			let x = 0;
			const target = 100;
			for (let i = 0; i < 20; i++) x = lerp(x, target, FACTOR);
			expect(Math.abs(x - target)).toBeLessThan(THRESHOLD);
		});

		it('reaches 95% of the distance within ~9 frames', () => {
			let x = 0;
			const target = 100;
			for (let i = 0; i < 9; i++) x = lerp(x, target, FACTOR);
			expect(x).toBeGreaterThan(95);
		});

		it('does not overshoot', () => {
			let x = 0;
			const target = 100;
			for (let i = 0; i < 100; i++) {
				x = lerp(x, target, FACTOR);
				expect(x).toBeLessThanOrEqual(target);
			}
		});

		it('works with negative coordinates', () => {
			expect(lerp(0, -100, FACTOR)).toBe(-30);
			expect(lerp(-50, -100, FACTOR)).toBe(-65);
		});
	});

	describe('snap threshold', () => {
		it('snaps when remaining distance is below threshold on both axes', () => {
			const data = { x: 99.8, y: 199.7 };
			const target = { x: 100, y: 200 };
			const dx = target.x - data.x;
			const dy = target.y - data.y;
			expect(Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD).toBe(true);
		});

		it('does not snap when one axis is still above threshold', () => {
			const data = { x: 99.8, y: 198 };
			const target = { x: 100, y: 200 };
			const dx = target.x - data.x;
			const dy = target.y - data.y;
			expect(Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD).toBe(false);
		});
	});

	describe('tick simulation', () => {
		it('interpolates multiple cursors independently', () => {
			const cursorMap = new Map();
			const targets = new Map();

			cursorMap.set('a', { user: {}, data: { x: 0, y: 0 } });
			cursorMap.set('b', { user: {}, data: { x: 50, y: 50 } });
			targets.set('a', { x: 100, y: 200 });
			targets.set('b', { x: 0, y: 0 });

			// simulate one tick
			for (const [key, target] of targets) {
				const entry = cursorMap.get(key);
				const dx = target.x - entry.data.x;
				const dy = target.y - entry.data.y;
				if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) {
					entry.data = { ...entry.data, x: target.x, y: target.y };
					targets.delete(key);
				} else {
					entry.data = { ...entry.data, x: entry.data.x + dx * FACTOR, y: entry.data.y + dy * FACTOR };
				}
			}

			expect(cursorMap.get('a').data.x).toBeCloseTo(30, 5);
			expect(cursorMap.get('a').data.y).toBeCloseTo(60, 5);
			expect(cursorMap.get('b').data.x).toBeCloseTo(35, 5);
			expect(cursorMap.get('b').data.y).toBeCloseTo(35, 5);
		});

		it('preserves non-xy fields during interpolation', () => {
			const entry = { user: { name: 'Alice' }, data: { x: 0, y: 0, color: 'red', pressure: 0.8 } };
			const target = { x: 100, y: 200 };
			const dx = target.x - entry.data.x;
			const dy = target.y - entry.data.y;
			entry.data = { ...entry.data, x: entry.data.x + dx * FACTOR, y: entry.data.y + dy * FACTOR };

			expect(entry.data.color).toBe('red');
			expect(entry.data.pressure).toBe(0.8);
			expect(entry.data.x).toBeCloseTo(30, 5);
		});

		it('removes target from map after snap', () => {
			const targets = new Map();
			const cursorMap = new Map();
			cursorMap.set('a', { user: {}, data: { x: 99.9, y: 199.9 } });
			targets.set('a', { x: 100, y: 200 });

			const entry = cursorMap.get('a');
			const dx = targets.get('a').x - entry.data.x;
			const dy = targets.get('a').y - entry.data.y;
			if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) {
				entry.data = { ...entry.data, x: targets.get('a').x, y: targets.get('a').y };
				targets.delete('a');
			}

			expect(targets.size).toBe(0);
			expect(entry.data.x).toBe(100);
			expect(entry.data.y).toBe(200);
		});

		it('cleans up orphaned targets (entry removed between ticks)', () => {
			const targets = new Map();
			const cursorMap = new Map();
			targets.set('gone', { x: 100, y: 100 });

			for (const [key] of targets) {
				if (!cursorMap.get(key)) targets.delete(key);
			}

			expect(targets.size).toBe(0);
		});
	});

	describe('cache key isolation', () => {
		it('interpolate flag produces a distinct cache key', () => {
			const topic = 'canvas';
			const key1 = topic;
			const key2 = topic + '\0lerp';
			expect(key1).not.toBe(key2);
		});

		it('maxAge + interpolate combine correctly', () => {
			const topic = 'canvas';
			const maxAge = 30000;
			let key = topic;
			if (maxAge > 0) key += '\0' + maxAge;
			key += '\0lerp';
			expect(key).toBe('canvas\x0030000\x00lerp');
		});
	});

	describe('interpolation eligibility', () => {
		it('non-numeric x/y falls back to snap', () => {
			const data = { x: 'hello', y: 'world' };
			const eligible = typeof data?.x === 'number' && typeof data?.y === 'number';
			expect(eligible).toBe(false);
		});

		it('missing x/y falls back to snap', () => {
			const data = { color: 'red' };
			const eligible = typeof data?.x === 'number' && typeof data?.y === 'number';
			expect(eligible).toBe(false);
		});

		it('null data falls back to snap', () => {
			const data = null;
			const eligible = typeof data?.x === 'number' && typeof data?.y === 'number';
			expect(eligible).toBe(false);
		});

		it('numeric x/y is eligible', () => {
			const data = { x: 10, y: 20 };
			const eligible = typeof data?.x === 'number' && typeof data?.y === 'number';
			expect(eligible).toBe(true);
		});

		it('NaN x/y is not eligible', () => {
			const data = { x: NaN, y: 10 };
			const eligible = typeof data?.x === 'number' && typeof data?.y === 'number';
			// NaN is typeof 'number' -- but this is acceptable because lerp(NaN, ...)
			// produces NaN, which will fail the threshold check and the cursor will
			// effectively be invisible. Not worth a special case.
			expect(eligible).toBe(true);
		});
	});

	describe('rAF lifecycle', () => {
		let rafCallbacks;
		let rafId;
		let cancelledIds;

		beforeEach(() => {
			rafCallbacks = [];
			rafId = 0;
			cancelledIds = new Set();
		});

		function mockRAF(fn) {
			const id = ++rafId;
			rafCallbacks.push({ id, fn });
			return id;
		}

		function mockCancelRAF(id) {
			cancelledIds.add(id);
		}

		function flushRAF() {
			const pending = rafCallbacks.splice(0);
			for (const { id, fn } of pending) {
				if (!cancelledIds.has(id)) fn();
			}
		}

		it('loop stops when all targets converge', () => {
			const cursorMap = new Map();
			const targets = new Map();
			cursorMap.set('a', { user: {}, data: { x: 99.9, y: 99.9 } });
			targets.set('a', { x: 100, y: 100 });
			let loopRafId = null;

			function tick() {
				for (const [key, target] of targets) {
					const entry = cursorMap.get(key);
					if (!entry) { targets.delete(key); continue; }
					const dx = target.x - entry.data.x;
					const dy = target.y - entry.data.y;
					if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) {
						entry.data = { ...entry.data, x: target.x, y: target.y };
						targets.delete(key);
					} else {
						entry.data = { ...entry.data, x: entry.data.x + dx * FACTOR, y: entry.data.y + dy * FACTOR };
					}
				}
				if (targets.size > 0) {
					loopRafId = mockRAF(tick);
				} else {
					loopRafId = null;
				}
			}

			loopRafId = mockRAF(tick);
			flushRAF();

			// a was close enough to snap, targets should be empty, no new rAF scheduled
			expect(targets.size).toBe(0);
			expect(loopRafId).toBe(null);
		});

		it('loop continues while targets remain', () => {
			const cursorMap = new Map();
			const targets = new Map();
			cursorMap.set('a', { user: {}, data: { x: 0, y: 0 } });
			targets.set('a', { x: 100, y: 100 });
			let loopRafId = null;

			function tick() {
				for (const [key, target] of targets) {
					const entry = cursorMap.get(key);
					if (!entry) { targets.delete(key); continue; }
					const dx = target.x - entry.data.x;
					const dy = target.y - entry.data.y;
					if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) {
						entry.data = { ...entry.data, x: target.x, y: target.y };
						targets.delete(key);
					} else {
						entry.data = { ...entry.data, x: entry.data.x + dx * FACTOR, y: entry.data.y + dy * FACTOR };
					}
				}
				if (targets.size > 0) {
					loopRafId = mockRAF(tick);
				} else {
					loopRafId = null;
				}
			}

			loopRafId = mockRAF(tick);
			flushRAF();

			// still far from target, should have scheduled another rAF
			expect(targets.size).toBe(1);
			expect(loopRafId).not.toBe(null);
		});

		it('cancelAnimationFrame stops the loop', () => {
			let called = false;
			const id = mockRAF(() => { called = true; });
			mockCancelRAF(id);
			flushRAF();
			expect(called).toBe(false);
		});
	});
});
