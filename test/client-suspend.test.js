// Suspend-aware resume: a device sleep freezes the monotonic clock while the
// wall clock keeps counting, so a wall delta far exceeding the monotonic
// delta over the same span marks a sleep gap. Above the threshold a
// still-OPEN socket is closed (the server has likely idle-dropped it with
// the close frame suppressed) so the reconnect + resume path replays the
// gap; a socket that delivered a frame in the last few seconds is trusted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/client-runtime.js';

// - Mock WebSocket (mirrors test/client-real.test.js) -------------------------

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

	_receive(data) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({
	location: { protocol: 'http:', host: 'localhost:5173' }
});

const clientModule = await import('../src/client.js');

function flush() {
	return new Promise((r) => setTimeout(r, 0));
}

// Mutable fake clocks injected through the client runtime seam. Sleep is
// simulated by advancing the wall clock past the monotonic one.
let wallMs;
let monoMs;

function installClocks() {
	wallMs = 1_000_000;
	monoMs = 500_000;
	setRuntimeEnv({ clock: {
		now: () => wallMs,
		monotonic: () => monoMs,
		wallEpoch: () => wallMs
	} });
}

/** Advance both clocks together (awake time). */
function tickAwake(ms) {
	wallMs += ms;
	monoMs += ms;
}

/** Advance only the wall clock (device asleep; monotonic frozen). */
function sleep(ms) {
	wallMs += ms;
}

function installFakeDocument() {
	const origDoc = globalThis.document;
	let visibilityHandler;
	globalThis.document = /** @type {any} */ ({
		hidden: false,
		addEventListener(evt, fn) { if (evt === 'visibilitychange') visibilityHandler = fn; },
		removeEventListener() {}
	});
	return {
		fire: () => visibilityHandler?.(),
		setHidden(hidden) { globalThis.document.hidden = hidden; },
		restore() { globalThis.document = origDoc; }
	};
}

