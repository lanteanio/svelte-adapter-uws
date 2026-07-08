/**
 * Temporal codec for a fixed-cadence stream of numbers - one "slot" per value
 * series. Consecutive samples of a series (an entity's x, a cursor's y, a
 * telemetry gauge) are correlated, so each is encoded against the slot's
 * previous sample instead of in full:
 *
 *   - integers ride delta-of-delta (the Facebook Gorilla timestamp scheme): a
 *     value moving at a constant rate costs a single zero bit, and small
 *     changes ride 7 / 9 / 12-bit buckets before a 32-bit escape.
 *   - other finite numbers ride XOR-against-previous (the Gorilla value
 *     scheme): the XOR of two nearby doubles is mostly leading/trailing zeros,
 *     so only the meaningful middle bits travel, reusing the previous block's
 *     window when it fits.
 *
 * A per-value mode bit selects int vs float, so a series that mixes them (or
 * whose values wander in and out of the safe-integer range) stays correct with
 * no side channel. The first sample of a slot is written in full (64 bits).
 *
 * This is the general primitive behind the field-delta state wire; a codec
 * that carries fixed-cadence structured state (smooth entities today, cursors
 * / telemetry next) picks which fields changed and runs each numeric field's
 * value through a slot here. It knows nothing about entities or topics.
 *
 * Pure: no clocks, no timers, no runtime imports.
 *
 * @module svelte-adapter-uws/src/runtime/wire-stream
 */

import { f64ToWords, wordsToF64, clz64, ctz64 } from './wire-bits.js';

/** Fresh per-series temporal state. Reset on reconnect / on the series ending. */
export function createStreamSlot() {
	return {
		has: false, // a previous sample exists
		prev: 0, // previous value
		prevDelta: 0, // previous first-difference (the dod chain)
		hasWindow: false, // a float XOR window is established
		wLead: 0, // window leading-zero count
		wLen: 64 // window meaningful-bit length
	};
}

/** MSB-indexed bit (0 = most significant) of a 64-bit value in two words. */
function bitAt(hi, lo, p) {
	return p < 32 ? (hi >>> (31 - p)) & 1 : (lo >>> (63 - p)) & 1;
}

/** Write the `len` meaningful bits of a 64-bit XOR starting at MSB index `start`. */
function writeSpan(bw, hi, lo, start, len) {
	for (let i = 0; i < len; i++) bw.writeBit(bitAt(hi, lo, start + i));
}

/** Read a `len`-bit span at MSB index `start` back into two words. */
function readSpan(br, start, len) {
	let hi = 0;
	let lo = 0;
	for (let i = 0; i < len; i++) {
		const b = br.readBit();
		if (b) {
			const p = start + i;
			if (p < 32) hi = (hi | (b << (31 - p))) >>> 0;
			else lo = (lo | (b << (63 - p))) >>> 0;
		}
	}
	return { hi: hi >>> 0, lo: lo >>> 0 };
}

/** Write `value` as a two's-complement field of `bits` bits (MSB first). */
function writeSigned(bw, value, bits) {
	bw.writeBits(value < 0 ? value + Math.pow(2, bits) : value, bits);
}

/** Read a two's-complement field of `bits` bits. */
function readSigned(br, bits) {
	const u = br.readBits(bits);
	const half = Math.pow(2, bits - 1);
	return u >= half ? u - Math.pow(2, bits) : u;
}

// Signed delta-of-delta buckets: prefix code + payload width. The escape width
// (32) bounds the int path; a dod outside it falls to the float path.
const DOD_MAX = Math.pow(2, 31);

/**
 * Write one finite number into the stream against its slot. Advances the slot.
 * @param {import('./wire-bits.js').BitWriter} bw
 * @param {ReturnType<typeof createStreamSlot>} slot
 * @param {number} value - a finite number (the caller routes non-finite values
 *   to a literal path).
 */
