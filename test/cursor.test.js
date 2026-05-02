import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCursor } from '../plugins/cursor/server.js';
import { mockWs, mockPlatform } from './_helpers.js';

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

	describe('throttle leading-edge clears pending timer', () => {
		it('clears trailing timer when leading edge fires after window passes', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 200 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			// T=0: leading edge fires immediately
			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			expect(p.published).toHaveLength(1);

			// T=10: within window, schedules trailing timer at T=10+(200-10)=T=200
			vi.advanceTimersByTime(10);
			c.update(ws, 'canvas', { x: 1, y: 1 }, p);
			expect(p.published).toHaveLength(1);

			// Jump Date.now() to T=210 WITHOUT advancing timers (timer stays pending)
			const base = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(base + 200);

			// Update: 210-0 >= 200 -> leading edge, entry.timer exists -> clearTimeout
			c.update(ws, 'canvas', { x: 2, y: 2 }, p);
			expect(p.published).toHaveLength(2);

			Date.now.mockRestore();

			// Advance timers far past the scheduled time -- the cleared timer must not fire
			vi.advanceTimersByTime(500);
			expect(p.published).toHaveLength(2);

			vi.useRealTimers();
		});
	});

	describe('caps', () => {
		it('rejects invalid maxConnections / maxTopics', () => {
			expect(() => createCursor({ maxConnections: 0 })).toThrow('maxConnections must be a positive integer');
			expect(() => createCursor({ maxTopics: -1 })).toThrow('maxTopics must be a positive integer');
		});

		it('evicts oldest connection state when at maxConnections', () => {
			const c = createCursor({ throttle: 0, maxConnections: 2, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const wsA = mockWs({ id: 'A' });
			const wsB = mockWs({ id: 'B' });
			const wsC = mockWs({ id: 'C' });
			c.update(wsA, 'topic', { x: 1 }, p);
			c.update(wsB, 'topic', { x: 2 }, p);
			// Adding wsC at cap evicts wsA's state. wsA's data on 'topic'
			// remains in the topic map (eviction is connection-scoped, not
			// topic-scoped), but its wsState entry is gone so a new
			// `update(wsA, ...)` will get a fresh connection key.
			c.update(wsC, 'topic', { x: 3 }, p);
			expect(c.list('topic').length).toBe(3);
		});

		it('evicts oldest topic when at maxTopics', () => {
			const c = createCursor({ throttle: 0, maxTopics: 2, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, 'a', { x: 1 }, p);
			c.update(ws, 'b', { x: 2 }, p);
			c.update(ws, 'c', { x: 3 }, p);
			// Topic 'a' was evicted to make room for 'c'.
			expect(c.list('a')).toEqual([]);
			expect(c.list('b').length).toBe(1);
			expect(c.list('c').length).toBe(1);
		});
	});
});
