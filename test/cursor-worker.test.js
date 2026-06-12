// The cursor render worker as a unit: a fake worker scope, a mock WebSocket,
// and fake timers driving the frame fallback (no requestAnimationFrame under
// node, so scheduleFrame rides the 16ms runtime timer).
//
// What is pinned here: the minimal protocol handshake (subprotocol, hello
// caps, snapshot-as-subscribe, NO wire subscribe), the binary and JSON ingest
// arms, the store-parity visibility rule, the viewport wire throttle, the
// roster/feed bridges, reconnect + zombie recycling, and the
// pause/reinit/destroy lifecycle that the transfer-once canvas constraint
// imposes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachCursorWorker, CURSOR_SUBPROTOCOL } from '../plugins/cursor/cursor-worker.js';
import { CURSOR_LANE_SUBPROTOCOL } from '../files/utils.js';
import { buildBinaryFrame } from '../files/wire.js';
import {
	encodeCursor,
	CursorEncodeDict,
	CURSOR_CAPABILITY,
	CURSOR_CAPABILITY_DICT,
	CURSOR_SCHEMA_VERSION,
	CURSOR_SCHEMA_VERSION_DICT
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
	sockets = [];
	realWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = MockWebSocket;
});

afterEach(() => {
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
		...opts
	});
	return { scope, canvas, ctrl, sock: () => sockets[sockets.length - 1] };
}

function openWithBoard(ctrl, sock) {
	sock.open();
	ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 100, h: 100, zoom: 1 } });
	sock.message(JSON.stringify({ topic: '__cursor:t', event: 'catalog', data: [{ key: 'a', user: { name: 'Ada' } }] }));
	sock.message(JSON.stringify({ topic: '__cursor:t', event: 'update', data: { key: 'a', data: { x: 5, y: 6 } } }));
}

describe('handshake', () => {
	it('dials with the cursor lane subprotocol - the exact token the admission gate reads', () => {
		const { sock } = boot();
		expect(sock().protocols).toEqual([CURSOR_SUBPROTOCOL]);
		expect(CURSOR_SUBPROTOCOL).toBe(CURSOR_LANE_SUBPROTOCOL);
	});

	it('on open sends hello with ONLY the codec caps, then the snapshot request - and never a wire subscribe', () => {
		const { ctrl, sock } = boot();
		sock().open();
		const frames = sentJson(sock());
		expect(frames[0]).toEqual({ type: 'hello', caps: [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT] });
		expect(frames[1]).toEqual({ type: 'cursor-snapshot', topic: 't' });
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 10, h: 10, zoom: 1 } });
		expect(sentJson(sock()).some((f) => f && (f.type === 'subscribe' || f.type === 'subscribe-batch'))).toBe(false);
	});
});

describe('ingest', () => {
	it('applies JSON cursor events and renders only roster-known cursors (store-parity rule)', () => {
		const { ctrl, canvas, sock } = boot();
		openWithBoard(ctrl, sock());
		// A position whose user never arrived stays invisible.
		sock().message(JSON.stringify({ topic: '__cursor:t', event: 'update', data: { key: 'ghost', data: { x: 9, y: 9 } } }));
		sleepFrames(2);
		expect(ctrl._state.positionMap.size).toBe(2);
		expect(arcs(canvas)).toHaveLength(1);
		expect(arcs(canvas)[0].slice(1, 3)).toEqual([5, 6]);
	});

	it('decodes full-string binary frames after the wire-id announce', () => {
		const { ctrl, sock } = boot();
		sock().open();
		sock().message(JSON.stringify({ type: 'wire-id', topic: '__cursor:t', id: 7 }));
		const frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 7, 0, encodeCursor('update', { key: 'a', data: { x: 1.5, y: 2.5 } }));
		sock().message(toArrayBuffer(frame));
		expect(ctrl._state.positionMap.get('a')).toEqual({ x: 1.5, y: 2.5 });
		expect(ctrl._wireIds.get(7)).toBe('__cursor:t');
	});

	it('decodes short-id dictionary frames against its per-connection dictionary', () => {
		const { ctrl, sock } = boot();
		sock().open();
		sock().message(JSON.stringify({ type: 'wire-id', topic: '__cursor:t', id: 1 }));
		const enc = new CursorEncodeDict();
		// First frame interns the key (KEY-ASSIGN), second references it.
		const f1 = buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, 1, 0, encodeCursor('update', { key: 'mover', data: { x: 1, y: 1 } }, enc));
		const f2 = buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, 1, 0, encodeCursor('update', { key: 'mover', data: { x: 2, y: 2 } }, enc));
		sock().message(toArrayBuffer(f1));
		sock().message(toArrayBuffer(f2));
		expect(ctrl._state.positionMap.get('mover')).toEqual({ x: 2, y: 2 });
	});

	it('drops binary frames for unknown topic ids and oversized frames of both kinds', () => {
		const { ctrl, sock } = boot();
		sock().open();
		const frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 99, 0, encodeCursor('update', { key: 'a', data: { x: 1, y: 1 } }));
		sock().message(toArrayBuffer(frame)); // no wire-id for 99
		sock().message(new ArrayBuffer(1048577));
		sock().message('x'.repeat(1048577));
		sock().message('{not json');
		expect(ctrl._state.positionMap.size).toBe(0);
	});
});

