// Unit tests for the binary wire foundation: the framework frame envelope
// (src/runtime/wire.js) and the cursor payload codec (plugins/cursor/codec.js).
// Pure - no server, no sockets.

import { describe, it, expect } from 'vitest';
import {
	ByteWriter,
	ByteReader,
	buildBinaryFrame,
	parseBinaryFrame,
	allocWireId,
	wireIdAnnounce,
	createCapCounts,
	WIRE_BINARY_TAG
} from '../src/runtime/wire.js';
import {
	encodeCursor,
	decodeCursor,
	CURSOR_CAPABILITY,
	CURSOR_SCHEMA_VERSION
} from '../src/plugins/cursor/codec.js';

describe('ByteWriter / ByteReader', () => {
	it('round-trips unsigned varints across byte boundaries', () => {
		const values = [0, 1, 127, 128, 255, 256, 16383, 16384, 2 ** 21, 2 ** 32, 5_000_000_000, Number.MAX_SAFE_INTEGER];
		const w = new ByteWriter();
		for (const v of values) w.varint(v);
		const r = new ByteReader(w.take());
		for (const v of values) expect(r.varint()).toBe(v);
	});

	it('round-trips float32 (big-endian) and length-prefixed strings', () => {
		const w = new ByteWriter();
		w.f32(523.5);
		w.str('a1b2c3d4e5f6a7b8:42');
		w.str('');
		w.str('unicode éñ☃');
		const r = new ByteReader(w.take());
		expect(r.f32()).toBeCloseTo(523.5, 5);
		expect(r.str()).toBe('a1b2c3d4e5f6a7b8:42');
		expect(r.str()).toBe('');
		expect(r.str()).toBe('unicode éñ☃');
	});

	it('throws RangeError on read past end', () => {
		const r = new ByteReader(new Uint8Array([1]));
		r.u8();
		expect(() => r.u8()).toThrow(RangeError);
	});
});

