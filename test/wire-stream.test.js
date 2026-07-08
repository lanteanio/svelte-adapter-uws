import { describe, it, expect } from 'vitest';
import { BitWriter, BitReader, f64ToWords, wordsToF64, clz64, ctz64 } from '../src/runtime/wire-bits.js';
import { createStreamSlot, writeStreamValue, readStreamValue } from '../src/runtime/wire-stream.js';

/** Deterministic LCG so the property runs reproduce bit-for-bit. */
function lcg(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Round-trip a whole value series through one encode slot and one decode slot. */
function roundTrip(values) {
	const bw = new BitWriter();
	const es = createStreamSlot();
	for (const v of values) writeStreamValue(bw, es, v);
	const bytes = bw.finish();
	const br = new BitReader(bytes);
	const ds = createStreamSlot();
	const out = values.map(() => readStreamValue(br, ds));
	return { out, bytes };
}

describe('wire-bits', () => {
	it('round-trips arbitrary bit fields MSB-first', () => {
		const bw = new BitWriter();
		bw.writeBit(1);
		bw.writeBits(0b101, 3);
		bw.writeBits(0xdeadbeef, 32); // top bit set: must not sign-extend
		bw.writeBits(0, 5);
		const br = new BitReader(bw.finish());
		expect(br.readBit()).toBe(1);
		expect(br.readBits(3)).toBe(0b101);
		expect(br.readBits(32)).toBe(0xdeadbeef);
		expect(br.readBits(5)).toBe(0);
	});

	it('throws on a read past the end', () => {
		const bw = new BitWriter();
		bw.writeBits(0b1, 1);
		const br = new BitReader(bw.finish());
		br.readBit();
		expect(() => {
			for (let i = 0; i < 100; i++) br.readBit();
		}).toThrow(RangeError);
	});

	it('splits and reassembles a double losslessly', () => {
		for (const v of [0, 1, -1, 3.14159, 1e300, -1e-300, Number.MAX_VALUE, Number.MIN_VALUE, 2 ** 53]) {
			const { hi, lo } = f64ToWords(v);
			expect(wordsToF64(hi, lo)).toBe(v);
		}
	});

	it('counts leading and trailing zero bits of a 64-bit word', () => {
		expect(clz64(0, 0)).toBe(64);
		expect(ctz64(0, 0)).toBe(64);
		expect(clz64(0x80000000, 0)).toBe(0);
		expect(clz64(0, 1)).toBe(63);
		expect(ctz64(0, 1)).toBe(0);
		expect(ctz64(0x80000000, 0)).toBe(63);
		expect(ctz64(1, 0)).toBe(32);
	});
});

describe('wire-stream temporal codec', () => {
	it('round-trips a single value (full first sample)', () => {
		for (const v of [0, 42, -7, 3.5, 1e-9, 1e12]) {
			expect(roundTrip([v]).out).toEqual([v]);
		}
	});

	it('round-trips a constant integer series in near-zero bits', () => {
		const { out, bytes } = roundTrip([100, 100, 100, 100, 100, 100]);
		expect(out).toEqual([100, 100, 100, 100, 100, 100]);
		// 8 bytes for the first sample; the five repeats are ~1 bit each.
		expect(bytes.length).toBeLessThanOrEqual(10);
	});

	it('round-trips a linearly ramping integer series cheaply (dod = 0)', () => {
		const vals = [1000, 1001, 1002, 1003, 1004, 1005, 1006];
		const { out, bytes } = roundTrip(vals);
		expect(out).toEqual(vals);
		// Full sample + one 9-bit step + five 2-bit dod-zero steps ~= 11 bytes,
		// far under the 7 * 8 = 56 bytes a raw double series would cost.
		expect(bytes.length).toBeLessThanOrEqual(12);
		expect(bytes.length).toBeLessThan(vals.length * 8);
	});

	it('round-trips integers across every dod bucket and the escape', () => {
		const vals = [0, 1, 3, 70, 70 + 300, 70 + 300 + 5000, 70 + 300 + 5000 + 5_000_000, -2_000_000_000, 2_000_000_000];
		expect(roundTrip(vals).out).toEqual(vals);
	});

	it('round-trips negative and large safe integers', () => {
		const vals = [-1, -2, -1000, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0];
		expect(roundTrip(vals).out).toEqual(vals);
	});

	it('round-trips a smoothly ramping float series (XOR window)', () => {
		const vals = [];
		let x = 100.25;
		for (let i = 0; i < 32; i++) {
			vals.push(x);
			x += 0.5;
		}
		expect(roundTrip(vals).out).toEqual(vals);
	});

	it('round-trips repeated floats and float edge values', () => {
		const vals = [3.14, 3.14, 3.14, -2.5, -2.5, 1e300, -1e-300, Number.MAX_VALUE, Number.MIN_VALUE, 0.1, 0.2, 0.3];
		expect(roundTrip(vals).out).toEqual(vals);
	});

	it('round-trips series that mix ints and floats freely', () => {
		const vals = [10, 10.5, 11, 11, 0.001, 12, -3, -3.25, 2 ** 40, 2 ** 40 + 1, 0.5, 0.5];
		expect(roundTrip(vals).out).toEqual(vals);
	});

	it('round-trips 300 random mixed series exactly (property)', () => {
		const rnd = lcg(0x1234);
		for (let t = 0; t < 300; t++) {
			const n = 1 + Math.floor(rnd() * 20);
			const vals = [];
			for (let i = 0; i < n; i++) {
				const r = rnd();
				if (r < 0.4) vals.push(Math.floor((rnd() - 0.5) * 2_000_000)); // int
				else if (r < 0.7) vals.push((rnd() - 0.5) * 1e6); // float
				else if (vals.length) vals.push(vals[vals.length - 1]); // repeat
				else vals.push(0);
			}
			const { out } = roundTrip(vals);
			expect(out).toEqual(vals);
		}
	});

	it('a truncated stream throws (dropped frame), never a wrong value', () => {
		const bw = new BitWriter();
		const es = createStreamSlot();
		for (const v of [100, 101, 102, 103]) writeStreamValue(bw, es, v);
		const bytes = bw.finish();
		// Lop off the tail; decoding the full count must throw rather than fabricate.
		const cut = bytes.subarray(0, Math.max(1, bytes.length - 1));
		const br = new BitReader(cut);
		const ds = createStreamSlot();
		expect(() => {
			for (let i = 0; i < 4; i++) readStreamValue(br, ds);
		}).toThrow(RangeError);
	});
});
