// The cursor render worker with smoothing on: a fake worker scope, a mock
// WebSocket, fake timers driving the 16ms frame fallback, and the client
// runtime's clocks bound to the faked Date so the monotonic axis is fully
// scripted. What is pinned here: the extended hello caps, the snapshot time
// seed pairing, render frames that interpolate BETWEEN wire frames (the
// headline behavior), the widened-then-closing dirty gate, the raw feed
// contract, and the reconnect reset.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachCursorWorker } from '../plugins/cursor/cursor-worker.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../client-runtime.js';
import { buildBinaryFrame } from '../files/wire.js';
import {
	encodeCursor,
	CursorTimeEncodeDict,
	CURSOR_CAPABILITY,
	CURSOR_CAPABILITY_DICT,
	CURSOR_CAPABILITY_TIME,
	CURSOR_SCHEMA_VERSION_TIME
} from '../plugins/cursor/codec.js';

let sockets;

class MockWebSocket {
	constructor(url, protocols) {
		this.url = url;
		this.protocols = protocols;
		this.readyState = 0;
		this.sent = [];
		this.onopen = null;
		this.onmessage = null;
		this.onclose = null;
		this.onerror = null;
		sockets.push(this);
	}
	send(s) { this.sent.push(s); }
	close() {
		this.readyState = 3;
		if (this.onclose) this.onclose({});
	}
	open() {
		this.readyState = 1;
		if (this.onopen) this.onopen();
	}
	message(data) { if (this.onmessage) this.onmessage({ data }); }
}

function mock2dCtx() {
	return {
		ops: [],
		fillStyles: [],
		set fillStyle(v) { this.fillStyles.push(v); },
		get fillStyle() { return this.fillStyles[this.fillStyles.length - 1]; },
		globalCompositeOperation: 'source-over',
		clearRect(...a) { this.ops.push(['clearRect', ...a]); },
		beginPath() {},
		arc(...a) { this.ops.push(['arc', ...a]); },
		fill() {},
		drawImage() {}
	};
}

function mockCanvas() {
	const ctx = mock2dCtx();
	return { width: 0, height: 0, ctx, getContext: (t) => (t === '2d' ? ctx : null) };
}

function makeScope() {
	return { posted: [], postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }, onmessage: null };
}

const sleepFrames = (n = 1) => vi.advanceTimersByTime(17 * n);
const sentJson = (sock) => sock.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } });
const arcs = (canvas) => canvas.ctx.ops.filter((o) => o[0] === 'arc');

function toArrayBuffer(u8) {
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

let realWebSocket;

beforeEach(() => {
	vi.useFakeTimers();
	// Route the browser runtime's wall AND monotonic readers onto the faked
	// Date so advanceTimersByTime moves the interpolation clock too.
	setRuntimeEnv({ clock: { now: () => Date.now(), monotonic: () => Date.now() } });
	sockets = [];
	realWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = MockWebSocket;
});

afterEach(() => {
	resetRuntimeEnv();
	vi.useRealTimers();
	if (realWebSocket === undefined) delete globalThis.WebSocket;
	else globalThis.WebSocket = realWebSocket;
});

function boot(opts = {}) {
	const scope = makeScope();
	const canvas = mockCanvas();
	const ctrl = attachCursorWorker(scope);
	ctrl.handleMessage({
		type: 'init',
		topic: 't',
		url: 'ws://test/ws',
		canvas,
		gpu: 'canvas2d',
		devicePixelRatio: 1,
		smooth: { delayMs: 50, extrapolateMs: 250, snapGapMs: 5000 },
		...opts
	});
	return { scope, canvas, ctrl, sock: () => sockets[sockets.length - 1] };
}

/** Open the socket, deliver the time seed and roster, return the v3 encoder. */
function openSmoothed(ctrl, sock, serverBase) {
	sock.open();
	ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 } });
	sock.message(JSON.stringify({ topic: '__cursor:t', event: 'time', data: { t: serverBase } }));
	sock.message(JSON.stringify({ type: 'wire-id', topic: '__cursor:t', id: 1 }));
	sock.message(JSON.stringify({ topic: '__cursor:t', event: 'catalog', data: [{ key: 'a', user: { name: 'Ada' } }] }));
	const times = [];
	const enc = new CursorTimeEncodeDict(() => times.shift());
	return {
		sendStamped(x, y, t) {
			times.push(t);
			const payload = encodeCursor('update', { key: 'a', data: { x, y } }, enc);
			sock.message(toArrayBuffer(buildBinaryFrame(CURSOR_SCHEMA_VERSION_TIME, 1, 1, payload)));
		}
	};
}

