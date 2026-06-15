import { describe, it, expect } from 'vitest';
import {
	encodeCursor,
	decodeCursor,
	CursorTimeEncodeDict,
	CursorEncodeDict,
	CursorDecodeDict,
	CURSOR_SCHEMA_VERSION_TIME,
	CURSOR_SCHEMA_VERSION_DICT,
	CURSOR_CAPABILITY,
	CURSOR_CAPABILITY_DICT,
	CURSOR_CAPABILITY_TIME
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
		expect(decodeCursor(new Uint8Array([1, 0]), new CursorDecodeDict(), 4)).toBe(null);
		const enc = new CursorEncodeDict();
		const dec = new CursorDecodeDict();
		const frame = encodeCursor('update', { key: 'a', data: { x: 1, y: 2 } }, enc);
		const decoded = decodeCursor(frame, dec, CURSOR_SCHEMA_VERSION_DICT);
		expect(decoded.t).toBeUndefined();
		expect(decoded.data.data).toEqual({ x: 1, y: 2 });
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
		expect(state.schemaVersion).toBe(CURSOR_SCHEMA_VERSION_TIME);
		expect(typeof state.timeSource).toBe('function');
		expect(Number.isFinite(state.timeSource())).toBe(true);
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
