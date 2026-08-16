import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRateLimit } from '../src/plugins/ratelimit/server.js';
import { installAttribution } from '../src/runtime/utils/attribution.js';
import { mockWs, installFakeRuntimeClock, releaseRuntimeClock } from './_helpers.js';

/**
 * A mock connection whose userData carries the attribution slot exactly as the
 * runtime stamps it at open - through installAttribution, not by poking the
 * symbol - so these cases read the same contract the handler writes.
 * @param {Record<string, unknown>} userData
 * @param {{ tenantId?: string, principalId?: string } | null} attr
 */
function attributedWs(userData, attr) {
	const ws = mockWs(userData);
	installAttribution(attr === null ? null : () => attr, ws.getUserData());
	return ws;
}

describe('ratelimit plugin', () => {
	let limiter;

	beforeEach(() => {
		vi.restoreAllMocks();
		// The limiter reads wall time through the injectable runtime clock; bind
		// it to the global Date.now() so the tests that pin time with
		// vi.spyOn(Date, 'now') move the limiter's clock too.
		installFakeRuntimeClock();
		limiter = createRateLimit({ points: 5, interval: 1000 });
	});

	afterEach(() => {
		releaseRuntimeClock();
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

		it('throws on a non-function tenant resolver', () => {
			expect(() => createRateLimit({ points: 5, interval: 1000, tenant: 'bad' })).toThrow('tenant must be a function');
		});
	});

	describe('tenant scoping', () => {
		it('gives two tenants on the same key independent buckets', () => {
			const lim = createRateLimit({ points: 1, interval: 60000, tenant: (ws) => ws.getUserData().org });
			expect(lim.consume(mockWs({ ip: '9.9.9.9', org: 'a' })).allowed).toBe(true);
			// B is not exhausted by A's consume - separate bucket.
			expect(lim.consume(mockWs({ ip: '9.9.9.9', org: 'b' })).allowed).toBe(true);
			// Each tenant's own bucket (points:1) is now exhausted, independently.
			expect(lim.consume(mockWs({ ip: '9.9.9.9', org: 'a' })).allowed).toBe(false);
			expect(lim.consume(mockWs({ ip: '9.9.9.9', org: 'b' })).allowed).toBe(false);
		});

		it('clear(tenant) drops only that tenant', () => {
			const lim = createRateLimit({ points: 1, interval: 60000, tenant: (ws) => ws.getUserData().org });
			lim.consume(mockWs({ ip: '1.1.1.1', org: 'a' })); // A exhausted
			lim.consume(mockWs({ ip: '1.1.1.1', org: 'b' })); // B exhausted
			lim.clear('a');
			expect(lim.consume(mockWs({ ip: '1.1.1.1', org: 'a' })).allowed).toBe(true); // A cleared
			expect(lim.consume(mockWs({ ip: '1.1.1.1', org: 'b' })).allowed).toBe(false); // B untouched
		});

		it('reset(key, tenant) targets only the tenant-scoped bucket', () => {
			const lim = createRateLimit({ points: 1, interval: 60000, tenant: (ws) => ws.getUserData().org });
			lim.consume(mockWs({ ip: '2.2.2.2', org: 'a' }));
			lim.consume(mockWs({ ip: '2.2.2.2', org: 'b' }));
			lim.reset('2.2.2.2', 'a');
			expect(lim.consume(mockWs({ ip: '2.2.2.2', org: 'a' })).allowed).toBe(true); // A reset
			expect(lim.consume(mockWs({ ip: '2.2.2.2', org: 'b' })).allowed).toBe(false); // B untouched
		});

		it('no tenant resolver -> a shared bucket per key (byte-identical)', () => {
			const lim = createRateLimit({ points: 1, interval: 60000 });
			expect(lim.consume(mockWs({ ip: '3.3.3.3' })).allowed).toBe(true);
			expect(lim.consume(mockWs({ ip: '3.3.3.3' })).allowed).toBe(false); // same bucket, exhausted
		});

		it('rejects a tenant id containing the NUL delimiter (injection-safety)', () => {
			const lim = createRateLimit({ points: 5, interval: 1000, tenant: () => 'a\0b' });
			expect(() => lim.consume(mockWs({ ip: '1.2.3.4' }))).toThrow('NUL byte');
		});
	});

	describe('adapter attribution as the tenant source', () => {
		it('scopes buckets by the attribution tenantId when no tenant option is set', () => {
			const lim = createRateLimit({ points: 1, interval: 60000 });
			expect(lim.consume(attributedWs({ ip: '9.9.9.9' }, { tenantId: 'a' })).allowed).toBe(true);
			// Same IP, different attributed tenant: an independent bucket.
			expect(lim.consume(attributedWs({ ip: '9.9.9.9' }, { tenantId: 'b' })).allowed).toBe(true);
			expect(lim.consume(attributedWs({ ip: '9.9.9.9' }, { tenantId: 'a' })).allowed).toBe(false);
			expect(lim.consume(attributedWs({ ip: '9.9.9.9' }, { tenantId: 'b' })).allowed).toBe(false);
			// The attribution namespace is the same one the tenant option uses,
			// so tenant-scoped admin ops reach attribution-scoped buckets.
			lim.clear('a');
			expect(lim.consume(attributedWs({ ip: '9.9.9.9' }, { tenantId: 'a' })).allowed).toBe(true);
			expect(lim.consume(attributedWs({ ip: '9.9.9.9' }, { tenantId: 'b' })).allowed).toBe(false);
		});

		it('an explicit tenant option overrides the attribution slot', () => {
			const lim = createRateLimit({ points: 1, interval: 60000, tenant: (ws) => ws.getUserData().org });
			const wsA = attributedWs({ ip: '8.8.8.8', org: 'resolver-org' }, { tenantId: 'slot-org' });
			expect(lim.consume(wsA).allowed).toBe(true);
			// Exhausted under the RESOLVER's org: a connection attributed to the
			// slot org but resolving to the same resolver org shares the bucket...
			const wsB = attributedWs({ ip: '8.8.8.8', org: 'resolver-org' }, { tenantId: 'other-slot' });
			expect(lim.consume(wsB).allowed).toBe(false);
			// ...and the slot org's namespace was never touched.
			lim.clear('slot-org');
			expect(lim.consume(wsA).allowed).toBe(false);
		});

		it('neither option nor attribution stays byte-identical single-tenant', () => {
			const lim = createRateLimit({ points: 1, interval: 60000 });
			expect(lim.consume(attributedWs({ ip: '7.7.7.7' }, null)).allowed).toBe(true);
			// A second unattributed connection from the same IP hits the SAME
			// bucket under the SAME raw key an unscoped limiter would use:
			// reset() with no tenant frees it, proving no scoping was applied.
			expect(lim.consume(attributedWs({ ip: '7.7.7.7' }, null)).allowed).toBe(false);
			lim.reset('7.7.7.7');
			expect(lim.consume(attributedWs({ ip: '7.7.7.7' }, null)).allowed).toBe(true);
		});

		it('an attribution without a tenantId reads as unscoped', () => {
			const lim = createRateLimit({ points: 1, interval: 60000 });
			expect(lim.consume(attributedWs({ ip: '6.6.6.6' }, { principalId: 'p1' })).allowed).toBe(true);
			expect(lim.consume(attributedWs({ ip: '6.6.6.6' }, null)).allowed).toBe(false);
		});
	});

	describe('budget scoping', () => {
		it('throws on an unknown budget value', () => {
			expect(() => createRateLimit({ points: 5, interval: 1000, budget: 'global' }))
				.toThrow("budget must be 'principal' or 'tenant'");
		});

		it("budget:'tenant' shares one bucket across differently-keyed connections of one tenant and separates tenants", () => {
			const lim = createRateLimit({
				points: 2,
				interval: 60000,
				budget: 'tenant',
				tenant: (ws) => ws.getUserData().org
			});
			// Two DIFFERENT IPs, one tenant: both draw from the same allowance.
			expect(lim.consume(mockWs({ ip: '1.1.1.1', org: 'a' })).allowed).toBe(true);
			expect(lim.consume(mockWs({ ip: '2.2.2.2', org: 'a' })).allowed).toBe(true);
			expect(lim.consume(mockWs({ ip: '3.3.3.3', org: 'a' })).allowed).toBe(false);
			// A different tenant is untouched by tenant a's exhaustion.
			expect(lim.consume(mockWs({ ip: '1.1.1.1', org: 'b' })).allowed).toBe(true);
		});

		it("budget:'tenant' works from the adapter attribution when no tenant option is set", () => {
			const lim = createRateLimit({ points: 1, interval: 60000, budget: 'tenant' });
			expect(lim.consume(attributedWs({ ip: '1.1.1.1' }, { tenantId: 'a' })).allowed).toBe(true);
			expect(lim.consume(attributedWs({ ip: '2.2.2.2' }, { tenantId: 'a' })).allowed).toBe(false);
			expect(lim.consume(attributedWs({ ip: '1.1.1.1' }, { tenantId: 'b' })).allowed).toBe(true);
		});

		it("budget:'tenant' refuses a connection with no tenant id, naming what to add", () => {
			const lim = createRateLimit({ points: 5, interval: 1000, budget: 'tenant' });
			expect(() => lim.consume(attributedWs({ ip: '1.2.3.4' }, null)))
				.toThrow(/tenant.*option|attribution/);
			let message = '';
			try {
				lim.consume(attributedWs({ ip: '1.2.3.4' }, null));
			} catch (err) {
				message = /** @type {Error} */ (err).message;
			}
			expect(message).toContain('tenant');
			expect(message).toContain('attribution');
		});

		it("clear(tenant) drops the shared budget bucket under budget:'tenant'", () => {
			const lim = createRateLimit({
				points: 1,
				interval: 60000,
				budget: 'tenant',
				tenant: (ws) => ws.getUserData().org
			});
			lim.consume(mockWs({ ip: '1.1.1.1', org: 'a' }));
			expect(lim.consume(mockWs({ ip: '2.2.2.2', org: 'a' })).allowed).toBe(false);
			lim.clear('a');
			expect(lim.consume(mockWs({ ip: '2.2.2.2', org: 'a' })).allowed).toBe(true);
		});

		it("clear(tenant) under budget:'principal' never touches an unscoped bucket whose raw key equals the id", () => {
			// Raw keys are not derived from tenant ids, so a custom key can
			// legitimately EQUAL one. A tenant-aimed clear that deleted it
			// would lift that unrelated connection's ban - amnesty across the
			// namespace boundary.
			const lim = createRateLimit({
				points: 1,
				interval: 60000,
				blockDuration: 60000,
				keyBy: (ws) => ws.getUserData().key,
				tenant: (ws) => ws.getUserData().org ?? null
			});
			// Unscoped connection whose raw key is the string 'acme'; exhaust
			// it into its ban.
			expect(lim.consume(mockWs({ key: 'acme' })).allowed).toBe(true);
			expect(lim.consume(mockWs({ key: 'acme' })).allowed).toBe(false);
			// Tenant-aimed clear for tenant 'acme' must not lift that ban.
			lim.clear('acme');
			expect(lim.consume(mockWs({ key: 'acme' })).allowed).toBe(false);
		});

		it("admin ops under budget:'tenant' address the tenant's one bucket by the tenant argument", () => {
			const lim = createRateLimit({
				points: 2,
				interval: 60000,
				budget: 'tenant',
				tenant: (ws) => ws.getUserData().org
			});
			// Seed tenant a's shared bucket with one consume (1 point left),
			// then ban it: the key argument is not read in this mode; the
			// tenant IS the bucket.
			expect(lim.consume(mockWs({ ip: '1.1.1.1', org: 'a' })).allowed).toBe(true);
			lim.ban('ignored-key', 60000, 'a');
			expect(lim.consume(mockWs({ ip: '2.2.2.2', org: 'a' })).allowed).toBe(false);
			expect(lim.consume(mockWs({ ip: '1.1.1.1', org: 'b' })).allowed).toBe(true);
			// unban restores the non-banned state; the remaining allowance
			// (one point) is drawable again.
			lim.unban('ignored-key', 'a');
			expect(lim.consume(mockWs({ ip: '3.3.3.3', org: 'a' })).allowed).toBe(true);
			expect(lim.consume(mockWs({ ip: '3.3.3.3', org: 'a' })).allowed).toBe(false);
			// reset drops the tenant's shared bucket entirely: the full
			// allowance returns.
			lim.reset('ignored-key', 'a');
			expect(lim.consume(mockWs({ ip: '4.4.4.4', org: 'a' })).allowed).toBe(true);
		});

		it("admin ops under budget:'tenant' refuse a call with no tenant id, in admin wording", () => {
			const lim = createRateLimit({ points: 1, interval: 60000, budget: 'tenant' });
			for (const call of [() => lim.reset('k'), () => lim.ban('k', 1000), () => lim.unban('k')]) {
				let message = '';
				try { call(); } catch (err) { message = /** @type {Error} */ (err).message; }
				expect(message).toContain('tenantId argument');
				// The consume path's connection wording would misdirect an
				// admin caller toward the attribution hook.
				expect(message).not.toContain('this one has none');
			}
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

	describe('maxBuckets cap', () => {
		it('rejects invalid maxBuckets', () => {
			expect(() => createRateLimit({ points: 1, interval: 1000, maxBuckets: 0 }))
				.toThrow('maxBuckets must be a positive integer');
			expect(() => createRateLimit({ points: 1, interval: 1000, maxBuckets: -1 }))
				.toThrow('maxBuckets must be a positive integer');
			expect(() => createRateLimit({ points: 1, interval: 1000, maxBuckets: 1.5 }))
				.toThrow('maxBuckets must be a positive integer');
		});

		it('rejects invalid evictionSample', () => {
			expect(() => createRateLimit({ points: 1, interval: 1000, evictionSample: 0 }))
				.toThrow('evictionSample must be a positive integer');
			expect(() => createRateLimit({ points: 1, interval: 1000, evictionSample: 2.5 }))
				.toThrow('evictionSample must be a positive integer');
		});

		it('rejects a non-function onEvict', () => {
			expect(() => createRateLimit({ points: 1, interval: 1000, onEvict: 'nope' }))
				.toThrow('onEvict must be a function');
		});

		it('reports the evicted key, and ties fall to the earliest sampled entry', () => {
			// Tiny cap to make the saturation path testable in unit time.
			const evicted = [];
			const rl = createRateLimit({
				points: 1,
				interval: 60_000,
				maxBuckets: 2,
				onEvict: (e) => evicted.push(e)
			});

			// Pin Date.now so the lazy expired-entry sweep does not free
			// any slots: every bucket is unexpired.
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			rl.consume(mockWs({ ip: 'a' }));
			rl.consume(mockWs({ ip: 'b' }));
			// At cap, and both candidates are equally active, so the earliest
			// one sampled loses.
			rl.consume(mockWs({ ip: 'c' }));

			expect(evicted).toEqual([{ key: 'a', banned: false }]);

			// 'b' is untouched: still at its post-consume state (allowed: false,
			// because its single point was already drained).
			expect(rl.consume(mockWs({ ip: 'b' })).allowed).toBe(false);
		});

		it('evicts an unbanned bucket rather than a banned one, so key churn cannot clear a ban', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 2,
				interval: 1000,
				blockDuration: 30_000,
				maxBuckets: 2,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// 'a' exhausts its allowance and earns a 30 s ban.
			const wsA = mockWs({ ip: 'a' });
			rl.consume(wsA);
			rl.consume(wsA);
			expect(rl.consume(wsA).resetMs).toBe(30_000);

			// 'b' fills the map to the cap. It is deliberately made both busier than
			// the banned key and the only one still inside its window, so neither the
			// activity nor the expiry preference can be what saves 'a' here.
			const wsB = mockWs({ ip: 'b' });
			rl.consume(wsB);
			rl.consume(wsB);
			Date.now.mockReturnValue(2100);
			rl.consume(wsB);
			rl.consume(wsB);

			// A third identity forces an eviction.
			rl.consume(mockWs({ ip: 'c' }));

			expect(evicted).toEqual([{ key: 'b', banned: false }]);

			// 'a' is still serving its ban, with the time it had left.
			const aAgain = rl.consume(wsA);
			expect(aAgain.allowed).toBe(false);
			expect(aAgain.resetMs).toBe(28_900);
		});

		it('does not prefer a banned bucket even when it is the least active one', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 1,
				interval: 60_000,
				maxBuckets: 2,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// A ban placed on a key that has never sent a message: nothing in the map
			// is less active, so only its ban keeps it out of the victim pool.
			rl.ban('a', 30_000);
			rl.consume(mockWs({ ip: 'b' }));
			rl.consume(mockWs({ ip: 'c' }));

			expect(evicted).toEqual([{ key: 'b', banned: false }]);
			expect(rl.consume(mockWs({ ip: 'a' })).resetMs).toBe(30_000);
		});

		it('evicts the most recently placed ban only when every sampled candidate is banned, and flags it', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 1,
				interval: 60_000,
				maxBuckets: 2,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			rl.ban('a', 30_000);
			rl.ban('b', 60_000);
			rl.consume(mockWs({ ip: 'c' }));

			// Nothing unbanned to take, so the bound wins - and the lost enforcement
			// is reported rather than silent. The ban that goes is the one placed
			// last, so a key that keeps earning fresh bans can only ever evict its
			// own. Both were placed in the same millisecond here, which is exactly
			// the case a timestamp comparison could not have decided at all.
			expect(evicted).toEqual([{ key: 'b', banned: true }]);

			// The ban that was already in the map is untouched.
			expect(rl.consume(mockWs({ ip: 'a' })).resetMs).toBe(30_000);
		});

		it('does not let identity churn that earns its own bans clear an older ban', () => {
			// A cap below the default evictionSample of 16, so the sampling loop
			// wraps and every eviction sees the whole map: the exhaustive regime,
			// where sample-max and map-max are the same entry. The sampled regime
			// - a cap far above the sample, which is the shipped default shape -
			// is covered by the three tests below.
			const evicted = [];
			const rl = createRateLimit({
				points: 2,
				interval: 1000,
				blockDuration: 60_000,
				maxBuckets: 8,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// 'a' spends its allowance and earns a sixty-second ban.
			const wsA = mockWs({ ip: 'a' });
			for (let i = 0; i < 3; i++) rl.consume(wsA);
			expect(rl.consume(wsA).allowed).toBe(false);

			// Forty throwaway identities, each spending the three messages it takes
			// to auto-ban itself. That fills the map with bans, so every eviction
			// candidate is banned and the last-resort rule is the only thing between
			// 'a' and a fresh allowance. Picking the soonest-expiring ban there would
			// hand the flood precisely the oldest ban in the map, which is 'a'.
			for (let i = 0; i < 40; i++) {
				Date.now.mockReturnValue(1001 + i);
				const ws = mockWs({ ip: 'churn-' + i });
				for (let j = 0; j < 3; j++) rl.consume(ws);
			}

			expect(evicted.some((e) => e.key === 'a')).toBe(false);
			// The map really did saturate with bans, so the last-resort rule ran.
			expect(evicted.some((e) => e.banned)).toBe(true);

			// 'a' is still serving the ban it earned, with the time it had left.
			const after = rl.consume(wsA);
			expect(after.allowed).toBe(false);
			expect(after.resetMs).toBe(61_000 - 1040);
		});

		it('leaves a ban alone under churn that stays under the limit, at a cap far above the sample', () => {
			// maxBuckets four times the default evictionSample of 16: every
			// eviction now walks a WINDOW of the map, which is the regime the
			// shipped defaults (1_000_000 / 16) always run in.
			const evicted = [];
			const rl = createRateLimit({
				points: 2,
				interval: 1000,
				blockDuration: 60_000,
				maxBuckets: 64,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// 'a' is banned and then says nothing, so by 3500 it has drawn nothing
			// across both scored windows and its own window has elapsed: the ideal
			// victim on every count except the ban, and the first entry the cursor
			// walks. Only the ban keeps it out of the pool.
			rl.ban('a', 60_000);
			Date.now.mockReturnValue(3500);

			// Four hundred one-shot identities, none of which exhausts itself, so
			// every sample has unbanned entries to take.
			for (let i = 0; i < 400; i++) {
				Date.now.mockReturnValue(3500 + i);
				rl.consume(mockWs({ ip: 'churn-' + i }));
			}

			expect(evicted.some((e) => e.banned)).toBe(false);
			expect(evicted.some((e) => e.key === 'a')).toBe(false);
			const after = rl.consume(mockWs({ ip: 'a' }));
			expect(after.allowed).toBe(false);
			expect(after.resetMs).toBe(61_000 - 3899);
		});

		it('cannot clear the oldest ban in the map by churning bans, at a cap far above the sample', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 2,
				interval: 1000,
				blockDuration: 60_000,
				maxBuckets: 64,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// 'a' is banned before anything else, so it holds the oldest ban in
			// the map for the whole run.
			const wsA = mockWs({ ip: 'a' });
			for (let i = 0; i < 3; i++) rl.consume(wsA);
			expect(rl.consume(wsA).allowed).toBe(false);

			// Four hundred throwaway identities, each spending the three messages
			// it takes to auto-ban itself: the map saturates with bans, so the
			// last-resort rule runs on a sample of nothing but bans - and it can
			// never pick the one placed before all of them.
			for (let i = 0; i < 400; i++) {
				Date.now.mockReturnValue(1001 + i);
				const ws = mockWs({ ip: 'churn-' + i });
				for (let j = 0; j < 3; j++) rl.consume(ws);
			}

			// The last-resort rule really did run, many times over.
			expect(evicted.filter((e) => e.banned).length).toBeGreaterThan(100);
			expect(evicted.some((e) => e.key === 'a')).toBe(false);

			const after = rl.consume(wsA);
			expect(after.allowed).toBe(false);
			expect(after.resetMs).toBe(61_000 - 1400);
		});

		it('can still lose a ban placed after the map filled with bans - the documented residual', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 2,
				interval: 1000,
				blockDuration: 60_000,
				maxBuckets: 64,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// A map's worth of bans placed BEFORE the victim's, so the victim is
			// no longer the oldest ban and the sample-local rule is all that is
			// left. Under an exhaustive scan this could not happen (there is
			// always a newer ban in the map than 'a'), so it is also the proof
			// that eviction really samples rather than walking everything.
			for (let i = 0; i < 64; i++) {
				Date.now.mockReturnValue(1000 + i);
				const ws = mockWs({ ip: 'pre-' + i });
				for (let j = 0; j < 3; j++) rl.consume(ws);
			}

			Date.now.mockReturnValue(2000);
			const wsA = mockWs({ ip: 'a' });
			for (let i = 0; i < 3; i++) rl.consume(wsA);
			expect(rl.consume(wsA).allowed).toBe(false);

			for (let i = 0; i < 400; i++) {
				Date.now.mockReturnValue(2001 + i);
				const ws = mockWs({ ip: 'churn-' + i });
				for (let j = 0; j < 3; j++) rl.consume(ws);
			}

			// Enforcement was lost, and it was REPORTED - which is what onEvict
			// with banned:true exists for and what sizing maxBuckets above the
			// bans in flight prevents.
			expect(evicted).toContainEqual({ key: 'a', banned: true });
			const after = rl.consume(wsA);
			expect(after.allowed).toBe(true);
			expect(after.resetMs).toBe(1000);
		});

		it('holds ban() to the same cap as consume()', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 1,
				interval: 60_000,
				maxBuckets: 1,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			rl.ban('a', 30_000);
			rl.ban('b', 30_000);

			// The insert made room instead of growing the map past the cap, and the
			// ban it was asked to record is in place.
			expect(evicted).toEqual([{ key: 'a', banned: true }]);
			expect(rl.consume(mockWs({ ip: 'b' })).allowed).toBe(false);
		});

		it('evicts the least active bucket, not the oldest', () => {
			const rl = createRateLimit({ points: 10, interval: 60_000, maxBuckets: 2 });
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			const wsA = mockWs({ ip: 'a' });
			for (let i = 0; i < 5; i++) rl.consume(wsA);
			rl.consume(mockWs({ ip: 'b' }));

			// 'a' is the oldest entry but has seen five messages to 'b's one.
			rl.consume(mockWs({ ip: 'c' }));

			// 'a' kept its drawn-down window: 10 points, 5 consumed, 1 more now.
			expect(rl.consume(wsA).remaining).toBe(4);
			// 'b' was the victim, so it comes back as a fresh bucket.
			expect(rl.consume(mockWs({ ip: 'b' })).remaining).toBe(9);
		});

		it('breaks a tie towards the bucket whose window has already elapsed', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 10,
				interval: 1000,
				maxBuckets: 2,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// 'a' is inserted first and so is sampled first: only the tiebreak can
			// send this eviction to 'b'.
			const wsA = mockWs({ ip: 'a' });
			const wsB = mockWs({ ip: 'b' });
			rl.consume(wsA);
			rl.consume(wsB);
			rl.consume(wsB);

			// 'a' refills at 2000 and draws again, so it carries one point from the
			// window that just ended and one from the current one - the same two
			// that 'b' drew.
			Date.now.mockReturnValue(2000);
			rl.consume(wsA);

			// At 2600 'b' has been sitting on an elapsed window since 2000 while 'a'
			// runs to 3000. Equal activity, so the one that would have refilled on
			// its next message anyway is the one dropped.
			Date.now.mockReturnValue(2600);
			rl.consume(mockWs({ ip: 'c' }));
			expect(evicted).toEqual([{ key: 'b', banned: false }]);

			// 'a' is intact: still inside its window with one point spent.
			expect(rl.consume(wsA).remaining).toBe(8);
		});

		it('prefers the bucket idle longest, and dropping it costs its owner nothing', () => {
			const evicted = [];
			const capped = createRateLimit({
				points: 10,
				interval: 1000,
				maxBuckets: 2,
				onEvict: (e) => evicted.push(e)
			});
			// The same traffic against a limiter that never reaches its cap, as the
			// control for what eviction cost.
			const roomy = createRateLimit({ points: 10, interval: 1000, maxBuckets: 100 });
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			const wsIdle = mockWs({ ip: 'idle' });
			const wsLive = mockWs({ ip: 'live' });
			for (let i = 0; i < 8; i++) {
				capped.consume(wsIdle);
				roomy.consume(wsIdle);
			}

			// Three windows later 'idle' has said nothing since, so it has drawn
			// nothing in either of the two windows the score spans - it goes, even
			// though it was by far the busier of the two when it was awake. A
			// lifetime counter would have made it the harder one to evict the
			// longer it stayed silent.
			Date.now.mockReturnValue(5000);
			capped.consume(wsLive);
			roomy.consume(wsLive);
			capped.consume(mockWs({ ip: 'new' }));
			roomy.consume(mockWs({ ip: 'new' }));
			expect(evicted).toEqual([{ key: 'idle', banned: false }]);

			// And it cost 'idle' nothing at all: the limiter that kept the bucket
			// and the limiter that dropped it answer identically, because a bucket
			// whose window elapsed refills to full on the next message either way.
			expect(capped.consume(wsIdle)).toEqual(roomy.consume(wsIdle));
			expect(capped.consume(wsIdle)).toEqual(roomy.consume(wsIdle));
		});

		it('keeps a resident key through sustained identity churn', () => {
			const rl = createRateLimit({ points: 100, interval: 60_000, maxBuckets: 4 });
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			const resident = mockWs({ ip: 'resident' });
			for (let i = 0; i < 20; i++) rl.consume(resident);

			// Two hundred one-shot identities against a four-entry map: every one
			// of them forces an eviction, and none of them may cost the resident
			// client its window.
			for (let i = 0; i < 200; i++) rl.consume(mockWs({ ip: 'churn-' + i }));

			expect(rl.consume(resident).remaining).toBe(79);
		});

		it('keeps a resident key that messages more slowly than one window', () => {
			const evicted = [];
			const rl = createRateLimit({
				points: 10,
				interval: 1000,
				maxBuckets: 4,
				onEvict: (e) => evicted.push(e)
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			// A client sending a burst every couple of seconds against a one-second
			// window: its window is elapsed most of the time, and that alone must
			// not make it the preferred victim, or the anti-churn property would
			// hold for nobody but clients faster than the window.
			const resident = mockWs({ ip: 'resident' });
			for (let i = 0; i < 9; i++) rl.consume(resident);

			Date.now.mockReturnValue(2500);
			for (let i = 0; i < 30; i++) rl.consume(mockWs({ ip: 'churn-' + i }));
			expect(evicted.some((e) => e.key === 'resident')).toBe(false);

			// And again once its draw has aged into the previous window.
			Date.now.mockReturnValue(2900);
			rl.consume(resident);
			for (let i = 30; i < 60; i++) rl.consume(mockWs({ ip: 'churn-' + i }));
			expect(evicted.some((e) => e.key === 'resident')).toBe(false);

			// Its allowance was never handed back either: nine drawn before the
			// churn, one after the refill.
			expect(rl.consume(resident).remaining).toBe(8);
		});

		it('an onEvict listener that throws cannot change what the call charged', () => {
			const rl = createRateLimit({
				points: 5,
				interval: 60_000,
				maxBuckets: 2,
				onEvict: () => {
					throw new Error('listener blew up');
				}
			});
			vi.spyOn(Date, 'now').mockReturnValue(1000);

			rl.consume(mockWs({ ip: 'a' }));
			rl.consume(mockWs({ ip: 'b' }));

			// The insert that trips the cap. The listener throws through to the
			// caller, but only once the call has decided and taken its point - a
			// broken logger must not be a way to send a free message.
			const wsC = mockWs({ ip: 'c' });
			expect(() => rl.consume(wsC)).toThrow('listener blew up');
			expect(rl.consume(wsC).remaining).toBe(3);

			// The map is whole: exactly one entry went, and 'b' kept its state.
			expect(rl.consume(mockWs({ ip: 'b' })).remaining).toBe(3);
		});
	});
});
