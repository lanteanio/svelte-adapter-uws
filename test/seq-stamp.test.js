import { describe, it, expect } from 'vitest';
import { stampSeq, nextTopicSeq, explicitSeqValue, resolveEntrySeq } from '../src/runtime/utils/epoch.js';

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
		expect(stampSeq({ seq: BigInt(Number.MAX_SAFE_INTEGER) }, map, 'room')).toBe(Number.MAX_SAFE_INTEGER);
		expect(map.has('room')).toBe(false);
	});

	it('refuses a snowflake, the id class that motivated the bigint spelling', () => {
		// A real Twitter/Discord-shaped snowflake. Stamping it used to project
		// through Number() and round; the frame then carried an id the caller
		// never issued, and the NEXT snowflake could round onto the same
		// double. The two ids below are adjacent and collapse - so the frame
		// that should have advanced the client's watermark would not have.
		const snowflake = 1541815603606036481n;
		expect(Number(snowflake), 'the collision this refusal exists for').toBe(Number(snowflake + 1n));
		const map = new Map();
		for (const id of [snowflake, snowflake + 1n]) {
			expect(() => stampSeq({ seq: id }, map, 'room')).toThrow(/exceeds the wire/i);
		}
		expect(map.has('room')).toBe(false);
	});

	it('rejects a non-positive or unrepresentable bigint the way it rejects numbers', () => {
		const map = new Map();
		for (const bad of [0n, -1n]) {
			expect(() => stampSeq({ seq: bad }, map, 'room')).toThrow(/positive integer/);
		}
		// A magnitude fault earns the magnitude message, not the legal-forms
		// one: the value IS a positive integer, and sending that caller to
		// look for a spelling mistake would waste their time.
		expect(() => stampSeq({ seq: 10n ** 400n }, map, 'room')).toThrow(/exceeds the wire/i);
		expect(map.has('room')).toBe(false);
	});

	it('refuses an over-range NUMBER through the stamp, not only through the validator', () => {
		// stampSeqValue keeps its own inlined copy of the number arm's
		// predicate for the hot path, and that copy is what every
		// platform.publish call actually runs. Asserting the range on
		// explicitSeqValue alone leaves this copy free to sit at
		// Number.isInteger while the suite stays green - and then the primary
		// publish lane puts a rounded id on the wire, which is the whole
		// defect. Drive it through stampSeq, on the number spelling.
		const map = new Map();
		for (const over of [2 ** 53, 2 ** 53 + 2, 2 ** 60, 1e308]) {
			expect(() => stampSeq({ seq: over }, map, 'room'), String(over)).toThrow(/exceeds the wire/i);
		}
		expect(stampSeq({ seq: Number.MAX_SAFE_INTEGER }, map, 'room')).toBe(Number.MAX_SAFE_INTEGER);
		expect(map.has('room'), 'a refused or explicit stamp never advances the counter').toBe(false);
	});
});

