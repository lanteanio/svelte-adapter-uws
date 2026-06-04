import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCursor } from '../plugins/cursor/server.js';
import { mockWs, mockPlatform, mockWalkPlatform } from './_helpers.js';

// Helpers to filter the new split-wire-format publish stream. The plugin
// emits `join` (with user metadata) then `update` / `bulk` (positions
// only) on the same topic; tests typically only care about one or two
// of those streams.
const pubs = (p, event) => p.published.filter((e) => e.event === event);
const positionEvents = (p) => p.published.filter((e) => e.event === 'update' || e.event === 'bulk');

describe('cursor plugin - server', () => {
	let cursors;
	let platform;

	beforeEach(() => {
		vi.useRealTimers();
		// All-immediate defaults for assertion convenience: 0/0 = no
		// throttle, no topic coalescing. Individual tests opt into
		// throttled behavior explicitly.
		cursors = createCursor({
			throttle: 0,
			topicThrottle: 0,
			select: (userData) => ({ id: userData.id, name: userData.name })
		});
		platform = mockPlatform();
	});

	describe('createCursor', () => {
		it('returns a cursor tracker with the expected API', () => {
			expect(typeof cursors.update).toBe('function');
			expect(typeof cursors.remove).toBe('function');
			expect(typeof cursors.list).toBe('function');
			expect(typeof cursors.snapshot).toBe('function');
			expect(typeof cursors.clear).toBe('function');
		});

		it('works with default options', () => {
			const c = createCursor();
			expect(typeof c.update).toBe('function');
		});

		it('throws on negative throttle', () => {
			expect(() => createCursor({ throttle: -1 })).toThrow('non-negative');
		});

		it('throws on negative topicThrottle', () => {
			expect(() => createCursor({ topicThrottle: -1 })).toThrow('non-negative');
		});

		it('throws on non-function select', () => {
			expect(() => createCursor({ select: 'bad' })).toThrow('function');
		});
	});

	describe('wire format', () => {
		it('first update on a topic emits join then update', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			cursors.update(ws, 'canvas', { x: 10, y: 20 }, platform);

			expect(platform.published).toHaveLength(2);
			expect(platform.published[0].event).toBe('join');
			expect(platform.published[0].topic).toBe('__cursor:canvas');
			expect(platform.published[0].data).toEqual({
				key: expect.any(String),
				user: { id: '1', name: 'Alice' }
			});
			expect(platform.published[1].event).toBe('update');
			expect(platform.published[1].topic).toBe('__cursor:canvas');
			expect(platform.published[1].data).toEqual({
				key: platform.published[0].data.key,
				data: { x: 10, y: 20 }
			});
		});

		it('subsequent updates on the same topic skip the join event', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			cursors.update(ws, 'canvas', { x: 0, y: 0 }, platform);
			platform.reset();
			cursors.update(ws, 'canvas', { x: 1, y: 1 }, platform);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].event).toBe('update');
		});

		it('update payload does not carry user metadata', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			cursors.update(ws, 'canvas', { x: 5, y: 5 }, platform);

			const update = pubs(platform, 'update')[0];
			expect(update.data).not.toHaveProperty('user');
			expect(update.data.data).toEqual({ x: 5, y: 5 });
		});

		it('cursor broadcasts opt OUT of compression (the 60Hz hot path stays uncompressed)', () => {
			// Hot-path-safe guarantee: cursor never asks the framework to compress,
			// on the binary wire (no opt-in) or the JSON fallback (explicit
			// { compress: false }). A recording mock captures the per-call option.
			const seen = [];
			const p = {
				published: [],
				publish(topic, event, data, options) { seen.push(options); p.published.push({ topic, event, data }); return true; },
				send(ws, topic, event, data, options) { seen.push(options); return 1; }
			};
			const ws = mockWs({ id: '1', name: 'Alice' });
			cursors.update(ws, 'canvas', { x: 5, y: 5 }, p); // join + update, synchronous at throttle 0
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.every((o) => o && o.compress === false)).toBe(true);
		});

		it('first update on each topic for the same ws emits its own join', () => {
			const ws = mockWs({ id: '1', name: 'Alice' });
			cursors.update(ws, 'canvas-a', { x: 1 }, platform);
			cursors.update(ws, 'canvas-b', { x: 2 }, platform);

			const joins = pubs(platform, 'join');
			expect(joins).toHaveLength(2);
			expect(joins.map((j) => j.topic).sort()).toEqual([
				'__cursor:canvas-a',
				'__cursor:canvas-b'
			]);
		});

		it('uses select to extract user info on the join event', () => {
			const c = createCursor({
				throttle: 0,
				topicThrottle: 0,
				select: (ud) => ({ id: ud.id })
			});
			const ws = mockWs({ id: '1', name: 'Alice', secret: 'token' });
			c.update(ws, 'room', { x: 0, y: 0 }, platform);

			const join = pubs(platform, 'join')[0];
			expect(join.data.user).toEqual({ id: '1' });
			expect(join.data.user.secret).toBeUndefined();
		});

		it('without select, the join event carries full userData', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', role: 'admin' });
			c.update(ws, 'room', { x: 5, y: 5 }, platform);

			const join = pubs(platform, 'join')[0];
			expect(join.data.user).toEqual({ id: '1', role: 'admin' });
		});
	});

	describe('per-cursor throttle', () => {
		it('second update within throttle window is not broadcast immediately', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0, y: 0 }, p); // join + update
			expect(pubs(p, 'update')).toHaveLength(1);
			p.reset();

			vi.advanceTimersByTime(50); // still within 100ms window
			c.update(ws, 'canvas', { x: 10, y: 10 }, p);
			expect(pubs(p, 'update')).toHaveLength(0); // throttled
		});

		it('trailing edge fires after throttle window', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			p.reset();

			vi.advanceTimersByTime(50);
			c.update(ws, 'canvas', { x: 10, y: 10 }, p); // sets trailing timer

			vi.advanceTimersByTime(50); // timer fires
			const updates = pubs(p, 'update');
			expect(updates).toHaveLength(1);
			expect(updates[0].data.data).toEqual({ x: 10, y: 10 });
		});

		it('trailing edge sends latest data, not intermediate', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			p.reset();

			vi.advanceTimersByTime(30);
			c.update(ws, 'canvas', { x: 5, y: 5 }, p);
			vi.advanceTimersByTime(30);
			c.update(ws, 'canvas', { x: 99, y: 99 }, p);

			vi.advanceTimersByTime(40); // timer fires
			const updates = pubs(p, 'update');
			expect(updates).toHaveLength(1);
			expect(updates[0].data.data).toEqual({ x: 99, y: 99 });
		});

		it('update after throttle window passes broadcasts immediately', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			p.reset();

			vi.advanceTimersByTime(100);
			c.update(ws, 'canvas', { x: 50, y: 50 }, p);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('throttle: 0 broadcasts every update', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			c.update(ws, 'canvas', { x: 1, y: 1 }, p);
			c.update(ws, 'canvas', { x: 2, y: 2 }, p);

			expect(pubs(p, 'update')).toHaveLength(3);
		});
	});

	describe('topicThrottle (per-topic coalescing)', () => {
		it('single mover: tick fires on next cadence boundary, emits one update', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 16 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0 }, p);
			// Nothing flushes synchronously - the tracker scheduler is now
			// always-tick (no leading-edge sync path). All flushes go
			// through the macrotask tick so cross-socket co-arrivals
			// (each their own JS task in production) batch correctly.
			expect(positionEvents(p)).toHaveLength(0);

			vi.advanceTimersByTime(16);
			expect(pubs(p, 'update')).toHaveLength(1);
			expect(pubs(p, 'bulk')).toHaveLength(0);
		});

		it('co-arriving movers in the same JS pass batch into one bulk on the tick', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 16 });
			const wsA = mockWs({ id: 'A' });
			const wsB = mockWs({ id: 'B' });
			const p = mockPlatform();

			c.update(wsA, 'canvas', { x: 1 }, p);
			c.update(wsB, 'canvas', { x: 2 }, p);
			expect(positionEvents(p)).toHaveLength(0);

			vi.advanceTimersByTime(16);
			expect(pubs(p, 'update')).toHaveLength(0);
			const bulks = pubs(p, 'bulk');
			expect(bulks).toHaveLength(1);
			expect(bulks[0].data).toHaveLength(2);
		});

		it('cross-task-boundary movers still coalesce into one bulk per cadence cycle', async () => {
			// THE PRODUCTION SHAPE. uWS dispatches each WS message as its
			// own JS task, microtasks drain between tasks. Pre-0.5.5 fix
			// (synchronous flush) and the 0.5.5 microtask-defer attempt
			// BOTH failed here: each broadcast fired its own UPDATE
			// because there was no shared task in which to coalesce.
			// Always-tick (macrotask via setTimeout) batches every
			// broadcast that lands before the timer fires, regardless of
			// how many task boundaries separate them.
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 16 });
			const p = mockPlatform();
			const COUNT = 50;

			for (let i = 0; i < COUNT; i++) {
				c.update(mockWs({ id: 'c' + i }), 'canvas', { x: i }, p);
				// Cross a microtask boundary between each broadcast -
				// this is exactly what uWS does between socket dispatches.
				await Promise.resolve();
			}

			expect(positionEvents(p)).toHaveLength(0);

			// Fire the tick.
			vi.advanceTimersByTime(16);
			expect(pubs(p, 'update')).toHaveLength(0);
			const bulks = pubs(p, 'bulk');
			expect(bulks).toHaveLength(1);
			expect(bulks[0].data).toHaveLength(COUNT);
		});

		it('mid-window mover joins the next tick instead of firing alone', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 16 });
			const wsA = mockWs({ id: 'A' });
			const wsB = mockWs({ id: 'B' });
			const p = mockPlatform();

			c.update(wsA, 'canvas', { x: 1 }, p);
			vi.advanceTimersByTime(16);
			expect(pubs(p, 'update')).toHaveLength(1);
			p.reset();

			// Mid-window: tick is no longer pending; new broadcast re-arms
			// for the remaining time in this cycle.
			vi.advanceTimersByTime(5);
			c.update(wsB, 'canvas', { x: 2 }, p);
			expect(positionEvents(p)).toHaveLength(0);

			vi.advanceTimersByTime(11);
			expect(pubs(p, 'update')).toHaveLength(1);
			expect(pubs(p, 'update')[0].data).toEqual({ key: expect.any(String), data: { x: 2 } });
		});

		it('multi-cycle saturation: bursts > topicThrottleMs apart produce one bulk per burst', async () => {
			// Repro of the demo's "1794 single-cursor UPDATEs / 38 BULKs
			// in 30s" pathology. Under steady production load the
			// message handler sees bursts of N broadcasts separated by
			// event-loop pauses (V8 GC, uWS internal work, outbound
			// drain). Each broadcast inside a burst arrives as its own
			// JS task (one per socket). Pre-fix, the first cursor of
			// each burst fired alone as an UPDATE; post-microtask-fix,
			// every cursor fired alone because microtasks drain between
			// tasks. With always-tick, every burst collapses to one
			// bulk holding the full burst population.
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 8 });
			const p = mockPlatform();
			const BURSTS = 10;
			const CURSORS_PER_BURST = 50;

			for (let b = 0; b < BURSTS; b++) {
				// Each burst arrives one task at a time (mimics N sockets
				// each dispatching their own message in sequence).
				for (let i = 0; i < CURSORS_PER_BURST; i++) {
					c.update(mockWs({ id: `c${b}_${i}` }), 'canvas', { x: i }, p);
					await Promise.resolve();
				}
				// Pause between bursts > topicThrottleMs so each burst
				// starts at a fresh cadence slot.
				vi.advanceTimersByTime(12);
			}

			const updates = pubs(p, 'update');
			const bulks = pubs(p, 'bulk');
			expect(updates.length).toBe(0);
			expect(bulks.length).toBe(BURSTS);
			for (const bulk of bulks) {
				expect(bulk.data.length).toBe(CURSORS_PER_BURST);
			}
		});

		it('topicThrottle: 0 disables coalescing - every broadcast goes out', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const wsA = mockWs({ id: 'A' });
			const wsB = mockWs({ id: 'B' });
			const p = mockPlatform();

			c.update(wsA, 'canvas', { x: 1 }, p);
			c.update(wsB, 'canvas', { x: 2 }, p);
			c.update(wsA, 'canvas', { x: 11 }, p);

			expect(pubs(p, 'update')).toHaveLength(3);
			expect(pubs(p, 'bulk')).toHaveLength(0);
		});

		it('clear() cancels the pending scheduler tick (no stale flush after reset)', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 16 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);  // leading-edge
			c.update(ws, 'canvas', { x: 2 }, p);  // queued for tick
			c.clear();

			vi.advanceTimersByTime(50);
			// Nothing should have fired post-clear.
			expect(p.published.filter((m) => m.event === 'update' || m.event === 'bulk').length).toBeLessThanOrEqual(1);
		});

		it('different topics are independently scheduled (one tick walks dirty topics only)', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 16 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws, 'canvas-a', { x: 1 }, p);  // leading-edge a
			vi.advanceTimersByTime(5);
			c.update(ws, 'canvas-b', { x: 1 }, p);  // leading-edge b
			// Both lead-edge fires went through; subsequent moves in-window
			// queue per-topic.
			p.reset();
			c.update(ws, 'canvas-a', { x: 11 }, p);
			c.update(ws, 'canvas-b', { x: 22 }, p);

			// canvas-a's deadline lands first (lastFlush=0 vs lastFlush=5).
			vi.advanceTimersByTime(11);  // canvas-a deadline
			expect(pubs(p, 'update').some((u) => u.topic === '__cursor:canvas-a')).toBe(true);

			vi.advanceTimersByTime(5);  // canvas-b deadline
			expect(pubs(p, 'update').some((u) => u.topic === '__cursor:canvas-b')).toBe(true);
		});
	});

	describe('stats() scheduler health accessor', () => {
		it('exposes flushes / drift / dirtyTopics / activeTopics', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			expect(c.stats()).toEqual({
				flushes: 0,
				driftMeanMs: 0,
				driftMaxMs: 0,
				dirtyTopicsCurrent: 0,
				activeTopicsTotal: 0,
				viewportsReported: 0,
				perSubscriberFlushes: 0,
				bpSkips: 0,
				culledEntriesDropped: 0
			});
		});

		it('activeTopicsTotal increments per touched topic', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();
			c.update(ws, 'a', { x: 1 }, p);
			c.update(ws, 'b', { x: 1 }, p);
			expect(c.stats().activeTopicsTotal).toBe(2);
		});

		it('flushes counter increments on every tick that fans out dirty entries', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 100 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);
			expect(c.stats().flushes).toBe(0);
			vi.advanceTimersByTime(100);
			expect(c.stats().flushes).toBe(1);

			c.update(ws, 'canvas', { x: 2 }, p);
			expect(c.stats().flushes).toBe(1);
			vi.advanceTimersByTime(100);
			expect(c.stats().flushes).toBe(2);
		});
	});

	describe('update - multiple topics', () => {
		it('same ws can have cursor state on different topics', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas-a', { x: 1 }, p);
			c.update(ws, 'canvas-b', { x: 2 }, p);

			const updates = pubs(p, 'update');
			expect(updates).toHaveLength(2);
			expect(updates.map((u) => u.topic).sort()).toEqual([
				'__cursor:canvas-a',
				'__cursor:canvas-b'
			]);
		});

		it('throttle is per-user per-topic', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas-a', { x: 0 }, p);
			c.update(ws, 'canvas-b', { x: 0 }, p);
			expect(pubs(p, 'update')).toHaveLength(2); // both immediate (different topics)
		});

		it('different connections have independent throttle', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			const p = mockPlatform();

			c.update(ws1, 'canvas', { x: 0 }, p);
			c.update(ws2, 'canvas', { x: 0 }, p);
			expect(pubs(p, 'update')).toHaveLength(2); // both immediate (different users)
		});
	});

	describe('remove', () => {
		it('removes ws from all topics and broadcasts removal', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas-a', { x: 1 }, p);
			c.update(ws, 'canvas-b', { x: 2 }, p);
			p.reset();

			c.remove(ws, p);

			const removes = pubs(p, 'remove');
			expect(removes).toHaveLength(2);
			expect(removes.map((r) => r.topic).sort()).toEqual([
				'__cursor:canvas-a',
				'__cursor:canvas-b'
			]);
		});

		it('remove payload contains only the connection key', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();
			c.update(ws, 'canvas', { x: 1 }, p);
			p.reset();
			c.remove(ws, p);
			expect(pubs(p, 'remove')[0].data).toEqual({ key: expect.any(String) });
			expect(pubs(p, 'remove')[0].data).not.toHaveProperty('user');
		});

		it('is safe to call for unknown ws', () => {
			const ws = mockWs({ id: '1' });
			expect(() => cursors.remove(ws, platform)).not.toThrow();
			expect(platform.published).toHaveLength(0);
		});

		it('cleans up empty topic maps', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);
			c.remove(ws, p);

			expect(c.list('canvas')).toEqual([]);
		});

		it('clears pending trailing-edge timers', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			p.reset();

			vi.advanceTimersByTime(50);
			c.update(ws, 'canvas', { x: 10, y: 10 }, p); // sets timer

			c.remove(ws, p); // should clear timer

			vi.advanceTimersByTime(100);
			const updates = pubs(p, 'update');
			expect(updates).toHaveLength(0);
		});

		it('clears pending topic-coalesce timers when last ws leaves', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 50 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p); // leading edge fires
			vi.advanceTimersByTime(5);
			c.update(ws, 'canvas', { x: 2 }, p); // schedules trailing topic-coalesce timer
			p.reset();

			c.remove(ws, p);
			vi.advanceTimersByTime(60);

			expect(pubs(p, 'update')).toHaveLength(0);
			expect(pubs(p, 'bulk')).toHaveLength(0);
		});
	});

	describe('list', () => {
		it('returns current cursor positions for a topic', () => {
			const c = createCursor({
				throttle: 0,
				topicThrottle: 0,
				select: (ud) => ({ id: ud.id, name: ud.name })
			});
			const ws1 = mockWs({ id: '1', name: 'Alice' });
			const ws2 = mockWs({ id: '2', name: 'Bob' });
			const p = mockPlatform();

			c.update(ws1, 'canvas', { x: 10, y: 20 }, p);
			c.update(ws2, 'canvas', { x: 30, y: 40 }, p);

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
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id, name: ud.name }) });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();
			c.update(ws, 'canvas', { x: 5, y: 10 }, p);

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
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ud.name });
			const ws = mockWs({ name: 'Alice' });
			const p = mockPlatform();
			c.update(ws, 'canvas', 42, p);

			const list = c.list('canvas');
			expect(list[0].user).toBe('Alice');
			expect(list[0].data).toBe(42);
		});

		it('handles null and undefined user and data values', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: () => null });
			const ws = mockWs({});
			const p = mockPlatform();
			c.update(ws, 'canvas', undefined, p);

			const list = c.list('canvas');
			expect(list[0].user).toBe(null);
			expect(list[0].data).toBe(undefined);
		});

		it('handles array data without converting to an object', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ud });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();
			c.update(ws, 'canvas', [1, 2, 3], p);

			const list = c.list('canvas');
			expect(Array.isArray(list[0].data)).toBe(true);
			expect(list[0].data).toEqual([1, 2, 3]);
		});

		it('deeply isolates nested objects from internal state', () => {
			const c = createCursor({
				throttle: 0,
				topicThrottle: 0,
				select: (ud) => ({ id: ud.id, meta: { color: ud.color } })
			});
			const ws = mockWs({ id: '1', color: 'red' });
			const p = mockPlatform();
			c.update(ws, 'canvas', { pos: { x: 1, y: 2 } }, p);

			const list1 = c.list('canvas');
			list1[0].user.meta.color = 'blue';
			list1[0].data.pos.x = 999;

			const list2 = c.list('canvas');
			expect(list2[0].user.meta.color).toBe('red');
			expect(list2[0].data.pos.x).toBe(1);
		});

		it('does not throw when data contains non-cloneable values', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id, fn: ud.fn }) });
			const ws = mockWs({ id: '1', fn: () => {} });
			const p = mockPlatform();
			c.update(ws, 'canvas', { handler: () => {} }, p);

			expect(() => c.list('canvas')).not.toThrow();
			const list = c.list('canvas');
			expect(list).toHaveLength(1);
			expect(list[0].user.id).toBe('1');
		});

		it('reflects latest stored data even if not yet broadcast', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0 }, p);
			vi.advanceTimersByTime(50);
			c.update(ws, 'canvas', { x: 99 }, p); // throttled, not broadcast yet

			const list = c.list('canvas');
			expect(list[0].data).toEqual({ x: 99 });
		});
	});

	describe('snapshot', () => {
		it('returns the cursor tracker with a snapshot method', () => {
			expect(typeof cursors.snapshot).toBe('function');
		});

		it('sends catalog + bulk events with current positions to the given ws', () => {
			const c = createCursor({
				throttle: 0,
				topicThrottle: 0,
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

			expect(p.sent).toHaveLength(2);
			expect(p.sent[0].ws).toBe(newWs);
			expect(p.sent[0].topic).toBe('__cursor:canvas');
			expect(p.sent[0].event).toBe('catalog');
			expect(Array.isArray(p.sent[0].data)).toBe(true);
			expect(p.sent[0].data).toHaveLength(2);
			for (const entry of p.sent[0].data) {
				expect(entry).toEqual({ key: expect.any(String), user: expect.any(Object) });
				expect(entry).not.toHaveProperty('data');
			}

			expect(p.sent[1].event).toBe('bulk');
			expect(Array.isArray(p.sent[1].data)).toBe(true);
			expect(p.sent[1].data).toHaveLength(2);
			for (const entry of p.sent[1].data) {
				expect(entry).toEqual({ key: expect.any(String), data: expect.any(Object) });
				expect(entry).not.toHaveProperty('user');
			}
		});

		it('catalog and bulk reference the same key set', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id, name: ud.name }) });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();
			c.update(ws, 'room', { x: 5, y: 15 }, p);
			p.reset();

			const newWs = mockWs({ id: '2', name: 'Bob' });
			c.snapshot(newWs, 'room', p);

			const catalogKeys = p.sent[0].data.map((e) => e.key).sort();
			const bulkKeys = p.sent[1].data.map((e) => e.key).sort();
			expect(catalogKeys).toEqual(bulkKeys);
			expect(p.sent[0].data[0].user).toEqual({ id: '1', name: 'Alice' });
			expect(p.sent[1].data[0].data).toEqual({ x: 5, y: 15 });
		});

		it('sends empty catalog + bulk for an unknown topic', () => {
			const p = mockPlatform();
			cursors.snapshot(mockWs({ id: '1' }), 'nonexistent', p);
			expect(p.sent).toHaveLength(2);
			expect(p.sent[0].event).toBe('catalog');
			expect(p.sent[0].data).toEqual([]);
			expect(p.sent[1].event).toBe('bulk');
			expect(p.sent[1].data).toEqual([]);
		});

		it('sends empty catalog + bulk when the topic has no active cursors', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);
			c.remove(ws, p);
			p.reset();

			c.snapshot(mockWs({ id: '2' }), 'canvas', p);
			expect(p.sent).toHaveLength(2);
			expect(p.sent[0].data).toEqual([]);
			expect(p.sent[1].data).toEqual([]);
		});

		it('reflects the latest stored position even if not yet broadcast', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0 }, p);
			vi.advanceTimersByTime(50);
			c.update(ws, 'canvas', { x: 99 }, p); // throttled
			p.reset();

			const newWs = mockWs({ id: '2' });
			c.snapshot(newWs, 'canvas', p);

			expect(p.sent[1].data[0].data).toEqual({ x: 99 });
		});

		it('sends snapshots independently per topic', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas-a', { x: 1 }, p);
			c.update(ws, 'canvas-b', { x: 2 }, p);
			p.reset();

			const viewer = mockWs({ id: '2' });
			c.snapshot(viewer, 'canvas-a', p);

			expect(p.sent).toHaveLength(2);
			expect(p.sent[0].topic).toBe('__cursor:canvas-a');
			expect(p.sent[1].topic).toBe('__cursor:canvas-a');
		});
	});

	describe('clear', () => {
		it('resets all state', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 1 }, p);
			c.clear();

			expect(c.list('canvas')).toEqual([]);
		});

		it('clears all pending per-cursor timers', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 100, topicThrottle: 0 });
			const ws = mockWs({ id: '1', name: 'Alice' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0 }, p);
			p.reset();

			vi.advanceTimersByTime(50);
			c.update(ws, 'canvas', { x: 10 }, p); // sets timer

			c.clear();

			vi.advanceTimersByTime(100);
			expect(positionEvents(p)).toHaveLength(0);
		});

		it('clears all pending topic-coalesce timers', () => {
			vi.useFakeTimers();
			const c = createCursor({ throttle: 0, topicThrottle: 50 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws, 'canvas', { x: 0 }, p); // leading edge
			vi.advanceTimersByTime(5);
			c.update(ws, 'canvas', { x: 1 }, p); // schedules trailing coalesce
			p.reset();

			c.clear();
			vi.advanceTimersByTime(60);

			expect(positionEvents(p)).toHaveLength(0);
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
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const ws = mockWsSubs({ id: '1' }, ['__cursor:canvas']);
			const p = mockPlatform();

			const handled = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 5, y: 10 } }), platform: p });

			expect(handled).toBe(true);
			expect(pubs(p, 'join')).toHaveLength(1);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('hooks.message handles cursor-snapshot for subscribed clients', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const ws1 = mockWs({ id: '1' });
			const p = mockPlatform();

			c.update(ws1, 'canvas', { x: 1 }, p);
			p.reset();

			const ws2 = mockWsSubs({ id: '2' }, ['__cursor:canvas']);
			const handled = c.hooks.message(ws2, { data: encode({ type: 'cursor-snapshot', topic: 'canvas' }), platform: p });

			expect(handled).toBe(true);
			expect(p.sent).toHaveLength(2);
			expect(p.sent[0].event).toBe('catalog');
			expect(p.sent[1].event).toBe('bulk');
		});

		it('hooks.message rejects cursor updates from unsubscribed clients', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const ws = mockWsSubs({ id: '1' }, []);
			const p = mockPlatform();

			const handled = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'secret', data: { x: 1 } }), platform: p });

			expect(handled).toBe(true);
			expect(p.published).toHaveLength(0);
		});

		it('hooks.message rejects cursor-snapshot from unsubscribed clients', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
			const ws = mockWsSubs({}, ['__cursor:public']);
			const p = mockPlatform();

			const handled = c.hooks.message(ws, { data: encode({ type: 'cursor-snapshot', topic: 'secret' }), platform: p });

			expect(handled).toBe(true);
			expect(p.sent).toHaveLength(0);
		});

		it('hooks.message works with manual ws.subscribe() (isSubscribed-based auth)', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const subs = new Set();
			const ws = {
				getUserData: () => ({ id: '1' }),
				isSubscribed: (topic) => subs.has(topic),
				subscribe: (topic) => subs.add(topic)
			};
			const p = mockPlatform();

			// Not subscribed yet - rejected.
			const r1 = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 1 } }), platform: p });
			expect(r1).toBe(true);
			expect(p.published).toHaveLength(0);

			// Manually subscribe.
			ws.subscribe('__cursor:canvas');

			// Now accepted: join + update fire.
			const r2 = c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 2 } }), platform: p });
			expect(r2).toBe(true);
			expect(pubs(p, 'join')).toHaveLength(1);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('hooks.message returns undefined for non-JSON data', () => {
			const data = new TextEncoder().encode('not json').buffer;
			const result = cursors.hooks.message(mockWs(), { data, platform });
			expect(result).toBeUndefined();
		});

		it('hooks.message surfaces errors from select() instead of swallowing them', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: () => { throw new Error('select failed'); } });
			const ws = mockWsSubs({}, ['__cursor:canvas']);
			expect(() => c.hooks.message(ws, { data: encode({ type: 'cursor', topic: 'canvas', data: { x: 1 } }), platform })).toThrow('select failed');
		});

		it('hooks.message surfaces errors from platform.publish() instead of swallowing them', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
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
			const c = createCursor({ throttle: 0, topicThrottle: 0 });
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
			const c = createCursor({ throttle: 200, topicThrottle: 0 });
			const ws = mockWs({ id: '1' });
			const p = mockPlatform();

			// T=0: leading edge fires immediately
			c.update(ws, 'canvas', { x: 0, y: 0 }, p);
			expect(pubs(p, 'update')).toHaveLength(1);

			// T=10: within window, schedules trailing timer at T=10+(200-10)=T=200
			vi.advanceTimersByTime(10);
			c.update(ws, 'canvas', { x: 1, y: 1 }, p);
			expect(pubs(p, 'update')).toHaveLength(1);

			// Jump Date.now() to T=210 WITHOUT advancing timers (timer stays pending)
			const base = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(base + 200);

			// Update: 210-0 >= 200 -> leading edge, entry.timer exists -> clearTimeout
			c.update(ws, 'canvas', { x: 2, y: 2 }, p);
			expect(pubs(p, 'update')).toHaveLength(2);

			Date.now.mockRestore();

			// Advance timers far past the scheduled time - the cleared timer must not fire
			vi.advanceTimersByTime(500);
			expect(pubs(p, 'update')).toHaveLength(2);

			vi.useRealTimers();
		});
	});

	describe('caps', () => {
		it('rejects invalid maxConnections / maxTopics', () => {
			expect(() => createCursor({ maxConnections: 0 })).toThrow('maxConnections must be a positive integer');
			expect(() => createCursor({ maxTopics: -1 })).toThrow('maxTopics must be a positive integer');
		});

		it('evicts oldest connection state when at maxConnections', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, maxConnections: 2, select: (ud) => ({ id: ud.id }) });
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
			const c = createCursor({ throttle: 0, topicThrottle: 0, maxTopics: 2, select: (ud) => ({ id: ud.id }) });
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

		it('rejects invalid maxTopicLength / maxDataBytes at construction', () => {
			expect(() => createCursor({ maxTopicLength: 0 })).toThrow('maxTopicLength must be a positive integer');
			expect(() => createCursor({ maxTopicLength: -1 })).toThrow('maxTopicLength must be a positive integer');
			expect(() => createCursor({ maxDataBytes: 0 })).toThrow('maxDataBytes must be a positive integer');
			expect(() => createCursor({ maxDataBytes: -1 })).toThrow('maxDataBytes must be a positive integer');
		});
	});

	describe('topic + payload caps', () => {
		it('silently drops updates whose topic exceeds the default 256-char cap', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, 'a'.repeat(257), { x: 1 }, p);
			expect(p.published).toHaveLength(0);
			expect(c.list('a'.repeat(257))).toEqual([]);
		});

		it('accepts topic exactly at the cap', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, 'a'.repeat(256), { x: 1 }, p);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('silently drops updates whose JSON-encoded data exceeds the default 8 KB cap', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			// 9 KB payload exceeds 8 KB cap.
			const tooBig = { payload: 'x'.repeat(9 * 1024) };
			c.update(ws, 'topic', tooBig, p);
			expect(p.published).toHaveLength(0);
		});

		it('accepts data exactly at the cap', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			// Build payload exactly at the cap. JSON wrapping adds ~14 bytes
			// for { "payload": "..." } so the inner string is 8192 - ~14.
			const fits = { payload: 'x'.repeat(8192 - 16) };
			c.update(ws, 'topic', fits, p);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('honors custom maxTopicLength and maxDataBytes', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, maxTopicLength: 16, maxDataBytes: 64, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, 'a'.repeat(17), { x: 1 }, p);
			expect(p.published).toHaveLength(0);
			c.update(ws, 'short', { payload: 'x'.repeat(80) }, p);
			expect(p.published).toHaveLength(0);
			c.update(ws, 'short', { x: 1 }, p);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('drops updates whose data is unserializable (BigInt / circular)', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, 'topic', { big: BigInt(42) }, p);
			expect(p.published).toHaveLength(0);
		});

		it('accepts undefined/null data (no JSON.stringify needed)', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, 'topic', null, p);
			expect(pubs(p, 'update')).toHaveLength(1);
		});

		it('drops empty or non-string topic', () => {
			const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
			const p = mockPlatform();
			const ws = mockWs({ id: 'A' });
			c.update(ws, '', { x: 1 }, p);
			c.update(ws, /** @type {any} */ (123), { x: 1 }, p);
			c.update(ws, /** @type {any} */ (null), { x: 1 }, p);
			expect(p.published).toHaveLength(0);
		});
	});
});