describe('suspend-aware resume', () => {
	beforeEach(() => {
		installClocks();
		try {
			clientModule.connect().close();
		} catch { /* no existing connection */ }
		MockWebSocket._last = null;
	});

	afterEach(() => {
		resetRuntimeEnv();
	});

	describe('visibility resume', () => {
		it('closes a surviving socket when the hidden span contains a sleep gap', async () => {
			vi.useFakeTimers();
			const doc = installFakeDocument();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;
			expect(ws1.readyState).toBe(MockWebSocket.OPEN);

			doc.setHidden(true);
			doc.fire();
			sleep(120_000); // device sleeps two minutes; monotonic frozen
			doc.setHidden(false);
			doc.fire();

			expect(ws1._closeCalls.length).toBe(1);
			// onclose classified RETRY with the attempt counter reset - the
			// reconnect fires after one minimal backoff step.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(MockWebSocket._last).not.toBe(ws1);

			doc.restore();
			vi.useRealTimers();
			conn.close();
		});

		it('trusts a surviving socket when the hidden span passed awake', async () => {
			const doc = installFakeDocument();
			const conn = clientModule.connect();
			await flush();
			const ws1 = MockWebSocket._last;

			doc.setHidden(true);
			doc.fire();
			tickAwake(600_000); // ten minutes hidden, never asleep
			doc.setHidden(false);
			doc.fire();

			expect(ws1._closeCalls.length).toBe(0);
			expect(MockWebSocket._last).toBe(ws1);

			doc.restore();
			conn.close();
		});

		it('trusts a slept-through socket that has delivered a fresh frame', async () => {
			const doc = installFakeDocument();
			const conn = clientModule.connect();
			await flush();
			const ws1 = MockWebSocket._last;

			doc.setHidden(true);
			doc.fire();
			sleep(120_000);
			// The socket proves itself alive right after wake, before the
			// user returns to the tab.
			ws1._receive({ topic: 't', event: 'e', data: {} });
			doc.setHidden(false);
			doc.fire();

			expect(ws1._closeCalls.length).toBe(0);

			doc.restore();
			conn.close();
		});

		it('does not trip on a short sleep below the threshold', async () => {
			const doc = installFakeDocument();
			const conn = clientModule.connect();
			await flush();
			const ws1 = MockWebSocket._last;

			doc.setHidden(true);
			doc.fire();
			sleep(30_000);
			doc.setHidden(false);
			doc.fire();

			expect(ws1._closeCalls.length).toBe(0);

			doc.restore();
			conn.close();
		});
	});

	describe('hide-time gap handling', () => {
		it('acts on a gap accrued while visible when the tab hides before the tick', async () => {
			const doc = installFakeDocument();
			const conn = clientModule.connect();
			await flush();
			const ws1 = MockWebSocket._last;

			// Lid close on a visible tab, then the user hides the tab before
			// the 30s detector tick could read the gap. The hide-time
			// re-stamp must act on the gap, not swallow it.
			sleep(120_000);
			doc.setHidden(true);
			doc.fire();

			expect(ws1._closeCalls.length).toBe(1);

			doc.restore();
			conn.close();
		});
	});

	describe('superseded-socket close race', () => {
		it('a stale socket firing a late close does not mute its replacement', async () => {
			vi.useFakeTimers();
			const doc = installFakeDocument();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;
			// Real browsers fire onclose asynchronously, so a forced close can
			// race the visibility reconnect - defer this socket's close event.
			ws1.close = (code = 1000) => {
				ws1._closeCalls.push(code);
				ws1.readyState = MockWebSocket.CLOSING;
			};

			// Device sleeps on a visible tab; the overdue detector tick fires
			// first on wake and force-closes (close event still pending).
			sleep(120_000);
			tickAwake(30_000);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(ws1._closeCalls.length).toBe(1);

			// The visibility handler runs next, sees a non-OPEN socket, and
			// reconnects immediately.
			doc.setHidden(false);
			doc.fire();
			const ws2 = MockWebSocket._last;
			expect(ws2).not.toBe(ws1);

			// The stale socket's close finally lands - BEFORE the replacement
			// finishes opening. It must not null out the fresh socket.
			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 1000 });

			await vi.advanceTimersByTimeAsync(0);
			// The replacement completed its handshake: frames were sent on it,
			// proving the connection reference survived the stale close.
			expect(ws2.readyState).toBe(MockWebSocket.OPEN);
			expect(ws2._sent.length).toBeGreaterThan(0);

			doc.restore();
			vi.useRealTimers();
			conn.close();
		});
	});

	describe('interval detector', () => {
		it('closes on a sleep gap the visibility handler never saw', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;
			expect(ws1.readyState).toBe(MockWebSocket.OPEN);

			// Keep the reference stamps fresh across one awake interval.
			tickAwake(30_000);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(ws1._closeCalls.length).toBe(0);

			// Lid closes on a visible tab: 90s sleep, then the next tick fires.
			sleep(90_000);
			tickAwake(30_000);
			await vi.advanceTimersByTimeAsync(30_000);

			expect(ws1._closeCalls.length).toBe(1);

			vi.useRealTimers();
			conn.close();
		});

		it('stays quiet across awake intervals with a silent but live server', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;

			// Two minutes of awake silence: below the 150s silence threshold
			// and containing no sleep gap.
			for (let i = 0; i < 4; i++) {
				tickAwake(30_000);
				await vi.advanceTimersByTimeAsync(30_000);
			}

			expect(ws1._closeCalls.length).toBe(0);

			vi.useRealTimers();
			conn.close();
		});

		it('suppresses the pure-silence close when the timer itself was throttled', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;

			// A backgrounded tab throttled our 30s timer: 200s of awake time (NO
			// sleep - wall and monotonic advance together) passes before the tick
			// fires. Silence now exceeds 150s, but it is our own frozen loop, not a
			// dead server, so the pure-silence close must be suppressed.
			tickAwake(200_000);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(ws1._closeCalls.length).toBe(0);

			// The very next on-cadence tick re-measures: the server is still silent
			// and the timer is no longer throttled, so the close now fires
			// (suppression is temporary, never permanent).
			tickAwake(30_000);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(ws1._closeCalls.length).toBe(1);

			vi.useRealTimers();
			conn.close();
		});
	});
});
