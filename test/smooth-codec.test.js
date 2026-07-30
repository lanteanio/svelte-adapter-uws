import { describe, it, expect } from 'vitest';
import {
	encodeSmooth,
	decodeSmooth,
	SmoothEncodeDict,
	SmoothDecodeDict,
	SMOOTH_CAPABILITY,
	SMOOTH_TOPIC_PREFIX,
	SMOOTH_SCHEMA_VERSION
} from '../src/plugins/smooth/codec.js';
import { createSmoothWireCodec } from '../src/plugins/smooth/server.js';
import { WS_CAPS } from '../src/runtime/utils.js';
import { mockWs } from './_helpers.js';

/** A scripted time source: returns the next value on each call. */
function scriptedTime(values) {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

describe('smooth wire constants', () => {
	it('pins the negotiated capability, topic prefix, and schema version', () => {
		expect(SMOOTH_CAPABILITY).toBe('smooth.protocol:1');
		expect(SMOOTH_TOPIC_PREFIX).toBe('__smooth:');
		expect(SMOOTH_SCHEMA_VERSION).toBe(1);
	});
});

describe('encodeSmooth / decodeSmooth round trips', () => {
	it('round-trips coordinate updates with delta-coded stamps', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000, 5016, 5016, 5010]));
		const dec = new SmoothDecodeDict();
		const frames = [
			encodeSmooth('update', { key: 'a', data: { x: 1.5, y: 2.5 } }, enc),
			encodeSmooth('update', { key: 'a', data: { x: 3.5, y: 4.5 } }, enc),
			encodeSmooth('update', { key: 'b', data: { x: 5.5, y: 6.5 } }, enc),
			encodeSmooth('update', { key: 'a', data: { x: 7.5, y: 8.5 } }, enc) // wall stepped back
		];
		const decoded = frames.map((f) => decodeSmooth(f, dec));
		// The backward wall step writes a zero delta and holds: both sides
		// stay non-decreasing and in lock-step.
		expect(decoded.map((d) => d.t)).toEqual([5000, 5016, 5016, 5016]);
		expect(decoded[0]).toEqual({ event: 'update', data: { key: 'a', data: { x: 1.5, y: 2.5 } }, t: 5000 });
		expect(decoded[2].data).toEqual({ key: 'b', data: { x: 5.5, y: 6.5 } });
		expect(decoded[3].data).toEqual({ key: 'a', data: { x: 7.5, y: 8.5 } });
	});

	it('a state richer than {x, y} rides the field delta and survives exactly', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000]));
		const dec = new SmoothDecodeDict();
		const state = { x: 1, y: 2, vx: -3.25, label: 'hi', nested: { hp: [1, 2, 3] } };
		const frame = encodeSmooth('update', { key: 'a', data: state }, enc);
		const decoded = decodeSmooth(frame, dec);
		expect(decoded.event).toBe('update');
		expect(decoded.t).toBe(7000);
		expect(decoded.data).toEqual({ key: 'a', data: state });
	});

	it('a non-positional state rides the field delta too', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000]));
		const dec = new SmoothDecodeDict();
		const frame = encodeSmooth('update', { key: 'a', data: { hp: 10, name: 'bob' } }, enc);
		expect(decodeSmooth(frame, dec).data.data).toEqual({ hp: 10, name: 'bob' });
	});

	it('round-trips coordinate acks: id, t, and state intact, t inside the data', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000]));
		const dec = new SmoothDecodeDict();
		const frame = encodeSmooth('ack', { id: 37, t: 123456, state: { x: 1.5, y: -2.5 } }, enc);
		const decoded = decodeSmooth(frame, dec);
		expect(decoded).toEqual({ event: 'ack', data: { id: 37, state: { x: 1.5, y: -2.5 }, t: 123456 } });
		// The ack stamp is absolute and travels outside the delta chain.
		expect(decoded.t).toBeUndefined();
	});

	it('round-trips JSON-state acks', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000]));
		const dec = new SmoothDecodeDict();
		const frame = encodeSmooth('ack', { id: 2, t: 999, state: { hp: 3, x: 1 } }, enc);
		expect(decodeSmooth(frame, dec)).toEqual({ event: 'ack', data: { id: 2, state: { hp: 3, x: 1 }, t: 999 } });
		// An absent state rides as null rather than declining the frame.
		const bare = encodeSmooth('ack', { id: 3, t: 1000 }, enc);
		expect(decodeSmooth(bare, dec)).toEqual({ event: 'ack', data: { id: 3, state: null, t: 1000 } });
	});

	it('declines acks with a missing or invalid stamp; floors valid floats', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000]));
		const dec = new SmoothDecodeDict();
		// Missing/invalid stamps ride the JSON fallback (where the field is
		// simply absent and the client skips the clock sample) - a coerced
		// epoch would poison binary clients' clock estimators.
		expect(encodeSmooth('ack', { id: 1, state: { x: 1, y: 1 } }, enc)).toBe(null);
		expect(encodeSmooth('ack', { id: 4, t: -5, state: { x: 1, y: 1 } }, enc)).toBe(null);
		expect(encodeSmooth('ack', { id: 4, t: NaN, state: { x: 1, y: 1 } }, enc)).toBe(null);
		expect(decodeSmooth(encodeSmooth('ack', { id: 5, t: 10.9, state: { x: 1, y: 1 } }, enc), dec).data.t).toBe(10);
	});

	it('rejects invalid ack ids', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000]));
		expect(encodeSmooth('ack', { id: -1, t: 0, state: { x: 1, y: 1 } }, enc)).toBe(null);
		expect(encodeSmooth('ack', { id: 1.5, t: 0, state: { x: 1, y: 1 } }, enc)).toBe(null);
		expect(encodeSmooth('ack', { t: 0, state: { x: 1, y: 1 } }, enc)).toBe(null);
		expect(enc.lastT).toBe(-1);
	});

	it('acks never touch the delta-stamp chain', () => {
		const enc = new SmoothEncodeDict(scriptedTime([9000, 9016]));
		const dec = new SmoothDecodeDict();
		const ack = encodeSmooth('ack', { id: 1, t: 8888, state: { x: 0, y: 0 } }, enc);
		expect(enc.lastT).toBe(-1);
		expect(decodeSmooth(ack, dec).data.t).toBe(8888);
		// The first update after ack traffic still writes the absolute stamp
		// and both sides agree.
		const upd = encodeSmooth('update', { key: 'a', data: { x: 1, y: 1 } }, enc);
		expect(decodeSmooth(upd, dec).t).toBe(9000);
	});

	it('round-trips remove frames', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000]));
		const dec = new SmoothDecodeDict();
		const frame = encodeSmooth('remove', { key: 'gone' }, enc);
		expect(decodeSmooth(frame, dec)).toEqual({ event: 'remove', data: { key: 'gone' } });
		expect(encodeSmooth('remove', {}, enc)).toBe(null);
		expect(encodeSmooth('remove', null, enc)).toBe(null);
	});
});

