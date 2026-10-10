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

describe('client disconnect admission', () => {
	it.each(['offline', 'silence', 'activity-gap', 'hide-gap', 'show-gap'])('reports %s self-close before the closing handshake ends', async cause => {
		let wall = 1000000, mono = 1000000;
		setRuntimeEnv({ clock: { now: () => wall, monotonic: () => mono }, rng: { float: () => 0.5 } });
		connect(); const old = latest(); old.open();
		if (cause === 'offline') event('offline');
		else if (cause === 'silence') {
			for (let i = 0; i < 6; i++) { wall += 30000; mono += 30000; await vi.advanceTimersByTimeAsync(30000); }
		} else {
			if (cause === 'show-gap') { globalThis.document.hidden = true; event('visibilitychange'); }
			wall += 120000;
			if (cause === 'activity-gap') await vi.advanceTimersByTimeAsync(30000);
			else { globalThis.document.hidden = cause === 'hide-gap'; event('visibilitychange'); }
		}
		expect(old.readyState).toBe(ControlledSocket.CLOSING);
		expect(statuses.at(-1)).toBe('disconnected');
		expect(connection.send({ command: 'dropped' })).toBe(false);
		event('online');
		expect(sockets()).toHaveLength(2);
		expect(statuses.slice(-2)).toEqual(['disconnected', 'connecting']);
		old.closed(); latest().open();
		expect(statuses.at(-1)).toBe(globalThis.document.hidden ? 'suspended' : 'open');
	});

	it('keeps a replacement socket subscription retry after the old close arrives', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		connect(); connection.subscribe('room'); const old = latest(); old.open();
		event('offline'); event('online'); const next = latest(); next.open();
		next.receive({ type: 'subscribe-denied', topic: 'room', reason: 'RATE_LIMITED' });
		const before = next.frames().filter(frame => frame.type === 'subscribe-batch').length;
		old.closed(4401);
		await vi.advanceTimersByTimeAsync(500);
		expect(next.frames().filter(frame => frame.type === 'subscribe-batch')).toHaveLength(before + 1);
		expect(statuses.at(-1)).toBe('open');
	});

	it('honors a permanent close from a replacement-status subscriber', () => {
		connect(); latest().open();
		connection.status.subscribe(status => { if (status === 'disconnected') connection.close(); });
		event('offline'); event('online');
		expect(sockets()).toHaveLength(1);
		expect(statuses.at(-1)).toBe('failed');
	});
});
