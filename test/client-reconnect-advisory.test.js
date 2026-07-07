// Client honoring of the server drain advisory (PROTOCOL.md 3.9): a `reconnect`
// control frame received before the close makes the client reconnect on a
// dispersed delay in [afterMs, afterMs + windowMs) with failure class 'DRAIN',
// instead of its normal backoff - so a draining node's fleet scatters. A
// terminal close still wins, a stale advisory is ignored, and a fresh open
// clears the stash. Driven with the MockWebSocket + runtime-seam pattern from
// client-suspend.test.js (fake timers for the reconnect, a pinned RNG so the
// dispersed delay is deterministic).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/client-runtime.js';

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
	get bufferedAmount() { return 0; }
	send(data) { this._sent.push(data); }
	close(code = 1000, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
	_receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });

const clientModule = await import('../src/client.js');

// A wall clock the client reads via the runtime seam (drives now() and the
// advisory validity deadline). Timers are vi's fake timers, independent of this.
let wallMs;
function installEnv() {
	wallMs = 1_000_000;
	setRuntimeEnv({
		clock: { now: () => wallMs, monotonic: () => wallMs, wallEpoch: () => wallMs },
		rng: { float: () => 0 } // pin: dispersed delay -> the afterMs floor; backoff -> base*0.75
	});
}

describe('client drain-advisory honoring', () => {
	beforeEach(() => {
		installEnv();
		try { clientModule.connect().close(); } catch { /* no existing connection */ }
		MockWebSocket._last = null;
	});
	afterEach(() => {
		resetRuntimeEnv();
		vi.useRealTimers();
	});

	async function openClient() {
		vi.useFakeTimers();
		const conn = clientModule.connect();
		await vi.advanceTimersByTimeAsync(0);
		const ws = MockWebSocket._last;
		expect(ws.readyState).toBe(MockWebSocket.OPEN);
		let failure;
		const unsub = conn.failure.subscribe((f) => { failure = f; });
		return { conn, ws, unsub, getFailure: () => failure };
	}

	it('honors an advisory: DRAIN class + dispersed delay (not normal backoff)', async () => {
		const { conn, ws, unsub, getFailure } = await openClient();

		ws._receive({ type: 'reconnect', afterMs: 10000, windowMs: 5000 });
		ws.close(1001, 'Server draining');

		expect(getFailure()).toEqual({ kind: 'ws-close', class: 'DRAIN', code: 1001, reason: 'Server draining' });

		// Normal backoff (rng 0) would reconnect at ~2250ms; the dispersed schedule
		// (rng 0 -> the afterMs floor = 10000ms) must NOT have fired yet.
		await vi.advanceTimersByTimeAsync(2250);
		expect(MockWebSocket._last).toBe(ws);
		// At the dispersed delay the reconnect fires (a fresh socket).
		await vi.advanceTimersByTimeAsync(10000 - 2250);
		expect(MockWebSocket._last).not.toBe(ws);

		unsub();
		conn.close();
	});

	it('honors an afterMs-absent advisory (the exact frame production shutdown emits)', async () => {
		const { conn, ws, unsub, getFailure } = await openClient();

		// Graceful shutdown() sends windowMs only (no afterMs). The client's
		// afterMs-default-0 branch + deadline math (now + 0 + windowMs + grace) must
		// not NaN out and drop the advisory to a normal RETRY.
		ws._receive({ type: 'reconnect', windowMs: 8000 });
		ws.close(1001, 'Server shutting down');

		expect(getFailure()).toEqual({ kind: 'ws-close', class: 'DRAIN', code: 1001, reason: 'Server shutting down' });
		// rng 0 -> dispersed delay = afterMs floor = 0; the reconnect fires promptly
		// (before the ~2250ms normal backoff would), proving the dispersed path ran.
		await vi.advanceTimersByTimeAsync(0);
		expect(MockWebSocket._last).not.toBe(ws);

		unsub();
		conn.close();
	});

	it('lets a terminal close (4401) win over a pending advisory', async () => {
		const { conn, ws, unsub, getFailure } = await openClient();

		ws._receive({ type: 'reconnect', afterMs: 10000, windowMs: 5000 });
		ws.close(4401, 'unauthorized');

		expect(getFailure().class).toBe('TERMINAL');
		// Terminal: no reconnect ever.
		await vi.advanceTimersByTimeAsync(60000);
		expect(MockWebSocket._last).toBe(ws);

		unsub();
		conn.close();
	});

	it('clears the stashed advisory on the next successful open', async () => {
		const { conn, ws, unsub, getFailure } = await openClient();

		ws._receive({ type: 'reconnect', afterMs: 10000, windowMs: 5000 });
		ws.close(1001, 'Server draining');
		expect(getFailure().class).toBe('DRAIN');

		// Fire the dispersed reconnect -> a fresh socket opens (clearing the stash).
		await vi.advanceTimersByTimeAsync(10000);
		const ws2 = MockWebSocket._last;
		expect(ws2).not.toBe(ws);
		await vi.advanceTimersByTimeAsync(0);
		expect(ws2.readyState).toBe(MockWebSocket.OPEN);

		// A later plain close (no fresh advisory) is a normal RETRY, not a drain.
		ws2.close(1006, 'network blip');
		expect(getFailure().class).toBe('RETRY');

		unsub();
		conn.close();
	});

	it('ignores a stale advisory whose close arrives past the validity deadline', async () => {
		const { conn, ws, unsub, getFailure } = await openClient();

		ws._receive({ type: 'reconnect', afterMs: 1000, windowMs: 5000 });
		// deadline = now + afterMs + windowMs + 5000 grace = now + 11000. Advance the
		// wall clock past it before the close arrives.
		wallMs += 20000;
		ws.close(1001, 'Server draining');

		expect(getFailure().class).toBe('RETRY');

		unsub();
		conn.close();
	});

	it('uses normal backoff when no advisory was received', async () => {
		const { conn, ws, unsub, getFailure } = await openClient();

		ws.close(1001, 'going away');
		expect(getFailure().class).toBe('RETRY');
		await vi.advanceTimersByTimeAsync(2250);
		expect(MockWebSocket._last).not.toBe(ws);

		unsub();
		conn.close();
	});
});
