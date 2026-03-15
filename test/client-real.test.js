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

	close() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
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
			const store = clientModule.on('todos');
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'todos', event: 'created', data: { id: 1 } });

			const value = get(store);
			expect(value).toEqual({ topic: 'todos', event: 'created', data: { id: 1 } });
			clientModule.connect().close();
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

	describe('ready()', () => {
		it('resolves when connection is open', async () => {
			const p = clientModule.ready();
			await flush();
			await p; // should not hang
			clientModule.connect().close();
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
	});
});