describe('dictionary discipline', () => {
	it('assigns a key once, then refs: later frames are shorter and still resolve', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000, 5016, 5032]));
		const dec = new SmoothDecodeDict();
		const first = encodeSmooth('update', { key: 'player-one', data: { x: 1, y: 2 } }, enc);
		const second = encodeSmooth('update', { key: 'player-one', data: { x: 3, y: 4 } }, enc);
		const third = encodeSmooth('update', { key: 'player-one', data: { x: 5, y: 6 } }, enc);
		// The key string travels once; the steady state pays a 1-byte ref and
		// a 1-byte stamp delta.
		expect(second.length).toBeLessThan(first.length - 'player-one'.length + 2);
		expect(third.length).toBe(second.length);
		expect(decodeSmooth(first, dec).data.key).toBe('player-one');
		expect(decodeSmooth(second, dec).data.key).toBe('player-one');
		expect(decodeSmooth(third, dec).data.key).toBe('player-one');
		expect(enc.byKey.size).toBe(1);
	});

	it('a declined event leaves the dictionary and stamp untouched', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000, 7016]));
		// Additive events have no binary form: they fall back to JSON.
		expect(encodeSmooth('other', { key: 'a', data: { x: 1, y: 2 } }, enc)).toBe(null);
		expect(encodeSmooth('time', { t: 123 }, enc)).toBe(null);
		expect(enc.lastT).toBe(-1);
		expect(enc.byKey.size).toBe(0);
	});

	it('an un-encodable frame declines without interning keys or advancing stamps', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000, 7016]));
		const dec = new SmoothDecodeDict();
		// A missing state, a non-string key, and a null envelope all decline; the
		// dict, the stamp, and the field-delta baseline stay untouched.
		expect(encodeSmooth('update', { key: 'a' }, enc)).toBe(null);
		expect(encodeSmooth('update', { key: 5, data: { x: 1, y: 2 } }, enc)).toBe(null);
		expect(encodeSmooth('update', null, enc)).toBe(null);
		expect(enc.lastT).toBe(-1);
		expect(enc.byKey.size).toBe(0);
		expect(enc.fields.byKey.size).toBe(0);
		expect(enc.baseline.size).toBe(0);
		// The decoder never saw the failed frames and stays in lock-step: the
		// next valid frame opens with the absolute stamp and the key assign.
		const frame = encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		const decoded = decodeSmooth(frame, dec);
		expect(decoded.t).toBe(7000);
		expect(decoded.data).toEqual({ key: 'a', data: { x: 1, y: 2 } });
	});

	it('a field whose value JSON drops degrades exactly as the value codec does', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000]));
		const dec = new SmoothDecodeDict();
		// BigInt / function / symbol values ride the JSON-faithful value codec: a
		// bigint degrades to null (as it does on the command wire) and a function
		// or symbol value drops the key entirely, exactly as JSON.stringify treats
		// them at an object-field position.
		const frame = encodeSmooth('update', { key: 'a', data: { v: 1n, keep: 2, fn: () => 0 } }, enc);
		expect(decodeSmooth(frame, dec).data.data).toEqual({ v: null, keep: 2 });
	});

	it('encoding without a dictionary (or with a foreign one) declines', () => {
		expect(encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } })).toBe(null);
		expect(encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } }, null)).toBe(null);
		const foreign = new SmoothEncodeDict(scriptedTime([5000]));
		foreign.schemaVersion = 99;
		expect(encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } }, foreign)).toBe(null);
	});
});

