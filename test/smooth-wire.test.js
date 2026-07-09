import { describe, it, expect } from 'vitest';
import {
	encodeCursor,
	decodeCursor,
	CursorTimeEncodeDict,
	CursorStreamEncodeDict,
	CursorEncodeDict,
	CursorDecodeDict,
	CURSOR_SCHEMA_VERSION_TIME,
	CURSOR_SCHEMA_VERSION_DICT,
	CURSOR_SCHEMA_VERSION_STREAM,
	CURSOR_CAPABILITY,
	CURSOR_CAPABILITY_DICT,
	CURSOR_CAPABILITY_TIME,
	CURSOR_CAPABILITY_STREAM
} from '../src/plugins/cursor/codec.js';
import { createCursor, createCursorWireCodec } from '../src/plugins/cursor/server.js';
import { WS_CAPS } from '../src/runtime/utils.js';
import { mockWs, mockPlatform } from './_helpers.js';

/** A scripted time source: returns the next value on each call. */
function scriptedTime(values) {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

describe('cursor codec schemaVersion 3 (server-stamped wire)', () => {
	it('round-trips update frames with delta-coded stamps', () => {
		const enc = new CursorTimeEncodeDict(scriptedTime([5000, 5016, 5016, 5010]));
		const dec = new CursorDecodeDict();
		const frames = [
			encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc),
			encodeCursor('update', { key: 'a', data: { x: 3, y: 4 } }, enc),
			encodeCursor('update', { key: 'b', data: { x: 5, y: 6 } }, enc),
			encodeCursor('update', { key: 'a', data: { x: 7, y: 8 } }, enc) // wall stepped back
		];
		const decoded = frames.map((f) => decodeCursor(f, dec, CURSOR_SCHEMA_VERSION_TIME));
		expect(decoded.map((d) => d.t)).toEqual([5000, 5016, 5016, 5016]);
		expect(decoded[0].data).toEqual({ key: 'a', data: { x: 1, y: 2 } });
		expect(decoded[3].data).toEqual({ key: 'a', data: { x: 7, y: 8 } });
	});

	it('the steady-state stamp costs one byte, not a full epoch', () => {
		const enc = new CursorTimeEncodeDict(scriptedTime([1_750_000_000_000, 1_750_000_000_016]));
		const first = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		const second = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		// First frame also pays the key assign; the comparison that isolates
		// the stamp is against a fresh dict's second frame at v2.
		const enc2 = new CursorEncodeDict();
		encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc2);
		const secondV2 = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc2);
		expect(second.length).toBe(secondV2.length + 1);
		expect(first.length).toBeGreaterThan(second.length + 4); // absolute epoch ~6 bytes
	});

	it('round-trips bulk frames with one stamp for all entries', () => {
		const enc = new CursorTimeEncodeDict(scriptedTime([8000]));
		const dec = new CursorDecodeDict();
		const frame = encodeCursor('bulk', [
			{ key: 'a', data: { x: 1, y: 2 } },
			{ key: 'b', data: { x: 3, y: 4 } }
		], enc);
		const decoded = decodeCursor(frame, dec, CURSOR_SCHEMA_VERSION_TIME);
		expect(decoded.t).toBe(8000);
		expect(decoded.data).toHaveLength(2);
		expect(decoded.data[1]).toEqual({ key: 'b', data: { x: 3, y: 4 } });
	});

	it('roster ops carry no stamp and leave the stamp state untouched', () => {
		const enc = new CursorTimeEncodeDict(scriptedTime([9000, 9016]));
		const dec = new CursorDecodeDict();
		const join = encodeCursor('join', { key: 'a', user: { name: 'x' } }, enc);
		const decodedJoin = decodeCursor(join, dec, CURSOR_SCHEMA_VERSION_TIME);
		expect(decodedJoin.t).toBeUndefined();
		expect(enc.lastT).toBe(-1);
		// The first position frame after roster traffic still writes the
		// absolute stamp and both sides agree.
		const upd = encodeCursor('update', { key: 'a', data: { x: 1, y: 1 } }, enc);
		expect(decodeCursor(upd, dec, CURSOR_SCHEMA_VERSION_TIME).t).toBe(9000);
	});

	it('a JSON fallback leaves both the key dict and the stamp untouched', () => {
		const enc = new CursorTimeEncodeDict(scriptedTime([7000, 7016]));
		// Rich data beyond {x, y} cannot ride the binary wire.
		expect(encodeCursor('update', { key: 'a', data: { x: 1, y: 2, label: 'hi' } }, enc)).toBe(null);
		expect(enc.lastT).toBe(-1);
		expect(enc.byKey.size).toBe(0);
		// 'time' is the snapshot clock event: deliberately JSON-only.
		expect(encodeCursor('time', { t: 123 }, enc)).toBe(null);
		expect(enc.lastT).toBe(-1);
	});

	it('a stamped frame without a decoder dictionary is dropped', () => {
		const enc = new CursorTimeEncodeDict(scriptedTime([5000]));
		const frame = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		expect(decodeCursor(frame, undefined, CURSOR_SCHEMA_VERSION_TIME)).toBe(null);
	});

	it('an unknown schema version is dropped, v1/v2 decode unchanged', () => {
		expect(decodeCursor(new Uint8Array([1, 0]), new CursorDecodeDict(), 5)).toBe(null);
		const enc = new CursorEncodeDict();
		const dec = new CursorDecodeDict();
		const frame = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		const decoded = decodeCursor(frame, dec, CURSOR_SCHEMA_VERSION_DICT);
		expect(decoded.t).toBeUndefined();
		expect(decoded.data.data).toEqual({ x: 1, y: 2 });
	});
});

