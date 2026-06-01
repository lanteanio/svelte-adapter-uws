// Client-side tests for the presence binary wire: that importing the presence
// client module advertises `presence.protocol:1` in the hello frame, and that an
// inbound 0x03 presence frame decodes into the topic store exactly as the JSON
// path would. Mirrors the cursor harness in wire-client.test.js.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBinaryFrame } from '../files/wire.js';
import { encodePresence, PRESENCE_CAPABILITY, PRESENCE_SCHEMA_VERSION } from '../plugins/presence/codec.js';

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	constructor(url) {
		this.url = url;
		this.readyState = MockWebSocket.CONNECTING;
		this._sent = [];
		this.binaryType = 'blob';
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
	deliver(data) { this.onmessage?.({ data }); }
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });

const clientModule = await import('../client.js');
// Import the REAL presence client module: its module-load registerWireCodec call
// is what we are exercising (a typo there would not advertise the capability).
const presenceMod = await import('../plugins/presence/client.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function helloFrame(mock) {
	const f = mock._sent.find((s) => typeof s === 'string' && s.includes('"hello"'));
	return f ? JSON.parse(f) : null;
}

describe('presence client inbound binary (0x03)', () => {
	beforeEach(() => {
		try { clientModule.connect().close(); } catch { /* none */ }
		MockWebSocket._last = null;
		delete globalThis.location;
	});

	it('advertises presence.protocol:1 in the hello frame', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const hello = helloFrame(MockWebSocket._last);
		expect(hello.caps).toContain('batch');
		expect(hello.caps).toContain(PRESENCE_CAPABILITY); // presence.protocol:1
	});

	it('decodes a 0x03 state frame into the topic store after a wire-id announce', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__presence:room').subscribe((v) => { if (v !== null) seen.push(v); });

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__presence:room', id: 1 }));
		const roster = { '1': { id: '1', name: 'Alice' }, '2': { id: '2', name: 'Bob' } };
		mock.deliver(buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 1, 3, encodePresence('state', roster)).buffer);

		expect(seen[seen.length - 1]).toEqual({ topic: '__presence:room', event: 'state', data: roster });
		unsub();
	});

	it('decodes a diff frame with lossless leaves', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__presence:room').subscribe((v) => { if (v !== null) seen.push(v); });

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__presence:room', id: 1 }));
		const diff = { joins: { '3': { id: '3', name: 'Cara' } }, leaves: { '2': { id: '2', name: 'Bob' } } };
		mock.deliver(buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 1, 4, encodePresence('diff', diff)).buffer);

		expect(seen[seen.length - 1]).toEqual({ topic: '__presence:room', event: 'diff', data: diff });
		unsub();
	});

	it('the presence() store requests a snapshot on open (the late-join / reconnect bind path)', async () => {
		// presence() subscribes to status and sends {type:'presence-snapshot', topic}
		// on every status==='open' - so a late-joining or reconnecting client re-binds
		// its board-scoped roster. status fires 'open' on each (re)connect, so this
		// same request re-fires after a reconnect.
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const users = presenceMod.presence('room');
		const unsub = users.subscribe(() => {});
		await flush();

		const snaps = mock._sent.filter((s) => typeof s === 'string' && s.includes('presence-snapshot'));
		expect(snaps.length).toBeGreaterThanOrEqual(1);
		expect(JSON.parse(snaps[snaps.length - 1])).toEqual({ type: 'presence-snapshot', topic: 'room' });
		unsub();
	});

	it('decodes a heartbeat frame as an object map (never an array)', async () => {
		const conn = clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const unsub = conn.on('__presence:room').subscribe((v) => { if (v !== null) seen.push(v); });

		mock.deliver(JSON.stringify({ type: 'wire-id', topic: '__presence:room', id: 1 }));
		const roster = { '1': { id: '1' } };
		mock.deliver(buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 1, 5, encodePresence('heartbeat', roster)).buffer);

		const last = seen[seen.length - 1];
		expect(last.event).toBe('heartbeat');
		expect(Array.isArray(last.data)).toBe(false);
		expect(last.data).toEqual(roster);
		unsub();
	});

	it('merges a field-level update diff into the existing user', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const users = presenceMod.presence('room-merge', { maxAge: 0 });
		const unsub = users.subscribe((v) => seen.push(v));
		await flush();

		// Seed a user via a state frame, then send a field-level update carrying
		// only the changed field.
		mock.deliver(JSON.stringify({ topic: '__presence:room-merge', event: 'state', data: { '1': { id: '1', name: 'Alice' } } }));
		mock.deliver(JSON.stringify({ topic: '__presence:room-merge', event: 'diff', data: { joins: {}, leaves: {}, updates: { '1': { typing: true } } } }));

		expect(seen[seen.length - 1]).toEqual([{ id: '1', name: 'Alice', typing: true }]);
		unsub();
	});

	it('drops a field-level update for an unknown user (reconciles on next state)', async () => {
		clientModule.connect({ path: '/ws' });
		await flush();
		const mock = MockWebSocket._last;

		const seen = [];
		const users = presenceMod.presence('room-unknown', { maxAge: 0 });
		const unsub = users.subscribe((v) => seen.push(v));
		await flush();

		mock.deliver(JSON.stringify({ topic: '__presence:room-unknown', event: 'diff', data: { joins: {}, leaves: {}, updates: { '99': { typing: true } } } }));

		expect(seen[seen.length - 1]).toEqual([]);
		unsub();
	});
});
