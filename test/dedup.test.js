import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDedup } from '../plugins/dedup/server.js';

describe('createDedup', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe('API surface', () => {
		it('returns the documented surface', () => {
			const d = createDedup({ ttl: 1000 });
			expect(typeof d.claim).toBe('function');
			expect(typeof d.has).toBe('function');
			expect(typeof d.delete).toBe('function');
			expect(typeof d.size).toBe('function');
			expect(typeof d.clear).toBe('function');
		});

		it('starts empty', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.size()).toBe(0);
			expect(d.has('any')).toBe(false);
		});
	});

	describe('input validation', () => {
		it('throws when options is missing', () => {
			expect(() => createDedup()).toThrow('options object is required');
		});

		it('throws when ttl is missing or invalid', () => {
			expect(() => createDedup({})).toThrow('ttl');
			expect(() => createDedup({ ttl: 0 })).toThrow('positive');
			expect(() => createDedup({ ttl: -1 })).toThrow('positive');
			expect(() => createDedup({ ttl: NaN })).toThrow('positive');
			expect(() => createDedup({ ttl: '1000' })).toThrow('positive');
		});

		it('throws when maxEntries is invalid', () => {
			expect(() => createDedup({ ttl: 1000, maxEntries: 0 })).toThrow('positive integer');
			expect(() => createDedup({ ttl: 1000, maxEntries: 1.5 })).toThrow('positive integer');
		});

		it('throws when id is empty or non-string', () => {
			const d = createDedup({ ttl: 1000 });
			expect(() => d.claim('')).toThrow('non-empty string');
			expect(() => d.claim(undefined)).toThrow('non-empty string');
			expect(() => d.has(123)).toThrow('non-empty string');
			expect(() => d.delete(null)).toThrow('non-empty string');
		});
	});

	describe('claim', () => {
		it('returns true on first sight', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.claim('msg-1')).toBe(true);
		});

		it('returns false on duplicate claim within the window', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.claim('msg-1')).toBe(true);
			expect(d.claim('msg-1')).toBe(false);
			expect(d.claim('msg-1')).toBe(false);
		});

		it('returns true again after the window expires', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.claim('msg-1')).toBe(true);
			vi.advanceTimersByTime(2000);
			expect(d.claim('msg-1')).toBe(true);
		});

		it('does NOT extend the window on duplicate claim (fixed-window TTL)', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('msg-1');
			vi.advanceTimersByTime(800);
			expect(d.claim('msg-1')).toBe(false);
			vi.advanceTimersByTime(300);
			// 1100ms total from first claim - already past the window.
			expect(d.claim('msg-1')).toBe(true);
		});

		it('treats different ids independently', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.claim('a')).toBe(true);
			expect(d.claim('b')).toBe(true);
			expect(d.claim('a')).toBe(false);
			expect(d.claim('b')).toBe(false);
			expect(d.size()).toBe(2);
		});
	});

	describe('has', () => {
		it('returns false for unknown ids', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.has('missing')).toBe(false);
		});

		it('returns true for live entries', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('msg-1');
			expect(d.has('msg-1')).toBe(true);
		});

		it('returns false and prunes expired entries', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('msg-1');
			vi.advanceTimersByTime(2000);
			expect(d.size()).toBe(1);
			expect(d.has('msg-1')).toBe(false);
			expect(d.size()).toBe(0);
		});

		it('exact-boundary expiry (now == expiresAt) treats entry as expired', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('msg-1');
			vi.advanceTimersByTime(1000);
			expect(d.has('msg-1')).toBe(false);
		});
	});

	describe('delete', () => {
		it('returns true and removes a live entry', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('msg-1');
			expect(d.delete('msg-1')).toBe(true);
			expect(d.has('msg-1')).toBe(false);
			expect(d.claim('msg-1')).toBe(true);
		});

		it('returns false for a missing id', () => {
			const d = createDedup({ ttl: 1000 });
			expect(d.delete('missing')).toBe(false);
		});

		it('returns false for an expired entry but still removes it', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('msg-1');
			vi.advanceTimersByTime(2000);
			expect(d.delete('msg-1')).toBe(false);
			expect(d.size()).toBe(0);
		});
	});

	describe('size and clear', () => {
		it('size reflects retained entries', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('a');
			d.claim('b');
			d.claim('c');
			expect(d.size()).toBe(3);
		});

		it('clear forgets everything', () => {
			const d = createDedup({ ttl: 1000 });
			d.claim('a');
			d.claim('b');
			d.clear();
			expect(d.size()).toBe(0);
			expect(d.claim('a')).toBe(true);
			expect(d.claim('b')).toBe(true);
		});
	});

	describe('eviction', () => {
		it('prunes expired entries when over 110% of maxEntries', () => {
			const d = createDedup({ ttl: 100, maxEntries: 5 });
			for (let i = 0; i < 5; i++) d.claim('old' + i);
			expect(d.size()).toBe(5);
			vi.advanceTimersByTime(200);

			// Push past 110% of maxEntries (= 5.5) by claiming 2 fresh ids.
			d.claim('new1');
			d.claim('new2');

			expect(d.size()).toBe(2);
			expect(d.has('new1')).toBe(true);
			expect(d.has('new2')).toBe(true);
			expect(d.has('old0')).toBe(false);
		});

		it('hard-evicts oldest entries when over cap with no expired entries', () => {
			const d = createDedup({ ttl: 60_000, maxEntries: 3 });
			d.claim('a');
			d.claim('b');
			d.claim('c');
			d.claim('d');
			d.claim('e');

			expect(d.size()).toBeLessThanOrEqual(3);
			expect(d.has('e')).toBe(true);
			// 'a' was the oldest; evicted by the time 'e' arrived.
			expect(d.has('a')).toBe(false);
		});
	});
});
