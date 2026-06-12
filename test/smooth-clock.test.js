import { describe, it, expect } from 'vitest';
import { createServerClock } from '../plugins/smooth/clock.js';

// The estimator is pure (every time reading is an argument), so these tests
// script monotonic time directly - no fake timers, no runtime clock.

describe('createServerClock', () => {
	it('returns null before any sample', () => {
		const c = createServerClock();
		expect(c.estServerNow(1000)).toBe(null);
		expect(c.offset()).toBe(null);
	});

	it('estimates from one-way samples and snaps on the first', () => {
		const c = createServerClock();
		// Server is 1,000,000ms ahead of the client monotonic axis; this
		// frame took 100ms downstream, so the candidate underestimates.
		c.sample(1_000_100, 200);
		expect(c.estServerNow(200)).toBe(200 + (1_000_100 - 200));
		expect(c.offset()).toBe(999_900);
	});

	it('the windowed max approaches the true offset from below', () => {
		const c = createServerClock();
		// True offset 1,000,000; downstream delays 120 / 40 / 80ms.
		c.sample(1_000_000 + 0 - 120, 0);
		c.sample(1_000_000 + 100 - 40, 100);
		c.sample(1_000_000 + 200 - 80, 200);
		c.estServerNow(200);
		// The fastest frame (40ms) dominates: offset = trueOffset - 40,
		// reached through the slew from the first sample's snap.
		const applied = c.offset();
		expect(applied).toBeGreaterThan(1_000_000 - 121);
		expect(applied).toBeLessThanOrEqual(1_000_000 - 40);
	});

	it('slews toward a better sample instead of jumping', () => {
		const c = createServerClock();
		c.sample(1_000_000, 0);
		expect(c.estServerNow(0)).toBe(1_000_000);
		// A faster frame raises the target by 100ms; one frame later only
		// ~16ms * 0.05 of it may be applied.
		c.sample(1_000_116, 16);
		const est = c.estServerNow(16);
		expect(est).toBeGreaterThan(1_000_016);
		expect(est).toBeLessThan(1_000_016 + 2);
	});

	it('snaps when the divergence exceeds the snap threshold', () => {
		const c = createServerClock();
		c.sample(1_000_000, 0);
		c.estServerNow(0);
		c.sample(1_005_000, 10); // 5s better: not a slew case
		expect(c.estServerNow(10)).toBe(10 + (1_005_000 - 10));
	});

	it('a round-trip seed bounds the estimate from above', () => {
		const c = createServerClock();
		// Request at 0, reply at 100 carrying serverT 2000: the true offset
		// cannot exceed 2000 - 0 (the send leg).
		c.seed(2000, 0, 100);
		// A queued slow frame whose stamp races ahead of its arrival would
		// otherwise claim a huge offset; the upper bound clips it.
		c.sample(50_000, 200);
		c.estServerNow(200);
		expect(c.offset()).toBe(2000);
	});

	it('the upper bound expires so drift cannot pin a stale ceiling', () => {
		const c = createServerClock({ upperTtlMs: 1000 });
		c.seed(2000, 0, 100);
		c.sample(50_000, 1200); // past the ttl: upper released
		c.estServerNow(1200);
		expect(c.offset()).toBe(50_000 - 1200);
	});

	it('old buckets rotate out so the estimate tracks drift', () => {
		const c = createServerClock({ bucketMs: 100, buckets: 2, slewRate: 1000 });
		c.sample(1_000_000, 0); // offset 1,000,000
		c.estServerNow(0);
		expect(c.offset()).toBe(1_000_000);
		// The client clock now runs fast relative to the server: every later
		// candidate is lower. Once the original bucket rotates out, the
		// estimate follows the newer (lower) maximum down.
		c.sample(999_500 + 250, 250);
		c.sample(999_500 + 400, 400);
		c.estServerNow(400);
		expect(c.offset()).toBe(999_500);
	});

	it('ignores malformed samples', () => {
		const c = createServerClock();
		c.sample(NaN, 0);
		c.sample(1000, Infinity);
		c.seed(1000, 200, 100); // reply before request
		expect(c.estServerNow(10)).toBe(null);
	});

	it('reset forgets everything', () => {
		const c = createServerClock();
		c.seed(2000, 0, 100);
		c.estServerNow(100);
		c.reset();
		expect(c.estServerNow(200)).toBe(null);
		expect(c.offset()).toBe(null);
	});
});
