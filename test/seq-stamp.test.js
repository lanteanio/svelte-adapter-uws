import { describe, it, expect } from 'vitest';
import { stampSeq, nextTopicSeq, explicitSeqValue } from '../src/runtime/utils/epoch.js';

// stampSeq is the shared publish-path resolver: it turns the `seq` option into
// the value stamped on the wire, the same way for every publish entry point.
// It is pure with respect to inputs other than the supplied counter map
// (mirrors nextTopicSeq), so each case uses a fresh map. The three-way
// resolution (explicit number / false / in-memory counter) is the seam that
// lets a replay backend put the broadcast frame and its buffer on ONE
// authoritative seq space without changing the wire shape.

describe('stampSeq (publish-path seq resolver)', () => {
	it('stamps an explicit numeric seq verbatim and does not advance the counter', () => {
		const map = new Map();
		expect(stampSeq({ seq: 42 }, map, 'room')).toBe(42);
		// The in-memory counter is untouched, so a later absent-seq publish still
		// starts at 1 - the numeric authority and the local counter are two tracks.
		expect(map.has('room')).toBe(false);
		expect(stampSeq(undefined, map, 'room')).toBe(1);
	});

	it('stamps a large positive-integer seq verbatim without touching the counter', () => {
		const map = new Map();
		expect(stampSeq({ seq: 9_000_000_000 }, map, 'room')).toBe(9_000_000_000);
		expect(map.has('room')).toBe(false);
	});

	it('rejects a non-positive-integer explicit seq (fail fast, never corrupt the wire)', () => {
		const map = new Map();
		// 0 collides with the 0x03 frame's no-seq sentinel; a negative / fractional
		// value diverges JSON vs varint; NaN / Infinity emit invalid JSON and poison
		// the max-seen guard. All must throw rather than reach the wire.
		for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
			expect(() => stampSeq({ seq: bad }, map, 'room')).toThrow(TypeError);
		}
		// A rejected publish never advanced the in-memory counter.
		expect(map.has('room')).toBe(false);
	});

	it('returns null for seq:false so the envelope omits the field', () => {
		const map = new Map();
		expect(stampSeq({ seq: false }, map, 'room')).toBe(null);
		expect(map.has('room')).toBe(false);
	});

	it('falls through to the in-memory counter when seq is absent', () => {
		const map = new Map();
		expect(stampSeq(undefined, map, 'room')).toBe(1);
		expect(stampSeq({}, map, 'room')).toBe(2);
		expect(stampSeq(null, map, 'room')).toBe(3);
	});

	it('treats a legacy truthy seq:true as the in-memory counter, NOT numeric 1', () => {
		const map = new Map([['room', 4]]);
		// Back-compat: seq:true historically meant "stamp the per-topic counter".
		// It must keep incrementing the counter, never collapse to the number 1.
		expect(stampSeq({ seq: true }, map, 'room')).toBe(5);
		expect(stampSeq({ seq: true }, map, 'room')).toBe(6);
	});

	it('increments independently per topic', () => {
		const map = new Map();
		expect(stampSeq(undefined, map, 'a')).toBe(1);
		expect(stampSeq(undefined, map, 'b')).toBe(1);
		expect(stampSeq(undefined, map, 'a')).toBe(2);
	});

	it('is equivalent to nextTopicSeq for the absent case (byte-identical hot path)', () => {
		const a = new Map();
		const b = new Map();
		for (let i = 0; i < 5; i++) {
			expect(stampSeq(undefined, a, 'room')).toBe(nextTopicSeq(b, 'room'));
		}
	});

	it('treats seq:null as no seq, the way a nullable column means it', () => {
		// A JSON round trip writes an unset seq as null, and a nullable DB
		// column answers null for "no seq I know of". Drawing the counter for
		// either would mark the topic non-authoritative behind the caller's
		// back - the silent half of the misuse the thrown arm below closes.
		const map = new Map();
		expect(stampSeq({ seq: null }, map, 'room')).toBe(null);
		expect(map.has('room')).toBe(false);
	});

	it('throws for a seq that is neither number, bigint, boolean, null, nor absent', () => {
		// A string from a JSON column meant as a seq used to draw the local
		// counter silently - the same misuse class had one failure mode that
		// throws (an uncarriable number) and one that degrades in silence.
		const map = new Map();
		for (const bad of ['1234', {}, [], Symbol('seq')]) {
			expect(() => stampSeq({ seq: bad }, map, 'room')).toThrow(/legal|counter|bigint/i);
		}
		expect(map.has('room')).toBe(false);
	});

	it('stamps a bigint as the same explicit authority a number spells', () => {
		const map = new Map();
		expect(stampSeq({ seq: 42n }, map, 'room')).toBe(42);
		// The wire's seq space is IEEE double: an exactly-representable bigint
		// beyond 2^53 projects to that exact double.
		expect(stampSeq({ seq: 2n ** 60n }, map, 'room')).toBe(2 ** 60);
		// Beyond exact representation it rounds to the nearest double,
		// monotone - the same projection Number(snowflake) performs at a call
		// site, so the two spellings of one value never disagree on validity.
		const snowflake = 1541815603606036480n;
		expect(stampSeq({ seq: snowflake }, map, 'room')).toBe(Number(snowflake));
		expect(map.has('room')).toBe(false);
	});

	it('rejects a non-positive or unrepresentable bigint the way it rejects numbers', () => {
		const map = new Map();
		for (const bad of [0n, -1n, 10n ** 400n]) {
			expect(() => stampSeq({ seq: bad }, map, 'room')).toThrow(TypeError);
		}
		expect(map.has('room')).toBe(false);
	});
});

describe('explicitSeqValue (the shared explicit-authority validator)', () => {
	it('accepts both spellings and projects into the double seq space', () => {
		expect(explicitSeqValue(7)).toBe(7);
		expect(explicitSeqValue(7n)).toBe(7);
		expect(explicitSeqValue(2n ** 60n)).toBe(2 ** 60);
	});

	it('accepts exactly the boundary every 1-based authority starts at', () => {
		// The first value a Redis INCR or the in-memory counter ever issues is
		// 1; a validator that started refusing it would refuse every fresh
		// topic's first explicit stamp.
		expect(explicitSeqValue(1)).toBe(1);
		expect(explicitSeqValue(1n)).toBe(1);
		const map = new Map();
		expect(stampSeq({ seq: 1 }, map, 'room')).toBe(1);
		expect(stampSeq({ seq: 1n }, map, 'room')).toBe(1);
		expect(map.has('room')).toBe(false);
	});

	it('projection is monotone, so max-seen guards hold across the spellings', () => {
		// Two adjacent snowflakes may collapse to one double, but never
		// reorder: the guard's monotone-max survives the projection.
		const a = 1541815603606036480n;
		const b = a + 1000000n;
		expect(explicitSeqValue(b)).toBeGreaterThanOrEqual(explicitSeqValue(a));
	});

	it('refuses what neither lane can carry', () => {
		for (const bad of [0, -3, 2.5, NaN, Infinity, 0n, -2n, 10n ** 400n]) {
			expect(() => explicitSeqValue(bad)).toThrow(TypeError);
		}
	});
});
