// The cursor self-identity surface: the server hands every connection its
// own roster key as a single-target 'you' event (before the first join
// broadcast, and inside every snapshot reply), the client merge treats it as
// pure metadata (never an entry in the cursor Map), and the render worker's
// hideSelf filter keys off the MAIN connection's key delivered via config -
// never off the 'you' its own second socket receives.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCursor } from '../plugins/cursor/server.js';
import { encodeCursor, CursorEncodeDict, CursorTimeEncodeDict } from '../plugins/cursor/codec.js';
import { applyEvent, mergeOutput } from '../plugins/cursor/decode.js';
import { attachCursorWorker } from '../plugins/cursor/cursor-worker.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../client-runtime.js';
import { mockWs, mockPlatform, installFakeRuntimeClock, releaseRuntimeClock } from './_helpers.js';

describe('cursor plugin - self identity (server)', () => {
	beforeEach(() => {
		vi.useRealTimers();
		installFakeRuntimeClock();
	});
	afterEach(() => releaseRuntimeClock());

	function tracker() {
		return createCursor({ throttle: 0, topicThrottle: 0, select: (ud) => ({ id: ud.id }) });
	}

	// Records publishes and sends into ONE ordered log so cross-channel
	// ordering (the single-target 'you' ahead of the join broadcast) is
	// assertable; mockPlatform keeps them in separate arrays.
	function seqPlatform() {
		const log = [];
		return {
			log,
			publish(topic, event, data) { log.push({ kind: 'publish', topic, event, data }); return true; },
			send(ws, topic, event, data) { log.push({ kind: 'send', ws, topic, event, data }); return 1; }
		};
	}

	it("the first move sends the mover its key as 'you' before the join broadcast", () => {
		const c = tracker();
		const p = seqPlatform();
		const ws = mockWs({ id: 'A' });
		c.update(ws, 'board', { x: 1, y: 2 }, p);

		expect(p.log.map((e) => e.event)).toEqual(['you', 'join', 'update']);
		const [you, join] = p.log;
		expect(you.kind).toBe('send'); // single-target, never broadcast
		expect(you.ws).toBe(ws);
		expect(you.topic).toBe('__cursor:board');
		expect(you.data).toEqual({ key: join.data.key }); // the key the join announces
		expect(join.kind).toBe('publish');
	});

	it("subsequent moves on the topic never repeat 'you'", () => {
		const c = tracker();
		const p = seqPlatform();
		const ws = mockWs({ id: 'A' });
		c.update(ws, 'board', { x: 1, y: 1 }, p);
		p.log.length = 0;

		c.update(ws, 'board', { x: 2, y: 2 }, p);
		c.update(ws, 'board', { x: 3, y: 3 }, p);
		expect(p.log.map((e) => e.event)).toEqual(['update', 'update']);
	});

	it("each topic hands out its own 'you' (same connection, same key)", () => {
		const c = tracker();
		const p = seqPlatform();
		const ws = mockWs({ id: 'A' });
		c.update(ws, 'board-a', { x: 1, y: 1 }, p);
		c.update(ws, 'board-b', { x: 2, y: 2 }, p);

		const yous = p.log.filter((e) => e.event === 'you');
		expect(yous.map((e) => e.topic)).toEqual(['__cursor:board-a', '__cursor:board-b']);
		// one connection, one key, regardless of topic
		expect(yous[0].data.key).toBe(yous[1].data.key);
	});

	it("the snapshot reply is [time, you, catalog, bulk] and 'you' carries the requester's broadcast key", async () => {
		const c = tracker();
		const p = mockPlatform();
		const mover = mockWs({ id: 'M' });
		c.update(mover, 'board', { x: 1, y: 1 }, p);
		const moverKey = p.published.find((e) => e.event === 'join').data.key;
		p.reset();

		await c.snapshot(mover, 'board', p);
		expect(p.sent.map((e) => e.event)).toEqual(['time', 'you', 'catalog', 'bulk']);
		expect(p.sent[1].ws).toBe(mover);
		expect(p.sent[1].data).toEqual({ key: moverKey });
	});

	it('snapshot-then-move keeps one identity: the later join broadcasts the snapshot key', async () => {
		const c = tracker();
		const p = mockPlatform();
		const ws = mockWs({ id: 'A' });
		await c.snapshot(ws, 'board', p);
		const snapshotKey = p.sent.find((e) => e.event === 'you').data.key;
		p.reset();

		c.update(ws, 'board', { x: 1, y: 1 }, p);
		expect(p.published.find((e) => e.event === 'join').data.key).toBe(snapshotKey);
		// the first move still leads with 'you' (the snapshot did not consume
		// the join gate), and it names the same key
		expect(p.sent.filter((e) => e.event === 'you').map((e) => e.data.key)).toEqual([snapshotKey]);
	});

	it('snapshotting never announces the viewer: no join broadcast, no roster entry', async () => {
		const c = tracker();
		const p = mockPlatform();
		const mover = mockWs({ id: 'M' });
		c.update(mover, 'board', { x: 1, y: 1 }, p);
		p.reset();

		const viewer = mockWs({ id: 'V' });
		await c.snapshot(viewer, 'board', p);
		expect(p.published).toHaveLength(0); // nothing broadcast to others
		expect(c.list('board')).toHaveLength(1); // roster still holds the mover only
		expect(p.sent.find((e) => e.event === 'catalog').data).toHaveLength(1);
		expect(p.sent.find((e) => e.event === 'you').data.key).not.toBe(
			p.sent.find((e) => e.event === 'catalog').data[0].key
		);
	});

	it('distinct connections receive distinct keys', async () => {
		const c = tracker();
		const p = mockPlatform();
		await c.snapshot(mockWs({ id: 'A' }), 'board', p);
		await c.snapshot(mockWs({ id: 'B' }), 'board', p);
		const keys = p.sent.filter((e) => e.event === 'you').map((e) => e.data.key);
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it("'you' declines the binary codec (JSON fallback) and leaves the dictionary untouched", () => {
		const dict = new CursorEncodeDict();
		expect(encodeCursor('you', { key: '7' }, dict)).toBe(null);
		expect(dict.byKey.size).toBe(0);
		const stamped = new CursorTimeEncodeDict(() => 1234);
		expect(encodeCursor('you', { key: '7' }, stamped)).toBe(null);
		expect(stamped.byKey.size).toBe(0);
		expect(stamped.lastT).toBe(-1);
	});

	it("a sendWire-capable platform still routes 'you' through the codec, which declines it", async () => {
		// emitTo prefers sendWire when the tracker has a codec; the codec's
		// null return is the framework's send-JSON-for-this-frame signal, so a
		// binary-capable connection receives 'you' as a plain JSON envelope.
		const wired = [];
		const p = {
			publish() { return true; },
			send() { return 1; },
			publishWire() { return true; },
			sendWire(ws, topic, event, data, codec) {
				wired.push({ event, encoded: codec.encode(event, data, new CursorEncodeDict()) });
				return 1;
			}
		};
		const c = createCursor({ throttle: 0, topicThrottle: 0 });
		await c.snapshot(mockWs({ id: 'A' }), 'board', p);
		const you = wired.find((e) => e.event === 'you');
		expect(you).toBeTruthy();
		expect(you.encoded).toBe(null);
	});
});

describe('cursor client merge - self identity stays out of the Map', () => {
	it("applyEvent treats 'you' as a no-op: no pollution, no re-emit", () => {
		const state = { positionMap: new Map(), userMap: new Map(), timestamps: new Map() };
		applyEvent(state, { event: 'catalog', data: [{ key: 'a', user: { name: 'Ada' } }] }, 1000);
		applyEvent(state, { event: 'update', data: { key: 'a', data: { x: 1, y: 2 } } }, 1000);

		expect(applyEvent(state, { event: 'you', data: { key: 'a' } }, 1000)).toBe(false);
		expect(applyEvent(state, { event: 'you', data: { key: 'zzz' } }, 1000)).toBe(false);
		expect(state.positionMap.size).toBe(1);
		expect(state.userMap.size).toBe(1);
		expect(state.timestamps.size).toBe(1);

		const merged = mergeOutput(state);
		expect([...merged.keys()]).toEqual(['a']);
		expect(merged.get('a')).toEqual({ user: { name: 'Ada' }, data: { x: 1, y: 2 } });
	});
});

describe('cursor render worker - hideSelf', () => {
	let sockets;
	let realWebSocket;

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

	beforeEach(() => {
		vi.useFakeTimers();
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
			...opts
		});
		return { scope, canvas, ctrl, sock: () => sockets[sockets.length - 1] };
	}

	/** Open the socket and seed a two-user board (keys 'a' and 'b'). */
	function openBoard(ctrl, sock, topic = 't') {
		sock.open();
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 1000, h: 1000, zoom: 1 } });
		const ch = '__cursor:' + topic;
		sock.message(JSON.stringify({ topic: ch, event: 'catalog', data: [{ key: 'a', user: { name: 'Ada' } }, { key: 'b', user: { name: 'Bea' } }] }));
		sock.message(JSON.stringify({ topic: ch, event: 'bulk', data: [{ key: 'a', data: { x: 10, y: 10 } }, { key: 'b', data: { x: 20, y: 20 } }] }));
	}

	const visibleKeys = (ctrl) => ctrl._visible.map((v) => v.key).sort();

	it('a worker configured with the self key excludes it from the rendered set and keeps the others', () => {
		const { ctrl, sock } = boot({ hideSelf: true });
		openBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [], hidden: [], selfKey: 'a' });
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['b']);
		// the merged state keeps the self entry - hideSelf filters pixels,
		// never data
		expect(ctrl._state.positionMap.has('a')).toBe(true);
	});

	it('without hideSelf the same config message leaves the self key rendered', () => {
		const { ctrl, sock } = boot();
		openBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [], hidden: [], selfKey: 'a' });
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['a', 'b']);
	});

	it('renders everything until the filter key arrives, then drops the self key', () => {
		const { ctrl, sock } = boot({ hideSelf: true });
		openBoard(ctrl, sock());
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['a', 'b']); // key unknown: nothing filtered
		ctrl.handleMessage({ type: 'config', colors: [], hidden: [], selfKey: 'b' });
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['a']);
	});

	it("never adopts a 'you' event from its own socket as the filter key", () => {
		const { ctrl, sock } = boot({ hideSelf: true });
		openBoard(ctrl, sock());
		// The worker socket's own snapshot reply names the WORKER connection's
		// key, not the user's; it must not engage the filter.
		sock().message(JSON.stringify({ topic: '__cursor:t', event: 'you', data: { key: 'b' } }));
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['a', 'b']);
	});

	it('the feed excludes the self key like the canvas does', () => {
		const { scope, ctrl, sock } = boot({ hideSelf: true, feedRate: 10 });
		openBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [], hidden: [], selfKey: 'a' });
		vi.advanceTimersByTime(200);
		const feeds = scope.posted.filter((m) => m.msg.type === 'feed');
		expect(feeds.length).toBeGreaterThan(0);
		expect(feeds[feeds.length - 1].msg.keys).toEqual(['b']);
	});

	it('a topic switch clears the stale filter key until the main thread re-pushes one', () => {
		const { ctrl, sock } = boot({ hideSelf: true });
		openBoard(ctrl, sock());
		ctrl.handleMessage({ type: 'config', colors: [], hidden: [], selfKey: 'a' });
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['b']);

		// Re-init on a new board: keys are per-topic, so the old filter key
		// must not hide an unrelated user who happens to reuse it.
		ctrl.handleMessage({ type: 'init', topic: 'u', url: 'ws://test/ws', gpu: 'canvas2d', devicePixelRatio: 1, hideSelf: true });
		openBoard(ctrl, sock(), 'u');
		sleepFrames(1);
		expect(visibleKeys(ctrl)).toEqual(['a', 'b']);
	});
});