describe('viewport wire', () => {
	it('sends the rect immediately, then time-gates with a trailing latest-wins send', () => {
		const { ctrl, sock } = boot();
		sock().open();
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 100, h: 100, zoom: 1 } });
		let vp = sentJson(sock()).filter((f) => f && f.type === 'cursor-viewport');
		expect(vp).toHaveLength(1);

		ctrl.handleMessage({ type: 'viewport', rect: { x: 10, y: 0, w: 100, h: 100, zoom: 1 } });
		ctrl.handleMessage({ type: 'viewport', rect: { x: 20, y: 0, w: 100, h: 100, zoom: 1 } });
		vp = sentJson(sock()).filter((f) => f && f.type === 'cursor-viewport');
		expect(vp).toHaveLength(1); // still gated

		vi.advanceTimersByTime(110);
		vp = sentJson(sock()).filter((f) => f && f.type === 'cursor-viewport');
		expect(vp).toHaveLength(2);
		expect(vp[1].rect.x).toBe(20); // latest rect won the trailing edge

		vi.advanceTimersByTime(200);
		ctrl.handleMessage({ type: 'viewport', rect: { x: 20, y: 0, w: 100, h: 100, zoom: 1 } });
		vp = sentJson(sock()).filter((f) => f && f.type === 'cursor-viewport');
		expect(vp).toHaveLength(2); // unchanged rect never re-sends
	});

	it('rejects malformed rects', () => {
		const { ctrl } = boot();
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: -5, h: 10 } });
		ctrl.handleMessage({ type: 'viewport', rect: { x: 'a', y: 0, w: 5, h: 10 } });
		expect(ctrl._rect).toBe(null);
	});
});

describe('roster and feed bridges', () => {
	it('posts roster deltas on catalog/join/remove', () => {
		const { scope, ctrl, sock } = boot();
		void ctrl;
		sock().open();
		sock().message(JSON.stringify({ topic: '__cursor:t', event: 'catalog', data: [{ key: 'a', user: { n: 1 } }] }));
		sock().message(JSON.stringify({ topic: '__cursor:t', event: 'join', data: { key: 'b', user: { n: 2 } } }));
		sock().message(JSON.stringify({ topic: '__cursor:t', event: 'remove', data: { key: 'a' } }));
		const rosters = scope.posted.filter((p) => p.msg.type === 'roster').map((p) => p.msg.users);
		expect(rosters).toHaveLength(3);
		expect(rosters[1]).toEqual([['a', { n: 1 }], ['b', { n: 2 }]]);
		expect(rosters[2]).toEqual([['b', { n: 2 }]]);
	});

	it('samples in-view positions at the feed rate with transferred buffers carrying BOARD coordinates', () => {
		const { scope, ctrl, sock } = boot({ feedRate: 10 });
		openWithBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'viewport', rect: { x: 2, y: 2, w: 100, h: 100, zoom: 2 } });
		vi.advanceTimersByTime(100);
		const feeds = scope.posted.filter((p) => p.msg.type === 'feed');
		expect(feeds.length).toBeGreaterThanOrEqual(1);
		const f = feeds[feeds.length - 1];
		expect(f.msg.keys).toEqual(['a']);
		// Board coordinates, NOT the zoom-transformed view coordinates.
		expect(Array.from(f.msg.positions)).toEqual([5, 6]);
		expect(f.transfer).toContain(f.msg.positions.buffer);
		expect(f.transfer).toContain(f.msg.colors.buffer);
	});

	it('excludes hidden cursors from render AND feed', () => {
		const { scope, ctrl, canvas, sock } = boot({ feedRate: 10 });
		openWithBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [], hidden: ['a'] });
		sleepFrames(2);
		expect(arcs(canvas)).toHaveLength(0);
		vi.advanceTimersByTime(100);
		const feeds = scope.posted.filter((p) => p.msg.type === 'feed');
		expect(feeds[feeds.length - 1].msg.keys).toEqual([]);
	});

	it('applies color overrides from config', () => {
		const { ctrl, canvas, sock } = boot();
		openWithBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [['a', 0x11223344]], hidden: [] });
		sleepFrames(2);
		expect(canvas.ctx.fillStyles).toContain('rgba(17,34,51,' + (0x44 / 255) + ')');
	});
});

