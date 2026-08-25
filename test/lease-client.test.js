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
		// RETIRE ANY SINGLETON THIS FILE DID NOT CREATE. `connect()` returns a
		// process-wide singleton, and a serial run (`--no-file-parallelism`, one
		// worker, pool size 1) shares a single module registry across test files -
		// so a suite that ran earlier can leave a live connection behind. This
		// file's `connect()` would then return THAT connection, never construct a
		// MockWebSocket, and leave `_last` unset: the failure reads as
		// `Cannot read properties of undefined (reading '_sent')` several helpers
		// away from the cause. Closing first is what makes this file's socket ours.
		// Under file parallelism each file gets a fresh registry, so this is a
		// no-op there - which is exactly why the defect only ever showed up serial.
		clientModule.connect().close();
		MockWebSocket._last = null;
		conn = clientModule.connect({ url: 'ws://localhost:5173/ws' });
		await flush(); // socket auto-opens
		sock = MockWebSocket._last;
		// Fail here rather than several helpers deep if the retire above ever
		// stops working: an undefined socket is a harness fault, not a gate bug.
		expect(sock, 'the client did not construct a socket - a stale singleton leaked in').toBeTruthy();
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

	it('reports its permit-starved backlog in the replenish request, and only then', async () => {
		// Spend the only permit: the replenish fires from the !fresh branch with
		// an empty queue, so it carries NO backlog - the historical byte shape.
		openWindow(sock, 1);
		await subscribeOne(conn, 'r-0');
		for (let i = 1; i <= 4; i++) await subscribeOne(conn, 'r-' + i); // queue 4, latch holds
		const first = sentFrames(sock).filter((f) => f && f.type === 'request-n');
		expect(first.length).toBe(1);
		expect(Object.prototype.hasOwnProperty.call(first[0], 'queued'), 'no backlog yet, so no field').toBe(false);

		// A re-grant smaller than the backlog drains two, re-arms the latch, and
		// the next starved send asks again - now reporting what is still waiting.
		openWindow(sock, 2); // drains r-1, r-2; r-3 and r-4 stay queued
		await subscribeOne(conn, 'r-5'); // queues (window spent) -> replenish
		const reqs = sentFrames(sock).filter((f) => f && f.type === 'request-n');
		expect(reqs.length).toBe(2);
		expect(reqs[1].queued, 'the frame reports the live backlog at request time').toBe(3);
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