describe('buildBinaryFrame / parseBinaryFrame', () => {
	it('round-trips the 0x03 header (schemaVersion, topicId, seq) and payload', () => {
		const payload = new Uint8Array([9, 8, 7]);
		const frame = buildBinaryFrame(1, 7, 123, payload);
		expect(frame[0]).toBe(WIRE_BINARY_TAG);
		const parsed = parseBinaryFrame(frame);
		expect(parsed).not.toBeNull();
		expect(parsed.schemaVersion).toBe(1);
		expect(parsed.topicId).toBe(7);
		expect(parsed.seq).toBe(123);
		expect([...parsed.payload]).toEqual([9, 8, 7]);
	});

	it('carries a seq past 2^32 without corruption (long-lived topic)', () => {
		const parsed = parseBinaryFrame(buildBinaryFrame(2, 300, 5_000_000_000, new Uint8Array([1])));
		expect(parsed.topicId).toBe(300);
		expect(parsed.seq).toBe(5_000_000_000);
		expect(parsed.schemaVersion).toBe(2);
	});

	it('returns null for a non-0x03 leading byte or a truncated frame', () => {
		expect(parseBinaryFrame(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull();
		expect(parseBinaryFrame(new Uint8Array([WIRE_BINARY_TAG]))).toBeNull();
		expect(parseBinaryFrame(new Uint8Array([]))).toBeNull();
	});
});

describe('wire id + cap-count helpers', () => {
	it('allocWireId assigns monotonic per-connection ids and reuses them', () => {
		const ud = {};
		const SLOT = Symbol('topic-ids');
		expect(allocWireId(ud, SLOT, 'a')).toEqual({ id: 1, isNew: true });
		expect(allocWireId(ud, SLOT, 'b')).toEqual({ id: 2, isNew: true });
		expect(allocWireId(ud, SLOT, 'a')).toEqual({ id: 1, isNew: false });
	});

	it('wireIdAnnounce builds a parseable control frame', () => {
		expect(JSON.parse(wireIdAnnounce('__cursor:board', 5))).toEqual({
			type: 'wire-id', topic: '__cursor:board', id: 5
		});
	});

	it('createCapCounts tracks live advertisements and clears at zero', () => {
		const cc = createCapCounts();
		expect(cc.has('x')).toBe(false);
		cc.adjust(undefined, new Set(['x', 'y']));
		cc.adjust(undefined, new Set(['x']));
		expect(cc.has('x')).toBe(true);
		expect(cc.has('y')).toBe(true);
		cc.adjust(new Set(['x']), null); // one x leaves
		expect(cc.has('x')).toBe(true);  // one x remains
		cc.adjust(new Set(['x', 'y']), null);
		expect(cc.has('x')).toBe(false);
		expect(cc.has('y')).toBe(false);
	});
});

describe('cursor codec', () => {
	const frame = (event, data) => decodeCursor(encodeCursor(event, data));

	it('round-trips update with fractional float positions (the demo shape)', () => {
		// x = clientX - getBoundingClientRect().left -> fractional double.
		const out = frame('update', { key: '42', data: { x: 523.5, y: 128.0078125 } });
		expect(out.event).toBe('update');
		expect(out.data.key).toBe('42');
		expect(out.data.data.x).toBeCloseTo(523.5, 3);
		expect(out.data.data.y).toBeCloseTo(128.0078125, 3);
	});

	it('round-trips a 221-entry bulk and is >=60% smaller than JSON', () => {
		const entries = [];
		for (let i = 0; i < 221; i++) entries.push({ key: String(i), data: { x: Math.random() * 1920, y: Math.random() * 1080 } });
		const payload = encodeCursor('bulk', entries);
		const frameBytes = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 1, 9999, payload).length;
		const jsonBytes = JSON.stringify({ topic: '__cursor:board', event: 'bulk', data: entries, seq: 9999 }).length;
		expect(frameBytes).toBeLessThan(jsonBytes * 0.4); // >=60% reduction (measured ~83%)

		const out = decodeCursor(payload);
		expect(out.event).toBe('bulk');
		expect(out.data).toHaveLength(221);
		expect(out.data[5].key).toBe('5');
		expect(out.data[5].data.x).toBeCloseTo(entries[5].data.x, 2);
	});

	it('round-trips remove, join, and catalog (arbitrary user JSON)', () => {
		expect(frame('remove', { key: 'a1b2c3d4:7' })).toEqual({ event: 'remove', data: { key: 'a1b2c3d4:7' } });
		expect(frame('join', { key: '9', user: { id: 9, name: 'Kevin', color: '#f0f' } }))
			.toEqual({ event: 'join', data: { key: '9', user: { id: 9, name: 'Kevin', color: '#f0f' } } });
		expect(frame('catalog', [{ key: '1', user: { name: 'A' } }, { key: '2', user: null }]))
			.toEqual({ event: 'catalog', data: [{ key: '1', user: { name: 'A' } }, { key: '2', user: null }] });
	});

	it('declines (returns null -> JSON fallback) for non-{x,y} or extra-field data', () => {
		expect(encodeCursor('update', { key: '1', data: { x: 1, y: 2, pressure: 0.5 } })).toBeNull();
		expect(encodeCursor('update', { key: '1', data: { label: 'hi' } })).toBeNull();
		expect(encodeCursor('update', { key: '1', data: { x: 1, y: Infinity } })).toBeNull();
		expect(encodeCursor('update', { key: 42, data: { x: 1, y: 2 } })).toBeNull(); // non-string key
		expect(encodeCursor('bulk', [{ key: '1', data: { x: 1, y: 2 } }, { key: '2', data: { z: 3 } }])).toBeNull();
	});

	it('decodes an unknown opcode or truncated payload to null (no throw)', () => {
		expect(decodeCursor(new Uint8Array([0x7f]))).toBeNull(); // unknown op
		const good = encodeCursor('update', { key: 'abc', data: { x: 1, y: 2 } });
		expect(decodeCursor(good.subarray(0, good.length - 3))).toBeNull(); // truncated
	});

	it('exposes the capability token and schema version of record', () => {
		expect(CURSOR_CAPABILITY).toBe('cursor.protocol:2');
		expect(CURSOR_SCHEMA_VERSION).toBe(1);
	});
});
