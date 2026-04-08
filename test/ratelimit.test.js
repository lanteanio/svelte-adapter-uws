import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRateLimit } from '../plugins/ratelimit/server.js';

/**
 * Create a mock WebSocket that mimics the uWS/vite wrapper API.
 * @param {Record<string, any>} userData
 */
function mockWs(userData = {}) {
	return {
		getUserData: () => userData
	};
}

describe('ratelimit plugin', () => {
	let limiter;

	beforeEach(() => {
		vi.restoreAllMocks();
		limiter = createRateLimit({ points: 5, interval: 1000 });
	});

	describe('createRateLimit', () => {
		it('returns a rate limiter with the expected API', () => {
			expect(typeof limiter.consume).toBe('function');
			expect(typeof limiter.reset).toBe('function');
			expect(typeof limiter.ban).toBe('function');
			expect(typeof limiter.unban).toBe('function');
			expect(typeof limiter.clear).toBe('function');
		});

		it('throws on missing options', () => {
			expect(() => createRateLimit()).toThrow('options object is required');
		});

		it('throws on non-positive points', () => {
			expect(() => createRateLimit({ points: 0, interval: 1000 })).toThrow('positive integer');
			expect(() => createRateLimit({ points: -1, interval: 1000 })).toThrow('positive integer');
			expect(() => createRateLimit({ points: 1.5, interval: 1000 })).toThrow('positive integer');
		});

		it('throws on non-positive interval', () => {
			expect(() => createRateLimit({ points: 5, interval: 0 })).toThrow('positive number');
			expect(() => createRateLimit({ points: 5, interval: -100 })).toThrow('positive number');
		});

		it('throws on negative blockDuration', () => {
			expect(() => createRateLimit({ points: 5, interval: 1000, blockDuration: -1 })).toThrow('non-negative');
		});

		it('throws on invalid keyBy', () => {
			expect(() => createRateLimit({ points: 5, interval: 1000, keyBy: 'bad' })).toThrow('keyBy');
		});

		it('accepts valid options without throwing', () => {
			expect(() => createRateLimit({ points: 10, interval: 500 })).not.toThrow();
			expect(() => createRateLimit({ points: 1, interval: 100, blockDuration: 0, keyBy: 'connection' })).not.toThrow();
			expect(() => createRateLimit({ points: 1, interval: 100, keyBy: () => 'custom' })).not.toThrow();
		});
	});

	describe('consume - basic token bucket', () => {
		it('first consume is allowed and decrements remaining', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			const result = limiter.consume(ws);

			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(4);
			expect(result.resetMs).toBeGreaterThan(0);
		});

		it('consuming all points succeeds', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			for (let i = 0; i < 5; i++) {
				expect(limiter.consume(ws).allowed).toBe(true);
			}
			expect(limiter.consume(ws).remaining).toBe(0);
		});

		it('exceeding points is rejected', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			for (let i = 0; i < 5; i++) limiter.consume(ws);

			const result = limiter.consume(ws);
			expect(result.allowed).toBe(false);
		});

		it('custom cost deducts multiple points', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			const result = limiter.consume(ws, 3);

			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(2);
		});

		it('cost exceeding remaining is rejected without deducting', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			limiter.consume(ws, 4); // 1 left

			const result = limiter.consume(ws, 2);
			expect(result.allowed).toBe(false);
		});

		it('throws on negative cost', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			expect(() => limiter.consume(ws, -1)).toThrow('non-negative finite number');
		});

		it('throws on NaN cost', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			expect(() => limiter.consume(ws, NaN)).toThrow('non-negative finite number');
		});

		it('throws on Infinity cost', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			expect(() => limiter.consume(ws, Infinity)).toThrow('non-negative finite number');
		});

		it('allows zero cost (no-op consume)', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			const result = limiter.consume(ws, 0);
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(5);
		});
	});

	describe('consume - refill', () => {
		it('refills after interval passes', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			// Exhaust
			for (let i = 0; i < 5; i++) limiter.consume(ws);
			expect(limiter.consume(ws).allowed).toBe(false);

			// Advance past interval
			Date.now.mockReturnValue(now + 1001);
			const result = limiter.consume(ws);
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(4);
		});

		it('partial interval does not refill', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			for (let i = 0; i < 5; i++) limiter.consume(ws);

			Date.now.mockReturnValue(now + 500);
			expect(limiter.consume(ws).allowed).toBe(false);
		});
	});

	describe('consume - auto-ban', () => {
		it('bans when points exhausted and blockDuration set', () => {
			const rl = createRateLimit({ points: 2, interval: 1000, blockDuration: 5000 });
			const ws = mockWs({ ip: '1.2.3.4' });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			rl.consume(ws);
			rl.consume(ws);
			const result = rl.consume(ws);

			expect(result.allowed).toBe(false);
			expect(result.resetMs).toBe(5000);
		});

		it('ban expires after blockDuration', () => {
			const rl = createRateLimit({ points: 2, interval: 1000, blockDuration: 5000 });
			const ws = mockWs({ ip: '1.2.3.4' });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			rl.consume(ws);
			rl.consume(ws);
			rl.consume(ws); // triggers ban

			Date.now.mockReturnValue(now + 5001);
			const result = rl.consume(ws);
			expect(result.allowed).toBe(true);
		});

		it('during ban, resetMs reflects ban expiry', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, blockDuration: 3000 });
			const ws = mockWs({ ip: '1.2.3.4' });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			rl.consume(ws);
			rl.consume(ws); // triggers ban

			Date.now.mockReturnValue(now + 1000);
			const result = rl.consume(ws);
			expect(result.allowed).toBe(false);
			expect(result.resetMs).toBe(2000);
		});
	});

	describe('keyBy modes', () => {
		it('ip mode: same IP shares bucket', () => {
			const ws1 = mockWs({ ip: '1.2.3.4' });
			const ws2 = mockWs({ ip: '1.2.3.4' });

			limiter.consume(ws1, 3);
			const result = limiter.consume(ws2, 1);
			expect(result.remaining).toBe(1);
		});

		it('ip mode: different IPs get separate buckets', () => {
			const ws1 = mockWs({ ip: '1.2.3.4' });
			const ws2 = mockWs({ ip: '5.6.7.8' });

			limiter.consume(ws1, 5);
			expect(limiter.consume(ws1).allowed).toBe(false);
			expect(limiter.consume(ws2).allowed).toBe(true);
		});

		it('ip mode: falls back to remoteAddress', () => {
			const ws1 = mockWs({ remoteAddress: '10.0.0.1' });
			const ws2 = mockWs({ remoteAddress: '10.0.0.1' });

			limiter.consume(ws1, 4);
			expect(limiter.consume(ws2).remaining).toBe(0);
		});

		it('connection mode: each ws gets its own bucket', () => {
			const rl = createRateLimit({ points: 3, interval: 1000, keyBy: 'connection' });
			const ws1 = mockWs({});
			const ws2 = mockWs({});

			rl.consume(ws1, 3);
			expect(rl.consume(ws1).allowed).toBe(false);
			expect(rl.consume(ws2).allowed).toBe(true);
		});

		it('custom function: uses return value as key', () => {
			const rl = createRateLimit({
				points: 3,
				interval: 1000,
				keyBy: (ws) => ws.getUserData().room
			});
			const ws1 = mockWs({ room: 'A' });
			const ws2 = mockWs({ room: 'A' });
			const ws3 = mockWs({ room: 'B' });

			rl.consume(ws1, 3);
			expect(rl.consume(ws2).allowed).toBe(false); // same room
			expect(rl.consume(ws3).allowed).toBe(true);  // different room
		});

		it('ip mode: unknown userData returns "unknown"', () => {
			const ws = { getUserData: () => null };
			const result = limiter.consume(ws);
			expect(result.allowed).toBe(true);
		});
	});

	describe('reset / ban / unban / clear', () => {
		it('reset clears a key bucket', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			for (let i = 0; i < 5; i++) limiter.consume(ws);
			expect(limiter.consume(ws).allowed).toBe(false);

			limiter.reset('1.2.3.4');
			const result = limiter.consume(ws);
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(4); // 5 points, consumed 1
		});

		it('ban makes consume return false', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			limiter.ban('1.2.3.4', 5000);

			const result = limiter.consume(ws);
			expect(result.allowed).toBe(false);
			expect(result.resetMs).toBeGreaterThan(0);
		});

		it('ban defaults to blockDuration, then 60s', () => {
			const rl = createRateLimit({ points: 5, interval: 1000, blockDuration: 2000 });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			rl.ban('key1');
			const ws = mockWs({ ip: 'key1' });
			const result = rl.consume(ws);
			expect(result.resetMs).toBe(2000);

			// Without blockDuration, defaults to 60s
			limiter.ban('key2');
			const ws2 = mockWs({ ip: 'key2' });
			const result2 = limiter.consume(ws2);
			expect(result2.resetMs).toBeLessThanOrEqual(60000);
		});

		it('unban allows consume again', () => {
			const ws = mockWs({ ip: '1.2.3.4' });
			// Consume once to create a bucket with tokens, then ban
			limiter.consume(ws); // 4 remaining
			limiter.ban('1.2.3.4', 60000);
			expect(limiter.consume(ws).allowed).toBe(false);

			limiter.unban('1.2.3.4');
			expect(limiter.consume(ws).allowed).toBe(true); // 3 remaining
		});

		it('operations on unknown keys are safe', () => {
			expect(() => limiter.reset('nope')).not.toThrow();
			expect(() => limiter.ban('nope')).not.toThrow();
			expect(() => limiter.unban('nope')).not.toThrow();
		});

		it('clear resets all state', () => {
			const ws1 = mockWs({ ip: '1.2.3.4' });
			const ws2 = mockWs({ ip: '5.6.7.8' });
			limiter.consume(ws1, 5);
			limiter.consume(ws2, 5);

			limiter.clear();

			const r1 = limiter.consume(ws1);
			expect(r1.allowed).toBe(true);
			expect(r1.remaining).toBe(4); // fresh bucket: 5 - 1
			expect(limiter.consume(ws2).allowed).toBe(true);
		});
	});

	describe('unban', () => {
		it('unbans a previously banned key', () => {
			const rl = createRateLimit({ points: 1, interval: 1000 });
			const ws = mockWs({ remoteAddress: '1.2.3.4' });
			rl.ban('1.2.3.4', 5000);
			expect(rl.consume(ws).allowed).toBe(false);
			rl.unban('1.2.3.4');
			rl.reset('1.2.3.4');
			expect(rl.consume(ws).allowed).toBe(true);
		});

		it('unban on non-existent key is a no-op', () => {
			expect(() => limiter.unban('never-seen')).not.toThrow();
		});
	});

	describe('keyBy ip fallback', () => {
		it('uses remoteAddress from userData', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, keyBy: 'ip' });
			const ws = mockWs({ remoteAddress: '10.0.0.1' });
			rl.consume(ws);
			const r = rl.consume(ws);
			expect(r.allowed).toBe(false);
		});

		it('falls back to ip field', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, keyBy: 'ip' });
			const ws = mockWs({ ip: '10.0.0.2' });
			rl.consume(ws);
			expect(rl.consume(ws).allowed).toBe(false);
		});

		it('falls back to address field', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, keyBy: 'ip' });
			const ws = mockWs({ address: '10.0.0.3' });
			rl.consume(ws);
			expect(rl.consume(ws).allowed).toBe(false);
		});

		it('returns unknown when getUserData returns null', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, keyBy: 'ip' });
			const ws = { getUserData: () => null };
			rl.consume(ws);
			expect(rl.consume(ws).allowed).toBe(false);
		});

		it('returns unknown when ws has no getUserData', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, keyBy: 'ip' });
			const ws = {};
			rl.consume(ws);
			expect(rl.consume(ws).allowed).toBe(false);
		});
	});

	describe('keyBy connection', () => {
		it('assigns unique keys per connection', () => {
			const rl = createRateLimit({ points: 1, interval: 1000, keyBy: 'connection' });
			const ws1 = mockWs();
			const ws2 = mockWs();
			rl.consume(ws1);
			rl.consume(ws2);
			// Each ws gets its own bucket, so second consume on each should fail
			expect(rl.consume(ws1).allowed).toBe(false);
			expect(rl.consume(ws2).allowed).toBe(false);
		});

		it('reuses same key for same connection', () => {
			const rl = createRateLimit({ points: 2, interval: 1000, keyBy: 'connection' });
			const ws = mockWs();
			rl.consume(ws);
			const r = rl.consume(ws);
			expect(r.remaining).toBe(0);
		});
	});

	describe('lazy cleanup', () => {
		it('removes expired entries when map exceeds threshold', () => {
			const rl = createRateLimit({ points: 1, interval: 100, keyBy: (ws) => ws.getUserData().id });
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			// Create 1001 entries
			for (let i = 0; i < 1001; i++) {
				rl.consume(mockWs({ id: String(i) }));
			}

			// Advance past interval so all are expired
			Date.now.mockReturnValue(now + 200);

			// Next consume triggers cleanup
			rl.consume(mockWs({ id: 'trigger' }));

			// Verify by checking that old keys got fresh buckets
			const result = rl.consume(mockWs({ id: '0' }));
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(0); // 1 point, just consumed
		});
	});
});