describe('decodeSmooth malformed input', () => {
	function freshFrame() {
		const enc = new SmoothEncodeDict(scriptedTime([5000]));
		return encodeSmooth('update', { key: 'abcdef', data: { x: 1, y: 2 } }, enc);
	}

	it('drops an unknown opcode', () => {
		expect(decodeSmooth(new Uint8Array([99, 0, 0]), new SmoothDecodeDict())).toBe(null);
		expect(decodeSmooth(new Uint8Array([0]), new SmoothDecodeDict())).toBe(null);
	});

	it('drops an unknown schema version', () => {
		expect(decodeSmooth(freshFrame(), new SmoothDecodeDict(), 2)).toBe(null);
		expect(decodeSmooth(freshFrame(), new SmoothDecodeDict(), 0)).toBe(null);
	});

	it('drops a frame without a decoder dictionary', () => {
		expect(decodeSmooth(freshFrame(), undefined)).toBe(null);
		expect(decodeSmooth(freshFrame(), null)).toBe(null);
		expect(decodeSmooth(freshFrame(), {})).toBe(null);
	});

	it('drops a truncated payload at every cut point', () => {
		const frame = freshFrame();
		for (let cut = 1; cut < frame.length; cut++) {
			expect(decodeSmooth(frame.slice(0, cut), new SmoothDecodeDict())).toBe(null);
		}
		expect(decodeSmooth(new Uint8Array(0), new SmoothDecodeDict())).toBe(null);
	});

	it('drops a frame whose keyref the dictionary cannot resolve', () => {
		const enc = new SmoothEncodeDict(scriptedTime([5000, 5016]));
		encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } }, enc); // carries the assign
		const refFrame = encodeSmooth('update', { key: 'a', data: { x: 3, y: 4 } }, enc);
		// A decoder that never saw the assign cannot resolve the ref.
		expect(decodeSmooth(refFrame, new SmoothDecodeDict())).toBe(null);
		// Same desync on a remove frame.
		const removeFrame = encodeSmooth('remove', { key: 'a' }, enc);
		expect(decodeSmooth(removeFrame, new SmoothDecodeDict())).toBe(null);
	});
});

