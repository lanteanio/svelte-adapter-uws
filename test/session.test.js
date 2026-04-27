import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSession } from '../plugins/session/server.js';

describe('createSession', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe('API surface', () => {
		it('returns the documented surface', () => {
			const s = createSession({ ttl: 1000 });
			expect(typeof s.get).toBe('function');
			expect(typeof s.set).toBe('function');
			expect(typeof s.delete).toBe('function');
			expect(typeof s.touch).toBe('function');
			expect(typeof s.size).toBe('function');
			expect(typeof s.clear).toBe('function');
		});

		it('starts empty', () => {
			const s = createSession({ ttl: 1000 });
			expect(s.size()).toBe(0);
			expect(s.get('any')).toBe(null);
		});
	});

	describe('input validation', () => {
		it('throws when options is missing', () => {
			expect(() => createSession()).toThrow('options object is required');
		});

		it('throws when ttl is missing or invalid', () => {
			expect(() => createSession({})).toThrow('ttl');
			expect(() => createSession({ ttl: 0 })).toThrow('positive');
			expect(() => createSession({ ttl: -1 })).toThrow('positive');
			expect(() => createSession({ ttl: NaN })).toThrow('positive');
			expect(() => createSession({ ttl: '1000' })).toThrow('positive');
		});

		it('throws when maxEntries is invalid', () => {
			expect(() => createSession({ ttl: 1000, maxEntries: 0 })).toThrow('positive integer');
			expect(() => createSession({ ttl: 1000, maxEntries: -1 })).toThrow('positive integer');
			expect(() => createSession({ ttl: 1000, maxEntries: 1.5 })).toThrow('positive integer');
		});

		it('throws when token is empty or non-string on get/set/delete/touch', () => {
			const s = createSession({ ttl: 1000 });
			expect(() => s.get('')).toThrow('non-empty string');
			expect(() => s.get(undefined)).toThrow('non-empty string');
			expect(() => s.set('', { a: 1 })).toThrow('non-empty string');
			expect(() => s.delete(123)).toThrow('non-empty string');
			expect(() => s.touch(null)).toThrow('non-empty string');
		});
	});

	describe('basic round-trip', () => {
		it('set then get returns the stored data', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { userId: 42 });
			expect(s.get('tok')).toEqual({ userId: 42 });
		});

		it('get returns null for an unknown token', () => {
			const s = createSession({ ttl: 1000 });
			expect(s.get('missing')).toBe(null);
		});

		it('set replaces existing data', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			s.set('tok', { v: 2 });
			expect(s.get('tok')).toEqual({ v: 2 });
			expect(s.size()).toBe(1);
		});

		it('preserves null and undefined and falsy data values', () => {
			const s = createSession({ ttl: 1000 });
			s.set('a', null);
			s.set('b', 0);
			s.set('c', '');
			s.set('d', false);
			expect(s.get('a')).toBe(null);
			expect(s.get('b')).toBe(0);
			expect(s.get('c')).toBe('');
			expect(s.get('d')).toBe(false);
		});
	});

	describe('TTL expiry', () => {
		it('returns null after ttl elapses with no activity', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(999);
			expect(s.get('tok')).toEqual({ v: 1 });
			vi.advanceTimersByTime(2000);
			expect(s.get('tok')).toBe(null);
		});

		it('expired entry is pruned on access', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(2000);
			expect(s.size()).toBe(1);
			s.get('tok');
			expect(s.size()).toBe(0);
		});

		it('exact-boundary expiry (now == expiresAt) treats entry as expired', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(1000);
			expect(s.get('tok')).toBe(null);
		});
	});

	describe('sliding TTL', () => {
		it('get within the window extends the lifetime by another full ttl', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(800);
			// 800ms in - get refreshes to "now + 1000".
			expect(s.get('tok')).toEqual({ v: 1 });
			vi.advanceTimersByTime(800);
			// Total 1600ms from set, but only 800ms from the refresh - still alive.
			expect(s.get('tok')).toEqual({ v: 1 });
		});

		it('touch refreshes TTL without reading', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(800);
			expect(s.touch('tok')).toBe(true);
			vi.advanceTimersByTime(800);
			expect(s.get('tok')).toEqual({ v: 1 });
		});

		it('touch returns false for missing tokens', () => {
			const s = createSession({ ttl: 1000 });
			expect(s.touch('missing')).toBe(false);
		});

		it('touch returns false for expired entries and removes them', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(2000);
			expect(s.touch('tok')).toBe(false);
			expect(s.size()).toBe(0);
		});
	});

	describe('delete', () => {
		it('returns true when removing a live entry', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			expect(s.delete('tok')).toBe(true);
			expect(s.get('tok')).toBe(null);
		});

		it('returns false for an unknown token', () => {
			const s = createSession({ ttl: 1000 });
			expect(s.delete('missing')).toBe(false);
		});

		it('returns false for an expired entry but still removes it', () => {
			const s = createSession({ ttl: 1000 });
			s.set('tok', { v: 1 });
			vi.advanceTimersByTime(2000);
			expect(s.delete('tok')).toBe(false);
			expect(s.size()).toBe(0);
		});
	});

	describe('size and clear', () => {
		it('size reflects the number of retained entries', () => {
			const s = createSession({ ttl: 1000 });
			s.set('a', 1);
			s.set('b', 2);
			s.set('c', 3);
			expect(s.size()).toBe(3);
		});

		it('clear removes everything', () => {
			const s = createSession({ ttl: 1000 });
			s.set('a', 1);
			s.set('b', 2);
			s.clear();
			expect(s.size()).toBe(0);
			expect(s.get('a')).toBe(null);
		});
	});

	describe('eviction', () => {
		it('prunes expired entries when the map grows past 110% of maxEntries', () => {
			const s = createSession({ ttl: 100, maxEntries: 5 });
			// Insert 5 entries that will all expire.
			for (let i = 0; i < 5; i++) s.set('old' + i, i);
			expect(s.size()).toBe(5);
			vi.advanceTimersByTime(200);

			// Push past 110% of maxEntries (5 * 1.1 = 5.5) by inserting 2 fresh ones.
			s.set('new1', 'fresh');
			s.set('new2', 'fresh');

			// After the second set, prune kicked in: expired entries removed.
			expect(s.size()).toBe(2);
			expect(s.get('new1')).toBe('fresh');
			expect(s.get('new2')).toBe('fresh');
			expect(s.get('old0')).toBe(null);
		});

		it('hard-evicts oldest entries when over cap with no expired entries', () => {
			const s = createSession({ ttl: 60_000, maxEntries: 3 });
			s.set('a', 1);
			s.set('b', 2);
			s.set('c', 3);
			s.set('d', 4); // size 4, over 110% of 3 (= 3.3)? actually 4 > 3.3 -> prunes
			s.set('e', 5);

			// All entries are still live (long ttl), so prune cannot delete anything;
			// hard-eviction must remove the oldest insertion-order entries until size <= maxEntries.
			expect(s.size()).toBeLessThanOrEqual(3);
			expect(s.get('e')).toBe(5);
			// 'a' is the oldest; after the second over-cap insert it should have been evicted.
			expect(s.get('a')).toBe(null);
		});
	});
});