describe('cursor codec schemaVersion 4 (temporally-streamed positions)', () => {
	/** Encode->decode one update over a shared v4 dict pair. */
	function roundTrip(enc, dec, key, x, y) {
		const frame = encodeCursor('update', { key, data: { x, y } }, enc);
		expect(frame).not.toBe(null);
		const decoded = decodeCursor(frame, dec, CURSOR_SCHEMA_VERSION_STREAM);
		expect(decoded).not.toBe(null);
		return { frame, decoded };
	}

	it('round-trips a drifting cursor and shrinks the steady-state frame', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime([5000, 5016, 5032, 5048]));
		const dec = new CursorDecodeDict();
		const a = roundTrip(enc, dec, 'a', 100, 200);
		expect(a.decoded.data).toEqual({ key: 'a', data: { x: 100, y: 200 } });
		expect(a.decoded.t).toBe(5000);
		// Whole-pixel drift rides the integer stream: a few bits per axis.
		const b = roundTrip(enc, dec, 'a', 101, 199);
		expect(b.decoded.data).toEqual({ key: 'a', data: { x: 101, y: 199 } });
		expect(b.decoded.t).toBe(5016);
		const c = roundTrip(enc, dec, 'a', 102, 198);
		expect(c.decoded.data).toEqual({ key: 'a', data: { x: 102, y: 198 } });
		// Steady state: [op][1-byte stamp][1-byte keyref][~2 bytes of position bits]
		// vs the v3 equivalent's 8 bytes of raw f32 positions.
		expect(c.frame.length).toBeLessThan(8);
		const encV3 = new CursorTimeEncodeDict(scriptedTime([5000, 5016]));
		encodeCursor('update', { key: 'a', data: { x: 100, y: 200 } }, encV3);
		const v3Steady = encodeCursor('update', { key: 'a', data: { x: 101, y: 199 } }, encV3);
		expect(c.frame.length).toBeLessThan(v3Steady.length);
	});

	it('delivers exactly the float32-narrowed value the v3 wire would have', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime([5000, 5016]));
		const dec = new CursorDecodeDict();
		// A fractional position that does not survive f32 exactly: the streamed
		// wire must deliver Math.fround(x), not the double - the precision
		// contract is unchanged across schema versions.
		const x = 123.4567891;
		const y = 0.1;
		const { decoded } = roundTrip(enc, dec, 'a', x, y);
		expect(decoded.data.data.x).toBe(Math.fround(x));
		expect(decoded.data.data.y).toBe(Math.fround(y));
		expect(decoded.data.data.x).not.toBe(x);
	});

	it('round-trips bulk frames: byte-aligned keyrefs, one trailing bit block', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime([8000, 8016]));
		const dec = new CursorDecodeDict();
		const first = encodeCursor('bulk', [
			{ key: 'a', data: { x: 1, y: 2 } },
			{ key: 'b', data: { x: 300.5, y: -4.25 } }
		], enc);
		const d1 = decodeCursor(first, dec, CURSOR_SCHEMA_VERSION_STREAM);
		expect(d1.t).toBe(8000);
		expect(d1.data).toEqual([
			{ key: 'a', data: { x: 1, y: 2 } },
			{ key: 'b', data: { x: 300.5, y: -4.25 } }
		]);
		// The second bulk deltas every cursor against its own previous sample.
		const second = encodeCursor('bulk', [
			{ key: 'a', data: { x: 2, y: 3 } },
			{ key: 'b', data: { x: 301.5, y: -4.25 } }
		], enc);
		const d2 = decodeCursor(second, dec, CURSOR_SCHEMA_VERSION_STREAM);
		expect(d2.data).toEqual([
			{ key: 'a', data: { x: 2, y: 3 } },
			{ key: 'b', data: { x: 301.5, y: -4.25 } }
		]);
		expect(second.length).toBeLessThan(first.length);
	});

	it('a remove clears the cursor stream on both ends: reappearance starts fresh', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime([5000, 5016, 5032]));
		const dec = new CursorDecodeDict();
		roundTrip(enc, dec, 'a', 100, 200);
		const rm = encodeCursor('remove', { key: 'a' }, enc);
		expect(enc.slots.has('a')).toBe(false);
		expect(decodeCursor(rm, dec, CURSOR_SCHEMA_VERSION_STREAM)).toEqual({ event: 'remove', data: { key: 'a' } });
		expect(dec.slots.has('a')).toBe(false);
		// The re-appearing cursor first-sights (a full 64-bit sample per axis)
		// and still decodes exactly.
		const back = roundTrip(enc, dec, 'a', 50, 60);
		expect(back.decoded.data).toEqual({ key: 'a', data: { x: 50, y: 60 } });
	});

	it('a JSON fallback leaves the key dict, the stamp, and the streams untouched', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime([7000, 7016]));
		const dec = new CursorDecodeDict();
		roundTrip(enc, dec, 'a', 1, 2);
		// Rich data beyond {x, y} declines to JSON - and must not perturb the
		// stream, so the NEXT binary frame still decodes in lock-step.
		expect(encodeCursor('update', { key: 'a', data: { x: 9, y: 9, label: 'hi' } }, enc)).toBe(null);
		const next = roundTrip(enc, dec, 'a', 3, 4);
		expect(next.decoded.data).toEqual({ key: 'a', data: { x: 3, y: 4 } });
	});

	it('a streamed frame without the slot store is dropped, never misread', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime([5000]));
		const frame = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		expect(decodeCursor(frame, undefined, CURSOR_SCHEMA_VERSION_STREAM)).toBe(null);
		const legacy = new CursorDecodeDict();
		legacy.slots = null; // an old decoder instance without the store
		expect(decodeCursor(frame, legacy, CURSOR_SCHEMA_VERSION_STREAM)).toBe(null);
	});

	it('a long two-cursor session round-trips exactly (mixed int and fractional motion)', () => {
		const enc = new CursorStreamEncodeDict(scriptedTime(Array.from({ length: 60 }, (_, i) => 1000 + i * 16)));
		const dec = new CursorDecodeDict();
		let ax = 0; let ay = 0; let bx = 500.25; let by = 300.75;
		for (let i = 0; i < 30; i++) {
			ax += (i % 3); ay += 1; // integer motion
			bx += 0.5; by -= 0.25; // fractional motion
			const fa = encodeCursor('update', { key: 'a', data: { x: ax, y: ay } }, enc);
			const fb = encodeCursor('update', { key: 'b', data: { x: bx, y: by } }, enc);
			expect(decodeCursor(fa, dec, CURSOR_SCHEMA_VERSION_STREAM).data).toEqual({ key: 'a', data: { x: Math.fround(ax), y: Math.fround(ay) } });
			expect(decodeCursor(fb, dec, CURSOR_SCHEMA_VERSION_STREAM).data).toEqual({ key: 'b', data: { x: Math.fround(bx), y: Math.fround(by) } });
		}
	});
});

