/**
 * MSB-first bit stream reader/writer over a byte buffer, plus the IEEE-754
 * double <-> 64-bit-word helpers a XOR-based float stream needs.
 *
 * The byte codecs (wire.js) are byte-aligned; a temporal value stream
 * (wire-stream.js) packs many sub-byte control codes and variable-width
 * payloads, so it needs a bit granularity the byte writer cannot express.
 * Bits are written most-significant first and read back in the same order, so
 * a value written as `writeBits(v, n)` reads back as `readBits(n)` unchanged.
 *
 * A 64-bit quantity is carried as a `{ hi, lo }` pair of unsigned 32-bit words
 * (JS bitwise ops are 32-bit, so a double's 64 bits never live in one integer).
 * `writeBits` takes a count up to 32; a 64-bit field is written as two halves.
 *
 * Pure: no clocks, no timers, no imports - it bundles for the browser and runs
 * under a deterministic harness unchanged.
 *
 * @module svelte-adapter-uws/src/runtime/wire-bits
 */

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
// Word order within the Float64Array view is platform-endian; probe it once so
// hi/lo always mean the same halves regardless of host endianness.
F64[0] = 2; // exponent-only double: its high word is non-zero, low word zero.
const HI = U32[0] !== 0 ? 0 : 1;
const LO = HI ^ 1;

/**
 * Split a JS number's IEEE-754 double encoding into two unsigned 32-bit words.
 * @param {number} v
 * @returns {{ hi: number, lo: number }} `hi` is the sign/exponent/high-mantissa
 *   word, `lo` the low-mantissa word - both `>>> 0` unsigned.
 */
export function f64ToWords(v) {
	F64[0] = v;
	return { hi: U32[HI] >>> 0, lo: U32[LO] >>> 0 };
}

/**
 * Reassemble a JS number from the two words {@link f64ToWords} produced.
 * @param {number} hi @param {number} lo
 * @returns {number}
 */
export function wordsToF64(hi, lo) {
	U32[HI] = hi >>> 0;
	U32[LO] = lo >>> 0;
	return F64[0];
}

/**
 * Count leading zero bits of a 64-bit value given as two words (0..64).
 * @param {number} hi @param {number} lo
 */
export function clz64(hi, lo) {
	if (hi !== 0) return Math.clz32(hi);
	if (lo !== 0) return 32 + Math.clz32(lo);
	return 64;
}

/**
 * Count trailing zero bits of a 64-bit value given as two words (0..64).
 * @param {number} hi @param {number} lo
 */
export function ctz64(hi, lo) {
	if (lo !== 0) return ctz32(lo);
	if (hi !== 0) return 32 + ctz32(hi);
	return 64;
}

/** Trailing zeros of a non-zero 32-bit word. */
function ctz32(x) {
	// 31 - clz32(lowest set bit).
	return 31 - Math.clz32(x & -x);
}

/**
 * Accumulates bits most-significant first into a growing byte array.
 */
export class BitWriter {
	constructor() {
		/** @type {number[]} completed bytes */
		this.bytes = [];
		// The partial byte being filled and how many bits it holds so far.
		this.cur = 0;
		this.nbits = 0;
	}

	/** Write one bit (its low bit is used). @param {number} b */
	writeBit(b) {
		this.cur = ((this.cur << 1) | (b & 1)) & 0xff;
		if (++this.nbits === 8) {
			this.bytes.push(this.cur);
			this.cur = 0;
			this.nbits = 0;
		}
	}

	/**
	 * Write the low `count` bits of `value` (0 <= count <= 32), MSB first.
	 * @param {number} value @param {number} count
	 */
	writeBits(value, count) {
		// Unsigned throughout: a 32-bit write of a value with bit 31 set must not
		// sign-extend. Peel one bit at a time from the top via division so a
		// 32-bit field never relies on a signed shift.
		for (let i = count - 1; i >= 0; i--) {
			this.writeBit((Math.floor(value / _pow2[i])) & 1);
		}
	}

	/**
	 * Finish the stream: flush the partial byte (zero-padded on the right) and
	 * return the exact bytes written.
	 * @returns {Uint8Array}
	 */
	finish() {
		if (this.nbits > 0) {
			this.bytes.push((this.cur << (8 - this.nbits)) & 0xff);
			this.cur = 0;
			this.nbits = 0;
		}
		return Uint8Array.from(this.bytes);
	}
}

/**
 * Reads bits most-significant first from a byte buffer, symmetric to
 * {@link BitWriter}. A read past the end throws a RangeError (a dropped frame).
 */
export class BitReader {
	/** @param {Uint8Array} buf */
	constructor(buf) {
		this._buf = buf;
		this._byte = 0;
		this._bit = 0; // 0..7, MSB first
	}

	/** @returns {number} 0 or 1 */
	readBit() {
		if (this._byte >= this._buf.length) throw new RangeError('wire-bits: read past end');
		const b = (this._buf[this._byte] >>> (7 - this._bit)) & 1;
		if (++this._bit === 8) {
			this._bit = 0;
			this._byte++;
		}
		return b;
	}

	/**
	 * Read `count` bits (0 <= count <= 32) MSB first as an unsigned integer.
	 * @param {number} count @returns {number}
	 */
	readBits(count) {
		let v = 0;
		for (let i = 0; i < count; i++) v = v * 2 + this.readBit();
		return v;
	}
}

// Powers of two up to 2^31, so `writeBits` peels a 32-bit field without a
// signed shift (2^31 overflows a signed int32).
const _pow2 = (() => {
	const a = new Array(32);
	let p = 1;
	for (let i = 0; i < 32; i++) {
		a[i] = p;
		p *= 2;
	}
	return a;
})();
