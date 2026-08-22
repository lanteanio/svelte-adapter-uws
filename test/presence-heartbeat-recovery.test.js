// What a client's roster holds when the server runs with `heartbeat: 0`.
//
// Presence publishes roster DIFFS with `seq: false` and makes no monotonic
// promise, so a dropped diff is never detected on the wire - that is the
// module's stated design, and consistency is meant to be re-established
// otherwise. The periodic full-roster heartbeat is what re-establishes it
// mid-session: it refreshes every entry's `maxAge` timer and re-adds an entry
// the local sweep already removed.
//
// `heartbeat: 0` reads as a bandwidth option. These cases pin what it actually
// costs, so the divergence is a fact the suite can fail on rather than a claim
// about code as written:
//
//   1. with heartbeats, a quiet user survives the sweep window indefinitely;
//   2. without them, a quiet user is swept at the first sweep past `maxAge`
//      and NOTHING re-adds them - the roster decays on its own, no dropped
//      frame required;
//   3. a join diff the client never receives is repaired by the next
//      heartbeat, and is permanent without one.
//
// The client is driven through the real `presence()` store over a mock socket,
// so the sweep, the timestamps and the heartbeat merge are the shipped ones.
// The runtime clock seam is pointed at the faked `Date.now`, which is what
// makes the 90 s window addressable in a test.

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

	send(data) { this._sent.push(data); }

	close(code = 1000, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	deliver(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });

const clientModule = await import('../src/client.js');
const { presence } = await import('../src/plugins/presence/client.js');

// The client store's default sweep window, and the sweep timer's period
// (maxAge / 2). The first sweep that can evict an entry stamped at t=0 runs at
// 135 s: at 90 s the cutoff equals the stamp and the comparison is strict.
const MAX_AGE = 90_000;
const FIRST_EVICTING_SWEEP = 135_000;

