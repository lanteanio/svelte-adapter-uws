import { describe, it, expect } from 'vitest';
import { createSharedRandom } from '../src/plugins/smooth/random.js';

// The generator is pure integer arithmetic over an explicit seed - no clocks,
// no global state - so every assertion here is exact.

describe('createSharedRandom', () => {
	it('the same seed yields the same float sequence', () => {
		const a = createSharedRandom(123);
		const b = createSharedRandom(123);
		for (let i = 0; i < 64; i++) expect(b.float()).toBe(a.float());
	});

	it('the same seed yields the same u32 sequence', () => {
		const a = createSharedRandom(123);
		const b = createSharedRandom(123);
		for (let i = 0; i < 64; i++) expect(b.u32()).toBe(a.u32());
	});

	it('float and u32 are two views of one stream', () => {
		const f = createSharedRandom(9);
		const u = createSharedRandom(9);
		for (let i = 0; i < 16; i++) expect(f.float()).toBe(u.u32() / 4294967296);
	});

	it('different seeds yield different sequences', () => {
		const a = createSharedRandom(1);
		const b = createSharedRandom(2);
		const as = [a.u32(), a.u32(), a.u32(), a.u32()];
		const bs = [b.u32(), b.u32(), b.u32(), b.u32()];
		expect(as).not.toEqual(bs);
	});

	it('consecutive integer seeds start uncorrelated', () => {
		// Command ids are small sequential integers; their first draws must
		// already be spread out, not clustered.
		const firsts = [];
		for (let id = 1; id <= 8; id++) firsts.push(createSharedRandom(id).u32());
		expect(new Set(firsts).size).toBe(8);
	});

	it('reseed restarts the stream exactly', () => {
		const r = createSharedRandom(7);
		const first = [r.float(), r.float(), r.float()];
		r.reseed(7);
		expect([r.float(), r.float(), r.float()]).toEqual(first);
		// Reseeding to a value equals constructing from it.
		r.reseed(55);
		const fresh = createSharedRandom(55);
		expect([r.u32(), r.u32()]).toEqual([fresh.u32(), fresh.u32()]);
	});

	it('floats stay in [0, 1)', () => {
		const r = createSharedRandom(0xdeadbeef);
		for (let i = 0; i < 10_000; i++) {
			const v = r.float();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('u32 stays in the unsigned 32-bit range as an integer', () => {
		const r = createSharedRandom(0xdeadbeef);
		for (let i = 0; i < 10_000; i++) {
			const v = r.u32();
			expect(Number.isInteger(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(0xffffffff);
		}
	});

	it('the default seed is zero', () => {
		const d = createSharedRandom();
		const z = createSharedRandom(0);
		expect([d.u32(), d.u32()]).toEqual([z.u32(), z.u32()]);
	});

	it('pins the exact output values per seed (algorithm drift fails loudly)', () => {
		// Hard-coded expected outputs of the current generator. A change to
		// the scramble constant, the mixing rounds, or engine semantics would
		// silently break prediction/authority parity for randomized commands;
		// this pin turns any such drift into a test failure.
		const u0 = createSharedRandom(0);
		expect([u0.u32(), u0.u32(), u0.u32()]).toEqual([1541420728, 454851044, 2900350524]);
		const u1 = createSharedRandom(1);
		expect([u1.u32(), u1.u32(), u1.u32()]).toEqual([814657751, 1364887502, 3363306467]);
		const u42 = createSharedRandom(42);
		expect([u42.u32(), u42.u32(), u42.u32()]).toEqual([2067236868, 4231632130, 3169330198]);
		// Floats are the same draws scaled by 2^-32, exactly.
		const f42 = createSharedRandom(42);
		expect(f42.float()).toBe(2067236868 / 4294967296);
		expect(f42.float()).toBe(4231632130 / 4294967296);
	});
});