describe('smoothing handshake', () => {
	it('advertises the time capability only when smoothing', () => {
		const { sock } = boot();
		sock().open();
		expect(sentJson(sock())[0]).toEqual({
			type: 'hello',
			caps: [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME]
		});
	});

	it('a non-smoothing worker keeps the lean caps and no smoother', () => {
		const { ctrl, sock } = boot({ smooth: null });
		sock().open();
		expect(sentJson(sock())[0]).toEqual({ type: 'hello', caps: [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT] });
		expect(ctrl._smoother).toBe(null);
	});
});

describe('interpolated rendering', () => {
	it('paints frames BETWEEN wire frames and settles when motion is played out', () => {
		const { ctrl, canvas, sock } = boot();
		const serverBase = 1_000_000;
		const wire = openSmoothed(ctrl, sock(), serverBase);

		// Three stamped frames: a 100px move over 100ms, then stationary.
		wire.sendStamped(0, 0, serverBase);
		wire.sendStamped(100, 0, serverBase + 100);
		wire.sendStamped(100, 0, serverBase + 200);

		// Drive ~30 frames with NO further wire data. The motion gate must
		// keep painting while buffered motion plays out.
		const xs = [];
		for (let i = 0; i < 30; i++) {
			sleepFrames(1);
			const a = arcs(canvas);
			if (a.length > xs.length) xs.push(a[a.length - 1][1]);
		}

		// Interpolation proof: several DISTINCT positions strictly between
		// the two wire positions were painted - frames the wire never sent.
		const between = [...new Set(xs.filter((x) => x > 0 && x < 100))];
		expect(between.length).toBeGreaterThanOrEqual(3);
		// And the motion converges on the final wire position exactly.
		expect(xs[xs.length - 1]).toBeCloseTo(100, 5);
		// Once everything settled the gate closes again: no further paints.
		const opsAfterSettle = canvas.ctx.ops.length;
		sleepFrames(10);
		expect(canvas.ctx.ops.length).toBe(opsAfterSettle);
		expect(ctrl._smoother.motionPending).toBe(false);
	});

	it('exposes the smoothing diagnostics on the debug surface', () => {
		const { scope, ctrl, sock } = boot();
		const wire = openSmoothed(ctrl, sock(), 2_000_000);
		wire.sendStamped(0, 0, 2_000_000);
		sleepFrames(2);
		const dbg = scope.__cursorWorkerDebug;
		expect(dbg.smoothing).toBe(true);
		expect(dbg.smoothRings).toBe(1);
		expect(dbg.smoothDelayMs).toBe(50);
		expect(typeof dbg.clockOffsetMs).toBe('number');
	});
});

describe('feed stays raw', () => {
	it('the thinned feed ships wire positions even while pixels interpolate', () => {
		const { scope, ctrl, sock } = boot({ feedRate: 10 });
		const serverBase = 3_000_000;
		const wire = openSmoothed(ctrl, sock(), serverBase);
		wire.sendStamped(0, 0, serverBase);
		wire.sendStamped(100, 0, serverBase + 100);
		// One frame in, the painted position is still far from 100 (the
		// render time trails); the next feed tick must report exactly 100.
		sleepFrames(1);
		vi.advanceTimersByTime(100);
		const feeds = scope.posted.filter((p) => p.msg.type === 'feed');
		expect(feeds.length).toBeGreaterThan(0);
		const last = feeds[feeds.length - 1].msg;
		expect(last.keys).toEqual(['a']);
		expect(last.positions[0]).toBe(100);
		expect(last.positions[1]).toBe(0);
	});
});

describe('reconnect', () => {
	it('forgets the clock and ring history when the socket recycles', () => {
		const { ctrl, sock } = boot();
		const wire = openSmoothed(ctrl, sock(), 4_000_000);
		wire.sendStamped(0, 0, 4_000_000);
		sleepFrames(1);
		expect(ctrl._smoother.size).toBe(1);
		expect(ctrl._smoother.clock.offset()).not.toBe(null);
		sock().close();
		vi.advanceTimersByTime(10_000); // past the reconnect backoff
		expect(sockets.length).toBeGreaterThan(1);
		expect(ctrl._smoother.size).toBe(0);
		expect(ctrl._smoother.clock.offset()).toBe(null);
	});
});
