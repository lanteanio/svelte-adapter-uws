import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -- Mock WebSocket -----------------------------------------------------------

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

		// Auto-open after microtask
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

	_receive(data) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
}

// -- Setup globals before import ---------------------------------------------

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({
	location: { protocol: 'http:', host: 'localhost:5173' }
});

// Import the real module -- vitest.config.js aliases 'svelte/store'
const clientModule = await import('../client.js');

// -- Helpers ------------------------------------------------------------------

/** Wait for all pending microtasks (WebSocket auto-open) */
function flush() {
	return new Promise((r) => setTimeout(r, 0));
}

/** Get a fresh store value synchronously */
function get(store) {
	let value;
	const unsub = store.subscribe((v) => { value = v; });
	unsub();
	return value;
}

// -- Tests --------------------------------------------------------------------

describe('client.js (real module)', () => {
	beforeEach(() => {
		// Reset singleton between tests by closing any existing connection
		try {
			const conn = clientModule.connect();
			conn.close();
		} catch { /* no existing connection */ }
		MockWebSocket._last = null;
	});

	describe('singleton behavior', () => {
		it('connect() returns the same instance on repeated calls', async () => {
			const a = clientModule.connect();
			const b = clientModule.connect();
			expect(a).toBe(b);
			a.close();
		});

		it('on() auto-connects (implicit singleton)', async () => {
			const store = clientModule.on('test-topic');
			await flush();
			// WebSocket was created
			expect(MockWebSocket._last).not.toBeNull();
			expect(MockWebSocket._last.url).toBe('ws://localhost:5173/ws');

			// Clean up
			clientModule.connect().close();
		});

		it('status auto-connects on first subscribe', async () => {
			const values = [];
			const unsub = clientModule.status.subscribe((v) => values.push(v));
			await flush();
			// Should have gone through connecting -> open (or at least connecting)
			expect(values.length).toBeGreaterThanOrEqual(1);
			unsub();
			clientModule.connect().close();
		});

		it('warns when connect(options) is called after implicit auto-connect', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// Trigger implicit auto-connect via on()
			clientModule.on('some-topic');
			await flush();

			// Now call connect() with options -- should warn
			clientModule.connect({ path: '/custom-ws' });
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('options are ignored')
			);

			warnSpy.mockRestore();
			clientModule.connect().close();
		});

		it('does not warn when connect() is called without options after auto-connect', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			clientModule.on('x');
			await flush();
			clientModule.connect(); // no options
			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
			clientModule.connect().close();
		});

		it('does not warn when connect(options) is the first call', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			clientModule.connect({ path: '/ws', debug: false });
			await flush();
			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
			clientModule.connect().close();
		});
	});

	describe('on() and message dispatch', () => {
		it('on(topic) returns a store that starts as null', async () => {
			const store = clientModule.on('notifications');
			expect(get(store)).toBeNull();
			clientModule.connect().close();
		});

		it('on(topic) receives messages for that topic', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = clientModule.on('todos');
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			ws._receive({ topic: 'todos', event: 'created', data: { id: 1 } });
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ topic: 'todos', event: 'created', data: { id: 1 } });

			unsub();
			conn.close();
		});

		it('on(topic, event) filters by event name', async () => {
			const store = clientModule.on('todos', 'created');
			let value = null;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			// Send a 'deleted' event -- should not update the filtered store
			ws._receive({ topic: 'todos', event: 'deleted', data: { id: 1 } });
			expect(value).toBeNull();

			// Send a 'created' event -- should update
			ws._receive({ topic: 'todos', event: 'created', data: { id: 2 } });
			expect(value).toEqual({ data: { id: 2 } });
			unsub();
			clientModule.connect().close();
		});

		it('ignores messages for unsubscribed topics', async () => {
			const store = clientModule.on('todos');
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'other', event: 'created', data: {} });
			expect(get(store)).toBeNull();
			clientModule.connect().close();
		});
	});

	describe('visibility reconnect after terminal close', () => {
		it('does not reconnect when the server has permanently rejected the client', async () => {
			// document must exist for the visibility handler to be registered
			const origDoc = globalThis.document;
			let visibilityHandler;
			globalThis.document = {
				hidden: false,
				addEventListener(evt, fn) { if (evt === 'visibilitychange') visibilityHandler = fn; },
				removeEventListener() {}
			};

			const conn = clientModule.connect();
			await flush();
			const ws1 = MockWebSocket._last;
			const wsCount = () => MockWebSocket._last;

			// Simulate terminal close from server
			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 1008 });

			// Simulate tab resume
			globalThis.document.hidden = false;
			visibilityHandler?.();
			await flush();

			// A new WebSocket should NOT have been created
			expect(MockWebSocket._last).toBe(ws1);

			globalThis.document = origDoc;
			conn.close();
		});
	});

	describe('ready()', () => {
		it('resolves when connection is open', async () => {
			const p = clientModule.ready();
			await flush();
			await p; // should not hang
			clientModule.connect().close();
		});

		it('rejects when close() is called before connection opens', async () => {
			// Open, then immediately close before any resolve
			const conn = clientModule.connect();
			const p = clientModule.ready();
			conn.close();
			await expect(p).rejects.toThrow('permanently closed');
		});

		it('rejects when the server sends a terminal close code', async () => {
			const p = clientModule.ready();
			// Do not flush - WS is still CONNECTING. Simulate terminal reject
			// before the connection opens so the promise cannot resolve first.
			const ws = MockWebSocket._last;
			ws.readyState = MockWebSocket.CLOSED;
			ws.onclose?.({ code: 1008 });
			await expect(p).rejects.toThrow('permanently closed');
		});
	});

	describe('crud()', () => {
		it('accumulates created/updated/deleted events', async () => {
			const store = clientModule.crud('items', [{ id: 1, name: 'a' }]);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'items', event: 'created', data: { id: 2, name: 'b' } });
			expect(value).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

			ws._receive({ topic: 'items', event: 'updated', data: { id: 1, name: 'A' } });
			expect(value).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'b' }]);

			ws._receive({ topic: 'items', event: 'deleted', data: { id: 2 } });
			expect(value).toEqual([{ id: 1, name: 'A' }]);

			unsub();
			clientModule.connect().close();
		});

		it('prepend option adds to the beginning', async () => {
			const store = clientModule.crud('items', [], { prepend: true });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'items', event: 'created', data: { id: 1 } });
			ws._receive({ topic: 'items', event: 'created', data: { id: 2 } });
			expect(value).toEqual([{ id: 2 }, { id: 1 }]);

			unsub();
			clientModule.connect().close();
		});

		it('ignores events with null data and does not throw', async () => {
			const store = clientModule.crud('items', [{ id: 1, name: 'a' }]);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			expect(() => {
				ws._receive({ topic: 'items', event: 'created', data: null });
				ws._receive({ topic: 'items', event: 'updated', data: null });
				ws._receive({ topic: 'items', event: 'deleted', data: null });
			}).not.toThrow();
			expect(value).toEqual([{ id: 1, name: 'a' }]);

			unsub();
			clientModule.connect().close();
		});
	});

	describe('count()', () => {
		it('handles set/increment/decrement', async () => {
			const store = clientModule.count('online', 10);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'online', event: 'increment', data: 5 });
			expect(value).toBe(15);

			ws._receive({ topic: 'online', event: 'decrement', data: 3 });
			expect(value).toBe(12);

			ws._receive({ topic: 'online', event: 'set', data: 42 });
			expect(value).toBe(42);

			unsub();
			clientModule.connect().close();
		});
	});

	describe('latest()', () => {
		it('keeps only last N events', async () => {
			const store = clientModule.latest('chat', 2);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'chat', event: 'msg', data: 'a' });
			ws._receive({ topic: 'chat', event: 'msg', data: 'b' });
			ws._receive({ topic: 'chat', event: 'msg', data: 'c' });

			expect(value).toHaveLength(2);
			expect(value[0].data).toBe('b');
			expect(value[1].data).toBe('c');

			unsub();
			clientModule.connect().close();
		});
	});

	describe('lookup()', () => {
		it('maintains a keyed record', async () => {
			const store = clientModule.lookup('users', [{ id: 'a', name: 'Alice' }]);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'users', event: 'created', data: { id: 'b', name: 'Bob' } });
			expect(value).toEqual({ a: { id: 'a', name: 'Alice' }, b: { id: 'b', name: 'Bob' } });

			ws._receive({ topic: 'users', event: 'deleted', data: { id: 'a' } });
			expect(value).toEqual({ b: { id: 'b', name: 'Bob' } });

			unsub();
			clientModule.connect().close();
		});

		it('ignores events with null data and does not throw', async () => {
			const store = clientModule.lookup('users', [{ id: 'a', name: 'Alice' }]);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			expect(() => {
				ws._receive({ topic: 'users', event: 'created', data: null });
				ws._receive({ topic: 'users', event: 'updated', data: null });
				ws._receive({ topic: 'users', event: 'deleted', data: null });
				ws._receive({ topic: 'users', event: 'custom', data: null });
			}).not.toThrow();
			expect(value).toEqual({ a: { id: 'a', name: 'Alice' } });

			unsub();
			clientModule.connect().close();
		});
	});

	describe('connect().send / sendQueued', () => {
		it('send() transmits when connected', async () => {
			const conn = clientModule.connect();
			await flush();

			const ws = MockWebSocket._last;
			conn.send({ type: 'ping' });
			// First messages are subscribe messages, then our send
			const sent = ws._sent.map((s) => JSON.parse(s));
			expect(sent.some((m) => m.type === 'ping')).toBe(true);
			conn.close();
		});

		it('sendQueued() queues when disconnected, flushes on reconnect', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws1 = MockWebSocket._last;

			// Close the connection (simulates network drop)
			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.();

			// Queue a message while disconnected
			conn.sendQueued({ type: 'important' });

			conn.close();
		});
	});

	describe('close()', () => {
		it('resets singleton so next connect() creates a new connection', async () => {
			const a = clientModule.connect();
			await flush();
			a.close();

			const b = clientModule.connect();
			expect(b).not.toBe(a);
			b.close();
		});
	});

	describe('lookup() with maxAge', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('expires entries after maxAge', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('sensors', [], { key: 'id', maxAge: 2000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			// Let MockWebSocket auto-open (microtask) and flush pending timers
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'sensors', event: 'created', data: { id: 'a', temp: 20 } });
			expect(value).toEqual({ a: { id: 'a', temp: 20 } });

			// Advance past maxAge + one full sweep cycle
			// Sweep fires at 1000ms intervals (maxAge/2). Entry created at T=0.
			// At T=3000 sweep: cutoff = 3000-2000 = 1000 > 0, so entry expires.
			vi.advanceTimersByTime(3100);
			expect(value).toEqual({});

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('refreshes timestamp on update, only expires stale entries', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('sensors', [], { key: 'id', maxAge: 2000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'sensors', event: 'created', data: { id: 'a', temp: 20 } });
			ws._receive({ topic: 'sensors', event: 'created', data: { id: 'b', temp: 30 } });

			// Advance 1500ms then refresh 'a' (its timestamp becomes T+1500)
			vi.advanceTimersByTime(1500);
			ws._receive({ topic: 'sensors', event: 'updated', data: { id: 'a', temp: 22 } });

			// Advance to T=3100: sweep at T=3000, cutoff=1000.
			// 'b' created at T=0 < 1000: expired. 'a' refreshed at T=1500 >= 1000: survives.
			vi.advanceTimersByTime(1600);
			expect(value).toEqual({ a: { id: 'a', temp: 22 } });

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('does not expire when maxAge is not set', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('users', [{ id: 'a', name: 'Alice' }]);
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			vi.advanceTimersByTime(100000);
			expect(value).toEqual({ a: { id: 'a', name: 'Alice' } });

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('cleans up sweep timer on last unsubscribe', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('sensors', [], { key: 'id', maxAge: 2000 });
			const unsub = store.subscribe(() => {});
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'sensors', event: 'created', data: { id: 'a', temp: 20 } });

			unsub();
			// Should not throw after cleanup
			vi.advanceTimersByTime(5000);

			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('ignores events with null data and does not throw', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('sensors', [], { key: 'id', maxAge: 5000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'sensors', event: 'created', data: { id: 'a', temp: 20 } });
			// Unknown event with null data - should not throw
			expect(() => {
				ws._receive({ topic: 'sensors', event: 'custom', data: null });
			}).not.toThrow();
			// Map should be unchanged
			expect(value).toEqual({ a: { id: 'a', temp: 20 } });

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('explicit delete removes entry immediately regardless of maxAge', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('sensors', [], { key: 'id', maxAge: 60000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'sensors', event: 'created', data: { id: 'a', temp: 20 } });
			ws._receive({ topic: 'sensors', event: 'deleted', data: { id: 'a' } });
			expect(value).toEqual({});

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});
	});

	describe('crud() with maxAge', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('expires entries after maxAge', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('items', [], { key: 'id', maxAge: 2000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'items', event: 'created', data: { id: 1, text: 'a' } });
			expect(value).toEqual([{ id: 1, text: 'a' }]);

			vi.advanceTimersByTime(3100);
			expect(value).toEqual([]);

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('refreshes timestamp on update', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('items', [], { key: 'id', maxAge: 2000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'items', event: 'created', data: { id: 1, text: 'a' } });
			ws._receive({ topic: 'items', event: 'created', data: { id: 2, text: 'b' } });

			vi.advanceTimersByTime(1500);
			ws._receive({ topic: 'items', event: 'updated', data: { id: 1, text: 'A' } });

			vi.advanceTimersByTime(1600);
			expect(value).toEqual([{ id: 1, text: 'A' }]);

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('ignores events with null data and does not throw', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('items', [], { key: 'id', maxAge: 5000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'items', event: 'created', data: { id: 1, text: 'a' } });
			// Unknown event with null data - should not throw
			expect(() => {
				ws._receive({ topic: 'items', event: 'custom', data: null });
			}).not.toThrow();
			// List should be unchanged
			expect(value).toEqual([{ id: 1, text: 'a' }]);

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('prepend still works with maxAge', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('items', [], { key: 'id', maxAge: 5000, prepend: true });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'items', event: 'created', data: { id: 1 } });
			ws._receive({ topic: 'items', event: 'created', data: { id: 2 } });
			expect(value).toEqual([{ id: 2 }, { id: 1 }]);

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});
	});

	describe('onReplay plugin', () => {
		/** @type {any} */
		let onReplayFn;

		beforeEach(async () => {
			const mod = await import('../plugins/replay/client.js');
			onReplayFn = mod.onReplay;
		});

		it('delivers missed messages then switches to live mode', async () => {
			const store = onReplayFn('chat', { since: 2 });
			/** @type {any[]} */
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			const ws = MockWebSocket._last;

			// Replay request should have been sent after ready()
			const replayMsg = ws._sent.map((s) => JSON.parse(s)).find((m) => m.type === 'replay');
			expect(replayMsg).toEqual(expect.objectContaining({ type: 'replay', topic: 'chat', since: 2 }));

			// Server sends one missed message then the end marker
			ws._receive({ topic: '__replay:chat', event: 'msg', data: { seq: 3, event: 'created', data: { id: 3 } } });
			ws._receive({ topic: '__replay:chat', event: 'end', data: null });

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ topic: 'chat', event: 'created', data: { id: 3 } });

			// After replay ends, live messages flow through
			ws._receive({ topic: 'chat', event: 'created', data: { id: 4 } });
			expect(events).toHaveLength(2);
			expect(events[1]).toEqual({ topic: 'chat', event: 'created', data: { id: 4 } });

			unsub();
			clientModule.connect().close();
		});

		it('drops live messages during the replay window', async () => {
			const store = onReplayFn('chat', { since: 0 });
			/** @type {any[]} */
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			const ws = MockWebSocket._last;

			// Live message arrives before end marker - should be dropped
			ws._receive({ topic: 'chat', event: 'created', data: { id: 99 } });
			expect(events).toHaveLength(0);

			// Replay message + end marker
			ws._receive({ topic: '__replay:chat', event: 'msg', data: { seq: 1, event: 'created', data: { id: 1 } } });
			ws._receive({ topic: '__replay:chat', event: 'end', data: null });

			expect(events).toHaveLength(1);
			expect(events[0].data).toEqual({ id: 1 });

			unsub();
			clientModule.connect().close();
		});

		it('emits a truncated event when the server signals buffer overflow', async () => {
			const store = onReplayFn('chat', { since: 1 });
			/** @type {any[]} */
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			const ws = MockWebSocket._last;

			// Server replays what it has, then signals truncation
			ws._receive({ topic: '__replay:chat', event: 'msg', data: { seq: 5, event: 'created', data: { id: 5 } } });
			ws._receive({ topic: '__replay:chat', event: 'end', data: { truncated: true } });

			expect(events).toHaveLength(2);
			expect(events[0]).toEqual({ topic: 'chat', event: 'created', data: { id: 5 } });
			expect(events[1]).toEqual({ topic: 'chat', event: 'truncated', data: null });

			unsub();
			clientModule.connect().close();
		});

		it('emits no truncated event when replay is gap-free', async () => {
			const store = onReplayFn('chat', { since: 0 });
			/** @type {any[]} */
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: '__replay:chat', event: 'end', data: null });

			const truncatedEvents = events.filter((e) => e.event === 'truncated');
			expect(truncatedEvents).toHaveLength(0);

			unsub();
			clientModule.connect().close();
		});

		it('resets output to null on unsubscribe so reuse starts clean', async () => {
			const store = onReplayFn('chat', { since: 0 });
			/** @type {any[]} */
			const events = [];
			const unsub1 = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: '__replay:chat', event: 'msg', data: { seq: 1, event: 'created', data: { id: 1 } } });
			ws._receive({ topic: '__replay:chat', event: 'end', data: null });
			expect(events).toHaveLength(1);

			unsub1();

			// Resubscribe - should start null, not emit the previous event immediately
			const seen = [];
			const unsub2 = store.subscribe((v) => seen.push(v));
			expect(seen).toEqual([null]);

			unsub2();
			clientModule.connect().close();
		});

		it('does not send a replay request after the store is torn down', async () => {
			const store = onReplayFn('chat', { since: 0 });
			// Subscribe then immediately unsubscribe before the socket opens
			const unsub = store.subscribe(() => {});
			unsub();

			// Let the socket open and any microtasks flush
			await flush();

			const ws = MockWebSocket._last;
			const replayMsgs = ws._sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'replay');
			expect(replayMsgs).toHaveLength(0);

			clientModule.connect().close();
		});
	});

	describe('store reuse after full unsubscribe', () => {
		it('delivers messages after resubscribing to the same on() wrapper', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = clientModule.on('reuse-topic');

			// First subscription cycle
			const events1 = [];
			const unsub1 = store.subscribe((v) => { if (v) events1.push(v); });
			await flush();
			ws._receive({ topic: 'reuse-topic', event: 'ping', data: 1 });
			expect(events1).toHaveLength(1);

			// Full unsubscribe (triggers release + topicStores.delete)
			unsub1();

			// Second subscription cycle on the SAME wrapper object
			const events2 = [];
			const unsub2 = store.subscribe((v) => { if (v) events2.push(v); });
			await flush();
			ws._receive({ topic: 'reuse-topic', event: 'ping', data: 2 });
			expect(events2).toHaveLength(1);
			expect(events2[0].data).toBe(2);

			unsub2();
			conn.close();
		});

		it('delivers messages after resubscribing to the same on(topic, event) wrapper', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = clientModule.on('reuse-topic2', 'created');

			const events1 = [];
			const unsub1 = store.subscribe((v) => { if (v) events1.push(v); });
			await flush();
			ws._receive({ topic: 'reuse-topic2', event: 'created', data: { id: 1 } });
			expect(events1).toHaveLength(1);

			unsub1();

			const events2 = [];
			const unsub2 = store.subscribe((v) => { if (v) events2.push(v); });
			await flush();
			ws._receive({ topic: 'reuse-topic2', event: 'created', data: { id: 2 } });
			expect(events2).toHaveLength(1);
			expect(events2[0].data).toEqual({ id: 2 });

			unsub2();
			conn.close();
		});

		it('crud() with maxAge delivers messages after the store restarts', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = clientModule.crud('reuse-items', [], { maxAge: 60000 });

			let value1 = [];
			const unsub1 = store.subscribe((v) => { value1 = v; });
			await flush();
			ws._receive({ topic: 'reuse-items', event: 'created', data: { id: 1 } });
			expect(value1).toHaveLength(1);

			unsub1(); // triggers stop() -> sourceUnsub() -> release() -> topicStores.delete()

			let value2 = [];
			const unsub2 = store.subscribe((v) => { value2 = v; });
			await flush();
			ws._receive({ topic: 'reuse-items', event: 'created', data: { id: 2 } });
			expect(value2).toContainEqual({ id: 2 });

			unsub2();
			conn.close();
		});
	});

	describe('ref-counted subscriptions (real module)', () => {
		it('sends subscribe on first on() and unsubscribe when all unsub', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;
			ws._sent.length = 0; // clear initial messages

			const store1 = clientModule.on('shared-topic');
			const unsub1 = store1.subscribe(() => {});
			await flush();

			// Should have sent subscribe
			const sub1 = ws._sent.find((s) => {
				const m = JSON.parse(s);
				return m.type === 'subscribe' && m.topic === 'shared-topic';
			});
			expect(sub1).toBeDefined();
			ws._sent.length = 0;

			// Second subscriber -- no new WS message
			const store2 = clientModule.on('shared-topic');
			const unsub2 = store2.subscribe(() => {});
			await flush();
			const sub2 = ws._sent.find((s) => {
				const m = JSON.parse(s);
				return m.type === 'subscribe' && m.topic === 'shared-topic';
			});
			expect(sub2).toBeUndefined();

			// Unsubscribe first -- still subscribed at WS level
			unsub1();
			await flush();
			expect(ws._sent.find((s) => {
				const m = JSON.parse(s);
				return m.type === 'unsubscribe' && m.topic === 'shared-topic';
			})).toBeUndefined();

			// Unsubscribe second -- now unsubscribe at WS level
			unsub2();
			await flush();
			const unsub_msg = ws._sent.find((s) => {
				const m = JSON.parse(s);
				return m.type === 'unsubscribe' && m.topic === 'shared-topic';
			});
			expect(unsub_msg).toBeDefined();

			conn.close();
		});

	describe('presence client plugin', () => {
		/** @type {any} */
		let presenceFn;

		beforeEach(async () => {
			const mod = await import('../plugins/presence/client.js');
			presenceFn = mod.presence;
		});

		it('refreshes entry when updated event arrives', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = presenceFn('presence-updated-topic');
			/** @type {any[]} */
			let current = [];
			const unsub = store.subscribe((v) => { current = v; });

			// Initial list
			ws._receive({ topic: '__presence:presence-updated-topic', event: 'list',
				data: [{ key: '1', data: { id: '1', name: 'Alice' } }] });
			expect(current).toEqual([{ id: '1', name: 'Alice' }]);

			// Server broadcasts updated data for the same key
			ws._receive({ topic: '__presence:presence-updated-topic', event: 'updated',
				data: { key: '1', data: { id: '1', name: 'Alice Renamed' } } });
			expect(current).toEqual([{ id: '1', name: 'Alice Renamed' }]);

			unsub();
			conn.close();
		});

		it('evicts store from cache after all subscribers unsubscribe', async () => {
			const conn = clientModule.connect();
			await flush();

			const store1 = presenceFn('presence-evict-topic');
			const unsub = store1.subscribe(() => {});
			unsub();

			// After all subscribers are gone, the next call must return a fresh instance
			const store2 = presenceFn('presence-evict-topic');
			expect(store2).not.toBe(store1);

			conn.close();
		});
	});

	describe('groups client plugin', () => {
		/** @type {typeof import('../plugins/groups/client.js').group} */
		let groupFn;

		beforeEach(async () => {
			const mod = await import('../plugins/groups/client.js');
			groupFn = mod.group;
		});

		it('two instances of the same group share the same store object', async () => {
			const conn = clientModule.connect();
			await flush();

			const a = groupFn('shared-lobby');
			const b = groupFn('shared-lobby');
			expect(a).toBe(b);

			conn.close();
		});

		it('second instance sees members snapshot delivered to the first', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			// First subscriber - server sends initial members snapshot
			const storeA = groupFn('snapshot-lobby');
			let listA = [];
			const unsubA = storeA.members.subscribe((v) => { listA = v; });

			ws._receive({ topic: '__group:snapshot-lobby', event: 'members',
				data: [{ role: 'member' }, { role: 'admin' }] });
			expect(listA).toHaveLength(2);

			// Second component subscribes after the snapshot was already delivered
			const storeB = groupFn('snapshot-lobby');
			let listB = [];
			const unsubB = storeB.members.subscribe((v) => { listB = v; });

			// Both see the same snapshot immediately - no server round-trip needed
			expect(listB).toHaveLength(2);

			unsubA();
			unsubB();
			conn.close();
		});

		it('evicts store from cache after all subscribers unsubscribe', async () => {
			const conn = clientModule.connect();
			await flush();

			const store1 = groupFn('evict-lobby');
			const unsub = store1.members.subscribe(() => {});
			unsub();

			const store2 = groupFn('evict-lobby');
			expect(store2).not.toBe(store1);

			conn.close();
		});
	});
	});

	describe('construct-without-subscribe cleanup', () => {
		it('on(topic) store created but never subscribed is cleaned up after microtask', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			// Create a store but never subscribe to it
			clientModule.on('cleanup-topic');

			// A message arrives while the dangling store exists
			ws._receive({ topic: 'cleanup-topic', event: 'ping', data: 'stale' });

			// Let microtask cleanup run
			await flush();

			// Subscribe to a fresh store - must NOT see the pre-cleanup message
			const events = [];
			const store2 = clientModule.on('cleanup-topic');
			const unsub = store2.subscribe((v) => { if (v) events.push(v); });
			expect(events).toHaveLength(0);

			// New messages still flow through normally
			await flush();
			ws._receive({ topic: 'cleanup-topic', event: 'ping', data: 'live' });
			expect(events).toHaveLength(1);
			expect(events[0].data).toBe('live');

			unsub();
			conn.close();
		});

		it('on(topic, event) store created but never subscribed is cleaned up after microtask', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			clientModule.on('cleanup-topic2', 'created');

			ws._receive({ topic: 'cleanup-topic2', event: 'created', data: { id: 0 } });

			await flush();

			const events = [];
			const store2 = clientModule.on('cleanup-topic2', 'created');
			const unsub = store2.subscribe((v) => { if (v) events.push(v); });
			expect(events).toHaveLength(0);

			await flush();
			ws._receive({ topic: 'cleanup-topic2', event: 'created', data: { id: 1 } });
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ data: { id: 1 } });

			unsub();
			conn.close();
		});

		it('on(topic) store that IS subscribed before microtask is not cleaned up', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = clientModule.on('keepalive-topic');

			// Subscribe synchronously - before the cleanup microtask fires
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });

			await flush();
			ws._receive({ topic: 'keepalive-topic', event: 'update', data: 42 });
			expect(events).toHaveLength(1);
			expect(events[0].data).toBe(42);

			unsub();
			conn.close();
		});

		it('second on(topic) call reuses existing entry, cleanup does not evict it if subscribed', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			// First call: creates the entry, never subscribes
			clientModule.on('shared-cleanup-topic');

			// Second call: reuses the entry, subscribes immediately
			const store2 = clientModule.on('shared-cleanup-topic');
			const events = [];
			const unsub = store2.subscribe((v) => { if (v) events.push(v); });

			// Microtask fires; first wrapper's subs=0 but topicRefCounts shows an active sub
			await flush();
			ws._receive({ topic: 'shared-cleanup-topic', event: 'msg', data: 'hello' });
			expect(events).toHaveLength(1);

			unsub();
			conn.close();
		});
	});

	describe('cursor client plugin', () => {
		/** @type {typeof import('../plugins/cursor/client.js').cursor} */
		let cursorFn;

		beforeEach(async () => {
			const mod = await import('../plugins/cursor/client.js');
			cursorFn = mod.cursor;
		});

		it('two calls with the same topic return the same store instance', async () => {
			const conn = clientModule.connect();
			await flush();

			const a = cursorFn('cursor-shared');
			const b = cursorFn('cursor-shared');
			expect(a).toBe(b);

			conn.close();
		});

		it('two calls with the same topic and maxAge return the same store instance', async () => {
			const conn = clientModule.connect();
			await flush();

			const a = cursorFn('cursor-age', { maxAge: 5000 });
			const b = cursorFn('cursor-age', { maxAge: 5000 });
			expect(a).toBe(b);

			conn.close();
		});

		it('different maxAge values produce different instances', async () => {
			const conn = clientModule.connect();
			await flush();

			const a = cursorFn('cursor-diff', { maxAge: 5000 });
			const b = cursorFn('cursor-diff', { maxAge: 10000 });
			expect(a).not.toBe(b);

			conn.close();
		});

		it('evicts cache entry after all subscribers unsubscribe', async () => {
			const conn = clientModule.connect();
			await flush();

			const store1 = cursorFn('cursor-evict');
			const unsub = store1.subscribe(() => {});
			unsub();

			const store2 = cursorFn('cursor-evict');
			expect(store2).not.toBe(store1);

			conn.close();
		});

		it('shared store receives cursor updates for all subscribers', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const storeA = cursorFn('cursor-live');
			const storeB = cursorFn('cursor-live');
			expect(storeA).toBe(storeB);

			/** @type {Map<string, any>[]} */
			const snapsA = [];
			/** @type {Map<string, any>[]} */
			const snapsB = [];
			const unsubA = storeA.subscribe((m) => snapsA.push(m));
			const unsubB = storeB.subscribe((m) => snapsB.push(m));
			await flush();

			ws._receive({ topic: '__cursor:cursor-live', event: 'update',
				data: { key: 'u1', user: { name: 'Alice' }, data: { x: 10, y: 20 } } });

			// Both subscribers should see the update
			const lastA = snapsA[snapsA.length - 1];
			const lastB = snapsB[snapsB.length - 1];
			expect(lastA.get('u1')).toEqual({ user: { name: 'Alice' }, data: { x: 10, y: 20 } });
			expect(lastB.get('u1')).toEqual({ user: { name: 'Alice' }, data: { x: 10, y: 20 } });

			unsubA();
			unsubB();
			conn.close();
		});
	});
});