describe('field-delta state', () => {
	/** Drive one encode->decode over a shared dict pair, asserting the round trip. */
	function roundTrip(enc, dec, key, state) {
		const frame = encodeSmooth('update', { key, data: state }, enc);
		expect(frame).not.toBe(null);
		const decoded = decodeSmooth(frame, dec);
		expect(decoded.event).toBe('update');
		expect(decoded.data.key).toBe(key);
		return { frame, decoded };
	}

	it('sends only the changed fields after the first frame, reconstructing exactly', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		const first = roundTrip(enc, dec, 'p', { x: 1, y: 2, vx: 3, vy: 4, hp: 100 });
		expect(first.decoded.data.data).toEqual({ x: 1, y: 2, vx: 3, vy: 4, hp: 100 });
		// Only x and y move next tick: the steady-state frame is far smaller than
		// the first, and still reconstructs the full state.
		const second = roundTrip(enc, dec, 'p', { x: 5, y: 6, vx: 3, vy: 4, hp: 100 });
		expect(second.decoded.data.data).toEqual({ x: 5, y: 6, vx: 3, vy: 4, hp: 100 });
		expect(second.frame.length).toBeLessThan(first.frame.length);
		// An unchanged tick carries the op, the stamp delta, the key ref, and two
		// zero counts - nothing else.
		const third = roundTrip(enc, dec, 'p', { x: 5, y: 6, vx: 3, vy: 4, hp: 100 });
		expect(third.decoded.data.data).toEqual({ x: 5, y: 6, vx: 3, vy: 4, hp: 100 });
		expect(third.frame.length).toBeLessThanOrEqual(second.frame.length);
	});

	it('carries added and removed fields', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		roundTrip(enc, dec, 'e', { x: 1, y: 1, hp: 10 });
		// hp drops out, weapon appears.
		const b = roundTrip(enc, dec, 'e', { x: 1, y: 1, weapon: 'rifle' });
		expect(b.decoded.data.data).toEqual({ x: 1, y: 1, weapon: 'rifle' });
		// hp comes back with a new value, weapon stays.
		const c = roundTrip(enc, dec, 'e', { x: 1, y: 1, weapon: 'rifle', hp: 5 });
		expect(c.decoded.data.data).toEqual({ x: 1, y: 1, weapon: 'rifle', hp: 5 });
	});

	it('treats a field set to undefined as removed, matching JSON', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016]));
		const dec = new SmoothDecodeDict();
		roundTrip(enc, dec, 'e', { x: 1, hp: 9 });
		const b = roundTrip(enc, dec, 'e', { x: 1, hp: undefined });
		expect(b.decoded.data.data).toEqual({ x: 1 });
		expect('hp' in b.decoded.data.data).toBe(false);
	});

	it('interns each field name once across entities that share a vocabulary', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032, 1048]));
		const dec = new SmoothDecodeDict();
		// Two entities with the same field shape. The second entity's fields ref the
		// dictionary the first entity already populated, so its first frame is not
		// paying to announce the field names again.
		const a1 = roundTrip(enc, dec, 'a', { hp: 1, ammo: 2, score: 3 });
		const b1 = roundTrip(enc, dec, 'b', { hp: 4, ammo: 5, score: 6 });
		expect(a1.decoded.data.data).toEqual({ hp: 1, ammo: 2, score: 3 });
		expect(b1.decoded.data.data).toEqual({ hp: 4, ammo: 5, score: 6 });
		// b's first frame carries only the entity-key assign extra over a's; the
		// three field names are already interned. It must be shorter than a's first
		// frame minus the field-name bytes it no longer sends.
		expect(b1.frame.length).toBeLessThan(a1.frame.length);
		expect(enc.fields.byKey.size).toBe(3);
	});

	it('keeps an object stream deltable across an interleaved XY frame', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		// Full object, then a pure {x,y} (rides the XY op, leaves the baseline
		// frozen), then a richer object again: the delta resumes against the basis
		// both ends still hold and the reconstruction is exact.
		roundTrip(enc, dec, 'e', { x: 1, y: 1, hp: 5 });
		const xy = roundTrip(enc, dec, 'e', { x: 2, y: 2 });
		expect(xy.decoded.data.data).toEqual({ x: 2, y: 2 });
		const back = roundTrip(enc, dec, 'e', { x: 3, y: 3, hp: 5 });
		expect(back.decoded.data.data).toEqual({ x: 3, y: 3, hp: 5 });
	});

	it('re-sends the full field set after a remove (reappearance is first-sight)', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		roundTrip(enc, dec, 'e', { x: 1, y: 1, hp: 9 });
		expect(decodeSmooth(encodeSmooth('remove', { key: 'e' }, enc), dec)).toEqual({
			event: 'remove',
			data: { key: 'e' }
		});
		expect(enc.baseline.has('e')).toBe(false);
		expect(dec.baseline.has('e')).toBe(false);
		// The entity comes back as {x,y} only: without a first-sight full set the
		// decoder would still be carrying the stale hp.
		const back = roundTrip(enc, dec, 'e', { x: 2, y: 2 });
		expect(back.decoded.data.data).toEqual({ x: 2, y: 2 });
	});

	it('stays in lock-step across a declined frame (baseline frozen)', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		roundTrip(enc, dec, 'e', { x: 1, y: 1, hp: 5 });
		// A declined event (no binary form) must not move the baseline or stamp.
		expect(encodeSmooth('other', { key: 'e', data: { x: 9 } }, enc)).toBe(null);
		const next = roundTrip(enc, dec, 'e', { x: 2, y: 1, hp: 5 });
		expect(next.decoded.data.data).toEqual({ x: 2, y: 1, hp: 5 });
	});

	it('reconstructs a long mutating sequence exactly', () => {
		const enc = new SmoothEncodeDict(scriptedTime(Array.from({ length: 40 }, (_, i) => 1000 + i * 16)));
		const dec = new SmoothDecodeDict();
		let state = { x: 0, y: 0, vx: 0, vy: 0, hp: 100, weapon: 'knife', ammo: 0 };
		for (let i = 0; i < 40; i++) {
			// Functional updates: a changed field is a new value (new reference for
			// the nested object), the contract the delta rests on.
			state = { ...state, x: i, y: i * 2 };
			if (i % 5 === 0) state = { ...state, hp: state.hp - 1 };
			if (i % 7 === 0) state = { ...state, weapon: i % 14 === 0 ? 'rifle' : 'pistol', ammo: i };
			if (i === 20) state = { ...state, extra: { nested: [i, i + 1] } };
			if (i === 30) { const { extra, ...rest } = state; state = rest; }
			const { decoded } = roundTrip(enc, dec, 'p', state);
			expect(decoded.data.data).toEqual(state);
		}
	});

	it('round-trips a field that flips numeric -> literal -> numeric (slot reset)', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032, 1048]));
		const dec = new SmoothDecodeDict();
		// hp is a number, then a string ("dead"), then a number again. The numeric
		// stream slot must reset when it leaves as a literal, so the re-entry
		// first-sights instead of XOR-ing against a stale sample.
		const a = roundTrip(enc, dec, 'e', { x: 1, hp: 100 });
		expect(a.decoded.data.data).toEqual({ x: 1, hp: 100 });
		const b = roundTrip(enc, dec, 'e', { x: 1, hp: 'dead' });
		expect(b.decoded.data.data).toEqual({ x: 1, hp: 'dead' });
		const c = roundTrip(enc, dec, 'e', { x: 1, hp: 42 });
		expect(c.decoded.data.data).toEqual({ x: 1, hp: 42 });
	});

	it('round-trips a frame that mixes changed numeric and literal fields', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016]));
		const dec = new SmoothDecodeDict();
		roundTrip(enc, dec, 'e', { x: 1.5, y: 2.5, name: 'a', alive: true });
		const b = roundTrip(enc, dec, 'e', { x: 9.5, y: 2.5, name: 'b', alive: false });
		// x and name changed (numeric + literal in one frame), y and... unchanged.
		expect(b.decoded.data.data).toEqual({ x: 9.5, y: 2.5, name: 'b', alive: false });
	});

	it('normalizes a -0 field to 0 on the delta path like the JSON round trip', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000]));
		const dec = new SmoothDecodeDict();
		// Three fields, so it rides the field delta (not the exactly-{x,y} fast path).
		const { decoded } = roundTrip(enc, dec, 'e', { x: -0, y: 5, z: 1 });
		expect(Object.is(decoded.data.data.x, 0)).toBe(true); // +0, not -0
	});

	it('a moving float field shrinks in steady state via the value stream', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016, 1032]));
		const dec = new SmoothDecodeDict();
		const first = roundTrip(enc, dec, 'e', { x: 123.5, y: 456.25, hp: 100 });
		const moved = roundTrip(enc, dec, 'e', { x: 124.0, y: 456.75, hp: 100 });
		expect(moved.decoded.data.data).toEqual({ x: 124.0, y: 456.75, hp: 100 });
		// hp unchanged (not sent); only x and y ride the bit stream, so the moved
		// frame is a fraction of the first-sight frame that carried three f64s.
		expect(moved.frame.length).toBeLessThan(first.frame.length);
	});

	it('the steady-state field delta is a large win over the full field set', () => {
		// The local, deterministic byte measurement the field delta targets: a
		// representative multi-field entity whose position moves each tick. The
		// first-sight frame carries every field name and value (what every tick
		// would cost WITHOUT the delta); the steady-state frame carries only the
		// two moved fields.
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016]));
		const dec = new SmoothDecodeDict();
		const s0 = { x: 100, y: 200, vx: 1, vy: -2, angle: 0.5, hp: 100, armor: 50, weapon: 'rifle', ammo: 30, flags: 3 };
		const s1 = { ...s0, x: 101, y: 199 };
		const fullSet = encodeSmooth('update', { key: 'player', data: s0 }, enc); // first-sight = full
		const deltaSteady = encodeSmooth('update', { key: 'player', data: s1 }, enc);
		expect(deltaSteady.length).toBeLessThan(fullSet.length / 2);
		// The steady-state frame still reconstructs the exact state.
		expect(decodeSmooth(fullSet, dec).data.data).toEqual(s0);
		expect(decodeSmooth(deltaSteady, dec).data.data).toEqual(s1);
	});
});

