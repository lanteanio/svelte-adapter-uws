// Coverage for the adapter client's production-wired send gate.
//
// The gate lives inside connect()/createConnection() as a closure: a
// subscribe / subscribe-batch routes through _flowSend, which consumes one
// permit from the current window, queues past the window into a bounded
// buffer, asks the server for more at a low-water mark, and folds queue
// pressure into the connection's _onLeaseDegraded boolean. This file drives
// the real client module against a mock socket, injects the server's lease-ok
// + lease control frames to open and size the window, and asserts the wire
// behaviour an app never sees directly:
//   - a sustained run below the low-water mark asks for more exactly once per
//     window (the replenish latch), not once per send;
//   - window exhaustion queues sends and flips _onLeaseDegraded true; a
//     re-grant drains the queue and flips it back to false.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// - Mock WebSocket -----------------------------------------------------------

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

	// Inject a server-to-client frame.
	_receive(obj) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({
	location: { protocol: 'http:', host: 'localhost:5173' }
});

const clientModule = await import('../src/client.js');

// - Helpers ------------------------------------------------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));

// Every JSON control frame the client pushed onto the mock socket, parsed.
function sentFrames(sock) {
	return sock._sent.map((raw) => {
		try { return JSON.parse(raw); } catch { return null; }
	});
}

function countSent(sock, type) {
	return sentFrames(sock).filter((f) => f && f.type === type).length;
}

// Open the gate to a window of `count` permits, modelling the server's
// lease-ok then lease handshake.
function openWindow(sock, count, ttlMs = 10_000) {
	sock._receive({ type: 'lease-ok' });
	sock._receive({ type: 'lease', count, ttlMs });
}

// Subscribe to one fresh topic and let its microtask flush run, so each call
// produces one discrete flow-controlled send.
async function subscribeOne(conn, topic) {
	const unsub = conn.on(topic).subscribe(() => {});
	await flush();
	return unsub;
}

// - Tests --------------------------------------------------------------------

describe('adapter client send gate (production-wired)', () => {
	let conn;
	let sock;

	beforeEach(async () => {
		conn = clientModule.connect({ url: 'ws://localhost:5173/ws' });
		await flush(); // socket auto-opens
		sock = MockWebSocket._last;
	});

	afterEach(() => {
		try { conn.close(); } catch { /* already closed */ }
		MockWebSocket._last = null;
	});

	it('runs the immediate send path until the server honours the cap', async () => {
		// No lease-ok yet: subscribes ride the wire immediately (zero-config).
		await subscribeOne(conn, 'plain-a');
		await subscribeOne(conn, 'plain-b');
		const subs = countSent(sock, 'subscribe');
		expect(subs).toBeGreaterThanOrEqual(2);
		// And nothing asked for a window before one was ever granted.
		expect(countSent(sock, 'request-n')).toBe(0);
	});

	it('asks for a window exactly once across a sustained sub-low-water run', async () => {
		// Open a window just above the client low-water mark (64). Each
		// subscribe below crosses into the low-water zone; without the latch
		// every one of them would emit a fresh request-n. With the latch the
		// client asks exactly once until a new window arrives.
		openWindow(sock, 70);
		for (let i = 0; i < 8; i++) await subscribeOne(conn, 'feed-' + i);

		expect(countSent(sock, 'request-n')).toBe(1);
	});

	it('re-arms the replenish latch when a fresh window is applied', async () => {
		// Spend below the low-water mark (window 70, mark 64) so the latch trips
		// once in the first window.
		openWindow(sock, 70);
		for (let i = 0; i < 8; i++) await subscribeOne(conn, 'a-' + i);
		expect(countSent(sock, 'request-n')).toBe(1);

		// Server answers with a fresh window. A still-backed-up client may now
		// ask once more on the next sub-low-water crossing, not on every send.
		openWindow(sock, 70);
		for (let i = 0; i < 8; i++) await subscribeOne(conn, 'b-' + i);
		expect(countSent(sock, 'request-n')).toBe(2);
	});

	it('queues past an exhausted window and surfaces degraded, then drains on re-grant', async () => {
		const flags = [];
		const off = conn._onLeaseDegraded((d) => flags.push(d));
		expect(flags[flags.length - 1]).toBe(false); // healthy at first

		// A tiny window: the first subscribe spends the only permit, the rest
		// queue against the bounded buffer and flip the connection degraded.
		openWindow(sock, 1);
		for (let i = 0; i < 5; i++) await subscribeOne(conn, 'q-' + i);
		expect(flags[flags.length - 1]).toBe(true);

		// A generous re-grant drains the queued sends in order and clears the
		// degraded signal.
		openWindow(sock, 256);
		await flush();
		expect(flags[flags.length - 1]).toBe(false);
		off();
	});

	it('never leaks a window count or deadline onto a sent frame', async () => {
		openWindow(sock, 4);
		for (let i = 0; i < 10; i++) await subscribeOne(conn, 'w-' + i);
		const INTERNAL_TOKENS = ['count', 'ttlMs', 'expiresAt', 'available', 'credit'];
		for (const raw of sock._sent) {
			let parsed = null;
			try { parsed = JSON.parse(raw); } catch { /* not json */ }
			// request-n carries only { type, n }; subscribe carries { type,
			// topic, ref }. Neither may carry an internal accounting field.
			if (!parsed) continue;
			for (const token of INTERNAL_TOKENS) {
				expect(Object.prototype.hasOwnProperty.call(parsed, token), 'leaked ' + token).toBe(false);
			}
		}
	});
});
