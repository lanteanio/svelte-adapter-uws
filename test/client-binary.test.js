// Regression tests for binary payload handling in client.js's send /
// sendQueued / queue-flush paths.
//
// Pre-fix bug: send() and sendQueued() unconditionally JSON.stringify'd
// the payload. JSON.stringify(new ArrayBuffer(N)) returns the literal
// string '{}' because ArrayBuffer has no own enumerable properties. Every
// binary frame produced by `live.binary` (svelte-realtime) reached the
// wire as the 2-byte text '{}' and the server-side handleRpc dropped it
// as a malformed envelope. The promise hung to its 30s timeout.
//
// Post-fix contract: ArrayBuffer and any ArrayBufferView (Uint8Array,
// DataView, etc) pass through to ws.send unchanged so the browser sends
// a binary frame. JSON-serializable inputs continue to go through
// JSON.stringify -> text frame, no behavior change for current callers.
//
// Both `send` and `sendQueued` (and the queue-flush path) route through
// a shared `serializeForSend(data)` helper, so the OPEN-path tests below
// cover the queue path's serialization decision by construction. The
// queue itself is keyed on the helper's output; if OPEN works, queue
// works.

import { describe, it, expect, beforeEach } from 'vitest';

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];
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
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({
	location: { protocol: 'http:', host: 'localhost:5173' }
});

const clientModule = await import('../client.js');

function flush() { return new Promise((r) => setTimeout(r, 0)); }

describe('client send / sendQueued binary payload contract', () => {
	beforeEach(() => {
		// Reset the singleton between tests, matching client-real.test.js.
		try {
			const conn = clientModule.connect();
			conn.close();
		} catch { /* no existing connection */ }
		MockWebSocket._last = null;
	});

	it('send() passes ArrayBuffer through to ws.send unchanged (no JSON.stringify)', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		const buf = new ArrayBuffer(8);
		new DataView(buf).setUint8(0, 0x00);
		new DataView(buf).setUint8(1, 0x42);
		conn.send(buf);

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(newFrames[0]).toBe(buf); // same reference, not stringified
		expect(newFrames[0]).toBeInstanceOf(ArrayBuffer);
	});

	it('send() passes Uint8Array through unchanged', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		const u8 = new Uint8Array([0x00, 0x42, 0xff, 0x01]);
		conn.send(u8);

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(newFrames[0]).toBe(u8);
		expect(ArrayBuffer.isView(newFrames[0])).toBe(true);
	});

	it('send() passes DataView through unchanged', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		const buf = new ArrayBuffer(16);
		const view = new DataView(buf);
		view.setUint8(0, 0x00);
		view.setUint16(1, 0xbeef);
		conn.send(view);

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(newFrames[0]).toBe(view);
		expect(ArrayBuffer.isView(newFrames[0])).toBe(true);
	});

	it('send() still JSON.stringifies plain objects (no behavior change for existing callers)', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		conn.send({ type: 'custom', payload: 42 });

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(typeof newFrames[0]).toBe('string');
		expect(JSON.parse(newFrames[0])).toEqual({ type: 'custom', payload: 42 });
	});

	it('sendQueued() in OPEN state passes ArrayBuffer through unchanged', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer;
		conn.sendQueued(buf);

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(newFrames[0]).toBe(buf);
		expect(newFrames[0]).toBeInstanceOf(ArrayBuffer);
	});

	it('sendQueued() in OPEN state JSON.stringifies plain objects', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		conn.sendQueued({ type: 'tick', n: 7 });

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(typeof newFrames[0]).toBe('string');
		expect(JSON.parse(newFrames[0])).toEqual({ type: 'tick', n: 7 });
	});

	it('regression: sending an ArrayBuffer no longer reaches the wire as the literal text "{}"', async () => {
		// This is the exact wire shape the bug report cites.
		// Pre-fix: JSON.stringify(new ArrayBuffer(N)) === '{}' regardless
		// of N, so a 200 KB upload chunk reached the wire as 2 bytes of text.
		// Post-fix: same ArrayBuffer reference, full byteLength preserved.
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;
		const startCount = mock._sent.length;

		const buf = new ArrayBuffer(200_000);
		conn.sendQueued(buf);

		const newFrames = mock._sent.slice(startCount);
		expect(newFrames).toHaveLength(1);
		expect(newFrames[0]).not.toBe('{}');
		expect(newFrames[0]).toBeInstanceOf(ArrayBuffer);
		expect(newFrames[0].byteLength).toBe(200_000);
	});
});