describe('createSmoothWireCodec', () => {
	function attachFor(caps, options) {
		const codec = createSmoothWireCodec(options);
		const ws = mockWs({ [WS_CAPS]: caps === null ? undefined : new Set(caps) });
		return codec.state.onAttach(ws);
	}

	it('exposes the codec definition the framework registers', () => {
		const codec = createSmoothWireCodec();
		expect(codec.capability).toBe(SMOOTH_CAPABILITY);
		expect(codec.schemaVersion).toBe(SMOOTH_SCHEMA_VERSION);
		expect(codec.encode).toBe(encodeSmooth);
	});

	it('attaches a dictionary only for connections advertising the capability', () => {
		const state = attachFor([SMOOTH_CAPABILITY]);
		expect(state).toBeInstanceOf(SmoothEncodeDict);
		expect(state.schemaVersion).toBe(SMOOTH_SCHEMA_VERSION);
		expect(typeof state.timeSource).toBe('function');
		expect(Number.isFinite(state.timeSource())).toBe(true);
	});

	it('returns null for connections without the capability', () => {
		expect(attachFor(['cursor.protocol:1'])).toBe(null);
		expect(attachFor([])).toBe(null);
		expect(attachFor(null)).toBe(null);
	});

	it('returns null when user data is unreachable', () => {
		const codec = createSmoothWireCodec();
		const broken = {
			getUserData() {
				throw new Error('closed');
			}
		};
		expect(codec.state.onAttach(broken)).toBe(null);
	});

	it('binary false disables the codec entirely', () => {
		expect(createSmoothWireCodec({ binary: false })).toBe(null);
	});

	it('an injected timeSource drives the update stamps', () => {
		const state = attachFor([SMOOTH_CAPABILITY], { timeSource: scriptedTime([4242, 4258]) });
		const dec = new SmoothDecodeDict();
		const first = encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } }, state);
		const second = encodeSmooth('update', { key: 'a', data: { x: 3, y: 4 } }, state);
		expect(decodeSmooth(first, dec).t).toBe(4242);
		expect(decodeSmooth(second, dec).t).toBe(4258);
	});

	it('onDetach clears the dictionary and tolerates a null state', () => {
		const codec = createSmoothWireCodec({ timeSource: scriptedTime([5000]) });
		const ws = mockWs({ [WS_CAPS]: new Set([SMOOTH_CAPABILITY]) });
		const state = codec.state.onAttach(ws);
		codec.encode('update', { key: 'a', data: { x: 1, y: 2 } }, state);
		codec.encode('update', { key: 'a', data: { hp: 5, mp: 3 } }, state);
		expect(state.byKey.size).toBe(1);
		expect(state.fields.byKey.size).toBe(2);
		expect(state.baseline.size).toBe(1);
		expect(state.slots.size).toBe(1);
		codec.state.onDetach(ws, state);
		expect(state.byKey.size).toBe(0);
		expect(state.fields.byKey.size).toBe(0);
		expect(state.baseline.size).toBe(0);
		expect(state.slots.size).toBe(0);
		expect(() => codec.state.onDetach(ws, null)).not.toThrow();
	});
});

