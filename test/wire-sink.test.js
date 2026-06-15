// Client-side tests for the sink-codec branch of the inbound 0x03 demux.
//
// A sink codec applies each frame in place inside decode (e.g. into a local
// document replica) and drives its own reactive surface. The demux must NOT
// dispatch a store event for a sink codec - even if its decode returns a
// value - so a frame that mutated local state never also fans out through the
// shared store ladder. A normal (non-sink) codec returning the same value
// DOES dispatch; that contrast is what proves the flag, not the decode shape.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBinaryFrame } from '../src/runtime/wire.js';

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

// A sink codec: decode records the raw payload bytes (proving it ran and
// "applied in place") and returns a truthy value. The truthy return is
// deliberate - it lets the test assert the sink flag, not the return shape,
// suppresses dispatch.
const sinkApplied = [];
const sinkSeqs = [];
clientModule.registerWireCodec('__sink:', {
	capability: 'sink.protocol:1',
	sink: true,
	decode: (payload, state, schemaVersion, seq) => {
		sinkApplied.push(Array.from(payload));
		sinkSeqs.push(seq);
		return { event: 'applied', data: { len: payload.length } };
	}
});

// A control codec under a different prefix: same truthy decode return, but
// NOT a sink, so it must dispatch a store event.
const plainApplied = [];
clientModule.registerWireCodec('__plain:', {
	capability: 'plain.protocol:1',
	decode: (payload) => {
		plainApplied.push(Array.from(payload));
		return { event: 'applied', data: { len: payload.length } };
	}
});

const flush = () => new Promise((r) => setTimeout(r, 0));
function helloFrame(mock) {
	const f = mock._sent.find((s) => typeof s === 'string' && s.includes('"hello"'));
	return f ? JSON.parse(f) : null;
}

describe('client inbound binary (0x03) sink-codec demux', () => {
	beforeEach(() => {
		try { clientModule.connect().close(); } catch { /* none */ }
		MockWebSocket._last = null;
		sinkApplied.length = 0;
		sinkSeqs.length = 0;
		plainApplied.length = 0;
	});

	it('advertises a sink codec capability in the hello frame like any other codec', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const hello = helloFrame(MockWebSocket._last);
		expect(hello.caps).toContain('sink.protocol:1');
	});

	it('runs a sink codec decode (applies in place) but dispatches NO store event', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__sink:doc').subscribe((v) => seen.push(v));
		const before = seen.length;

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__sink:doc', id: 1 }));
		const payload = new Uint8Array([1, 2, 3, 4]);
		mock.deliver(buildBinaryFrame(1, 1, 9, payload).buffer);

		// decode ran and applied the bytes in place...
		expect(sinkApplied).toEqual([[1, 2, 3, 4]]);
		// ...but the store ladder received nothing (sink suppressed dispatch).
		expect(seen.length).toBe(before);
		unsub();
	});

	it('contrast: a non-sink codec with an identical truthy decode DOES dispatch', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__plain:doc').subscribe((v) => seen.push(v));

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__plain:doc', id: 2 }));
		const payload = new Uint8Array([5, 6, 7]);
		mock.deliver(buildBinaryFrame(1, 2, 11, payload).buffer);

		expect(plainApplied).toEqual([[5, 6, 7]]);
		const last = seen[seen.length - 1];
		expect(last).toEqual({ topic: '__plain:doc', event: 'applied', data: { len: 3 }, seq: 11 });
		unsub();
	});

	it('passes the frame seq to a sink decode (so the codec owns its resume) while still suppressing dispatch', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__sink:doc').subscribe((v) => seen.push(v));
		const before = seen.length;

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__sink:doc', id: 1 }));
		mock.deliver(buildBinaryFrame(1, 1, 42, new Uint8Array([0xaa])).buffer);

		// decode applied the bytes AND received the frame's seq as its 4th arg,
		// so a sink codec can recover resume state itself; the framework still
		// dispatches nothing (no lastSeenSeqs tracking for a sink topic).
		expect(sinkApplied).toEqual([[0xaa]]);
		expect(sinkSeqs).toEqual([42]);
		expect(seen.length).toBe(before);
		unsub();
	});
});