describe('cursor plugin - viewport ingress', () => {
	let cursors;
	let platform;
	const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

	beforeEach(() => {
		vi.useRealTimers();
		cursors = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
		platform = mockPlatform();
	});

	it('exposes viewport / viewportFor on the tracker', () => {
		expect(typeof cursors.viewport).toBe('function');
		expect(typeof cursors.viewportFor).toBe('function');
	});

	it('records a reported viewport rect and reads it back via viewportFor', () => {
		const ws = mockWs({ id: 'A' });
		cursors.viewport(ws, 'board', { x: 100, y: 200, w: 1920, h: 1080, zoom: 1 });
		expect(cursors.viewportFor(ws, 'board')).toEqual({ x: 100, y: 200, w: 1920, h: 1080, zoom: 1 });
	});

	it('defaults zoom to 1 when omitted', () => {
		const ws = mockWs({ id: 'A' });
		cursors.viewport(ws, 'board', { x: 0, y: 0, w: 800, h: 600 });
		expect(cursors.viewportFor(ws, 'board')).toEqual({ x: 0, y: 0, w: 800, h: 600, zoom: 1 });
	});

	it('viewportFor returns null for a subscriber that never reported (the never-cull opt-in)', () => {
		const ws = mockWs({ id: 'A' });
		expect(cursors.viewportFor(ws, 'board')).toBeNull();
	});

	it('drops a malformed rect silently (missing field, non-number, non-object)', () => {
		const ws = mockWs({ id: 'A' });
		cursors.viewport(ws, 'board', { x: 1, y: 2, w: 3 });          // missing h
		cursors.viewport(ws, 'board', { x: 1, y: 2, w: 3, h: 'nope' }); // non-number
		cursors.viewport(ws, 'board', null);                            // non-object
		expect(cursors.viewportFor(ws, 'board')).toBeNull();
	});

	it('drops a degenerate zero / negative-size rect (stays whole-board, never culled)', () => {
		const ws = mockWs({ id: 'A' });
		cursors.viewport(ws, 'board', { x: 0, y: 0, w: 0, h: 100 });             // zero width
		cursors.viewport(ws, 'board', { x: 0, y: 0, w: 100, h: -5 });            // negative height
		cursors.viewport(ws, 'board', { x: 0, y: 0, w: 100, h: 100, zoom: 0 });  // zero zoom
		expect(cursors.viewportFor(ws, 'board')).toBeNull();
	});

	it('tears down an evicted subscriber viewport at the maxConnections cap (no subViewport leak)', () => {
		const c = createCursor({ throttle: 0, topicThrottle: 0, maxConnections: 1, select: (ud) => ({ id: ud.id }) });
		const a = mockWs({ id: 'A' });
		c.viewport(a, 'board', { x: 0, y: 0, w: 10, h: 10 });
		expect(c.viewportFor(a, 'board')).not.toBeNull();
		expect(c.stats().viewportsReported).toBe(1);

		// A second pure viewer trips the cap (1) and evicts A's wsState; A's
		// subViewport entry must be torn down with it.
		const b = mockWs({ id: 'B' });
		c.viewport(b, 'board', { x: 0, y: 0, w: 10, h: 10 });
		expect(c.viewportFor(a, 'board')).toBeNull();
		expect(c.stats().viewportsReported).toBe(1); // only B, not A + B
	});

	it('hooks.message routes a cursor-viewport frame for a subscribed ws', () => {
		const ws = mockWs({ id: 'A' });
		ws.subscribe('__cursor:board');
		const handled = cursors.hooks.message(ws, {
			data: enc({ type: 'cursor-viewport', topic: 'board', rect: { x: 10, y: 20, w: 640, h: 480, zoom: 2 } }),
			platform
		});
		expect(handled).toBe(true);
		expect(cursors.viewportFor(ws, 'board')).toEqual({ x: 10, y: 20, w: 640, h: 480, zoom: 2 });
	});

	it('hooks.message claims but does not record a cursor-viewport frame from an unsubscribed ws', () => {
		const ws = mockWs({ id: 'A' }); // not subscribed to __cursor:board
		const handled = cursors.hooks.message(ws, {
			data: enc({ type: 'cursor-viewport', topic: 'board', rect: { x: 10, y: 20, w: 640, h: 480 } }),
			platform
		});
		expect(handled).toBe(true);                          // claimed, so the app handler skips it
		expect(cursors.viewportFor(ws, 'board')).toBeNull(); // but the rect is not recorded
	});

	it('a viewport frame broadcasts nothing', () => {
		const ws = mockWs({ id: 'A' });
		ws.subscribe('__cursor:board');
		cursors.hooks.message(ws, {
			data: enc({ type: 'cursor-viewport', topic: 'board', rect: { x: 0, y: 0, w: 1, h: 1 } }),
			platform
		});
		expect(platform.published).toHaveLength(0);
		expect(platform.sent).toHaveLength(0);
	});

	it('remove(ws) tears down the subscriber viewport', () => {
		const ws = mockWs({ id: 'A' });
		cursors.viewport(ws, 'board', { x: 0, y: 0, w: 10, h: 10 });
		expect(cursors.viewportFor(ws, 'board')).not.toBeNull();
		cursors.remove(ws, platform);
		expect(cursors.viewportFor(ws, 'board')).toBeNull();
	});

	it('clear() tears down all subscriber viewports', () => {
		const ws = mockWs({ id: 'A' });
		cursors.viewport(ws, 'board', { x: 0, y: 0, w: 10, h: 10 });
		cursors.clear();
		expect(cursors.viewportFor(ws, 'board')).toBeNull();
	});

	it('stats().viewportsReported counts distinct reporting subscribers', () => {
		const a = mockWs({ id: 'A' });
		const b = mockWs({ id: 'B' });
		expect(cursors.stats().viewportsReported).toBe(0);
		cursors.viewport(a, 'board', { x: 0, y: 0, w: 1, h: 1 });
		cursors.viewport(b, 'board', { x: 0, y: 0, w: 1, h: 1 });
		cursors.viewport(a, 'other', { x: 0, y: 0, w: 1, h: 1 }); // same subscriber, second topic
		expect(cursors.stats().viewportsReported).toBe(2);
	});
});