describe('createCursorWireCodec capability negotiation', () => {
	function attachFor(caps) {
		const codec = createCursorWireCodec();
		const ws = mockWs({ [WS_CAPS]: caps === null ? undefined : new Set(caps) });
		return codec.state.onAttach(ws);
	}

	it('time + dict capabilities negotiate the stamped dictionary', () => {
		const state = attachFor([CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME]);
		expect(state).toBeInstanceOf(CursorTimeEncodeDict);
		expect(state).not.toBeInstanceOf(CursorStreamEncodeDict);
		expect(state.schemaVersion).toBe(CURSOR_SCHEMA_VERSION_TIME);
		expect(typeof state.timeSource).toBe('function');
		expect(Number.isFinite(state.timeSource())).toBe(true);
	});

	it('stream + time + dict capabilities negotiate the streamed dictionary', () => {
		const state = attachFor([CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME, CURSOR_CAPABILITY_STREAM]);
		expect(state).toBeInstanceOf(CursorStreamEncodeDict);
		expect(state.schemaVersion).toBe(CURSOR_SCHEMA_VERSION_STREAM);
		expect(state.slots).toBeInstanceOf(Map);
	});

	it('stream without time stays at its highest complete rung (the ladder is linear)', () => {
		const state = attachFor([CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_STREAM]);
		expect(state).toBeInstanceOf(CursorEncodeDict);
		expect(state).not.toBeInstanceOf(CursorTimeEncodeDict);
	});

	it('dict-only stays at the plain dictionary', () => {
		const state = attachFor([CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT]);
		expect(state).toBeInstanceOf(CursorEncodeDict);
		expect(state).not.toBeInstanceOf(CursorTimeEncodeDict);
	});

	it('time without dict cannot upgrade (the stamped wire is dictionaried)', () => {
		expect(attachFor([CURSOR_CAPABILITY, CURSOR_CAPABILITY_TIME])).toBe(null);
		expect(attachFor([CURSOR_CAPABILITY])).toBe(null);
		expect(attachFor(null)).toBe(null);
	});
});

describe('snapshot time seed', () => {
	it('the snapshot reply leads with the server time event', async () => {
		const cursors = createCursor();
		const platform = mockPlatform();
		const ws = mockWs();
		await cursors.snapshot(ws, 'board', platform);
		expect(platform.sent).toHaveLength(4);
		expect(platform.sent[0].event).toBe('time');
		expect(platform.sent[0].topic).toBe('__cursor:board');
		expect(typeof platform.sent[0].data.t).toBe('number');
		expect(Number.isFinite(platform.sent[0].data.t)).toBe(true);
		expect(platform.sent[1].event).toBe('you');
		expect(platform.sent[2].event).toBe('catalog');
		expect(platform.sent[3].event).toBe('bulk');
	});
});
