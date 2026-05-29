// Unit tests for the short-id dictionary cursor wire (schemaVersion 2). Pure -
// no server, no sockets. Pairs an encoder dictionary with a decoder dictionary
// and drives frames through both, exactly as one connection's server-side
// encode and that connection's client-side decode would.

import { describe, it, expect } from 'vitest';
import { buildBinaryFrame } from '../files/wire.js';
import {
	encodeCursor,
	decodeCursor,
	CursorEncodeDict,
	CursorDecodeDict,
	CURSOR_CAPABILITY,
	CURSOR_SCHEMA_VERSION,
	CURSOR_CAPABILITY_DICT,
	CURSOR_SCHEMA_VERSION_DICT
} from '../plugins/cursor/codec.js';

const SV = CURSOR_SCHEMA_VERSION_DICT;

/** A connection's paired encoder + decoder, plus a round-trip helper. */
function pair(maxEntries) {
	const enc = new CursorEncodeDict(maxEntries);
	const dec = new CursorDecodeDict();
	return {
		enc,
		dec,
		/** encode with the encoder dict, decode with the decoder dict. */
		rt(event, data) {
			const payload = encodeCursor(event, data, enc);
			if (payload == null) return { payload: null, out: null };
			return { payload, out: decodeCursor(payload, dec, SV) };
		}
	};
}

