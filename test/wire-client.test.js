// Client-side tests for the inbound 0x03 binary demux in client.js:
// binaryType, hello-cap advertisement (no URL opt-out), the wire-id
// announce -> wireIdMap, and decode -> dispatchEvent into the store ladder.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBinaryFrame } from '../files/wire.js';
import { encodeCursor, decodeCursor, CURSOR_CAPABILITY } from '../plugins/cursor/codec.js';

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
	// Helper for tests: simulate a server -> client frame.
	deliver(data) { this.onmessage?.({ data }); }
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });

const clientModule = await import('../client.js');
clientModule.registerWireCodec('__cursor:', { capability: CURSOR_CAPABILITY, decode: decodeCursor });

const flush = () => new Promise((r) => setTimeout(r, 0));

function helloFrame(mock) {
	const f = mock._sent.find((s) => typeof s === 'string' && s.includes('"hello"'));
	return f ? JSON.parse(f) : null;
}

describe('client inbound binary (0x03) demux', () => {
	beforeEach(() => {
		try { clientModule.connect().close(); } catch { /* none */ }
		MockWebSocket._last = null;
		delete globalThis.location;
	});

	it('sets binaryType=arraybuffer and advertises the registered wire capability', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		expect(mock.binaryType).toBe('arraybuffer');
		const hello = helloFrame(mock);
		expect(hello.caps).toContain('batch');
		expect(hello.caps).toContain(CURSOR_CAPABILITY);
	});

	it('decodes a 0x03 frame into the topic store after a wire-id announce', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__cursor:board').subscribe((v) => seen.push(v));

		// Announce the topic-id, then deliver a binary update for it.
		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__cursor:board', id: 1 }));
		const frame = buildBinaryFrame(1, 1, 42, encodeCursor('update', { key: '7', data: { x: 10.5, y: 20.5 } }));
		mock.deliver(frame.buffer);

		const last = seen[seen.length - 1];
		expect(last).toEqual({
			topic: '__cursor:board',
			event: 'update',
			data: { key: '7', data: { x: 10.5, y: 20.5 } }
		});
		unsub();
	});

	it('drops a 0x03 frame whose topic-id was never announced', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__cursor:board').subscribe((v) => seen.push(v));
		const before = seen.length;

		// No wire-id for id 99 -> unresolvable -> dropped, store unchanged.
		const frame = buildBinaryFrame(1, 99, 1, encodeCursor('update', { key: '7', data: { x: 1, y: 2 } }));
		mock.deliver(frame.buffer);

		expect(seen.length).toBe(before);
		unsub();
	});

	it('decodes a binary bulk frame into multiple cursor positions', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__cursor:board').subscribe((v) => seen.push(v));

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__cursor:board', id: 1 }));
		const entries = [{ key: 'a', data: { x: 1.5, y: 2.5 } }, { key: 'b', data: { x: 3.5, y: 4.5 } }];
		mock.deliver(buildBinaryFrame(1, 1, 7, encodeCursor('bulk', entries)).buffer);

		const last = seen[seen.length - 1];
		expect(last.event).toBe('bulk');
		expect(last.data).toEqual(entries);
		unsub();
	});

	it('always advertises the wire capability regardless of URL query params', async () => {
		globalThis.location = /** @type {any} */ ({ search: '?wire=json&foo=bar' });
		clientModule.connect({ path: '/ws' });
		await flush();
		const hello = helloFrame(MockWebSocket._last);
		expect(hello.caps).toContain('batch');               // batch is not a wire codec
		expect(hello.caps).toContain(CURSOR_CAPABILITY); // never omitted by a URL param
	});
});