describe('field-delta __proto__ field names (JSON.parse parity)', () => {
	it('a __proto__ literal field decodes as an own data property, prototype untouched', () => {
		// A field named '__proto__' must reconstruct as an inert own key -
		// byte-identical to the full-state JSON path - not be assigned through
		// the inherited setter into a live, wire-controlled prototype.
		const enc = new SmoothEncodeDict(scriptedTime([1000]));
		const dec = new SmoothDecodeDict();
		const state = JSON.parse('{"__proto__":{"isAdmin":true},"x":1}');
		const frame = encodeSmooth('update', { key: 'a', data: state }, enc);
		expect(frame).not.toBe(null);
		const data = decodeSmooth(frame, dec).data.data;
		expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
		expect(data.__proto__).toEqual({ isAdmin: true });
		expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
		expect(data.isAdmin).toBeUndefined();
		expect(JSON.stringify(data)).toBe(JSON.stringify(state));
	});

	it('a __proto__ numeric field decodes as an own data property too', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000]));
		const dec = new SmoothDecodeDict();
		const state = JSON.parse('{"__proto__":5,"x":1}');
		const frame = encodeSmooth('update', { key: 'a', data: state }, enc);
		expect(frame).not.toBe(null);
		const data = decodeSmooth(frame, dec).data.data;
		expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
		expect(data.__proto__).toBe(5);
		expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
	});

	it('a repeat-set delta carrying a __proto__ numeric field keeps it an own property', () => {
		const enc = new SmoothEncodeDict(scriptedTime([1000, 1016]));
		const dec = new SmoothDecodeDict();
		const first = encodeSmooth('update', { key: 'a', data: JSON.parse('{"__proto__":1,"x":2}') }, enc);
		expect(decodeSmooth(first, dec)).not.toBe(null);
		// Same numeric field set, no literals, nothing removed: the repeat-set op.
		const second = encodeSmooth('update', { key: 'a', data: JSON.parse('{"__proto__":3,"x":4}') }, enc);
		expect(second).not.toBe(null);
		expect(second[0]).toBe(6); // OP_STATE_DELTA_SAME
		const data = decodeSmooth(second, dec).data.data;
		expect(Object.prototype.hasOwnProperty.call(data, '__proto__')).toBe(true);
		expect(data.__proto__).toBe(3);
		expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
	});
});