describe('cursor plugin - backpressure (per-subscriber drop)', () => {
	const CURSOR = '__cursor:board';

	function setup(bpOptions = { enabled: true }) {
		const c = createCursor({
			throttle: 0,
			topicThrottle: 0,
			backpressure: bpOptions,
			select: (ud) => ({ id: ud.id })
		});
		const p = mockWalkPlatform();
		return { c, p };
	}

	it('validates backpressure.maxBufferedBytes', () => {
		expect(() => createCursor({ backpressure: { enabled: true, maxBufferedBytes: 0 } })).toThrow('positive integer');
		expect(() => createCursor({ backpressure: { enabled: true, maxBufferedBytes: 1.5 } })).toThrow('positive integer');
		expect(() => createCursor({ backpressure: { enabled: true, maxBufferedBytes: -1 } })).toThrow('positive integer');
		expect(() => createCursor({ backpressure: { enabled: true } })).not.toThrow(); // default cap
	});

	it('accepts the boolean shorthand and rejects a half-set or mistyped object', () => {
		expect(() => createCursor({ backpressure: true })).not.toThrow();
		expect(() => createCursor({ viewport: true })).not.toThrow();
		// tuning key without enabled is almost certainly a forgotten enabled:true
		expect(() => createCursor({ backpressure: { maxBufferedBytes: 4096 } })).toThrow('enabled');
		expect(() => createCursor({ viewport: { padding: 512 } })).toThrow('enabled');
		// non-boolean, non-object
		expect(() => createCursor({ viewport: 1 })).toThrow('true or an options object');
		expect(() => createCursor({ backpressure: 'x' })).toThrow('true or an options object');
	});

	it('viewport: true / backpressure: true actually engage the walk', () => {
		const c = createCursor({ throttle: 0, topicThrottle: 0, backpressure: true, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const a = mockWs({ id: 'A' });
		p.addSubscriber(a, CURSOR);
		c.update(a, 'board', { x: 1, y: 1 }, p);
		expect(c.stats().perSubscriberFlushes).toBe(1); // shorthand enabled backpressure -> walk
	});

	it('routes through the per-subscriber walk (sends), not the shared frame, for positions', () => {
		const { c, p } = setup();
		const a = mockWs({ id: 'A' });
		const b = mockWs({ id: 'B' });
		p.addSubscriber(a, CURSOR);
		p.addSubscriber(b, CURSOR);

		c.update(a, 'board', { x: 1, y: 2 }, p);

		// join is still a shared-frame broadcast; positions go per-subscriber.
		expect(p.published.map((e) => e.event)).toEqual(['join']);
		const updates = p.sent.filter((e) => e.event === 'update');
		expect(updates).toHaveLength(2); // delivered to both subscribers individually
		expect(updates.every((e) => e.data.data).valueOf()).toBeTruthy();
		expect(c.stats().perSubscriberFlushes).toBe(1);
		expect(c.stats().bpSkips).toBe(0);
	});

	it('skips a subscriber over the cap and lets it catch up on the next flush', () => {
		const { c, p } = setup({ enabled: true, maxBufferedBytes: 1024 });
		const a = mockWs({ id: 'A' });
		const slow = mockWs({ id: 'S' });
		p.addSubscriber(a, CURSOR);
		p.addSubscriber(slow, CURSOR);
		p.setBuffered(slow, 4096); // over the 1 KiB cap

		c.update(a, 'board', { x: 1, y: 1 }, p);
		expect(p.sentTo(slow)).toHaveLength(0); // skipped
		expect(p.sentTo(a)).toHaveLength(1); // healthy subscriber unaffected
		expect(c.stats().bpSkips).toBe(1);

		// Next flush, the slow consumer has drained below the cap: it receives
		// the LATEST position, not a replay of the skipped frame.
		p.reset();
		p.setBuffered(slow, 0);
		c.update(a, 'board', { x: 9, y: 9 }, p);
		const got = p.sentTo(slow);
		expect(got).toHaveLength(1);
		expect(got[0].data.data).toEqual({ x: 9, y: 9 });
		expect(c.stats().bpSkips).toBe(1); // no new skip
	});

	it('a closed/unknown ws reads bufferedAmount 0 and is never falsely skipped', () => {
		const { c, p } = setup({ enabled: true, maxBufferedBytes: 1024 });
		const a = mockWs({ id: 'A' });
		p.addSubscriber(a, CURSOR); // never setBuffered -> reads 0
		c.update(a, 'board', { x: 1, y: 1 }, p);
		expect(p.sentTo(a)).toHaveLength(1);
		expect(c.stats().bpSkips).toBe(0);
	});

	it('coalesces multiple movers into one per-subscriber bulk under topicThrottle', () => {
		vi.useFakeTimers();
		const c = createCursor({ throttle: 0, topicThrottle: 16, backpressure: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const a = mockWs({ id: 'A' });
		const b = mockWs({ id: 'B' });
		const viewer = mockWs({ id: 'V' });
		[a, b, viewer].forEach((ws) => p.addSubscriber(ws, CURSOR));

		c.update(a, 'board', { x: 1, y: 1 }, p);
		c.update(b, 'board', { x: 2, y: 2 }, p);
		expect(p.sent.filter((e) => e.event === 'bulk' || e.event === 'update')).toHaveLength(0); // nothing before the tick

		vi.advanceTimersByTime(16);
		const bulks = p.sent.filter((e) => e.event === 'bulk');
		expect(bulks).toHaveLength(3); // one bulk per subscriber
		expect(bulks[0].data).toHaveLength(2); // both movers coalesced
		vi.useRealTimers();
	});

	it('degrades to the shared frame on a platform without forEachSubscriber (no throw)', () => {
		const c = createCursor({ throttle: 0, topicThrottle: 0, backpressure: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockPlatform(); // minimal: no forEachSubscriber / bufferedAmount
		const a = mockWs({ id: 'A' });
		expect(() => c.update(a, 'board', { x: 1, y: 1 }, p)).not.toThrow();
		// fell back to the shared publish fan-out (join + update on published[])
		expect(p.published.map((e) => e.event)).toEqual(['join', 'update']);
		expect(p.sent).toHaveLength(0);
	});

	it('does not touch the per-subscriber primitives when backpressure is disabled', () => {
		const c = createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const forEachSpy = vi.spyOn(p, 'forEachSubscriber');
		const bufferedSpy = vi.spyOn(p, 'bufferedAmount');
		const a = mockWs({ id: 'A' });
		p.addSubscriber(a, CURSOR);

		c.update(a, 'board', { x: 1, y: 1 }, p);

		expect(forEachSpy).not.toHaveBeenCalled();
		expect(bufferedSpy).not.toHaveBeenCalled();
		// zero-config path: positions on the shared frame, nothing per-subscriber
		expect(p.published.map((e) => e.event)).toEqual(['join', 'update']);
		expect(c.stats().perSubscriberFlushes).toBe(0);
	});

	it('keeps two trackers in one process isolated (factory-closure scratch)', () => {
		const { c: c1, p: p1 } = setup();
		const { c: c2, p: p2 } = setup();
		const a = mockWs({ id: 'A' });
		const b = mockWs({ id: 'B' });
		p1.addSubscriber(a, CURSOR);
		p2.addSubscriber(b, CURSOR);

		c1.update(a, 'board', { x: 11, y: 11 }, p1);
		c2.update(b, 'board', { x: 22, y: 22 }, p2);

		expect(p1.sentTo(a)[0].data.data).toEqual({ x: 11, y: 11 });
		expect(p2.sentTo(b)[0].data.data).toEqual({ x: 22, y: 22 });
		expect(p1.sentTo(b)).toHaveLength(0);
		expect(p2.sentTo(a)).toHaveLength(0);
	});

	it('delivers to every healthy subscriber and skips only the over-cap ones', () => {
		const { c, p } = setup({ enabled: true, maxBufferedBytes: 1024 });
		const mover = mockWs({ id: 'M' });
		const healthy = [mockWs({ id: 'H1' }), mockWs({ id: 'H2' }), mockWs({ id: 'H3' })];
		const slow = [mockWs({ id: 'S1' }), mockWs({ id: 'S2' })];
		[mover, ...healthy, ...slow].forEach((ws) => p.addSubscriber(ws, CURSOR));
		slow.forEach((ws) => p.setBuffered(ws, 99999));

		c.update(mover, 'board', { x: 7, y: 7 }, p);

		// mover + 3 healthy receive; 2 slow skipped.
		expect(p.sent.filter((e) => e.event === 'update')).toHaveLength(4);
		slow.forEach((ws) => expect(p.sentTo(ws)).toHaveLength(0));
		expect(c.stats().bpSkips).toBe(2);
		expect(c.stats().perSubscriberFlushes).toBe(1);
	});
});

describe('cursor plugin - viewport culling', () => {
	const CURSOR = '__cursor:board';

	function viewportTracker(extra = {}) {
		return createCursor({
			throttle: 0,
			topicThrottle: 0,
			viewport: { enabled: true },
			select: (ud) => ({ id: ud.id }),
			...extra
		});
	}

	// Positions delivered to a subscriber, as a sorted "x,y" set, across both
	// the single-mover `update` and coalesced `bulk` wire shapes.
	function deliveredPositions(p, ws) {
		const out = [];
		for (const e of p.sentTo(ws)) {
			if (e.event === 'update') out.push(`${e.data.data.x},${e.data.data.y}`);
			else if (e.event === 'bulk') for (const it of e.data) out.push(`${it.data.x},${it.data.y}`);
		}
		return out.sort();
	}

	it('validates viewport.padding / viewport.cell and position', () => {
		expect(() => createCursor({ viewport: { enabled: true, padding: -1 } })).toThrow('non-negative');
		expect(() => createCursor({ viewport: { enabled: true, cell: 0 } })).toThrow('positive');
		expect(() => createCursor({ viewport: { enabled: true, cell: -5 } })).toThrow('positive');
		expect(() => createCursor({ position: 'bad' })).toThrow('function');
		expect(() => createCursor({ viewport: { enabled: true } })).not.toThrow();
	});

	it('keeps the shared fast path when viewport is enabled but nobody reports a rect', () => {
		const c = viewportTracker();
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' }); // never reports a rect
		p.addSubscriber(viewer, CURSOR);

		c.update(mockWs({ id: 'M' }), 'board', { x: 99999, y: 99999 }, p);

		// Zero reporters -> one shared publish, not an O(connections) walk.
		expect(p.published.map((e) => e.event)).toEqual(['join', 'update']);
		expect(p.sent).toHaveLength(0);
		expect(c.stats().perSubscriberFlushes).toBe(0);
	});

	it('never culls a non-reporting subscriber even when the walk is active', () => {
		const c = viewportTracker();
		const p = mockWalkPlatform();
		const reporter = mockWs({ id: 'R' });
		const nonReporter = mockWs({ id: 'N' });
		p.addSubscriber(reporter, CURSOR);
		p.addSubscriber(nonReporter, CURSOR);
		// The reporter's rect flips the topic onto the per-subscriber walk.
		c.viewport(reporter, 'board', { x: 0, y: 0, w: 10, h: 10, zoom: 1 });

		c.update(mockWs({ id: 'M' }), 'board', { x: 99999, y: 99999 }, p);

		expect(deliveredPositions(p, reporter)).toEqual([]); // culled (far outside)
		expect(deliveredPositions(p, nonReporter)).toEqual(['99999,99999']); // whole-board, never culled
		expect(c.stats().perSubscriberFlushes).toBe(1);
	});

	it('returns to the shared fast path after the last reporter leaves', () => {
		const c = viewportTracker();
		const p = mockWalkPlatform();
		const reporter = mockWs({ id: 'R' });
		p.addSubscriber(reporter, CURSOR);
		c.viewport(reporter, 'board', { x: 0, y: 0, w: 10, h: 10, zoom: 1 });
		c.update(mockWs({ id: 'M' }), 'board', { x: 5, y: 5 }, p);
		expect(c.stats().perSubscriberFlushes).toBe(1); // walked while a reporter existed

		c.remove(reporter, p); // last reporter gone -> reporter count back to 0
		p.reset();
		const viewer = mockWs({ id: 'V2' });
		p.addSubscriber(viewer, CURSOR);
		c.update(mockWs({ id: 'M2' }), 'board', { x: 6, y: 6 }, p);
		// Back on the shared frame.
		expect(p.published.map((e) => e.event)).toContain('update');
		expect(p.sent).toHaveLength(0);
		expect(c.stats().perSubscriberFlushes).toBe(1); // unchanged - no walk this flush
	});

	it('culls movers outside a reporter viewport, keeping the padding band', () => {
		const c = viewportTracker(); // default padding 256
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });

		c.update(mockWs({ id: 'near' }), 'board', { x: 500, y: 500 }, p); // inside
		c.update(mockWs({ id: 'band' }), 'board', { x: 1100, y: 500 }, p); // in 256 padding band
		c.update(mockWs({ id: 'far' }), 'board', { x: 2000, y: 500 }, p); // beyond padding

		expect(deliveredPositions(p, viewer)).toEqual(['1100,500', '500,500']);
		expect(c.stats().culledEntriesDropped).toBe(1); // the far mover, withheld from V
	});

	it('widens the overscan for a zoomed-out subscriber', () => {
		const c = viewportTracker(); // padding 256
		const p = mockWalkPlatform();
		const z1 = mockWs({ id: 'Z1' });
		const zHalf = mockWs({ id: 'ZH' });
		p.addSubscriber(z1, CURSOR);
		p.addSubscriber(zHalf, CURSOR);
		c.viewport(z1, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 }); // band -> 1256
		c.viewport(zHalf, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 0.5 }); // pad 512 -> 1512

		c.update(mockWs({ id: 'M' }), 'board', { x: 1400, y: 500 }, p);

		expect(deliveredPositions(p, z1)).toEqual([]); // 1400 > 1256, culled
		expect(deliveredPositions(p, zHalf)).toEqual(['1400,500']); // 1400 < 1512, delivered
	});

	it('delivers a coordinate-less frame to every subscriber (null-pos always visible)', () => {
		const c = viewportTracker();
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 1, h: 1, zoom: 1 }); // excludes ~everything

		c.update(mockWs({ id: 'M' }), 'board', { stroke: 'abc' }, p); // no x/y -> position null

		expect(p.sentTo(viewer).filter((e) => e.event === 'update')).toHaveLength(1);
		expect(c.stats().culledEntriesDropped).toBe(0); // a null-pos entry is never "dropped"
	});

	it('a position extractor that throws degrades that entry to always-delivered', () => {
		const c = viewportTracker({ position: () => { throw new Error('boom'); } });
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 1, h: 1, zoom: 1 });

		expect(() => c.update(mockWs({ id: 'M' }), 'board', { x: 5, y: 5 }, p)).not.toThrow();
		expect(p.sentTo(viewer).filter((e) => e.event === 'update')).toHaveLength(1);
	});

	it('sends a single visible mover as update and several as bulk, none as nothing', () => {
		vi.useFakeTimers();
		const c = createCursor({ throttle: 0, topicThrottle: 16, viewport: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const one = mockWs({ id: 'one' }); // viewport holds exactly one mover
		const many = mockWs({ id: 'many' }); // holds several
		const none = mockWs({ id: 'none' }); // holds zero
		[one, many, none].forEach((ws) => p.addSubscriber(ws, CURSOR));
		c.viewport(one, 'board', { x: 0, y: 0, w: 10, h: 10, zoom: 1 });
		c.viewport(many, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });
		c.viewport(none, 'board', { x: 50000, y: 50000, w: 10, h: 10, zoom: 1 });

		c.update(mockWs({ id: 'a' }), 'board', { x: 5, y: 5 }, p);
		c.update(mockWs({ id: 'b' }), 'board', { x: 400, y: 400 }, p);
		c.update(mockWs({ id: 'd' }), 'board', { x: 700, y: 700 }, p);
		vi.advanceTimersByTime(16);

		expect(p.sentTo(one).map((e) => e.event)).toEqual(['update']); // just (5,5)
		const manyEv = p.sentTo(many);
		expect(manyEv).toHaveLength(1);
		expect(manyEv[0].event).toBe('bulk');
		expect(manyEv[0].data).toHaveLength(3);
		expect(p.sentTo(none)).toHaveLength(0); // empty slice -> no frame
		vi.useRealTimers();
	});

	// Grid positions and a viewport rect; the visible set is whatever a flat
	// bounds test yields, independent of whether the index was built.
	function gridScenario(c, p, count) {
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 2000, h: 2000, zoom: 1 });
		const pad = 256;
		const expected = [];
		for (let i = 0; i < count; i++) {
			const x = (i * 137) % 4000; // spread across and beyond the rect
			const y = (i * 251) % 4000;
			c.update(mockWs({ id: 'm' + i }), 'board', { x, y }, p);
			if (x >= -pad && x <= 2000 + pad && y >= -pad && y <= 2000 + pad) expected.push(`${x},${y}`);
		}
		return { viewer, expected: expected.sort() };
	}

	it('direct path (below crossover) matches a brute-force bounds test', () => {
		vi.useFakeTimers();
		const c = createCursor({ throttle: 0, topicThrottle: 16, viewport: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const { viewer, expected } = gridScenario(c, p, 20); // < 64 -> direct
		vi.advanceTimersByTime(16);
		expect(deliveredPositions(p, viewer)).toEqual(expected);
		vi.useRealTimers();
	});

	it('indexed path (above crossover) matches the same brute-force bounds test', () => {
		vi.useFakeTimers();
		const c = createCursor({ throttle: 0, topicThrottle: 16, viewport: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const { viewer, expected } = gridScenario(c, p, 600); // > 512 -> indexed
		vi.advanceTimersByTime(16);
		expect(deliveredPositions(p, viewer)).toEqual(expected);
		vi.useRealTimers();
	});

	it('delivers everything (no blank board) for a degenerate wide viewport (deliver-all clamp)', () => {
		vi.useFakeTimers();
		const c = createCursor({ throttle: 0, topicThrottle: 16, viewport: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		// A huge rect spans far more cells than there are movers -> clamp to all.
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 100000, h: 100000, zoom: 1 });
		const COUNT = 600; // > 512 -> indexed path where the clamp lives
		for (let i = 0; i < COUNT; i++) c.update(mockWs({ id: 'm' + i }), 'board', { x: i, y: i }, p);
		// A mover far outside the rect a precise cull would drop: the clamp must
		// still deliver it (over-deliver to bound cost), proving no blank board.
		c.update(mockWs({ id: 'far' }), 'board', { x: 9999999, y: 9999999 }, p);
		vi.advanceTimersByTime(16);
		const bulks = p.sentTo(viewer).filter((e) => e.event === 'bulk');
		expect(bulks).toHaveLength(1);
		expect(bulks[0].data).toHaveLength(COUNT + 1); // all delivered, incl. the far one
		vi.useRealTimers();
	});

	it('coalesces cross-task-boundary movers into one culled bulk', async () => {
		vi.useFakeTimers();
		const c = createCursor({ throttle: 0, topicThrottle: 16, viewport: { enabled: true }, select: (ud) => ({ id: ud.id }) });
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });

		// Half inside the rect, half far outside, each across a microtask boundary.
		for (let i = 0; i < 10; i++) {
			const inside = i % 2 === 0;
			c.update(mockWs({ id: 'm' + i }), 'board', { x: inside ? 100 + i : 90000, y: 100 }, p);
			await Promise.resolve();
		}
		vi.advanceTimersByTime(16);
		const bulks = p.sentTo(viewer).filter((e) => e.event === 'bulk');
		expect(bulks).toHaveLength(1);
		expect(bulks[0].data).toHaveLength(5); // only the 5 inside survive the cull
		vi.useRealTimers();
	});

	it('broadcasts remove to every subscriber, even one culling that cursor', () => {
		const c = viewportTracker();
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		const mover = mockWs({ id: 'M' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 1, h: 1, zoom: 1 }); // excludes the mover
		c.update(mover, 'board', { x: 9000, y: 9000 }, p);

		c.remove(mover, p);
		// remove is a shared-frame broadcast (never culled), so it reaches everyone.
		expect(p.published.filter((e) => e.event === 'remove')).toHaveLength(1);
	});

	it('composes with backpressure: an over-cap reporter is skipped before culling', () => {
		const c = createCursor({
			throttle: 0, topicThrottle: 0,
			viewport: { enabled: true },
			backpressure: { enabled: true, maxBufferedBytes: 1024 },
			select: (ud) => ({ id: ud.id })
		});
		const p = mockWalkPlatform();
		const healthy = mockWs({ id: 'H' });
		const slow = mockWs({ id: 'S' });
		[healthy, slow].forEach((ws) => p.addSubscriber(ws, CURSOR));
		c.viewport(healthy, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });
		c.viewport(slow, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });
		p.setBuffered(slow, 99999);

		c.update(mockWs({ id: 'M' }), 'board', { x: 500, y: 500 }, p);

		expect(deliveredPositions(p, healthy)).toEqual(['500,500']);
		expect(p.sentTo(slow)).toHaveLength(0);
		expect(c.stats().bpSkips).toBe(1);
	});

	it('tears down per-flush scratch and viewports on clear(); the tracker still works after', () => {
		const c = viewportTracker();
		const p = mockWalkPlatform();
		const viewer = mockWs({ id: 'V' });
		p.addSubscriber(viewer, CURSOR);
		c.viewport(viewer, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });
		c.update(mockWs({ id: 'M' }), 'board', { x: 100, y: 100 }, p);
		expect(c.stats().viewportsReported).toBe(1);

		c.clear();
		expect(c.stats().viewportsReported).toBe(0);
		expect(c.viewportFor(viewer, 'board')).toBeNull();

		// Re-arm and flush again - scratch was reset, not corrupted.
		const v2 = mockWs({ id: 'V2' });
		p.addSubscriber(v2, CURSOR);
		p.reset();
		c.viewport(v2, 'board', { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 });
		c.update(mockWs({ id: 'M2' }), 'board', { x: 200, y: 200 }, p);
		expect(deliveredPositions(p, v2)).toEqual(['200,200']);
	});
});