describe('cursor dictionary wire (schemaVersion 2)', () => {
	it('round-trips every event type through a shared per-connection dictionary', () => {
		const c = pair();
		expect(c.rt('join', { key: '5', user: { name: 'A', color: '#f0f' } }).out)
			.toEqual({ event: 'join', data: { key: '5', user: { name: 'A', color: '#f0f' } } });
		expect(c.rt('update', { key: '5', data: { x: 523.5, y: 128.0078125 } }).out)
			.toEqual({ event: 'update', data: { key: '5', data: { x: 523.5, y: 128.0078125 } } });
		expect(c.rt('bulk', [{ key: '5', data: { x: 1, y: 2 } }, { key: '7', data: { x: 3, y: 4 } }]).out)
			.toEqual({ event: 'bulk', data: [{ key: '5', data: { x: 1, y: 2 } }, { key: '7', data: { x: 3, y: 4 } }] });
		expect(c.rt('catalog', [{ key: '5', user: { n: 1 } }, { key: '9', user: null }]).out)
			.toEqual({ event: 'catalog', data: [{ key: '5', user: { n: 1 } }, { key: '9', user: null }] });
		expect(c.rt('remove', { key: '5' }).out).toEqual({ event: 'remove', data: { key: '5' } });
	});

	it('announces a key inline once, then references it by id (KEY-ASSIGN before first use)', () => {
		const c = pair();
		const first = c.rt('update', { key: 'i-abc123:4567', data: { x: 1, y: 2 } });
		const second = c.rt('update', { key: 'i-abc123:4567', data: { x: 9, y: 8 } });
		expect(first.out.data.key).toBe('i-abc123:4567');
		expect(second.out.data.key).toBe('i-abc123:4567');
		// The second frame carries no key bytes - just a 1-byte id ref - so it is
		// strictly smaller than the first (which carried the full key string).
		expect(second.payload.length).toBeLessThan(first.payload.length);
	});

	it('is dramatically smaller than the full-string wire for realistic clustered keys, once warm', () => {
		// Redis-backed keys are "<instanceId>:<counter>" - long enough that the
		// short id is a large per-frame win after the first announce. Deterministic
		// fractional positions keep the byte counts stable across runs.
		const entries = [];
		for (let i = 0; i < 221; i++) entries.push({ key: 'instance-7f3a9c:' + i, data: { x: 1280.5 + i, y: 720.25 + i } });

		const c = pair();
		c.rt('bulk', entries);               // warm the dictionary (all ASSIGN)
		const warm = encodeCursor('bulk', entries, c.enc); // all REF now

		const v1 = encodeCursor('bulk', entries);          // full-string wire
		const jsonBytes = JSON.stringify({ topic: '__cursor:board', event: 'bulk', data: entries, seq: 1 }).length;

		// The dictionary's own contribution is the warm-frame shrink over the
		// full-string wire: for 18-char clustered keys, >= 60% smaller. The
		// vs-JSON figure swings with how verbose the JSON float reprs are (real
		// demo positions are full doubles -> ~88-89% smaller; the bench reports
		// the precise number); assert a robust >= 80% floor here.
		expect(warm.length).toBeLessThan(v1.length * 0.4); // >= 60% smaller than full-string wire
		expect(warm.length).toBeLessThan(jsonBytes * 0.2);  // >= 80% smaller than JSON
		// And it still round-trips against the warmed decoder dictionary.
		const out = decodeCursor(warm, c.dec, SV);
		expect(out.data).toHaveLength(221);
		expect(out.data[42].key).toBe('instance-7f3a9c:42');
	});

	it('a declined frame leaves the encoder dictionary UNCHANGED (no phantom id)', () => {
		// This is the load-bearing invariant: a frame that falls back to JSON
		// never reaches the decoder, so any id assigned for it would desync every
		// later reference. The encoder must not mutate the dict for a null return.
		const c = pair();
		const before = c.enc.byKey.size;

		// bulk with a bad entry -> null, dict untouched
		expect(encodeCursor('bulk', [{ key: 'good', data: { x: 1, y: 2 } }, { key: 'bad', data: { z: 9 } }], c.enc)).toBeNull();
		expect(c.enc.byKey.size).toBe(before);
		expect(c.enc.byKey.has('good')).toBe(false);

		// join with a non-serializable user -> null, dict untouched
		const circular = {}; circular.self = circular;
		expect(encodeCursor('join', { key: 'jx', user: circular }, c.enc)).toBeNull();
		expect(c.enc.byKey.has('jx')).toBe(false);

		// catalog with a bad entry -> null, dict untouched
		expect(encodeCursor('catalog', [{ key: 'c1', user: { n: 1 } }, { key: 'c2', user: 1n }], c.enc)).toBeNull();
		expect(c.enc.byKey.has('c1')).toBe(false);

		// A subsequent valid frame for a brand-new key still ASSIGNs cleanly and
		// round-trips - proving the dict was not left in a half-mutated state.
		const ok = c.rt('update', { key: 'good', data: { x: 5, y: 6 } });
		expect(ok.out).toEqual({ event: 'update', data: { key: 'good', data: { x: 5, y: 6 } } });
	});

	it('evicts least-recently-used ids at the cap and still round-trips (16-bit space modeled tiny)', () => {
		const c = pair(2); // id space of 2
		// Touch a, b (fill the space), then c, d (each evicts the LRU). Every
		// frame must still decode to the right key via its KEY-ASSIGN.
		for (const k of ['a', 'b', 'c', 'd', 'a']) {
			const out = c.rt('update', { key: k, data: { x: 0, y: 0 } }).out;
			expect(out.data.key).toBe(k);
		}
		expect(c.enc.byKey.size).toBeLessThanOrEqual(2);
	});

	it('falls back to INLINE keys for the overflow within a single frame, never corrupting it', () => {
		// A single bulk referencing more distinct keys than the id space: the
		// first `maxEntries` get ids, the rest go INLINE (full string, no id), so
		// the frame still decodes exactly even though it cannot dictionary every
		// key in one pass.
		const c = pair(3);
		const entries = [];
		for (let i = 0; i < 10; i++) entries.push({ key: 'k' + i, data: { x: i, y: i } });
		const out = c.rt('bulk', entries).out;
		expect(out.data.map((e) => e.key)).toEqual(entries.map((e) => e.key));
	});

	it('a key still works after a REMOVE (no free-on-remove): the id stays bound and reusable', () => {
		const c = pair();
		c.rt('join', { key: 'p', user: { n: 1 } });          // ASSIGN p
		c.rt('remove', { key: 'p' });                         // remove (id stays bound)
		const reuse = c.rt('update', { key: 'p', data: { x: 1, y: 2 } });
		expect(reuse.out.data.key).toBe('p');
		// p was announced once and never re-announced: only the very first frame
		// carried the key string.
		expect(c.dec.byId.size).toBe(1);
	});

	it('drops a v2 frame with no decoder dictionary rather than mis-reading keyref varints', () => {
		const enc = new CursorEncodeDict();
		const good = encodeCursor('update', { key: 'x', data: { x: 1, y: 2 } }, enc);
		expect(decodeCursor(good, null, SV)).toBeNull();
		expect(decodeCursor(good, undefined, SV)).toBeNull();
	});

	it('drops an unknown schemaVersion rather than mis-decoding', () => {
		const enc = new CursorEncodeDict();
		const good = encodeCursor('update', { key: 'x', data: { x: 1, y: 2 } }, enc);
		expect(decodeCursor(good, new CursorDecodeDict(), 99)).toBeNull();
		expect(decodeCursor(good, new CursorDecodeDict(), 0)).toBeNull();
	});

	it('drops a truncated v2 frame without throwing, and the decoder keeps working after', () => {
		const c = pair();
		const good = encodeCursor('bulk', [{ key: 'a', data: { x: 1, y: 1 } }, { key: 'b', data: { x: 2, y: 2 } }], c.enc);
		expect(decodeCursor(good.subarray(0, good.length - 3), c.dec, SV)).toBeNull();
		// A fresh, complete frame on a fresh connection still decodes.
		const c2 = pair();
		expect(c2.rt('update', { key: 'z', data: { x: 9, y: 9 } }).out)
			.toEqual({ event: 'update', data: { key: 'z', data: { x: 9, y: 9 } } });
	});

	it('a v2-unresolvable REF (decoder reset mid-stream) drops the frame rather than corrupting', () => {
		const enc = new CursorEncodeDict();
		encodeCursor('update', { key: 'q', data: { x: 1, y: 2 } }, enc); // ASSIGN q on the encoder
		const refFrame = encodeCursor('update', { key: 'q', data: { x: 3, y: 4 } }, enc); // REF q
		// A decoder that never saw the ASSIGN (e.g. reconnected) cannot resolve
		// the REF: drop, do not invent a key.
		expect(decodeCursor(refFrame, new CursorDecodeDict(), SV)).toBeNull();
	});

	it('keeps the full-string wire (schemaVersion 1) byte-identical and dict-independent', () => {
		const entries = [{ key: '42', data: { x: 1.5, y: 2.5 } }, { key: '7', data: { x: 3, y: 4 } }];
		// Passing a dictionary but decoding as v1 must ignore the dict entirely.
		const v1a = encodeCursor('bulk', entries);
		const v1b = encodeCursor('bulk', entries, { schemaVersion: 1 }); // non-dict state ignored
		expect([...v1a]).toEqual([...v1b]);
		expect(decodeCursor(v1a)).toEqual({ event: 'bulk', data: entries });
		expect(decodeCursor(v1a, new CursorDecodeDict(), CURSOR_SCHEMA_VERSION)).toEqual({ event: 'bulk', data: entries });
	});

	it('exposes the dictionary capability token and schema version of record', () => {
		expect(CURSOR_CAPABILITY).toBe('cursor.protocol:2');
		expect(CURSOR_SCHEMA_VERSION).toBe(1);
		expect(CURSOR_CAPABILITY_DICT).toBe('cursor.protocol:3');
		expect(CURSOR_SCHEMA_VERSION_DICT).toBe(2);
	});

	it('stamps schemaVersion 2 in the framework frame header for a dictionary payload', () => {
		const enc = new CursorEncodeDict();
		const payload = encodeCursor('update', { key: 'x', data: { x: 1, y: 2 } }, enc);
		const frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, 3, 5, payload);
		expect(frame[1]).toBe(CURSOR_SCHEMA_VERSION_DICT);
	});
});
