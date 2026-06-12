// Client-side tests for createSmoothChannel: option validation, the
// sync-on-open lifecycle (topic binding, self identity, basis adoption),
// command prediction + frame-batched flushing, ack/update/remove ingest with
// own-key suppression, overflow recovery, and teardown. The transport is
// injected (scripted sync replies, recorded command batches); inbound frames
// are driven through the singleton connection's mocked socket, the same
// harness shape as cursor-handle.test.js.

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

const clientModule = await import('../client.js');
const { createSmoothChannel } = await import('../plugins/smooth/client.js');
const { SmoothEncodeDict, encodeSmooth, SMOOTH_SCHEMA_VERSION } = await import('../plugins/smooth/codec.js');
const { buildBinaryFrame } = await import('../files/wire.js');

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const applyMove = (s, c) => ({ x: s.x + (c.dx || 0), y: s.y + (c.dy || 0) });

let topicCounter = 0;

/** A scripted transport: canned sync replies, recorded command batches. */
function makeTransport(overrides = {}) {
	const name = 'st-' + topicCounter++;
	const t = {
		name,
		sent: [],
		syncs: 0,
		sendCommand(batch) {
			t.sent.push(batch);
		},
		sync() {
			t.syncs++;
			return Promise.resolve({
				topic: name,
				t: Date.now(),
				you: 'me',
				ack: 0,
				states: [
					{ key: 'me', state: { x: 0, y: 0 } },
					{ key: 'other', state: { x: 5, y: 5 } }
				],
				...overrides
			});
		}
	};
	return t;
}

function makeChannel(transport, extra = {}) {
	return createSmoothChannel({
		apply: applyMove,
		initial: { x: 0, y: 0 },
		transport,
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

describe('option validation', () => {
	const transport = { sendCommand() {}, sync: async () => null };
	it('rejects missing apply, initial, and transport', () => {
		expect(() => createSmoothChannel()).toThrow('options object');
		expect(() => createSmoothChannel({ initial: {}, transport })).toThrow('apply');
		expect(() => createSmoothChannel({ apply: applyMove, transport })).toThrow('initial');
		expect(() => createSmoothChannel({ apply: applyMove, initial: {} })).toThrow('transport');
	});
	it('rejects malformed knobs eagerly', () => {
		const base = { apply: applyMove, initial: {}, transport };
		expect(() => createSmoothChannel({ ...base, computeError: 5 })).toThrow('computeError');
		expect(() => createSmoothChannel({ ...base, smoothTimeMs: -1 })).toThrow('smoothTimeMs');
		expect(() => createSmoothChannel({ ...base, windowCap: 0 })).toThrow('windowCap');
		expect(() => createSmoothChannel({ ...base, interpolationMs: 'fast' })).toThrow('interpolationMs');
		expect(() => createSmoothChannel({ ...base, cmdRate: -2 })).toThrow('cmdRate');
	});
});

describe('sync lifecycle', () => {
	it('syncs on open, adopts the identity and basis, and binds the wire topic', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		expect(t.syncs).toBe(1);
		expect(ch.self).toBe('me');
		expect(ch.topic).toBe(wire(t));
		expect(ch.predicted).toEqual({ x: 0, y: 0 });
		// now() applies the sync round trip's seed even with no render loop
		// (a headless channel still stamps with the synced clock).
		const est = ch.now();
		expect(Math.abs(est - Date.now())).toBeLessThan(1000);
		expect(ch.clockOffset).not.toBe(null);
		ch.destroy();
	});

	it('adopts the server ack watermark so older acks are ignored', async () => {
		const t = makeTransport({ ack: 7 });
		const ch = makeChannel(t);
		await flush();
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id: 5, state: { x: 99, y: 0 }, t: Date.now() } });
		expect(ch.predicted).toEqual({ x: 0, y: 0 });
		ch.destroy();
	});

	it('resync() re-requests the catalog', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		ch.resync();
		await flush();
		expect(t.syncs).toBe(2);
		ch.destroy();
	});
});

describe('commands', () => {
	it('predicts immediately and flushes one frame-batched send', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		const id1 = ch.command({ dx: 2 });
		const id2 = ch.command({ dx: 3 });
		expect(ch.predicted).toEqual({ x: 5, y: 0 });
		expect(ch.windowSize).toBe(2);
		await flush(40);
		expect(t.sent.length).toBe(1);
		expect(t.sent[0]).toEqual([
			{ id: id1, cmd: { dx: 2 } },
			{ id: id2, cmd: { dx: 3 } }
		]);
		ch.destroy();
	});

	it('flushes without a frame consumer (headless commanding)', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		ch.command({ dx: 1 });
		await flush(60);
		expect(t.sent.length).toBe(1);
		ch.destroy();
	});
});