describe('explicitSeqValue (the shared explicit-authority validator)', () => {
	it('accepts both spellings and answers them identically', () => {
		expect(explicitSeqValue(7)).toBe(7);
		expect(explicitSeqValue(7n)).toBe(7);
		expect(explicitSeqValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
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

	it('draws the line at the safe-integer range, on both spellings alike', () => {
		// MAX_SAFE_INTEGER is the last value the wire carries faithfully, and
		// one past it is the first it does not. Both spellings answer the same
		// way at both points - the rule is about the VALUE, so a number and a
		// bigint naming one id can never disagree.
		expect(explicitSeqValue(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
		expect(explicitSeqValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
		for (const over of [2 ** 53, 2 ** 60, 1e308]) {
			expect(() => explicitSeqValue(over), String(over)).toThrow(/exceeds the wire/i);
		}
		for (const over of [2n ** 53n, 2n ** 53n + 1n, 2n ** 53n + 2n, 2n ** 60n]) {
			expect(() => explicitSeqValue(over), String(over)).toThrow(/exceeds the wire/i);
		}
		// 2^53+2 is an EXACT double and is still refused. An exactness test
		// would have taken it while refusing 2^53+1, so a caller feeding
		// consecutive offsets through this band would have had every second
		// one rejected; and exactness would not have helped anyway, since the
		// envelope serializes 2^60 as 1152921504606847000.
		expect(BigInt(Number(2n ** 53n + 2n))).toBe(2n ** 53n + 2n);
		expect(String(2 ** 60)).not.toBe('1152921504606846976');
	});

	it('returns a value that survives the envelope as the id that was handed in', () => {
		// The class tripwire: whatever comes back must still be the caller's
		// own id after the JSON envelope has stringified it. This is the
		// property the range exists to guarantee, re-derived from the returned
		// double rather than from the guard's spelling - so it holds the line
		// wherever the line is drawn.
		let accepted = 0;
		for (let shift = 0n; shift < 64n; shift++) {
			for (const offset of [0n, 1n, 2n, 3n]) {
				const value = (1n << shift) + offset;
				if (value < 1n) continue;
				let returned;
				try {
					returned = explicitSeqValue(value);
				} catch {
					continue;
				}
				accepted++;
				expect(BigInt(returned), 'projected away from the id').toBe(value);
				// The envelope stringifies through String(double), which emits
				// the SHORTEST round-tripping decimal - not the integer. That is
				// the step an exact-double rule survived and a caller's id did
				// not: 2^60 is an exact double and still leaves as
				// 1152921504606847000. Re-parsing the returned double would
				// pass for any double at all, so the string is what is checked.
				expect(BigInt(String(returned)), 'lost in serialization').toBe(value);
			}
		}
		// A guard that refused everything would satisfy every assertion above
		// by never running one. The safe range covers 53 of the 64 shifts.
		expect(accepted, 'the range must actually admit values').toBeGreaterThan(200);
	});

	it('refuses what neither lane can carry', () => {
		for (const bad of [0, -3, 2.5, NaN, Infinity, 0n, -2n, 10n ** 400n]) {
			expect(() => explicitSeqValue(bad)).toThrow(TypeError);
		}
	});
});

// resolveEntrySeq is the batch lane's spelling of the same table, and it adds
// one thing the options lane has no use for: a refusal names the entry's
// position, because one bad value takes the whole batch down and the caller
// otherwise has no way to find it. Driven directly here - the mirror suite
// proves the five call sites pass their index, this proves what the resolver
// does with it, including the two passthroughs no call site exercises.
describe('resolveEntrySeq (the batch lane spelling)', () => {
	it('speaks the same table as the options lane', () => {
		expect(resolveEntrySeq(undefined)).toBe(undefined);
		expect(resolveEntrySeq(false)).toBe(false);
		expect(resolveEntrySeq(null), 'null is the second no-seq form').toBe(false);
		expect(resolveEntrySeq(true)).toBe(true);
		expect(resolveEntrySeq(9)).toBe(9);
		expect(resolveEntrySeq(9n), 'both spellings of one authority').toBe(9);
	});

	it('prefixes a refusal with the entry position when it is given one', () => {
		expect(() => resolveEntrySeq('7', 3)).toThrow(/^batch entry 3: /);
		expect(() => resolveEntrySeq(2 ** 53, 0), 'position 0 must still be named').toThrow(/^batch entry 0: /);
		// The prefix is additive: the shared wording survives underneath it, so
		// the two lanes cannot drift into two different explanations.
		expect(() => resolveEntrySeq('7', 3)).toThrow(/positive integer/);
		expect(() => resolveEntrySeq(2 ** 53, 1)).toThrow(/exceeds the wire/i);
	});

	it('keeps the refusal a TypeError, which callers match on', () => {
		expect(() => resolveEntrySeq('7', 3)).toThrow(TypeError);
	});

	it('leaves the message alone when no position is supplied', () => {
		// No caller passes one argument today. The branch exists so the resolver
		// stays usable without a position, and an unpinned branch is how
		// `batch entry undefined:` would reach a caller if the guard were ever
		// relaxed to only check the error type.
		expect(() => resolveEntrySeq('7')).toThrow(/^publish seq must be/);
		expect(() => resolveEntrySeq('7')).not.toThrow(/batch entry/);
		expect(() => resolveEntrySeq('7')).not.toThrow(/undefined:/);
	});

	it('does not dress up an error that is not a seq refusal', () => {
		// The value's own coercion runs inside the wrapped region: String(value)
		// on a hostile object throws from user code, not from the seq table, and
		// wrapping that as a seq refusal would misattribute it. The class guard
		// is what keeps the prefix honest.
		const hostile = { [Symbol.toPrimitive]() { throw new RangeError('from the value'); } };
		expect(() => resolveEntrySeq(hostile, 2)).toThrow(RangeError);
		expect(() => resolveEntrySeq(hostile, 2)).toThrow(/from the value/);
		expect(() => resolveEntrySeq(hostile, 2)).not.toThrow(/batch entry/);
	});
});
