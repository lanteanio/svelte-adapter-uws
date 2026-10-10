import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../src/client.js';
import { resetRuntimeEnv, setRuntimeEnv } from '../src/client-runtime.js';

// Control event arrival independently of close() so late callbacks exercise the
// real client's ownership checks. The built-runtime suite covers actual I/O.
class ControlledSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		ControlledSocket.instances.push(this);
	}
	send(value) {
		if (this.readyState !== 1) throw new Error('send on a non-open socket');
		this.sent.push(value);
	}
	close() { this.readyState = 2; }
	open() { this.readyState = 1; this.onopen?.(); }
	closed(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
	receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
	frames() { return this.sent.map(value => typeof value === 'string' ? JSON.parse(value) : value); }
}

const original = { WebSocket: globalThis.WebSocket, window: globalThis.window,
	document: globalThis.document, fetch: globalThis.fetch };
let connection;
let handlers;
let statuses;
let failures;
const sockets = () => ControlledSocket.instances;
const latest = () => sockets().at(-1);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function connect(options = {}) {
	connection = client.connect({ url: 'ws://localhost/ws', reconnectInterval: 1000, ...options });
	statuses = []; failures = [];
	connection.status.subscribe(value => statuses.push(value));
	connection.failure.subscribe(value => failures.push(value));
	return connection;
}
function event(name) { for (const fn of [...(handlers.get(name) || [])]) fn(); }

