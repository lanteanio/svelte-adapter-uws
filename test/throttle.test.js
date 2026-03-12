import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttle, debounce } from '../plugins/throttle/server.js';

/**
 * Create a mock platform that records publish calls.
 */
function mockPlatform() {
	const p = {
		published: [],
		publish(topic, event, data) {
			p.published.push({ topic, event, data });
			return true;
		},
		reset() {
			p.published.length = 0;
		}
	};
	return p;
}

describe('throttle plugin', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('throttle - creation', () => {
		it('returns a limiter with the expected API', () => {
			const t = throttle(100);
			expect(t.interval).toBe(100);
			expect(typeof t.publish).toBe('function');
			expect(typeof t.flush).toBe('function');
			expect(typeof t.cancel).toBe('function');
		});

		it('throws on negative interval', () => {
			expect(() => throttle(-1)).toThrow('non-negative finite number');
		});

		it('throws on NaN', () => {
			expect(() => throttle(NaN)).toThrow('non-negative finite number');
		});

		it('throws on Infinity', () => {
			expect(() => throttle(Infinity)).toThrow('non-negative finite number');
		});

		it('throws on non-number', () => {
			expect(() => throttle('100')).toThrow('non-negative finite number');
		});

		it('accepts 0', () => {
			const t = throttle(0);
			expect(t.interval).toBe(0);
		});
	});

	describe('throttle - publish', () => {
		it('sends first call immediately (leading edge)', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0]).toEqual({
				topic: 'cursor',
				event: 'move',
				data: { x: 10 }
			});
		});

		it('defers second call within interval', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });

			// Only the first should have been sent
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data).toEqual({ x: 10 });
		});

		it('sends latest value at interval end (trailing edge)', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });
			t.publish(platform, 'cursor', 'move', { x: 30 });

			vi.advanceTimersByTime(100);

			// Leading (x:10) + trailing (x:30, latest wins)
			expect(platform.published).toHaveLength(2);
			expect(platform.published[1].data).toEqual({ x: 30 });
		});

		it('discards intermediate values (latest wins)', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 1 });
			t.publish(platform, 'cursor', 'move', { x: 2 });
			t.publish(platform, 'cursor', 'move', { x: 3 });
			t.publish(platform, 'cursor', 'move', { x: 4 });

			vi.advanceTimersByTime(100);

			// Only x:1 (leading) and x:4 (trailing) should appear
			expect(platform.published).toHaveLength(2);
			expect(platform.published[0].data).toEqual({ x: 1 });
			expect(platform.published[1].data).toEqual({ x: 4 });
		});

		it('goes idle when no more calls after trailing send', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });

			// Trailing fires at t=100
			vi.advanceTimersByTime(100);
			expect(platform.published).toHaveLength(2);

			// Idle check fires at t=200 -- should not send anything
			vi.advanceTimersByTime(100);
			expect(platform.published).toHaveLength(2);
		});

		it('restarts leading edge after going idle', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			// First burst
			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });
			vi.advanceTimersByTime(100); // trailing fires
			vi.advanceTimersByTime(100); // goes idle

			platform.reset();

			// Second burst -- should get leading edge again
			t.publish(platform, 'cursor', 'move', { x: 100 });
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data).toEqual({ x: 100 });
		});

		it('handles multiple topics independently', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'chat', 'typing', { user: 'Alice' });

			// Both should fire immediately (different topics)
			expect(platform.published).toHaveLength(2);
			expect(platform.published[0].topic).toBe('cursor');
			expect(platform.published[1].topic).toBe('chat');

			// Deferred calls per topic
			t.publish(platform, 'cursor', 'move', { x: 20 });
			t.publish(platform, 'chat', 'typing', { user: 'Bob' });

			vi.advanceTimersByTime(100);

			// Each topic gets its trailing send
			expect(platform.published).toHaveLength(4);
		});

		it('continuous stream sends at interval rate', () => {
			const platform = mockPlatform();
			const t = throttle(50);

			// Simulate rapid publishes every 10ms for 200ms
			for (let i = 0; i < 20; i++) {
				t.publish(platform, 'cursor', 'move', { x: i });
				vi.advanceTimersByTime(10);
			}

			// Should have leading (x:0) + trailing sends at ~50ms intervals
			// Not 20 individual sends
			expect(platform.published.length).toBeLessThan(10);
			expect(platform.published.length).toBeGreaterThanOrEqual(3);

			// First should be x:0 (leading edge)
			expect(platform.published[0].data).toEqual({ x: 0 });
		});
	});

	describe('throttle - flush', () => {
		it('sends pending immediately', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });

			t.flush();

			expect(platform.published).toHaveLength(2);
			expect(platform.published[1].data).toEqual({ x: 20 });
		});

		it('flush(topic) sends only that topic', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'chat', 'typing', { user: 'A' });
			t.publish(platform, 'cursor', 'move', { x: 20 });
			t.publish(platform, 'chat', 'typing', { user: 'B' });

			t.flush('cursor');

			// cursor: leading + flushed trailing
			const cursorMsgs = platform.published.filter(p => p.topic === 'cursor');
			expect(cursorMsgs).toHaveLength(2);
			expect(cursorMsgs[1].data).toEqual({ x: 20 });

			// chat pending should still be there
			vi.advanceTimersByTime(100);
			const chatMsgs = platform.published.filter(p => p.topic === 'chat');
			expect(chatMsgs).toHaveLength(2);
			expect(chatMsgs[1].data).toEqual({ user: 'B' });
		});

		it('flush with no pending is safe', () => {
			const t = throttle(100);
			expect(() => t.flush()).not.toThrow();
			expect(() => t.flush('nonexistent')).not.toThrow();
		});

		it('flush clears timers (no double send)', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });

			t.flush();
			vi.advanceTimersByTime(200);

			// Should be exactly 2: leading + flushed. No timer-based send.
			expect(platform.published).toHaveLength(2);
		});
	});

	describe('throttle - cancel', () => {
		it('discards pending without sending', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'cursor', 'move', { x: 20 });

			t.cancel();
			vi.advanceTimersByTime(200);

			// Only the leading edge send
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data).toEqual({ x: 10 });
		});

		it('cancel(topic) discards only that topic', () => {
			const platform = mockPlatform();
			const t = throttle(100);

			t.publish(platform, 'cursor', 'move', { x: 10 });
			t.publish(platform, 'chat', 'typing', { user: 'A' });
			t.publish(platform, 'cursor', 'move', { x: 20 });
			t.publish(platform, 'chat', 'typing', { user: 'B' });

			t.cancel('cursor');
			vi.advanceTimersByTime(100);

			// cursor: only leading (x:10), trailing was cancelled
			const cursorMsgs = platform.published.filter(p => p.topic === 'cursor');
			expect(cursorMsgs).toHaveLength(1);

			// chat: leading + trailing (not cancelled)
			const chatMsgs = platform.published.filter(p => p.topic === 'chat');
			expect(chatMsgs).toHaveLength(2);
		});

		it('cancel with nothing pending is safe', () => {
			const t = throttle(100);
			expect(() => t.cancel()).not.toThrow();
			expect(() => t.cancel('nonexistent')).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// debounce
	// -----------------------------------------------------------------------

	describe('debounce - creation', () => {
		it('returns a limiter with the expected API', () => {
			const d = debounce(100);
			expect(d.interval).toBe(100);
			expect(typeof d.publish).toBe('function');
			expect(typeof d.flush).toBe('function');
			expect(typeof d.cancel).toBe('function');
		});

		it('throws on negative interval', () => {
			expect(() => debounce(-1)).toThrow('non-negative finite number');
		});

		it('throws on NaN', () => {
			expect(() => debounce(NaN)).toThrow('non-negative finite number');
		});

		it('throws on non-number', () => {
			expect(() => debounce('100')).toThrow('non-negative finite number');
		});
	});

	describe('debounce - publish', () => {
		it('does NOT send immediately', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'hello' });

			expect(platform.published).toHaveLength(0);
		});

		it('sends after interval of silence', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'hello' });
			vi.advanceTimersByTime(100);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0]).toEqual({
				topic: 'search',
				event: 'query',
				data: { q: 'hello' }
			});
		});

		it('resets timer on each new call', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'h' });
			vi.advanceTimersByTime(80);

			d.publish(platform, 'search', 'query', { q: 'he' });
			vi.advanceTimersByTime(80);

			// 160ms total, but only 80ms since last call -- should not fire yet
			expect(platform.published).toHaveLength(0);

			vi.advanceTimersByTime(20);

			// Now 100ms since last call -- fires
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data).toEqual({ q: 'he' });
		});

		it('multiple rapid calls result in one send (latest value)', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'h' });
			d.publish(platform, 'search', 'query', { q: 'he' });
			d.publish(platform, 'search', 'query', { q: 'hel' });
			d.publish(platform, 'search', 'query', { q: 'hell' });
			d.publish(platform, 'search', 'query', { q: 'hello' });

			vi.advanceTimersByTime(100);

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data).toEqual({ q: 'hello' });
		});

		it('handles multiple topics independently', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'a' });
			vi.advanceTimersByTime(50);

			d.publish(platform, 'filter', 'update', { category: 'books' });
			vi.advanceTimersByTime(50);

			// 100ms since 'search', should fire
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].topic).toBe('search');

			vi.advanceTimersByTime(50);

			// 100ms since 'filter', should fire
			expect(platform.published).toHaveLength(2);
			expect(platform.published[1].topic).toBe('filter');
		});

		it('cleans up after firing', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'a' });
			vi.advanceTimersByTime(100);
			expect(platform.published).toHaveLength(1);

			// No extra sends after more time
			vi.advanceTimersByTime(500);
			expect(platform.published).toHaveLength(1);
		});
	});

	describe('debounce - flush', () => {
		it('sends pending immediately', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'hello' });
			d.flush();

			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].data).toEqual({ q: 'hello' });
		});

		it('flush clears timer (no double send)', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'hello' });
			d.flush();
			vi.advanceTimersByTime(200);

			expect(platform.published).toHaveLength(1);
		});
	});

	describe('debounce - cancel', () => {
		it('discards pending without sending', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'hello' });
			d.cancel();
			vi.advanceTimersByTime(200);

			expect(platform.published).toHaveLength(0);
		});

		it('cancel(topic) discards only that topic', () => {
			const platform = mockPlatform();
			const d = debounce(100);

			d.publish(platform, 'search', 'query', { q: 'a' });
			d.publish(platform, 'filter', 'update', { c: 'books' });

			d.cancel('search');
			vi.advanceTimersByTime(100);

			// search was cancelled, filter should fire
			expect(platform.published).toHaveLength(1);
			expect(platform.published[0].topic).toBe('filter');
		});
	});
});