describe('inbound ingest', () => {
	it('acknowledgements drain the window and rebase the prediction', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		const id = ch.command({ dx: 2 });
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id, state: { x: 2, y: 0 }, t: Date.now() } });
		expect(ch.windowSize).toBe(0);
		expect(ch.predicted).toEqual({ x: 2, y: 0 });
		// A duplicate acknowledgement changes nothing.
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id, state: { x: 77, y: 0 }, t: Date.now() } });
		expect(ch.predicted).toEqual({ x: 2, y: 0 });
		ch.destroy();
	});

	it('a divergent acknowledgement snaps the simulation to the authority', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		const id = ch.command({ dx: 2 });
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id, state: { x: 50, y: 0 }, t: Date.now() } });
		expect(ch.predicted).toEqual({ x: 50, y: 0 });
		ch.destroy();
	});

	it('keeps the own key out of the remote set and surfaces remote entities per frame', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		const frames = [];
		ch.onFrame((local, remote) => frames.push({ local, remote }));
		// A pending command makes the acknowledgement the carrier: the
		// own-key frame is dropped outright.
		ch.command({ dx: 1 });
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'me', data: { x: 40, y: 40 } } });
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'other', data: { x: 6, y: 6 } } });
		await flush(40);
		expect(frames.length).toBeGreaterThan(0);
		const last = frames[frames.length - 1];
		expect(last.remote.has('me')).toBe(false);
		expect(last.remote.has('other')).toBe(true);
		// The echoed own-key frame never perturbs an in-flight prediction.
		expect(ch.predicted).toEqual({ x: 1, y: 0 });
		ch.destroy();
	});

	it('remove drops a remote entity', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		const frames = [];
		ch.onFrame((local, remote) => frames.push(remote));
		MockWebSocket._last.emit({ topic: wire(t), event: 'remove', data: { key: 'other' } });
		await flush(40);
		expect(frames[frames.length - 1].has('other')).toBe(false);
		ch.destroy();
	});
});

describe('overflow recovery', () => {
	it('kills prediction at the window cap, reports it, resyncs, and re-engages on the next ack', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { windowCap: 2 });
		await flush();
		const seen = [];
		ch.onOverflow((o) => seen.push(o));
		ch.command({ dx: 1 });
		ch.command({ dx: 1 });
		const id3 = ch.command({ dx: 1 });
		expect(ch.overflowed).toBe(true);
		expect(seen).toEqual([true]);
		await flush();
		// The recovery sync rebased and re-engaged.
		expect(t.syncs).toBe(2);
		expect(ch.overflowed).toBe(false);
		expect(seen).toEqual([true, false]);
		// Prediction resumes for new commands.
		ch.command({ dx: 4 });
		expect(ch.predicted).toEqual({ x: 4, y: 0 });
		expect(id3).toBeGreaterThan(0);
		ch.destroy();
	});
});

describe('binary stamp ingestion', () => {
	it('a stamped binary update reaches the clock estimator through the dispatch path', async () => {
		// No sync-time stamp: the binary update's in-frame stamp is the
		// channel's ONLY server-time sample, so the estimated server clock
		// jumping to it proves the stamp survived decode -> dispatch -> tap.
		const t = makeTransport({ t: undefined });
		const ch = makeChannel(t);
		await flush();
		expect(ch.clockOffset).toBe(null);

		// The connection learns the wire topic id, then receives a real
		// binary frame encoded with a server clock far from the local one.
		MockWebSocket._last.emit({ type: 'wire-id', topic: wire(t), id: 7 });
		const FUTURE = Date.now() + 100000;
		const enc = new SmoothEncodeDict(() => FUTURE);
		const payload = encodeSmooth('update', { key: 'other', data: { x: 1, y: 2 } }, enc);
		const frame = buildBinaryFrame(SMOOTH_SCHEMA_VERSION, 7, 1, payload);
		const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
		MockWebSocket._last.onmessage?.({ data: buf });

		const est = ch.now();
		expect(est).toBeGreaterThan(Date.now() + 50000);
		ch.destroy();
	});
});

describe('own-entity continuation', () => {
	it('adopts an own-key update as authoritative when no command is pending, drops it while commands are in flight', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		// Idle: server-side motion for the local entity rebases it.
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'me', data: { x: 9, y: 9 } } });
		expect(ch.predicted).toEqual({ x: 9, y: 9 });
		// In flight: the acknowledgement is the carrier; the frame is dropped.
		ch.command({ dx: 1 });
		MockWebSocket._last.emit({ topic: wire(t), event: 'update', data: { key: 'me', data: { x: 50, y: 50 } } });
		expect(ch.predicted).toEqual({ x: 10, y: 9 });
		ch.destroy();
	});
});

describe('foreign watermark isolation', () => {
	it('a fresh view on a surviving server entity clamps the sync watermark and reconciles its own stream', async () => {
		// The server entity outlived a previous view: its watermark is far
		// above this fresh predictor's id space.
		const t = makeTransport({ ack: 50000 });
		const ch = makeChannel(t);
		await flush();
		const id = ch.command({ dx: 2 });
		expect(id).toBe(1);
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id, state: { x: 2, y: 0 }, t: Date.now() } });
		expect(ch.windowSize).toBe(0);
		expect(ch.predicted).toEqual({ x: 2, y: 0 });
		ch.destroy();
	});

	it('an ack for an id this view never issued is ignored', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		ch.command({ dx: 2 });
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id: 50000, state: { x: 0, y: 0 }, t: Date.now() } });
		expect(ch.windowSize).toBe(1);
		expect(ch.predicted).toEqual({ x: 2, y: 0 });
		ch.destroy();
	});
});

describe('teardown', () => {
	it('destroy stops the loop and the flush pump', async () => {
		const t = makeTransport();
		const ch = makeChannel(t);
		await flush();
		ch.command({ dx: 1 });
		ch.destroy();
		await flush(60);
		expect(t.sent.length).toBe(0);
		ch.destroy(); // idempotent
	});
});
