// The channel's wire views (`options.wire`): states unpack at ingest and in
// the sync roster, commands and shots pack on transmit, and the prediction
// always replays the ORIGINAL command objects. The harness is the scripted
// transport + mocked singleton socket from smooth-channel.test.js.

import { describe, it, expect, beforeEach } from 'vitest';

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
	send(data) {
		this._sent.push(data);
	}
	close(code = 1000, reason = '') {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
	emit(obj) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' } });
globalThis.requestAnimationFrame = /** @type {any} */ ((cb) => setTimeout(cb, 0));
globalThis.cancelAnimationFrame = /** @type {any} */ ((h) => clearTimeout(h));

const clientModule = await import('../src/client.js');
const { createSmoothChannel } = await import('../src/plugins/smooth/client.js');

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const applyMove = (s, c) => ({ x: s.x + (c.dx || 0), y: s.y + (c.dy || 0), hp: s.hp });

// The app's wire views: a state {x,y,hp} rides as [x,y,hp]; a command
// {dx,dy} rides as [dx,dy]. Deliberately asymmetric shapes so a value that
// skipped its codec is unmistakable.
const stateWire = {
	pack: (s) => [s.x, s.y, s.hp],
	unpack: (a) => {
		if (!Array.isArray(a) || a.length !== 3) throw new Error('bad state record');
		return { x: a[0], y: a[1], hp: a[2] };
	}
};
const commandWire = {
	pack: (c) => [c.dx || 0, c.dy || 0],
	unpack: (a) => ({ dx: a[0], dy: a[1] })
};

let topicCounter = 0;

function makeTransport(overrides = {}) {
	const name = 'wv-' + topicCounter++;
	const t = {
		name,
		sent: [],
		shots: [],
		sync() {
			return Promise.resolve({
				topic: name,
				t: Date.now(),
				you: 'me',
				ack: 0,
				states: [
					{ key: 'me', state: [0, 0, 100] },
					{ key: 'other', state: [5, 5, 80] }
				],
				...overrides
			});
		},
		sendCommand(batch) {
			t.sent.push(batch);
		},
		sendShoot(payload) {
			t.shots.push(payload);
		}
	};
	return t;
}

function makeChannel(transport, extra = {}) {
	return createSmoothChannel({
		apply: applyMove,
		initial: { x: 0, y: 0, hp: 100 },
		transport,
		wire: { state: stateWire, command: commandWire },
		// Render remotes at the estimated present, clamped to the last ingested
		// point, so an unpacked position is sampled exactly - no render-in-the-
		// past wait, no extrapolation drift.
		interpolationMs: 0,
		extrapolateMs: 0,
		...extra
	});
}

const wire = (t) => '__smooth:' + t.name;

beforeEach(async () => {
	try {
		clientModule.connect().close();
	} catch {
		/* no singleton yet */
	}
	MockWebSocket._last = null;
	await flush(2);
});

describe('wire option validation', () => {
	const transport = { sendCommand() {}, sync: async () => null };
	it('rejects a non-object wire and a half codec pair', () => {
		expect(() => createSmoothChannel({ apply: applyMove, initial: {}, transport, wire: 5 })).toThrow('wire');
		expect(() => createSmoothChannel({ apply: applyMove, initial: {}, transport, wire: { state: { pack() {} } } })).toThrow('wire.state');
		expect(() => createSmoothChannel({ apply: applyMove, initial: {}, transport, wire: { command: { unpack() {} } } })).toThrow('wire.command');
	});
	it('accepts an empty wire object as off', () => {
		const ch = createSmoothChannel({ apply: applyMove, initial: {}, transport, wire: {} });
		ch.destroy();
	});
});

describe('state wire view', () => {
	it('unpacks the sync roster into the basis and the remote set', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		let local = null;
		let remote = null;
		ch.onFrame((l, r) => {
			local = l;
			remote = r;
		});
		await flush();
		expect(ch.predicted).toEqual({ x: 0, y: 0, hp: 100 });
		expect(local).toEqual({ x: 0, y: 0, hp: 100 });
		// toMatchObject: the remote frame state also carries the render layer's
		// SMOOTH_FRESHNESS symbol tag, orthogonal to the wire view under test.
		expect(remote.get('other')).toMatchObject({ x: 5, y: 5, hp: 80 });
		ch.destroy();
	});

	it('unpacks a packed update for a remote and a packed own-key rebase', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		let remote = null;
		ch.onFrame((l, r) => {
			remote = r;
		});
		await flush();
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'other', data: [6, 7, 79] } });
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'me', data: [40, 40, 60] } });
		await flush();
		expect(remote.get('other')).toMatchObject({ x: 6, y: 7, hp: 79 }); // + SMOOTH_FRESHNESS tag
		expect(remote.has('me')).toBe(false);
		// No commands in flight: the own-key update rebases the prediction.
		expect(ch.predicted).toEqual({ x: 40, y: 40, hp: 60 });
		ch.destroy();
	});

	it('unpacks a packed ack into the reconciliation', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		ch.onFrame(() => {});
		await flush();
		const id = ch.command({ dx: 2 });
		expect(ch.predicted).toEqual({ x: 2, y: 0, hp: 100 });
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id, state: [2, 0, 100], t: Date.now() } });
		await flush();
		expect(ch.windowSize).toBe(0);
		expect(ch.predicted).toEqual({ x: 2, y: 0, hp: 100 });
		ch.destroy();
	});

	it('drops a malformed packed frame without killing the channel', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		let remote = null;
		ch.onFrame((l, r) => {
			remote = r;
		});
		await flush();
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'other', data: { not: 'a record' } } });
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id: 1, state: 'garbage', t: Date.now() } });
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'other', data: [9, 9, 42] } });
		await flush();
		expect(remote.get('other')).toMatchObject({ x: 9, y: 9, hp: 42 }); // + SMOOTH_FRESHNESS tag
		ch.destroy();
	});
});

describe('command wire view', () => {
	it('transmits packed commands while predicting with the originals', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		ch.onFrame(() => {});
		await flush();
		const id = ch.command({ dx: 3, dy: 1 });
		await flush(40);
		expect(ch.predicted).toEqual({ x: 3, y: 1, hp: 100 });
		const batch = t.sent.flat();
		expect(batch.length).toBe(1);
		expect(batch[0].id).toBe(id);
		expect(batch[0].cmd).toEqual([3, 1]);
		ch.destroy();
	});

	it('packs a shot command', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		ch.onFrame(() => {});
		await flush();
		ch.shoot({ dx: 0, dy: 0 });
		expect(t.shots.length).toBe(1);
		expect(t.shots[0].cmd).toEqual([0, 0]);
		ch.destroy();
	});
});
