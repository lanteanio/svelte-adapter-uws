/**
 * Generic compact binary codec for the JSON value space (null, boolean,
 * number, string, array, plain object). Encodes a value to bytes and decodes
 * it back, matching `JSON.stringify` / `JSON.parse` round-trip semantics
 * exactly - so a value carried through this codec reaches the far side
 * observationally identical to the same value carried as JSON text. That
 * equivalence is the contract that lets a binary transport (e.g. the `0x03`
 * ingress frame) replace a JSON transport without changing what the handler
 * receives.
 *
 * The point is to remove the `JSON.parse` on the hot path: a value packed by an
 * app's `wire.command.pack` (a compact array/number/object) encodes here into
 * bytes the receiver reads with zero `JSON.parse`. It is deliberately schema-
 * free - any packed value works with no per-app codec declaration (the idiot-
 * proof zero-config path). A consumer that wants a tighter, schema-specific
 * encoding still can; this is the general default.
 *
 * Layout: `[tag:u8][tag-specific...]`
 *   0 NULL     -                          null / undefined / non-finite number
 *   1 FALSE    -                          false
 *   2 TRUE     -                          true
 *   3 INT      [zigzag varint]            integer in +/- 2^52
 *   4 FLOAT    [f64 big-endian]           any other finite number
 *   5 STRING   [varint len][utf8]         string
 *   6 ARRAY    [varint count][value...]   array (element gaps -> null)
 *   7 OBJECT   [varint count][str,value]  plain object (undefined values dropped)
 *
 * JSON parity rules, applied so binary == JSON round trip:
 *   - `undefined`, functions and symbols: dropped from objects (key omitted),
 *     coerced to null inside arrays and at the top level - exactly as
 *     `JSON.stringify` treats them.
 *   - non-finite numbers (NaN, +/-Infinity): encoded as null, as JSON does.
 *   - a `__proto__` object key decodes to an own data property (never a
 *     prototype swap), exactly as `JSON.parse` defines it.
 *   - integers within +/- 2^52 use the zigzag varint (compact, exact); every
 *     other finite number uses f64 (full double precision - command payloads
 *     are arbitrary app data, not screen coordinates, so f32 would lose bits).
 *
 * Integer math (not bit shifts) carries the zigzag past 2^31 so large ids /
 * counts stay exact. A malformed / truncated buffer throws a RangeError from
 * the reader, which the caller turns into a dropped frame.
 *
 * @module svelte-adapter-uws/src/runtime/wire-value
 */

import { ByteWriter, ByteReader } from './wire.js';

const TAG_NULL = 0;
const TAG_FALSE = 1;
const TAG_TRUE = 2;
const TAG_INT = 3;
const TAG_FLOAT = 4;
const TAG_STRING = 5;
const TAG_ARRAY = 6;
const TAG_OBJECT = 7;

// Integers within this magnitude survive the zigzag varint exactly: zigzag
// doubles the magnitude and the varint carries values below 2^53, so the input
// must stay within +/- 2^52. Larger integers ride the f64 path (still exact for
// safe integers up to 2^53, and precision-preserving beyond).
const INT_LIMIT = 0x10000000000000; // 2^52

/**
 * Write one JSON value.
 * @param {import('./wire.js').ByteWriter} w
 * @param {any} v
 */
export function writeValue(w, v) {
	// null / undefined and anything JSON drops-to-null at a value position.
	if (v === null || v === undefined) { w.u8(TAG_NULL); return; }
	const t = typeof v;
	if (t === 'boolean') { w.u8(v ? TAG_TRUE : TAG_FALSE); return; }
	if (t === 'number') {
		if (!Number.isFinite(v)) { w.u8(TAG_NULL); return; }
		if (Number.isInteger(v) && v >= -INT_LIMIT && v <= INT_LIMIT) {
			w.u8(TAG_INT);
			// zigzag: map signed -> unsigned so small-magnitude negatives stay short.
			w.varint(v >= 0 ? v * 2 : v * -2 - 1);
			return;
		}
		w.u8(TAG_FLOAT);
		w.f64(v);
		return;
	}
	if (t === 'string') { w.u8(TAG_STRING); w.str(v); return; }
	if (Array.isArray(v)) {
		w.u8(TAG_ARRAY);
		w.varint(v.length);
		for (let i = 0; i < v.length; i++) writeValue(w, v[i]);
		return;
	}
	if (t === 'object') {
		// Plain object: keep only own-enumerable keys whose value JSON would
		// keep (undefined / function / symbol values are dropped, matching
		// JSON.stringify). Count the kept keys first so the reader knows how
		// many pairs follow.
		const keys = Object.keys(v);
		let kept = 0;
		for (let i = 0; i < keys.length; i++) {
			const val = v[keys[i]];
			const vt = typeof val;
			if (val !== undefined && vt !== 'function' && vt !== 'symbol') kept++;
		}
		w.u8(TAG_OBJECT);
		w.varint(kept);
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			const val = v[key];
			const vt = typeof val;
			if (val === undefined || vt === 'function' || vt === 'symbol') continue;
			w.str(key);
			writeValue(w, val);
		}
		return;
	}
	// function / symbol / bigint at a value position: JSON would drop bigint by
	// throwing, but here (like an array element) it degrades to null rather than
	// failing the whole frame.
	w.u8(TAG_NULL);
}

/**
 * Read one JSON value written by {@link writeValue}.
 * @param {import('./wire.js').ByteReader} r
 * @returns {any}
 */
export function readValue(r) {
	const tag = r.u8();
	switch (tag) {
		case TAG_NULL: return null;
		case TAG_FALSE: return false;
		case TAG_TRUE: return true;
		case TAG_INT: {
			const u = r.varint();
			// un-zigzag: even -> +u/2, odd -> -(u+1)/2. Integer math throughout.
			return (u % 2 === 0) ? u / 2 : -(u + 1) / 2;
		}
		case TAG_FLOAT: return r.f64();
		case TAG_STRING: return r.str();
		case TAG_ARRAY: {
			const n = r.varint();
			const out = new Array(n);
			for (let i = 0; i < n; i++) out[i] = readValue(r);
			return out;
		}
		case TAG_OBJECT: {
			const n = r.varint();
			/** @type {Record<string, any>} */
			const out = {};
			for (let i = 0; i < n; i++) {
				const key = r.str();
				const val = readValue(r);
				// '__proto__' is defined as an OWN DATA property, exactly as
				// JSON.parse defines it: plain assignment would invoke the
				// inherited setter and replace the object's prototype with
				// wire-controlled data instead of creating the key.
				if (key === '__proto__') {
					Object.defineProperty(out, key, { value: val, enumerable: true, writable: true, configurable: true });
				} else {
					out[key] = val;
				}
			}
			return out;
		}
		default:
			throw new RangeError('wire-value: unknown tag ' + tag);
	}
}

/**
 * Encode a single JSON value to an exact-length byte buffer.
 * @param {any} v
 * @returns {Uint8Array}
 */
export function encodeValue(v) {
	const w = new ByteWriter(32);
	writeValue(w, v);
	return w.take();
}

/**
 * Decode a byte buffer produced by {@link encodeValue}. Returns the value, or
 * throws a RangeError on a truncated / malformed buffer.
 * @param {Uint8Array} bytes
 * @returns {any}
 */
export function decodeValue(bytes) {
	return readValue(new ByteReader(bytes));
}
