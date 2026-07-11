// Browser connectivity events: `setOffline(true)` (Playwright) and many real
// network drops fire the window `offline` event but do NOT close the socket, so
// without listening for it the client only notices via the ~150s silence
// detector - far too slow to arm the offline queue or show an accurate status.
// The client drives its status machine off `offline`/`online` so a drop is
// reflected at once and recovery on `online` skips the reconnect backoff.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetRuntimeEnv } from '../src/client-runtime.js';

// - Mock WebSocket (mirrors test/client-suspend.test.js) ----------------------

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];
		this._closeCalls = [];
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
		this._closeCalls.push(code);
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	_receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);

// A window that captures the offline/online listeners so the tests can fire them.
const winHandlers = { offline: new Set(), online: new Set() };
globalThis.window = /** @type {any} */ ({
	location: { protocol: 'http:', host: 'localhost:5173' },
	addEventListener(evt, fn) { if (winHandlers[evt]) winHandlers[evt].add(fn); },
	removeEventListener(evt, fn) { if (winHandlers[evt]) winHandlers[evt].delete(fn); }
});
function fireWindow(evt) { for (const fn of [...winHandlers[evt]]) fn(); }

const clientModule = await import('../src/client.js');

function flush() { return new Promise((r) => setTimeout(r, 0)); }

describe('browser offline/online connectivity', () => {
	beforeEach(() => {
		try { clientModule.connect().close(); } catch { /* no existing connection */ }
		MockWebSocket._last = null;
	});

	afterEach(() => {
		resetRuntimeEnv();
	});

	it('a browser offline event closes the live socket at once (arming reconnect + the offline queue)', async () => {
		const conn = clientModule.connect();
		await flush();
		const ws1 = MockWebSocket._last;
		expect(ws1.readyState).toBe(MockWebSocket.OPEN);

		// Before the fix the socket stayed OPEN until the ~150s silence detector.
		fireWindow('offline');
		expect(ws1._closeCalls.length).toBe(1);

		conn.close();
	});

	it('a browser online event reconnects immediately without advancing the backoff clock', async () => {
		vi.useFakeTimers();
		const conn = clientModule.connect();
		await vi.advanceTimersByTimeAsync(0);
		const ws1 = MockWebSocket._last;

		fireWindow('offline');
		expect(ws1._closeCalls.length).toBe(1); // onclose scheduled a backoff reconnect

		// Connectivity returns: the online handler preempts the pending backoff.
		fireWindow('online');
		await vi.advanceTimersByTimeAsync(0);
		expect(MockWebSocket._last).not.toBe(ws1); // a fresh socket, no backoff wait

		vi.useRealTimers();
		conn.close();
	});

	it('surfaces the drop even with no live socket to close', async () => {
		vi.useFakeTimers();
		let status;
		const unsub = clientModule.status.subscribe((s) => { status = s; });
		const conn = clientModule.connect();
		await vi.advanceTimersByTimeAsync(0);
		const ws1 = MockWebSocket._last;
		// First offline closes the socket; a second offline while already down has
		// no live socket - it must still report disconnected, not throw.
		fireWindow('offline');
		fireWindow('offline');
		expect(ws1._closeCalls.length).toBe(1);
		expect(status).toBe('disconnected');

		unsub();
		vi.useRealTimers();
		conn.close();
	});

	it('close() detaches the offline/online listeners (no leak, no post-close reconnect)', async () => {
		const conn = clientModule.connect();
		await flush();
		conn.close();
		expect(winHandlers.offline.size).toBe(0);
		expect(winHandlers.online.size).toBe(0);

		// Firing after close is inert - nothing reconnects.
		MockWebSocket._last = null;
		fireWindow('online');
		await flush();
		expect(MockWebSocket._last).toBe(null);
	});
});
