import { describe, it, expect } from 'vitest';
import {
	encodeSmooth,
	decodeSmooth,
	SmoothEncodeDict,
	SmoothDecodeDict,
	SMOOTH_CAPABILITY,
	SMOOTH_TOPIC_PREFIX,
	SMOOTH_SCHEMA_VERSION
} from '../plugins/smooth/codec.js';
import { createSmoothWireCodec } from '../plugins/smooth/server.js';
import { WS_CAPS } from '../files/utils.js';
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

	it('a state richer than {x, y} rides the JSON encoding and survives exactly', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000]));
		const dec = new SmoothDecodeDict();
		const state = { x: 1, y: 2, vx: -3.25, label: 'hi', nested: { hp: [1, 2, 3] } };
		const frame = encodeSmooth('update', { key: 'a', data: state }, enc);
		const decoded = decodeSmooth(frame, dec);
		expect(decoded.event).toBe('update');
		expect(decoded.t).toBe(7000);
		expect(decoded.data).toEqual({ key: 'a', data: state });
	});

	it('a non-positional state rides the JSON encoding too', () => {
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

	it('an unserializable state declines without interning keys or advancing stamps', () => {
		const enc = new SmoothEncodeDict(scriptedTime([7000, 7016]));
		const dec = new SmoothDecodeDict();
		// BigInt makes JSON.stringify throw; undefined makes it return non-string.
		expect(encodeSmooth('update', { key: 'a', data: { v: 1n } }, enc)).toBe(null);
		expect(encodeSmooth('update', { key: 'a' }, enc)).toBe(null);
		expect(encodeSmooth('update', { key: 5, data: { x: 1, y: 2 } }, enc)).toBe(null);
		expect(encodeSmooth('update', null, enc)).toBe(null);
		expect(enc.lastT).toBe(-1);
		expect(enc.byKey.size).toBe(0);
		// The decoder never saw the failed frames and stays in lock-step: the
		// next valid frame opens with the absolute stamp and the key assign.
		const frame = encodeSmooth('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		const decoded = decodeSmooth(frame, dec);
		expect(decoded.t).toBe(7000);
		expect(decoded.data).toEqual({ key: 'a', data: { x: 1, y: 2 } });
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
		expect(state.byKey.size).toBe(1);
		codec.state.onDetach(ws, state);
		expect(state.byKey.size).toBe(0);
		expect(() => codec.state.onDetach(ws, null)).not.toThrow();
	});
});