describe('connection lifecycle', () => {
	it('reconnects on close with backoff, resending hello + snapshot and resetting wire state', () => {
		const { ctrl, sock } = boot();
		sock().open();
		sock().message(JSON.stringify({ type: 'wire-id', topic: '__cursor:t', id: 4 }));
		expect(ctrl._wireIds.size).toBe(1);

		sock().close();
		expect(sockets).toHaveLength(1); // backoff pending, nothing yet
		vi.advanceTimersByTime(4000); // attempt 0: <= 3000 * 1.25
		expect(sockets).toHaveLength(2);
		expect(ctrl._wireIds.size).toBe(0); // per-connection state reset
		sockets[1].open();
		const frames = sentJson(sockets[1]);
		expect(frames[0].type).toBe('hello');
		expect(frames[1]).toEqual({ type: 'cursor-snapshot', topic: 't' });
	});

	it('recycles a half-dead socket via the zombie check', () => {
		const { sock } = boot();
		sock().open();
		const first = sock();
		vi.advanceTimersByTime(200_000); // no inbound traffic for > 150s
		expect(first.readyState).toBe(3);
		expect(sockets.length).toBeGreaterThan(1); // reconnect already scheduled + fired
	});

	it('pause closes the socket, clears state, blanks the surface, and stops reconnecting', () => {
		const { ctrl, canvas, sock } = boot();
		openWithBoard(ctrl, sock());
		sleepFrames(2);
		expect(arcs(canvas)).toHaveLength(1);
		const before = sockets.length;

		canvas.ctx.ops.length = 0;
		ctrl.handleMessage({ type: 'pause' });
		expect(ctrl._phase).toBe('paused');
		expect(ctrl._state.positionMap.size).toBe(0);
		expect(canvas.ctx.ops.some((o) => o[0] === 'clearRect')).toBe(true);
		expect(arcs(canvas)).toHaveLength(0);
		vi.advanceTimersByTime(60_000);
		expect(sockets).toHaveLength(before); // no reconnect while paused
	});

	it('re-init after pause resumes on the kept canvas - including on a NEW topic, with config cleared', () => {
		const { ctrl, canvas, sock } = boot();
		openWithBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [['a', 0x11223344]], hidden: [] });
		ctrl.handleMessage({ type: 'pause' });

		// No canvas on re-init: the surface was transferred once and is kept.
		ctrl.handleMessage({ type: 'init', topic: 'other', url: 'ws://test/ws', gpu: 'canvas2d', devicePixelRatio: 1 });
		const fresh = sockets[sockets.length - 1];
		fresh.open();
		expect(sentJson(fresh)[1]).toEqual({ type: 'cursor-snapshot', topic: 'other' });

		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 100, h: 100, zoom: 1 } });
		fresh.message(JSON.stringify({ topic: '__cursor:other', event: 'catalog', data: [{ key: 'a', user: {} }] }));
		fresh.message(JSON.stringify({ topic: '__cursor:other', event: 'update', data: { key: 'a', data: { x: 1, y: 1 } } }));
		canvas.ctx.fillStyles.length = 0;
		sleepFrames(2);
		// Old topic's color override must not leak onto the new topic's keys.
		expect(canvas.ctx.fillStyles).not.toContain('rgba(17,34,51,' + (0x44 / 255) + ')');
		expect(arcs(canvas).length).toBeGreaterThan(0);
	});

	it('re-init on a NEW topic clears the old board viewport: nothing renders until the new rect arrives', () => {
		const { ctrl, canvas, sock } = boot();
		openWithBoard(ctrl, sock());
		expect(ctrl._rect).not.toBe(null);
		ctrl.handleMessage({ type: 'pause' });
		ctrl.handleMessage({ type: 'init', topic: 'elsewhere', url: 'ws://test/ws', gpu: 'canvas2d', devicePixelRatio: 1 });
		expect(ctrl._rect).toBe(null);

		const fresh = sockets[sockets.length - 1];
		fresh.open();
		fresh.message(JSON.stringify({ topic: '__cursor:elsewhere', event: 'catalog', data: [{ key: 'a', user: {} }] }));
		fresh.message(JSON.stringify({ topic: '__cursor:elsewhere', event: 'update', data: { key: 'a', data: { x: 1, y: 1 } } }));
		canvas.ctx.ops.length = 0;
		sleepFrames(2);
		expect(arcs(canvas)).toHaveLength(0); // no rect, no paint
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 50, h: 50, zoom: 1 } });
		sleepFrames(2);
		expect(arcs(canvas)).toHaveLength(1);
	});

	it('a device-pixel-ratio change rides the viewport message and rescales the renderer', () => {
		const { ctrl, canvas, sock } = boot();
		openWithBoard(ctrl, sock());
		sleepFrames(2);
		expect(arcs(canvas)[0].slice(1, 3)).toEqual([5, 6]); // dpr 1

		canvas.ctx.ops.length = 0;
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 100, h: 100, zoom: 1 }, dpr: 2 });
		sleepFrames(2);
		expect(canvas.width).toBe(200); // surface rescaled to device pixels
		expect(arcs(canvas)[0].slice(1, 3)).toEqual([10, 12]); // coords now at dpr 2
	});

	it('destroy is terminal: state gone, later messages ignored', () => {
		const { ctrl, sock } = boot();
		sock().open();
		ctrl.handleMessage({ type: 'destroy' });
		expect(ctrl._phase).toBe('destroyed');
		const count = sockets.length;
		ctrl.handleMessage({ type: 'init', topic: 't2', url: 'ws://test/ws' });
		expect(sockets).toHaveLength(count);
	});
});