export function writeStreamValue(bw, slot, value) {
	if (!slot.has) {
		const w0 = f64ToWords(value);
		bw.writeBits(w0.hi, 32);
		bw.writeBits(w0.lo, 32);
		slot.has = true;
		slot.prev = value;
		slot.prevDelta = 0;
		slot.hasWindow = false;
		return;
	}
	// Int path when both ends are SAFE integers (so the delta arithmetic is
	// exact) and the double-difference lands in the escape range; otherwise the
	// XOR path (also exact - it round-trips the raw bits).
	if (Number.isSafeInteger(value) && Number.isSafeInteger(slot.prev)) {
		const delta = value - slot.prev;
		const dod = delta - slot.prevDelta;
		if (dod >= -DOD_MAX && dod < DOD_MAX) {
			bw.writeBit(0); // int mode
			if (dod === 0) {
				bw.writeBit(0);
			} else {
				bw.writeBit(1);
				if (dod >= -64 && dod <= 63) {
					bw.writeBit(0);
					writeSigned(bw, dod, 7);
				} else if (dod >= -256 && dod <= 255) {
					bw.writeBits(0b10, 2);
					writeSigned(bw, dod, 9);
				} else if (dod >= -2048 && dod <= 2047) {
					bw.writeBits(0b110, 3);
					writeSigned(bw, dod, 12);
				} else {
					bw.writeBits(0b111, 3);
					writeSigned(bw, dod, 32);
				}
			}
			slot.prev = value;
			slot.prevDelta = delta;
			return;
		}
	}
	// Float (XOR) path.
	bw.writeBit(1); // float mode
	const cur = f64ToWords(value);
	const pv = f64ToWords(slot.prev);
	const xhi = (cur.hi ^ pv.hi) >>> 0;
	const xlo = (cur.lo ^ pv.lo) >>> 0;
	if (xhi === 0 && xlo === 0) {
		bw.writeBit(0); // identical to prev
	} else {
		bw.writeBit(1);
		const lead = clz64(xhi, xlo);
		const trail = ctz64(xhi, xlo);
		const len = 64 - lead - trail;
		if (slot.hasWindow && lead >= slot.wLead && lead + len <= slot.wLead + slot.wLen) {
			bw.writeBit(0); // reuse the established window
			writeSpan(bw, xhi, xlo, slot.wLead, slot.wLen);
		} else {
			bw.writeBit(1); // new window
			bw.writeBits(lead, 6);
			bw.writeBits(len - 1, 6);
			writeSpan(bw, xhi, xlo, lead, len);
			slot.hasWindow = true;
			slot.wLead = lead;
			slot.wLen = len;
		}
	}
	slot.prev = value;
	slot.prevDelta = 0;
}

/**
 * Read one number written by {@link writeStreamValue}, advancing the slot the
 * same way. A truncated stream throws a RangeError (a dropped frame).
 * @param {import('./wire-bits.js').BitReader} br
 * @param {ReturnType<typeof createStreamSlot>} slot
 * @returns {number}
 */
export function readStreamValue(br, slot) {
	if (!slot.has) {
		const hi = br.readBits(32);
		const lo = br.readBits(32);
		const value = wordsToF64(hi, lo);
		slot.has = true;
		slot.prev = value;
		slot.prevDelta = 0;
		slot.hasWindow = false;
		return value;
	}
	if (br.readBit() === 0) {
		// Int mode.
		let dod = 0;
		if (br.readBit() === 1) {
			if (br.readBit() === 0) dod = readSigned(br, 7);
			else if (br.readBit() === 0) dod = readSigned(br, 9);
			else if (br.readBit() === 0) dod = readSigned(br, 12);
			else dod = readSigned(br, 32);
		}
		const delta = slot.prevDelta + dod;
		const value = slot.prev + delta;
		slot.prev = value;
		slot.prevDelta = delta;
		return value;
	}
	// Float mode.
	let value;
	const pv = f64ToWords(slot.prev);
	if (br.readBit() === 0) {
		value = slot.prev; // identical to prev
	} else {
		let lead;
		let len;
		if (br.readBit() === 0) {
			lead = slot.wLead;
			len = slot.wLen;
		} else {
			lead = br.readBits(6);
			len = br.readBits(6) + 1;
			slot.hasWindow = true;
			slot.wLead = lead;
			slot.wLen = len;
		}
		const x = readSpan(br, lead, len);
		value = wordsToF64((x.hi ^ pv.hi) >>> 0, (x.lo ^ pv.lo) >>> 0);
	}
	slot.prev = value;
	slot.prevDelta = 0;
	return value;
}
