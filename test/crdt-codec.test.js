// Unit tests for the CRDT binary wire (crdt.protocol:1, schemaVersion 1).
//
// Two halves:
//   1. The pure codec (plugins/crdt/codec.js): encode -> decode round-trips of
//      all three opcodes carrying OPAQUE bytes, the opcode namespace not
//      colliding with the leading-byte demux, JSON-fallback returns, and the
//      drop-don't-throw behavior on malformed / unknown frames. No sockets.
//   2. The client sink (plugins/crdt/client.js): an inbound 0x03 CRDT frame is
//      applied in place via onCrdtFrame and dispatches NO store event, while a
//      JSON frame for the same topic (the non-capable transport) still reaches
//      the store ladder with the identical { op, bytes } shape.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	ByteWriter,
	buildBinaryFrame,
	parseBinaryFrame,
	WIRE_BINARY_TAG
} from '../src/runtime/wire.js';
import {
	encodeCrdt,
	decodeCrdt,
	createCrdtWireCodec,
	CRDT_CAPABILITY,
	CRDT_SCHEMA_VERSION
} from '../src/plugins/crdt/codec.js';

const SV = CRDT_SCHEMA_VERSION;

/** encode then decode, the way one publish + that subscriber's decode would. */
function rt(op, bytes) {
	const payload = encodeCrdt('crdt', { op, bytes });
	if (payload == null) return { payload: null, out: null };
	return { payload, out: decodeCrdt(payload, null, SV) };
}

describe('CRDT binary wire (crdt.protocol:1)', () => {
	it('round-trips all three opcodes carrying opaque bytes', () => {
		const update = [0, 1, 2, 250, 255];
		const snapshot = [10, 20, 30, 40, 50, 60];
		const sv = [7, 8, 9];

		const u = rt('update', update).out;
		expect(u.event).toBe('crdt');
		expect(u.data.op).toBe('update');
		expect([...u.data.bytes]).toEqual(update);

		const s = rt('snapshot', snapshot).out;
		expect(s.data.op).toBe('snapshot');
		expect([...s.data.bytes]).toEqual(snapshot);

		const r = rt('sync-request', sv).out;
		expect(r.data.op).toBe('sync-request');
		expect([...r.data.bytes]).toEqual(sv);
	});

	it('accepts a Uint8Array bytes input and round-trips it identically to the number[] form', () => {
		// A replica hands the codec a Uint8Array directly; the JSON-transported
		// form is a number[]. Both must encode to the same payload so the wire is
		// independent of which container the caller used.
		const arr = [3, 14, 159, 26, 53];
		const fromTyped = encodeCrdt('crdt', { op: 'update', bytes: new Uint8Array(arr) });
		const fromArray = encodeCrdt('crdt', { op: 'update', bytes: arr });
		expect([...fromTyped]).toEqual([...fromArray]);
		expect([...decodeCrdt(fromTyped, null, SV).data.bytes]).toEqual(arr);
	});

	it('round-trips empty bytes (a zero-length update / sync) to an empty Uint8Array', () => {
		for (const op of ['update', 'snapshot', 'sync-request']) {
			const out = rt(op, []).out;
			expect(out.data.op).toBe(op);
			expect(out.data.bytes.length).toBe(0);
		}
	});

	it('treats the bytes as fully opaque: never inspects or rewrites them', () => {
		// A blob that happens to start with bytes that collide with framework
		// leading bytes (0x01/0x02/0x03) or another codec's opcodes must survive
		// verbatim - the codec never reads past its own op byte.
		const adversarial = [0x03, 0x02, 0x01, 0x00, 0xff, 0x80, 0x7f];
		const out = rt('update', adversarial).out;
		expect([...out.data.bytes]).toEqual(adversarial);
	});

	it("the op byte lives INSIDE the payload, so it never collides with the 0x03 leading-byte demux", () => {
		// The codec payload's byte 0 is the op (1/2/3). When wrapped in the
		// framework frame the leading byte is 0x03 (WIRE_BINARY_TAG) and the op
		// byte sits one full header deep - the two namespaces never overlap.
		const payload = encodeCrdt('crdt', { op: 'update', bytes: [42] });
		expect(payload[0]).toBe(1); // OP_UPDATE, the codec-internal byte
		const frame = buildBinaryFrame(SV, 5, 9, payload);
		expect(frame[0]).toBe(WIRE_BINARY_TAG); // 0x03 framework tag, distinct space
		const parsed = parseBinaryFrame(frame);
		expect(parsed.payload[0]).toBe(1); // op byte recovered from inside the payload
		expect([...decodeCrdt(parsed.payload, null, parsed.schemaVersion).data.bytes]).toEqual([42]);
	});

	it('is deterministic / stateless: the same input encodes to identical bytes every call', () => {
		// Encode-once-send-many: one encode is fanned out to every capable
		// subscriber, so encoding must not depend on any per-connection state.
		const data = { op: 'update', bytes: [1, 2, 3, 4] };
		expect([...encodeCrdt('crdt', data)]).toEqual([...encodeCrdt('crdt', data)]);
	});

	it('falls back to JSON (returns null) for shapes the binary form does not represent', () => {
		expect(encodeCrdt('crdt', null)).toBeNull();
		expect(encodeCrdt('crdt', 'nope')).toBeNull();
		expect(encodeCrdt('crdt', { op: 'unknown-op', bytes: [1] })).toBeNull();
		expect(encodeCrdt('crdt', { op: 'update' })).toBeNull(); // no bytes
		expect(encodeCrdt('crdt', { op: 'update', bytes: 'not-an-array' })).toBeNull();
		expect(encodeCrdt('crdt', { op: 'update', bytes: [1, 2, 300] })).toBeNull(); // out of byte range
		expect(encodeCrdt('crdt', { op: 'update', bytes: [1, 1.5] })).toBeNull(); // non-integer
		expect(encodeCrdt('crdt', { op: 'update', bytes: [1, -1] })).toBeNull(); // negative
	});

	it('drops an unknown schemaVersion rather than mis-decoding', () => {
		const good = encodeCrdt('crdt', { op: 'snapshot', bytes: [1, 2, 3] });
		expect(decodeCrdt(good, null, 99)).toBeNull();
		expect(decodeCrdt(good, null, 0)).toBeNull();
		expect(decodeCrdt(good, null, 2)).toBeNull();
	});

	it('drops an unknown opcode without throwing', () => {
		// op byte 9 is not update/snapshot/sync-request.
		expect(decodeCrdt(new Uint8Array([9, 1, 2, 3]), null, SV)).toBeNull();
	});

	it('drops an empty payload (no op byte) without throwing, and keeps working after', () => {
		expect(decodeCrdt(new Uint8Array([]), null, SV)).toBeNull();
		// A fresh, complete frame still decodes.
		expect([...decodeCrdt(encodeCrdt('crdt', { op: 'update', bytes: [5] }), null, SV).data.bytes]).toEqual([5]);
	});

	it('exposes the capability token and schema version of record', () => {
		expect(CRDT_CAPABILITY).toBe('crdt.protocol:1');
		expect(CRDT_SCHEMA_VERSION).toBe(1);
	});

	it('stamps schemaVersion 1 in the framework frame header', () => {
		const payload = encodeCrdt('crdt', { op: 'update', bytes: [1] });
		const frame = buildBinaryFrame(CRDT_SCHEMA_VERSION, 3, 5, payload);
		expect(frame[1]).toBe(CRDT_SCHEMA_VERSION);
	});
});

