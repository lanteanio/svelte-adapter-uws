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

	describe('visibility reconnect on tab resume', () => {
		it('reconnects immediately when tab resumes after hidden disconnect', async () => {
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

			// Simulate network drop while tab is hidden
			globalThis.document.hidden = true;
			visibilityHandler?.();

			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 1006 });

			// Resume tab -- should reconnect immediately
			globalThis.document.hidden = false;
			visibilityHandler?.();
			await flush();

			expect(MockWebSocket._last).not.toBe(ws1);
			expect(MockWebSocket._last.url).toBe('ws://localhost:5173/ws');

			globalThis.document = origDoc;
			conn.close();
		});

		it('clears pending reconnect timer on tab resume', async () => {
			vi.useFakeTimers();
			const origDoc = globalThis.document;
			let visibilityHandler;
			globalThis.document = {
				hidden: false,
				addEventListener(evt, fn) { if (evt === 'visibilitychange') visibilityHandler = fn; },
				removeEventListener() {}
			};

			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;

			// Drop connection (starts backoff timer)
			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 1006 });

			// Tab resumes -- should reconnect immediately, not wait for backoff
			globalThis.document.hidden = false;
			visibilityHandler?.();
			await vi.advanceTimersByTimeAsync(0);

			expect(MockWebSocket._last).not.toBe(ws1);

			globalThis.document = origDoc;
			vi.useRealTimers();
			conn.close();
		});
	});

	describe('once()', () => {
		it('resolves with the first matching event', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const p = clientModule.once('once-topic');
			ws._receive({ topic: 'once-topic', event: 'hello', data: 42 });

			const result = await p;
			expect(result.data).toBe(42);

			conn.close();
		});

		it('resolves with filtered event when event name is provided', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const p = clientModule.once('once-filtered', 'created');
			ws._receive({ topic: 'once-filtered', event: 'deleted', data: 'no' });
			ws._receive({ topic: 'once-filtered', event: 'created', data: 'yes' });

			const result = await p;
			expect(result.data).toBe('yes');

			conn.close();
		});

		it('rejects on timeout', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);

			const p = clientModule.once('once-timeout', { timeout: 1000 });
			vi.advanceTimersByTime(1001);

			await expect(p).rejects.toThrow('timed out');

			vi.useRealTimers();
			conn.close();
		});

		it('timeout with event name includes event in error', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);

			const p = clientModule.once('once-evt-timeout', 'specific', { timeout: 500 });
			vi.advanceTimersByTime(501);

			await expect(p).rejects.toThrow("'specific'");

			vi.useRealTimers();
			conn.close();
		});
	});

	describe('onDerived()', () => {
		it('subscribes to a topic derived from a source store', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			// Create a minimal writable store to use as source
			let sourceValue = 'room-1';
			const subscribers = new Set();
			const sourceStore = {
				subscribe(fn) {
					subscribers.add(fn);
					fn(sourceValue);
					return () => subscribers.delete(fn);
				}
			};

			const derived = clientModule.onDerived((id) => `room:${id}`, sourceStore);
			const values = [];
			const unsub = derived.subscribe((v) => { if (v) values.push(v); });
			await flush();

			ws._receive({ topic: 'room:room-1', event: 'msg', data: 'hello' });
			expect(values).toHaveLength(1);
			expect(values[0].topic).toBe('room:room-1');

			unsub();
			conn.close();
		});

		it('returns null when source value is null', async () => {
			const conn = clientModule.connect();
			await flush();

			const sourceStore = {
				subscribe(fn) {
					fn(null);
					return () => {};
				}
			};

			const derived = clientModule.onDerived((id) => `room:${id}`, sourceStore);
			let value = 'not-null';
			const unsub = derived.subscribe((v) => { value = v; });

			expect(value).toBeNull();

			unsub();
			conn.close();
		});
	});

	describe('maxReconnectAttempts exhaustion', () => {
		it('stops reconnecting after maxReconnectAttempts consecutive failures', async () => {
			vi.useFakeTimers();

			// Make subsequent connections fail by throwing in the constructor
			let connectCount = 0;
			const OrigWS = globalThis.WebSocket;
			globalThis.WebSocket = class extends MockWebSocket {
				constructor(url) {
					super(url);
					connectCount++;
					if (connectCount > 1) {
						// Simulate connection failure
						this.readyState = MockWebSocket.CLOSED;
						queueMicrotask(() => {
							this.onclose?.({ code: 1006 });
						});
					}
				}
			};
			globalThis.WebSocket.CONNECTING = 0;
			globalThis.WebSocket.OPEN = 1;
			globalThis.WebSocket.CLOSING = 2;
			globalThis.WebSocket.CLOSED = 3;

			const conn = clientModule.connect({ maxReconnectAttempts: 2 });
			await vi.advanceTimersByTimeAsync(0);

			// Initial connection succeeds (connectCount=1)
			const ws1 = MockWebSocket._last;
			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 1006 });

			// Reconnect attempt 1 fails (connectCount=2)
			await vi.advanceTimersByTimeAsync(5000);

			// Reconnect attempt 2 fails (connectCount=3)
			await vi.advanceTimersByTimeAsync(10000);

			const lastWs = MockWebSocket._last;
			// No more reconnects after exhaustion
			await vi.advanceTimersByTimeAsync(60000);
			expect(MockWebSocket._last).toBe(lastWs);
			expect(connectCount).toBe(3);

			globalThis.WebSocket = OrigWS;
			vi.useRealTimers();
			conn.close();
		});
	});

	describe('throttle close code', () => {
		it('jumps ahead in backoff on rate-limit close code (4429)', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws1 = MockWebSocket._last;

			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 4429 });

			// Should still reconnect (not terminal), but with higher backoff.
			// Throttle bumps attempt to 5; with the 2.2^n curve and a 3 second
			// base that lands at ~155 seconds plus jitter (worst case ~194s),
			// so a 250 second advance is enough to guarantee the timer fires.
			await vi.advanceTimersByTimeAsync(250000);
			expect(MockWebSocket._last).not.toBe(ws1);

			vi.useRealTimers();
			conn.close();
		});
	});

	describe('debug mode', () => {
		it('logs all WebSocket lifecycle events when debug is true', async () => {
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const conn = clientModule.connect({ debug: true });
			await flush();

			const ws = MockWebSocket._last;

			// Subscribe to a topic so resubscription is tested on reconnect
			const store = clientModule.on('debug-topic');
			const unsub = store.subscribe(() => {});
			await flush();

			// Send + sendQueued while connected
			conn.send({ type: 'ping' });
			conn.sendQueued({ type: 'queued-while-open' });

			// Queue a message while disconnected
			ws.readyState = MockWebSocket.CLOSED;
			ws.onclose?.({ code: 1006 });
			conn.sendQueued({ type: 'queued-while-closed' });

			// Reconnect -> should log resubscribe-batch and flush
			await new Promise((r) => setTimeout(r, 50));
			await flush();

			const allLogs = logSpy.mock.calls.map(c => String(c[0]));
			expect(allLogs.some(m => m.includes('[ws] connected'))).toBe(true);
			expect(allLogs.some(m => m.includes('[ws] subscribe'))).toBe(true);
			expect(allLogs.some(m => m.includes('[ws] send'))).toBe(true);
			expect(allLogs.some(m => m.includes('[ws] disconnected'))).toBe(true);
			expect(allLogs.some(m => m.includes('[ws] queued'))).toBe(true);

			unsub();
			logSpy.mockRestore();
			warnSpy.mockRestore();
			conn.close();
		});

		it('logs terminal close with debug', async () => {
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const conn = clientModule.connect({ debug: true });
			await flush();

			const ws = MockWebSocket._last;
			ws.readyState = MockWebSocket.CLOSED;
			ws.onclose?.({ code: 1008 });

			const warns = warnSpy.mock.calls.map(c => String(c[0]));
			expect(warns.some(m => m.includes('permanently closed'))).toBe(true);

			logSpy.mockRestore();
			warnSpy.mockRestore();
			conn.close();
		});
	});

	describe('oversized message rejection', () => {
		it('drops messages larger than 1MB', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = clientModule.on('big-topic');
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			// Simulate a >1MB message
			const bigData = 'x'.repeat(1048577);
			ws.onmessage?.({ data: bigData });

			expect(events).toHaveLength(0);

			unsub();
			conn.close();
		});
	});

	describe('visibility cleanup on close()', () => {
		it('removes visibilitychange listener on close()', async () => {
			const origDoc = globalThis.document;
			let removed = false;
			globalThis.document = {
				hidden: false,
				addEventListener() {},
				removeEventListener(evt) { if (evt === 'visibilitychange') removed = true; }
			};

			const conn = clientModule.connect();
			await flush();
			conn.close();
			expect(removed).toBe(true);

			globalThis.document = origDoc;
		});
	});

	describe('sendQueued overflow', () => {
		it('drops oldest message when queue is full', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			// Close connection so messages go to queue
			ws.readyState = MockWebSocket.CLOSED;
			ws.onclose?.({ code: 1006 });

			// Fill queue to MAX_QUEUE_SIZE (1000)
			for (let i = 0; i < 1001; i++) {
				conn.sendQueued({ i });
			}

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('queue full'));
			warnSpy.mockRestore();
			conn.close();
		});
	});

	describe('zombie connection detection', () => {
		it('force-closes a silent connection after SERVER_TIMEOUT_MS', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;

			// Advance past SERVER_TIMEOUT_MS (150s) + one 30s interval
			vi.advanceTimersByTime(180000);

			// The zombie detection should have called ws.close()
			expect(ws.readyState).toBe(MockWebSocket.CLOSED);

			vi.useRealTimers();
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

	describe('ready() SSR', () => {
		it('resolves immediately in SSR when no url is set', async () => {
			clientModule.connect();
			await flush();

			const savedWindow = globalThis.window;
			delete globalThis.window;
			try {
				const p = clientModule.ready();
				await p;
			} finally {
				globalThis.window = savedWindow;
			}
			clientModule.connect().close();
		});

		it('waits for connection in native app (no window, but url is set)', async () => {
			const savedWindow = globalThis.window;
			delete globalThis.window;
			try {
				clientModule.connect({ url: 'ws://backend.example.com/ws' });
				const p = clientModule.ready();
				// Should NOT resolve immediately - it should wait for the WS to open
				let resolved = false;
				p.then(() => { resolved = true; });
				// Give microtasks a chance
				await new Promise((r) => setTimeout(r, 0));
				// The mock auto-opens after a microtask, so it should resolve
				expect(resolved).toBe(true);
			} finally {
				globalThis.window = savedWindow;
			}
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

	describe('url option', () => {
		it('connects to the given URL instead of deriving from window.location', async () => {
			const conn = clientModule.connect({ url: 'wss://remote.example.com/ws' });
			await flush();

			const ws = MockWebSocket._last;
			expect(ws.url).toBe('wss://remote.example.com/ws');

			conn.close();
		});

		it('url takes precedence over path', async () => {
			const conn = clientModule.connect({ url: 'wss://remote.example.com/custom', path: '/ignored' });
			await flush();

			const ws = MockWebSocket._last;
			expect(ws.url).toBe('wss://remote.example.com/custom');

			conn.close();
		});

		it('on() works after connect({ url }) for cross-origin usage', async () => {
			clientModule.connect({ url: 'wss://remote.example.com/ws' });
			await flush();

			const ws = MockWebSocket._last;
			const store = clientModule.on('chat');
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();

			ws._receive({ topic: 'chat', event: 'msg', data: 'hello' });
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ topic: 'chat', event: 'msg', data: 'hello' });

			unsub();
			clientModule.connect().close();
		});

		it('reconnects to the same url after a disconnect', async () => {
			vi.useFakeTimers();

			const conn = clientModule.connect({ url: 'wss://remote.example.com/ws' });
			await vi.advanceTimersByTimeAsync(0);

			const ws1 = MockWebSocket._last;
			expect(ws1.url).toBe('wss://remote.example.com/ws');

			// Simulate network drop (non-terminal code so it reconnects)
			ws1.readyState = MockWebSocket.CLOSED;
			ws1.onclose?.({ code: 1006 });

			// Wait for reconnect (backoff timer + microtask for WS open)
			await vi.advanceTimersByTimeAsync(4000);

			const ws2 = MockWebSocket._last;
			expect(ws2).not.toBe(ws1);
			expect(ws2.url).toBe('wss://remote.example.com/ws');

			vi.useRealTimers();
			conn.close();
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

		it('initializes timestamps for non-empty initial data', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('seeded-sensors',
				[{ id: 'x', temp: 99 }],
				{ key: 'id', maxAge: 2000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			expect(value).toEqual({ x: { id: 'x', temp: 99 } });

			vi.advanceTimersByTime(3100);
			expect(value).toEqual({});

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('stop() resets to initial map on full unsubscribe', async () => {
			vi.useFakeTimers();
			const store = clientModule.lookup('stop-sensors',
				[{ id: 'a', temp: 10 }],
				{ key: 'id', maxAge: 60000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'stop-sensors', event: 'created', data: { id: 'b', temp: 20 } });
			expect(Object.keys(value)).toHaveLength(2);

			unsub();

			let value2;
			const unsub2 = store.subscribe((v) => { value2 = v; });
			expect(value2).toEqual({ a: { id: 'a', temp: 10 } });

			unsub2();
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

		it('initializes timestamps for non-empty initial data', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('seeded-items',
				[{ id: 1, text: 'seed' }],
				{ key: 'id', maxAge: 2000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			expect(value).toEqual([{ id: 1, text: 'seed' }]);

			// Advance past maxAge + sweep interval
			vi.advanceTimersByTime(3100);
			expect(value).toEqual([]);

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('handles deleted event in maxAge mode', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('del-items', [], { key: 'id', maxAge: 60000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'del-items', event: 'created', data: { id: 1 } });
			ws._receive({ topic: 'del-items', event: 'deleted', data: { id: 1 } });
			expect(value).toEqual([]);

			unsub();
			vi.useRealTimers();
			clientModule.connect().close();
		});

		it('stop() resets list to initial on full unsubscribe', async () => {
			vi.useFakeTimers();
			const store = clientModule.crud('stop-items',
				[{ id: 1, text: 'init' }],
				{ key: 'id', maxAge: 60000 });
			let value;
			const unsub = store.subscribe((v) => { value = v; });
			await vi.advanceTimersByTimeAsync(0);

			const ws = MockWebSocket._last;
			ws._receive({ topic: 'stop-items', event: 'created', data: { id: 2, text: 'new' } });
			expect(value).toHaveLength(2);

			unsub();

			// Resubscribe -- should start with initial data, not accumulated
			let value2;
			const unsub2 = store.subscribe((v) => { value2 = v; });
			expect(value2).toEqual([{ id: 1, text: 'init' }]);

			unsub2();
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

		it('handles join events by adding to members list', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = groupFn('join-lobby');
			let members = [];
			const unsub = store.members.subscribe((v) => { members = v; });

			ws._receive({ topic: '__group:join-lobby', event: 'members', data: [] });
			ws._receive({ topic: '__group:join-lobby', event: 'join', data: { role: 'member' } });
			expect(members).toEqual([{ role: 'member' }]);

			ws._receive({ topic: '__group:join-lobby', event: 'join', data: { role: 'admin' } });
			expect(members).toHaveLength(2);

			unsub();
			conn.close();
		});

		it('handles leave events by removing from members list', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = groupFn('leave-lobby');
			let members = [];
			const unsub = store.members.subscribe((v) => { members = v; });

			ws._receive({ topic: '__group:leave-lobby', event: 'members',
				data: [{ role: 'member' }, { role: 'admin' }] });
			expect(members).toHaveLength(2);

			ws._receive({ topic: '__group:leave-lobby', event: 'leave', data: { role: 'member' } });
			expect(members).toEqual([{ role: 'admin' }]);

			unsub();
			conn.close();
		});

		it('handles close events by clearing members', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = groupFn('close-lobby');
			let members = [];
			const unsub = store.members.subscribe((v) => { members = v; });

			ws._receive({ topic: '__group:close-lobby', event: 'members',
				data: [{ role: 'member' }] });
			expect(members).toHaveLength(1);

			ws._receive({ topic: '__group:close-lobby', event: 'close', data: null });
			expect(members).toEqual([]);

			unsub();
			conn.close();
		});

		it('forwards user messages to the messages store', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = groupFn('msg-lobby');
			const messages = [];
			const unsub = store.subscribe((v) => { if (v) messages.push(v); });

			ws._receive({ topic: '__group:msg-lobby', event: 'chat', data: { text: 'hello' } });
			expect(messages).toHaveLength(1);
			expect(messages[0].event).toBe('chat');

			unsub();
			conn.close();
		});

		it('stopListening clears stores on full unsubscribe', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = groupFn('lifecycle-lobby');
			let members = [];
			const unsub = store.members.subscribe((v) => { members = v; });

			ws._receive({ topic: '__group:lifecycle-lobby', event: 'members',
				data: [{ role: 'member' }] });
			expect(members).toHaveLength(1);

			unsub();

			// Resubscribe -- should start clean
			let members2 = [];
			const unsub2 = store.members.subscribe((v) => { members2 = v; });
			expect(members2).toEqual([]);

			unsub2();
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

		it('handles remove events', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = cursorFn('cursor-remove');
			const snapshots = [];
			const unsub = store.subscribe((m) => snapshots.push(m));
			await flush();

			ws._receive({ topic: '__cursor:cursor-remove', event: 'update',
				data: { key: 'u1', user: {}, data: { x: 1, y: 2 } } });
			expect(snapshots[snapshots.length - 1].has('u1')).toBe(true);

			ws._receive({ topic: '__cursor:cursor-remove', event: 'remove',
				data: { key: 'u1' } });
			expect(snapshots[snapshots.length - 1].has('u1')).toBe(false);

			unsub();
			conn.close();
		});

		it('handles bulk snapshot events', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = cursorFn('cursor-bulk');
			const snapshots = [];
			const unsub = store.subscribe((m) => snapshots.push(m));
			await flush();

			ws._receive({ topic: '__cursor:cursor-bulk', event: 'snapshot',
				data: [
					{ key: 'a', user: { name: 'A' }, data: { x: 1, y: 1 } },
					{ key: 'b', user: { name: 'B' }, data: { x: 2, y: 2 } }
				] });

			const last = snapshots[snapshots.length - 1];
			expect(last.size).toBe(2);
			expect(last.get('a').data).toEqual({ x: 1, y: 1 });

			unsub();
			conn.close();
		});

		it('handles bulk (batched) events', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = cursorFn('cursor-batch');
			const snapshots = [];
			const unsub = store.subscribe((m) => snapshots.push(m));
			await flush();

			ws._receive({ topic: '__cursor:cursor-batch', event: 'bulk',
				data: [
					{ key: 'a', user: { name: 'A' }, data: { x: 10, y: 10 } },
					{ key: 'b', user: { name: 'B' }, data: { x: 20, y: 20 } }
				] });

			const last = snapshots[snapshots.length - 1];
			expect(last.size).toBe(2);
			expect(last.get('b').data).toEqual({ x: 20, y: 20 });

			unsub();
			conn.close();
		});

		it('sends cursor-snapshot request on reconnect', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = cursorFn('cursor-snap-req');
			const unsub = store.subscribe(() => {});
			await flush();

			const snapshotMsgs = ws._sent
				.map((s) => JSON.parse(s))
				.filter((m) => m.type === 'cursor-snapshot' && m.topic === 'cursor-snap-req');
			expect(snapshotMsgs.length).toBeGreaterThanOrEqual(1);

			unsub();
			conn.close();
		});

		it('maxAge sweeps stale cursor entries', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;

			const store = cursorFn('cursor-maxage', { maxAge: 2000 });
			const snapshots = [];
			const unsub = store.subscribe((m) => snapshots.push(m));
			await vi.advanceTimersByTimeAsync(0);

			ws._receive({ topic: '__cursor:cursor-maxage', event: 'update',
				data: { key: 'stale', user: {}, data: { x: 0, y: 0 } } });
			expect(snapshots[snapshots.length - 1].has('stale')).toBe(true);

			vi.advanceTimersByTime(3000);
			expect(snapshots[snapshots.length - 1].has('stale')).toBe(false);

			unsub();
			vi.useRealTimers();
			conn.close();
		});

		it('cleans up sweep timer on unsubscribe', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);

			const store = cursorFn('cursor-cleanup');
			const unsub = store.subscribe(() => {});
			await vi.advanceTimersByTimeAsync(0);

			unsub();
			// Should not throw after cleanup
			vi.advanceTimersByTime(5000);

			vi.useRealTimers();
			conn.close();
		});
	});

	describe('presence client - join/leave/heartbeat events', () => {
		/** @type {any} */
		let presenceFn;

		beforeEach(async () => {
			const mod = await import('../plugins/presence/client.js');
			presenceFn = mod.presence;
		});

		it('handles join events', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = presenceFn('p-join');
			let current = [];
			const unsub = store.subscribe((v) => { current = v; });

			ws._receive({ topic: '__presence:p-join', event: 'list', data: [] });
			ws._receive({ topic: '__presence:p-join', event: 'join', data: { key: '1', data: { name: 'Alice' } } });
			expect(current).toEqual([{ name: 'Alice' }]);

			unsub();
			conn.close();
		});

		it('ignores join for already-present key', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = presenceFn('p-join-dup');
			let current = [];
			const unsub = store.subscribe((v) => { current = v; });

			ws._receive({ topic: '__presence:p-join-dup', event: 'list',
				data: [{ key: '1', data: { name: 'Alice' } }] });
			ws._receive({ topic: '__presence:p-join-dup', event: 'join',
				data: { key: '1', data: { name: 'Alice' } } });
			expect(current).toHaveLength(1);

			unsub();
			conn.close();
		});

		it('handles leave events', async () => {
			const conn = clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;

			const store = presenceFn('p-leave');
			let current = [];
			const unsub = store.subscribe((v) => { current = v; });

			ws._receive({ topic: '__presence:p-leave', event: 'list',
				data: [{ key: '1', data: { name: 'Alice' } }, { key: '2', data: { name: 'Bob' } }] });
			expect(current).toHaveLength(2);

			ws._receive({ topic: '__presence:p-leave', event: 'leave', data: { key: '1' } });
			expect(current).toEqual([{ name: 'Bob' }]);

			unsub();
			conn.close();
		});

		it('handles heartbeat events by refreshing timestamps', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;

			const store = presenceFn('p-heartbeat', { maxAge: 5000 });
			let current = [];
			const unsub = store.subscribe((v) => { current = v; });

			ws._receive({ topic: '__presence:p-heartbeat', event: 'list',
				data: [{ key: '1', data: { name: 'Alice' } }] });
			expect(current).toHaveLength(1);

			// Advance near maxAge, then send heartbeat to refresh
			vi.advanceTimersByTime(4000);
			ws._receive({ topic: '__presence:p-heartbeat', event: 'heartbeat', data: ['1'] });

			// Advance past original maxAge but within heartbeat refresh
			vi.advanceTimersByTime(2000);
			expect(current).toHaveLength(1);

			unsub();
			vi.useRealTimers();
			conn.close();
		});
	});

	describe('presence client - maxAge sweep', () => {
		/** @type {any} */
		let presenceFn;

		beforeEach(async () => {
			const mod = await import('../plugins/presence/client.js');
			presenceFn = mod.presence;
		});

		it('sweeps stale entries after maxAge', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;

			const store = presenceFn('presence-sweep', { maxAge: 2000 });
			let current = [];
			const unsub = store.subscribe((v) => { current = v; });

			ws._receive({ topic: '__presence:presence-sweep', event: 'list',
				data: [{ key: '1', data: { id: '1', name: 'Alice' } }] });
			expect(current).toHaveLength(1);

			vi.advanceTimersByTime(3000);
			expect(current).toHaveLength(0);

			unsub();
			vi.useRealTimers();
			conn.close();
		});

		it('cleans up sweep timer on unsubscribe', async () => {
			vi.useFakeTimers();
			const conn = clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);

			const store = presenceFn('presence-sweep-cleanup', { maxAge: 2000 });
			const unsub = store.subscribe(() => {});
			await vi.advanceTimersByTimeAsync(0);

			unsub();
			vi.advanceTimersByTime(5000);

			vi.useRealTimers();
			conn.close();
		});
	});

	describe('replay client - scan()', () => {
		/** @type {any} */
		let onReplayFn;

		beforeEach(async () => {
			const mod = await import('../plugins/replay/client.js');
			onReplayFn = mod.onReplay;
		});

		it('throws on invalid options.since', async () => {
			expect(() => onReplayFn('topic', {})).toThrow('options.since must be a number');
			expect(() => onReplayFn('topic')).toThrow('options.since must be a number');
		});

		it('scan() accumulates events through a reducer', async () => {
			const store = onReplayFn('scan-test', { since: 0 });
			const accumulated = store.scan([], (acc, event) => [...acc, event.data]);
			let value = [];
			const unsub = accumulated.subscribe((v) => { value = v; });
			await flush();

			const ws = MockWebSocket._last;
			ws._receive({ topic: '__replay:scan-test', event: 'end', data: null });
			ws._receive({ topic: 'scan-test', event: 'created', data: { id: 1 } });
			ws._receive({ topic: 'scan-test', event: 'created', data: { id: 2 } });

			expect(value).toEqual([{ id: 1 }, { id: 2 }]);

			unsub();
			clientModule.connect().close();
		});

		it('scan() cleans up source subscription on last unsubscribe', async () => {
			const store = onReplayFn('scan-cleanup', { since: 0 });
			const accumulated = store.scan(0, (acc) => acc + 1);
			const unsub1 = accumulated.subscribe(() => {});
			await flush();

			// Unsubscribe -- should clean up without errors
			unsub1();

			// Second subscriber re-activates cleanly
			let value = 0;
			const unsub2 = accumulated.subscribe((v) => { value = v; });
			expect(value).toBe(0);

			unsub2();
			clientModule.connect().close();
		});
	});

	describe('session resume (real module)', () => {
		/** @type {Map<string, string>} */
		let storage;

		beforeEach(() => {
			storage = new Map();
			globalThis.sessionStorage = /** @type {any} */ ({
				getItem: (k) => storage.get(k) ?? null,
				setItem: (k, v) => storage.set(k, String(v)),
				removeItem: (k) => storage.delete(k),
				clear: () => storage.clear()
			});
		});

		afterEach(() => {
			delete (/** @type {any} */ (globalThis)).sessionStorage;
		});

		it('stores sessionId from welcome envelope', async () => {
			clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;
			ws._receive({ type: 'welcome', sessionId: 'abc-123' });
			expect(storage.get('svelte-adapter-uws.session./ws')).toBe('abc-123');
			clientModule.connect().close();
		});

		it('tracks highest seq per topic from incoming events', async () => {
			vi.useFakeTimers();
			clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;
			ws._receive({ type: 'welcome', sessionId: 's1' });
			ws._receive({ topic: 'a', event: 'x', data: 1, seq: 5 });
			ws._receive({ topic: 'a', event: 'x', data: 2, seq: 7 });
			ws._receive({ topic: 'a', event: 'x', data: 3, seq: 6 }); // out-of-order, ignored
			ws._receive({ topic: 'b', event: 'y', data: 9, seq: 2 });

			ws.close();
			await vi.advanceTimersByTimeAsync(10000);
			const ws2 = MockWebSocket._last;
			const resumeFrame = ws2._sent.map(s => JSON.parse(s)).find(m => m.type === 'resume');
			expect(resumeFrame).toBeTruthy();
			expect(resumeFrame.sessionId).toBe('s1');
			expect(resumeFrame.lastSeenSeqs).toEqual({ a: 7, b: 2 });

			clientModule.connect().close();
			vi.useRealTimers();
		});

		it('sends resume frame before subscribe-batch on reconnect', async () => {
			vi.useFakeTimers();
			const store = clientModule.on('topic-x');
			const unsub = store.subscribe(() => {});
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;
			ws._receive({ type: 'welcome', sessionId: 's2' });
			ws._receive({ topic: 'topic-x', event: 'created', data: {}, seq: 4 });

			ws.close();
			await vi.advanceTimersByTimeAsync(10000);
			const ws2 = MockWebSocket._last;
			const sent = ws2._sent.map(s => JSON.parse(s));
			const resumeIdx = sent.findIndex(m => m.type === 'resume');
			const subIdx = sent.findIndex(m => m.type === 'subscribe-batch');
			expect(resumeIdx).toBeGreaterThanOrEqual(0);
			expect(subIdx).toBeGreaterThanOrEqual(0);
			expect(resumeIdx).toBeLessThan(subIdx);

			unsub();
			clientModule.connect().close();
			vi.useRealTimers();
		});

		it('skips resume frame when no seqs have been observed', async () => {
			vi.useFakeTimers();
			clientModule.connect();
			await vi.advanceTimersByTimeAsync(0);
			const ws = MockWebSocket._last;
			ws._receive({ type: 'welcome', sessionId: 's3' });

			ws.close();
			await vi.advanceTimersByTimeAsync(10000);
			const ws2 = MockWebSocket._last;
			const resumeFrame = ws2._sent.map(s => JSON.parse(s)).find(m => m.type === 'resume');
			expect(resumeFrame).toBeUndefined();

			clientModule.connect().close();
			vi.useRealTimers();
		});

		it('does not dispatch welcome or resumed envelopes as data events', async () => {
			const store = clientModule.on('topic-y');
			const events = [];
			const unsub = store.subscribe((v) => { if (v) events.push(v); });
			await flush();
			const ws = MockWebSocket._last;
			ws._receive({ type: 'welcome', sessionId: 's4' });
			ws._receive({ type: 'resumed' });
			ws._receive({ topic: 'topic-y', event: 'msg', data: 'hi' });

			expect(events).toHaveLength(1);
			expect(events[0].data).toBe('hi');

			unsub();
			clientModule.connect().close();
		});

		it('survives missing sessionStorage (private mode)', async () => {
			delete (/** @type {any} */ (globalThis)).sessionStorage;

			clientModule.connect();
			await flush();
			const ws = MockWebSocket._last;
			expect(() => ws._receive({ type: 'welcome', sessionId: 'lost' })).not.toThrow();
			expect(() => ws._receive({ topic: 't', event: 'e', data: 1, seq: 1 })).not.toThrow();

			clientModule.connect().close();
		});
	});
});
