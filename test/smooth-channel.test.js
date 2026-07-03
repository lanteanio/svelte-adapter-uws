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

const clientModule = await import('../src/client.js');
const { createSmoothChannel, createSharedRandom: clientCreateSharedRandom } = await import('../src/plugins/smooth/client.js');
const { SmoothEncodeDict, encodeSmooth, SMOOTH_SCHEMA_VERSION } = await import('../src/plugins/smooth/codec.js');
const { buildBinaryFrame } = await import('../src/runtime/wire.js');
const { createSharedRandom: randomCreateSharedRandom } = await import('../src/plugins/smooth/random.js');

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe('createSharedRandom export', () => {
	it('the smooth client entry re-exports the same generator as the random subpath', () => {
		expect(clientCreateSharedRandom).toBe(randomCreateSharedRandom);
	});
});

const applyMove = (s, c) => ({ x: s.x + (c.dx || 0), y: s.y + (c.dy || 0) });

/** Fire a 'shot' event on a firing command; move regardless. */
const fireApply = (s, c, ctx) => {
	if (c.fire) ctx.emitEvent('shot', { x: s.x, y: s.y, dir: c.dir });
	return { x: s.x + (c.dx || 0), y: s.y + (c.dy || 0) };
};

let topicCounter = 0;

/** A scripted transport: canned sync replies, recorded command batches. */
function makeTransport(overrides = {}) {
	const name = 'st-' + topicCounter++;
	const t = {
		name,
		sent: [],
		shots: [],
		syncs: 0,
		sendCommand(batch) {
			t.sent.push(batch);
		},
		sendShoot(payload) {
			t.shots.push(payload);
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

	it('feeds the announced identity to apply as ctx.key (null before the reply)', async () => {
		const keys = [];
		const t = makeTransport();
		const ch = makeChannel(t, {
			apply: (s, c, ctx) => {
				keys.push(ctx.key);
				return { x: s.x + (c.dx || 0), y: s.y };
			}
		});
		// Before the sync reply the identity is unknown.
		ch.command({ dx: 1 });
		expect(keys).toEqual([null]);
		await flush();
		ch.command({ dx: 1 });
		expect(keys).toEqual([null, 'me']);
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

describe('discrete events (onEvent)', () => {
	it('delivers an apply event optimistically when the command is issued (origin local)', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		const id = ch.command({ fire: true, dir: 'N', dx: 1 });
		// Synchronous: the optimistic copy is delivered inside command(), the
		// same frame it was issued - no flush, no render loop required.
		expect(events).toEqual([{ type: 'shot', key: '1:0', data: { x: 0, y: 0, dir: 'N' }, id: 1, origin: 'local' }]);
		expect(id).toBe(1);
		ch.destroy();
	});

	it('assigns a fresh ordinal per emit within one command', async () => {
		const apply = (s, c, ctx) => {
			ctx.emitEvent('a', { n: 1 });
			ctx.emitEvent('b', { n: 2 });
			return s;
		};
		const t = makeTransport();
		const ch = makeChannel(t, { apply });
		await flush();
		const keys = [];
		ch.onEvent((e) => keys.push(e.key));
		ch.command({});
		expect(keys).toEqual(['1:0', '1:1']);
		ch.destroy();
	});

	it('a command with no consumer does not throw and does not accumulate events', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		// Two firing commands before any consumer attaches: their events drain
		// and are dropped (no consumer), they must NOT leak into the next drain.
		ch.command({ fire: true });
		ch.command({ fire: true });
		const events = [];
		ch.onEvent((e) => events.push(e));
		ch.command({ fire: true }); // id 3
		expect(events).toEqual([{ type: 'shot', key: '3:0', data: { x: 0, y: 0, dir: undefined }, id: 3, origin: 'local' }]);
		ch.destroy();
	});

	it('delivers the authority broadcast from the wire (origin server)', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { type: 'boom', key: '9:0', data: { r: 3 }, id: 9 } });
		expect(events).toEqual([{ type: 'boom', key: '9:0', data: { r: 3 }, id: 9, origin: 'server' }]);
		ch.destroy();
	});

	it('ignores a malformed event frame (no key, no type, non-object)', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { type: 'boom' } }); // no key
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { key: '1:0' } }); // no type
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: null });
		expect(events).toEqual([]);
		ch.destroy();
	});

	it('delivers both copies of one event - it does not suppress by key (the consumer correlates)', async () => {
		// A `toAuthor` event reaches the owner both ways: the optimistic local
		// copy and the authoritative confirmation, sharing the correlation key.
		// The channel delivers both, distinguished by origin; suppression is the
		// authority's author-exclusion decision, not the client's.
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		ch.command({ fire: true, dir: 'E' }); // local '1:0'
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { type: 'shot', key: '1:0', data: { x: 0, y: 0, dir: 'E' }, id: 1 } });
		expect(events.map((e) => e.origin)).toEqual(['local', 'server']);
		expect(events[0].key).toBe(events[1].key);
		ch.destroy();
	});

	it('destroy() detaches the consumer: a later broadcast is not delivered', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		ch.destroy();
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { type: 'boom', key: '1:0', data: {}, id: 1 } });
		expect(events).toEqual([]);
	});

	it('a command issued from inside the handler keeps the transport batch in id order', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		let reentered = false;
		ch.onEvent((e) => {
			events.push(e);
			if (e.origin === 'local' && !reentered) {
				reentered = true;
				ch.command({ fire: true }); // re-entrant command from the handler
			}
		});
		const id1 = ch.command({ fire: true });
		expect(id1).toBe(1);
		// Both commands' optimistic events were delivered, each with its own id.
		expect(events.map((e) => e.id)).toEqual([1, 2]);
		await flush(40);
		// The transport batch is in ascending id order despite the re-entrancy -
		// the outer command queued before the handler's nested command ran.
		const batch = t.sent.flat();
		expect(batch.map((c) => c.id)).toEqual([1, 2]);
		ch.destroy();
	});

	it('ignores a server event frame with a non-numeric id (the typed contract is id:number)', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { type: 'boom', key: '9:0', data: {}, id: '9' } });
		MockWebSocket._last.emit({ topic: wire(t), event: 'event', data: { type: 'boom', key: '9:0', data: {} } }); // id absent
		expect(events).toEqual([]);
		ch.destroy();
	});

	it('an overflowed command runs no apply and delivers no local event', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { apply: fireApply, windowCap: 2 });
		await flush();
		const events = [];
		ch.onEvent((e) => events.push(e));
		ch.command({ fire: true }); // id 1, predicted
		ch.command({ fire: true }); // id 2, predicted
		expect(events).toHaveLength(2);
		ch.command({ fire: true }); // id 3: window cap hit, prediction killed, no apply
		expect(ch.overflowed).toBe(true);
		expect(events).toHaveLength(2); // no origin:'local' event for the killed command
		ch.destroy();
	});

	it('drops a one-shot event that landed before the tap bound (no stale replay on bind)', async () => {
		// A deferred sync so an event frame can land on the wire topic AFTER the
		// socket opens but BEFORE the sync reply binds the inbound tap.
		let resolveSync;
		const name = 'st-prebind-' + topicCounter++;
		const t = {
			name,
			sent: [],
			syncs: 0,
			sendCommand(batch) {
				t.sent.push(batch);
			},
			sync() {
				t.syncs++;
				return new Promise((res) => {
					resolveSync = res;
				});
			}
		};
		const ch = makeChannel(t, { apply: fireApply });
		const events = [];
		ch.onEvent((e) => events.push(e));
		await flush(5); // socket open, sync() called and pending - tap not yet bound
		MockWebSocket._last.emit({ topic: '__smooth:' + name, event: 'event', data: { type: 'early', key: '1:0', data: {}, id: 1 } });
		resolveSync({ topic: name, t: Date.now(), you: 'me', ack: 0, states: [] });
		await flush(5); // sync resolves, binds the tap, replays the store's current value
		expect(events).toEqual([]); // the pre-bind event is not re-fired on bind
		// A fresh event after the tap is live IS delivered.
		MockWebSocket._last.emit({ topic: '__smooth:' + name, event: 'event', data: { type: 'live', key: '2:0', data: {}, id: 2 } });
		expect(events).toEqual([{ type: 'live', key: '2:0', data: {}, id: 2, origin: 'server' }]);
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

describe('shoot (lag-compensated fire-and-forget)', () => {
	it('sends a shot through the transport, bypassing the prediction ring and the command batch', async () => {
		const t = makeTransport({ lc: 1 });
		const ch = makeChannel(t);
		await flush();
		const windowBefore = ch.windowSize;
		ch.shoot({ fire: true, dir: 0 });
		await flush();
		expect(t.shots).toHaveLength(1);
		expect(t.shots[0].cmd).toEqual({ fire: true, dir: 0 });
		// No prediction entry, and the shot rides its own send, not the command batch.
		expect(ch.windowSize).toBe(windowBefore);
		expect(t.sent).toHaveLength(0);
	});

	it('stamps a renderTime when the topic advertised lag compensation', async () => {
		const t = makeTransport({ lc: 1 });
		const ch = makeChannel(t);
		await flush();
		ch.shoot({ fire: true });
		expect(t.shots).toHaveLength(1);
		expect(typeof t.shots[0].rt).toBe('number');
		expect(Number.isFinite(t.shots[0].rt)).toBe(true);
		// The stamp is render-time: the synced clock minus the interpolation delay.
		expect(t.shots[0].rt).toBeCloseTo(ch.now() - ch.delay, -2);
	});

	it('omits the renderTime when lag compensation was not advertised (byte-identical off)', async () => {
		const t = makeTransport(); // no lc in the sync reply
		const ch = makeChannel(t);
		await flush();
		ch.shoot({ fire: true });
		expect(t.shots).toHaveLength(1);
		expect(t.shots[0]).toEqual({ cmd: { fire: true } });
		expect('rt' in t.shots[0]).toBe(false);
	});

	it('is inert when the transport predates the shoot path', async () => {
		const t = makeTransport({ lc: 1 });
		delete t.sendShoot;
		const ch = makeChannel(t);
		await flush();
		expect(() => ch.shoot({ fire: true })).not.toThrow();
	});

	it('echoes the latest server stamp (ackT) so the server can measure the round trip', async () => {
		const t = makeTransport({ lc: 1 });
		const ch = makeChannel(t);
		await flush();
		ch.shoot({ fire: true });
		expect(t.shots).toHaveLength(1);
		// A server-authored absolute stamp, not a client-derived latency.
		expect(typeof t.shots[0].ackT).toBe('number');
		expect(Number.isFinite(t.shots[0].ackT)).toBe(true);
	});

	it('suppresses the stamp before the clock has synced (cold start)', async () => {
		// lc is advertised but the sync reply carries no server time, so the clock
		// never seeds: a render-time built from the raw local wall clock would be
		// arbitrarily skewed, so the shot must go out stampless (resolve at present).
		const t = makeTransport({ lc: 1, t: undefined });
		const ch = makeChannel(t);
		await flush();
		ch.shoot({ fire: true });
		expect(t.shots).toHaveLength(1);
		expect(t.shots[0]).toEqual({ cmd: { fire: true } });
		expect('rt' in t.shots[0]).toBe(false);
		expect('ackT' in t.shots[0]).toBe(false);
	});
});

describe('stats() telemetry snapshot', () => {
	it('reflects identity, topic, the reconciliation window, and remote count', async () => {
		const t = makeTransport();
		const ch = makeChannel(t, { smoothTimeMs: 100 });
		await flush();

		// After sync: identity + topic bound, clock synced, the 'other' entity merged.
		let s = ch.stats();
		expect(s.self).toBe('me');
		expect(s.topic).toBe(wire(t));
		expect(s.clockSynced).toBe(true);
		expect(s.remoteCount).toBeGreaterThanOrEqual(1);
		expect(s.unacked).toBe(0);
		expect(s.windowCap).toBe(256);
		expect(s.overflowed).toBe(false);
		expect(s.correcting).toBe(false);
		expect(s.lastDivergence).toBe(0);

		// Issue commands: the un-acked reconciliation window grows.
		ch.command({ dx: 2 });
		ch.command({ dx: 3 });
		expect(ch.stats().unacked).toBe(2);

		// A diverging ack (server contradicts the prediction): window drains, the
		// last divergence and the active correction surface.
		MockWebSocket._last.emit({ topic: wire(t), event: 'ack', data: { id: 2, state: { x: 0, y: 0 }, t: Date.now() } });
		s = ch.stats();
		expect(s.unacked).toBe(0);
		expect(s.lastDivergence).toBeGreaterThan(0);
		expect(s.correcting).toBe(true);
		ch.destroy();
	});
});