describe('createCrdtWireCodec', () => {
	it('builds the codec with the capability, schema version, and encode', () => {
		const codec = createCrdtWireCodec();
		expect(codec.capability).toBe(CRDT_CAPABILITY);
		expect(codec.schemaVersion).toBe(CRDT_SCHEMA_VERSION);
		expect(typeof codec.encode).toBe('function');
		expect([...codec.encode('crdt', { op: 'update', bytes: [1, 2] })]).toEqual([1, 1, 2]);
	});

	it('returns null for binary:false (JSON for every client)', () => {
		expect(createCrdtWireCodec({ binary: false })).toBeNull();
	});

	it('is stateless: the codec declares no per-connection state factory', () => {
		// A stateless codec shares one encode across all subscribers; the document
		// replica holds the state, not the wire.
		expect(createCrdtWireCodec().state).toBeUndefined();
	});
});

// - Client sink + JSON-fallback transparency --------------------------------

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];
		this.binaryType = 'blob';
		MockWebSocket._last = this;
		queueMicrotask(() => {
			if (this.readyState === MockWebSocket.CONNECTING) {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.();
			}
		});
	}
	send(data) { this._sent.push(data); }
	close(code = 1000, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
	deliver(data) { this.onmessage?.({ data }); }
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });

const clientModule = await import('../src/client.js');
const crdtClient = await import('../src/plugins/crdt/client.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
function helloFrame(mock) {
	const f = mock._sent.find((s) => typeof s === 'string' && s.includes('"hello"'));
	return f ? JSON.parse(f) : null;
}

describe('CRDT client sink + JSON-fallback transparency', () => {
	beforeEach(() => {
		try { clientModule.connect().close(); } catch { /* none */ }
		MockWebSocket._last = null;
	});

	it('advertises crdt.protocol:1 in the hello frame', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const hello = helloFrame(MockWebSocket._last);
		expect(hello.caps).toContain(CRDT_CAPABILITY);
	});

	it('applies an inbound 0x03 CRDT frame in place via onCrdtFrame and dispatches NO store event', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const applied = [];
		const off = crdtClient.onCrdtFrame((frame) => applied.push(frame));

		const seen = [];
		const unsub = conn.on('__crdt:doc').subscribe((v) => seen.push(v));
		const before = seen.length;

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__crdt:doc', id: 1 }));
		const payload = encodeCrdt('crdt', { op: 'update', bytes: [11, 22, 33] });
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 1, 7, payload).buffer);

		// The sink applied the bytes in place...
		expect(applied.length).toBe(1);
		expect(applied[0].op).toBe('update');
		expect([...applied[0].bytes]).toEqual([11, 22, 33]);
		expect(applied[0].seq).toBe(7);
		// ...but the store ladder received nothing (sink suppressed dispatch).
		expect(seen.length).toBe(before);

		off();
		unsub();
	});

	it('routes all three opcodes through onCrdtFrame with the seq and schema version', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const applied = [];
		const off = crdtClient.onCrdtFrame((frame) => applied.push(frame));
		conn.on('__crdt:doc');

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__crdt:doc', id: 2 }));
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 2, 1, encodeCrdt('crdt', { op: 'snapshot', bytes: [1] })).buffer);
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 2, 2, encodeCrdt('crdt', { op: 'update', bytes: [2] })).buffer);
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 2, 3, encodeCrdt('crdt', { op: 'sync-request', bytes: [3] })).buffer);

		expect(applied.map((f) => f.op)).toEqual(['snapshot', 'update', 'sync-request']);
		expect(applied.map((f) => f.seq)).toEqual([1, 2, 3]);
		expect(applied.every((f) => f.schemaVersion === CRDT_SCHEMA_VERSION)).toBe(true);

		off();
	});

	it('JSON fallback transparency: a non-capable transport (a plain JSON frame) still reaches the store with the identical { op, bytes }', async () => {
		// A client without crdt.protocol:1 is sent the JSON envelope the server
		// would have published instead of a 0x03 frame. A JSON frame is not a sink
		// frame, so it dispatches through the normal store ladder with the exact
		// { op, bytes } shape the binary path decodes to - no update is lost and the
		// two transports are a 1:1.
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__crdt:doc').subscribe((v) => { if (v) seen.push(v); });

		mock.deliver(JSON.stringify({ topic: '__crdt:doc', event: 'crdt', data: { op: 'update', bytes: [11, 22, 33] } }));

		const last = seen[seen.length - 1];
		expect(last).toEqual({ topic: '__crdt:doc', event: 'crdt', data: { op: 'update', bytes: [11, 22, 33] } });
		unsub();
	});

	it('a malformed 0x03 CRDT frame is silently dropped (no onCrdtFrame call, no throw)', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const applied = [];
		const off = crdtClient.onCrdtFrame((frame) => applied.push(frame));
		conn.on('__crdt:doc');

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__crdt:doc', id: 3 }));
		// Unknown op byte 9: decode misses, sink drops, no handler call.
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 3, 1, new Uint8Array([9, 0, 0])).buffer);
		// Unknown schema version: also dropped.
		mock.deliver(buildBinaryFrame(99, 3, 2, encodeCrdt('crdt', { op: 'update', bytes: [1] })).buffer);

		expect(applied.length).toBe(0);
		off();
	});

	it('onCrdtFrame returns an unsubscribe that stops further frames, and isolates a throwing handler', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const good = [];
		const offBad = crdtClient.onCrdtFrame(() => { throw new Error('boom'); });
		const offGood = crdtClient.onCrdtFrame((frame) => good.push(frame));
		conn.on('__crdt:doc');

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__crdt:doc', id: 4 }));
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 4, 1, encodeCrdt('crdt', { op: 'update', bytes: [1] })).buffer);
		// The throwing handler did not prevent the good handler from receiving it.
		expect(good.length).toBe(1);

		offGood();
		mock.deliver(buildBinaryFrame(CRDT_SCHEMA_VERSION, 4, 2, encodeCrdt('crdt', { op: 'update', bytes: [2] })).buffer);
		// After unsubscribe, no further frames.
		expect(good.length).toBe(1);

		offBad();
	});

	it('rejects a non-function handler', () => {
		expect(() => crdtClient.onCrdtFrame(/** @type {any} */ (null))).toThrow(TypeError);
	});
});