beforeEach(() => {
	vi.useFakeTimers();
	setRuntimeEnv({ rng: { float: () => 0.5 } });
	ControlledSocket.instances = [];
	globalThis.WebSocket = ControlledSocket;
	handlers = new Map();
	const events = {
		addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
		removeEventListener(name, fn) { handlers.get(name)?.delete(fn); }
	};
	globalThis.window = { ...events, location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' } };
	globalThis.document = { ...events, hidden: false };
});
afterEach(() => {
	connection?.close(); connection = undefined;
	resetRuntimeEnv(); vi.useRealTimers(); vi.restoreAllMocks();
	Object.assign(globalThis, original);
});

describe('reversible connection pause', () => {

	it('cancels a connecting socket without exhaustion and ignores its late events', async () => {
		connect({ maxReconnectAttempts: 0 });
		const old = latest();
		connection.simulateOffline(); connection.simulateOffline();
		expect(statuses.at(-1)).toBe('disconnected');
		expect(connection.send({ n: 1 })).toBe(false);
		old.open(); old.closed(4401);
		await vi.advanceTimersByTimeAsync(60000);
		expect(sockets()).toHaveLength(1);
		expect(statuses).not.toContain('failed');
		expect(failures.every(value => value === null)).toBe(true);
		connection.resumeOnline(); connection.resumeOnline();
		expect(sockets()).toHaveLength(2);
		latest().open();
		expect(statuses.at(-1)).toBe('open');
		expect(connection.send({ n: 2 })).toBe(true);
		expect(latest().frames().at(-1)).toEqual({ n: 2 });
	});

	it('retains subscriptions, listeners, recovery offsets and queued payloads', async () => {
		connect();
		const received = [];
		const unsub = connection.on('room').subscribe(value => received.push(value));
		const old = latest(); old.open();
		old.receive({ type: 'subscribed', topic: 'room', ref: 1, epoch: 42 });
		old.receive({ topic: 'room', event: 'update', data: 1, seq: 7 });
		connection.simulateOffline();
		connection.sendQueued({ command: 'queued' });
		connection.resumeOnline(); latest().open();
		const frames = latest().frames();
		expect(frames.find(frame => frame.type === 'subscribe-batch')).toMatchObject({ topics: ['room'], recover: { room: { offset: 7, epoch: 42 } } });
		expect(frames.at(-1)).toEqual({ command: 'queued' });
		latest().receive({ topic: 'room', event: 'update', data: 2, seq: 8 });
		expect(received.filter(Boolean).map(value => value.data)).toEqual([1, 2]);
		unsub();
	});

	it('refunds a canceled scheduled retry and does not spend retries while paused', async () => {
		connect({ maxReconnectAttempts: 1 }); latest().closed(1011);
		connection.simulateOffline(); connection.simulateOffline();
		await vi.advanceTimersByTimeAsync(60000);
		expect(sockets()).toHaveLength(1);
		expect(statuses.at(-1)).toBe('disconnected');
		connection.resumeOnline(); latest().closed(1011);
		expect(statuses.at(-1)).toBe('disconnected');
		await vi.advanceTimersByTimeAsync(1000);
		expect(sockets()).toHaveLength(3);
		latest().closed(1011);
		expect(statuses.at(-1)).toBe('failed');
		expect(failures.at(-1).class).toBe('EXHAUSTED');
	});

	it('refunds a retry canceled after its socket attempt has started', async () => {
		connect({ maxReconnectAttempts: 1 }); latest().closed(1011);
		await vi.advanceTimersByTimeAsync(1000);
		expect(sockets()).toHaveLength(2);
		connection.simulateOffline(); connection.resumeOnline();
		expect(sockets()).toHaveLength(3);
		latest().closed(1011);
		expect(statuses.at(-1)).toBe('disconnected');
		await vi.advanceTimersByTimeAsync(1000);
		expect(sockets()).toHaveLength(4);
		latest().closed(1011);
		expect(failures.at(-1).class).toBe('EXHAUSTED');
	});
	it('refunds a retry canceled while its auth preflight is still pending', async () => {
		const pending = [];
		globalThis.fetch = vi.fn((url, options) => new Promise(resolve => pending.push({ options, resolve })));
		connect({ auth: true, maxReconnectAttempts: 1 });
		pending[0].resolve({ ok: false, status: 503, statusText: 'retry' }); await flush();
		await vi.advanceTimersByTimeAsync(1000);
		expect(pending).toHaveLength(2);
		connection.simulateOffline(); connection.resumeOnline();
		expect(pending[1].options.signal.aborted).toBe(true);
		expect(pending).toHaveLength(3);
		pending[2].resolve({ ok: false, status: 503, statusText: 'retry' }); await flush();
		expect(statuses.at(-1)).toBe('disconnected');
		await vi.advanceTimersByTimeAsync(1000);
		expect(pending).toHaveLength(4);
		pending[3].resolve({ ok: false, status: 503, statusText: 'retry' }); await flush();
		expect(failures.at(-1).class).toBe('EXHAUSTED');
	});
	it.each([200, 401, 429, 503])('ignores a canceled auth result (%i) and keeps the new preflight owned', async status => {
		const pending = [];
		globalThis.fetch = vi.fn((url, options) => new Promise(resolve => pending.push({ url, options, resolve })));
		connect({ auth: true });
		expect(pending).toHaveLength(1);
		connection.simulateOffline();
		expect(pending[0].options.signal.aborted).toBe(true);
		connection.resumeOnline();
		expect(pending).toHaveLength(2);
		pending[0].resolve({ ok: status === 200, status, headers: new Headers(), statusText: 'old result' });
		await flush();
		event('online'); event('visibilitychange');
		expect(pending).toHaveLength(2);
		expect(sockets()).toHaveLength(0);
		expect(statuses.at(-1)).toBe('connecting');
		expect(pending[1].options.signal.aborted).toBe(false);
		pending[1].resolve({ ok: true, status: 200 });
		await flush();
		expect(sockets()).toHaveLength(1);
		latest().open();
		expect(statuses.at(-1)).toBe('open');
	});

	it('keeps the new auth deadline after the canceled request settles', async () => {
		const pending = [];
		globalThis.fetch = vi.fn((url, options) => new Promise(resolve => pending.push({ options, resolve })));
		connect({ auth: true }); connection.simulateOffline(); connection.resumeOnline();
		pending[0].resolve({ ok: true, status: 200 }); await flush();
		await vi.advanceTimersByTimeAsync(15000);
		expect(pending[1].options.signal.aborted).toBe(true);
		expect(sockets()).toHaveLength(0);
	});

	it('suppresses browser and timer reconnect triggers while paused', async () => {
		connect({ maxReconnectAttempts: 0 }); latest().open(); connection.simulateOffline();
		event('offline'); event('online');
		globalThis.document.hidden = true; event('visibilitychange');
		globalThis.document.hidden = false; event('visibilitychange');
		await vi.advanceTimersByTimeAsync(300000);
		expect(sockets()).toHaveLength(1);
		expect(statuses.at(-1)).toBe('disconnected');
		expect(statuses).not.toContain('failed');
	});

	it('does not let an old close clear the new socket subscription retry', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		connect(); connection.subscribe('room'); const old = latest(); old.open();
		connection.simulateOffline(); connection.resumeOnline(); const next = latest(); next.open();
		next.receive({ type: 'subscribe-denied', topic: 'room', reason: 'RATE_LIMITED' });
		const before = next.frames().filter(frame => frame.type === 'subscribe-batch').length;
		old.closed(4401);
		await vi.advanceTimersByTimeAsync(500);
		expect(next.frames().filter(frame => frame.type === 'subscribe-batch')).toHaveLength(before + 1);
		expect(statuses.at(-1)).toBe('open');
	});

	it('keeps the queue when an open-status subscriber pauses synchronously', () => {
		connect(); connection.sendQueued({ command: 'saved' });
		let pause = true;
		connection.status.subscribe(status => { if (status === 'open' && pause) { pause = false; connection.simulateOffline(); } });
		const old = latest(); old.open();
		expect(old.sent).toHaveLength(0);
		connection.resumeOnline(); latest().open();
		expect(latest().frames().filter(frame => frame.command === 'saved')).toHaveLength(1);
	});

	it('does not report send admission if serialization pauses the socket', () => {
		connect(); latest().open();
		const before = latest().sent.length;
		expect(connection.send({ toJSON() { connection.simulateOffline(); return { command: 'lost' }; } })).toBe(false);
		expect(latest().sent).toHaveLength(before);
	});

	it.each(['close', 'terminal'])('never revives a connection ended by %s', mode => {
		connect(); latest().open();
		if (mode === 'close') { connection.simulateOffline(); connection.close(); }
		else latest().closed(4401);
		connection.simulateOffline(); connection.resumeOnline();
		expect(sockets()).toHaveLength(1);
		expect(statuses.at(-1)).toBe('failed');
	});

	it('is inert during SSR without a configured URL', () => {
		delete globalThis.window; delete globalThis.document; delete globalThis.WebSocket;
		connection = client.connect();
		const states = []; connection.status.subscribe(value => states.push(value));
		connection.simulateOffline(); connection.resumeOnline();
		expect(connection.send({ command: 'unused' })).toBe(false);
		expect(states).toEqual(['disconnected']);
		expect(vi.getTimerCount()).toBe(0);
	});
});
