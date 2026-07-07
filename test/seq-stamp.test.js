import { describe, it, expect } from 'vitest';
import { stampSeq, nextTopicSeq } from '../src/runtime/utils/epoch.js';

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
});