describe('presence heartbeat: 0 - what the client roster holds', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		setRuntimeEnv({ clock: { now: () => Date.now(), monotonic: () => Date.now() } });
		try { clientModule.connect().close(); } catch { /* no existing connection */ }
		MockWebSocket._last = null;
	});

	afterEach(() => {
		try { clientModule.connect().close(); } catch { /* already closed */ }
		resetRuntimeEnv();
		vi.useRealTimers();
	});

	/**
	 * Open a connection, subscribe to one presence topic, and return a handle
	 * that reports the store's current value. Each case uses its own topic:
	 * `presence()` memoizes per topic + maxAge.
	 *
	 * @param {string} topic
	 */
	async function bootRoom(topic) {
		clientModule.connect({ path: '/ws' });
		await vi.advanceTimersByTimeAsync(0);
		const mock = MockWebSocket._last;

		let latest = /** @type {any[]} */ ([]);
		const unsub = presence(topic).subscribe((v) => { latest = v; });

		return {
			mock,
			unsub,
			keys: () => latest.map((u) => u.id).sort(),
			frame: (event, data) => mock.deliver({ topic: '__presence:' + topic, event, data })
		};
	}

	it('keeps a quiet user while heartbeats arrive, well past the sweep window', async () => {
		const room = await bootRoom('hb-on');
		room.frame('state', { a: { id: 'a' }, b: { id: 'b' } });
		expect(room.keys()).toEqual(['a', 'b']);

		// Four heartbeat intervals at the 30 s default: 120 s of wall time, past
		// one full 90 s window, with neither user emitting a diff.
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(30_000);
			room.frame('heartbeat', { a: { id: 'a' }, b: { id: 'b' } });
		}
		await vi.advanceTimersByTimeAsync(30_000);

		expect(room.keys()).toEqual(['a', 'b']);
		room.unsub();
	});

	it('sweeps the same quiet user with no heartbeat, and nothing re-adds them', async () => {
		const room = await bootRoom('hb-off');
		room.frame('state', { a: { id: 'a' }, b: { id: 'b' } });
		expect(room.keys()).toEqual(['a', 'b']);

		// No frame of any kind, which is exactly the steady state of a room
		// where nobody joins, leaves or updates. Both users are still connected.
		await vi.advanceTimersByTimeAsync(FIRST_EVICTING_SWEEP);
		expect(room.keys()).toEqual([]);

		// The decay is terminal: the sweep has no counterpart that restores an
		// entry, so the roster stays empty until the socket reopens and the
		// client asks for a fresh snapshot.
		await vi.advanceTimersByTimeAsync(FIRST_EVICTING_SWEEP);
		expect(room.keys()).toEqual([]);
		room.unsub();
	});

	it('repairs a join the client never received on the next heartbeat', async () => {
		const room = await bootRoom('hb-repair');
		room.frame('state', { a: { id: 'a' } });

		// b joins; the diff carrying that join never reaches this client.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(room.keys()).toEqual(['a']);

		room.frame('heartbeat', { a: { id: 'a' }, b: { id: 'b' } });
		expect(room.keys()).toEqual(['a', 'b']);
		room.unsub();
	});

	it('leaves the same missed join missing for the whole session with heartbeat: 0', async () => {
		const room = await bootRoom('hb-repair-off');
		room.frame('state', { a: { id: 'a' } });

		// Same dropped join, no heartbeat behind it. Advancing past the sweep
		// window does not converge the two clients - it takes the one user this
		// client did see, leaving a roster that is wrong in both directions.
		await vi.advanceTimersByTimeAsync(FIRST_EVICTING_SWEEP);
		expect(room.keys()).toEqual([]);
		room.unsub();
	});

	it('a client that opted out of the sweep holds the roster with heartbeat: 0', async () => {
		// The pairing that makes `heartbeat: 0` safe: no server heartbeat AND no
		// client sweep. Nothing decays, and nothing recovers either - a dropped
		// diff is permanent, which is the trade the option is really offering.
		clientModule.connect({ path: '/ws' });
		await vi.advanceTimersByTimeAsync(0);
		const mock = MockWebSocket._last;

		let latest = /** @type {any[]} */ ([]);
		const unsub = presence('hb-off-noage', { maxAge: 0 }).subscribe((v) => { latest = v; });
		mock.deliver({ topic: '__presence:hb-off-noage', event: 'state', data: { a: { id: 'a' }, b: { id: 'b' } } });

		await vi.advanceTimersByTimeAsync(FIRST_EVICTING_SWEEP * 2);
		expect(latest.map((u) => u.id).sort()).toEqual(['a', 'b']);
		unsub();
	});

	it('the sweep window is the client option, not a constant of the module', async () => {
		// Guards the two cases above from passing for the wrong reason: if the
		// sweep ever stopped running, the decay case would fail and this one
		// would too, rather than both quietly agreeing.
		clientModule.connect({ path: '/ws' });
		await vi.advanceTimersByTimeAsync(0);
		const mock = MockWebSocket._last;

		let latest = /** @type {any[]} */ ([]);
		const unsub = presence('hb-short', { maxAge: 4_000 }).subscribe((v) => { latest = v; });
		mock.deliver({ topic: '__presence:hb-short', event: 'state', data: { a: { id: 'a' } } });

		await vi.advanceTimersByTimeAsync(4_000);
		expect(latest.map((u) => u.id)).toEqual(['a']);
		await vi.advanceTimersByTimeAsync(MAX_AGE);
		expect(latest).toEqual([]);
		unsub();
	});
});

describe('presence heartbeat: 0 - what the server says about it', () => {
	it('names the client option that completes the opt-out, once per process', async () => {
		const { createPresence } = await import('../src/plugins/presence/server.js');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		createPresence({ heartbeat: 0 });
		expect(warn).toHaveBeenCalledTimes(1);
		const message = warn.mock.calls[0][0];
		expect(message).toContain('maxAge: 0');
		expect(message).toContain('presence: heartbeat: 0');

		// A second instance is the same decision, not a second one to report.
		createPresence({ heartbeat: 0 });
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('says nothing for a heartbeat that is merely slower than the default', async () => {
		const { createPresence } = await import('../src/plugins/presence/server.js');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		createPresence({ heartbeat: 60_000 });
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
