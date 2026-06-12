// Client-side tests for cursor(topic, { canvas }): the handle surface, the
// per-canvas worker host (spawn-once, transfer-once, pause-on-unmount), the
// init gating on the main connection's first 'open', the viewport pump, the
// feed/roster bridges, display-config resolution, and the main-thread
// fallback that renders through the same renderer backends.
//
// Browser globals are patched before the module import, mirroring
// cursor-viewport-client.test.js. Each vitest vmForks file owns its globals.

import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';

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
	emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

class MockWorker {
	static instances = [];
	constructor(url, opts) {
		this.url = String(url);
		this.opts = opts;
		this.posted = [];
		this.terminated = false;
		this.onmessage = null;
		MockWorker.instances.push(this);
	}
	postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }
	terminate() { this.terminated = true; }
	emit(msg) { this.onmessage?.({ data: msg }); }
}

class MockOffscreen {}

globalThis.WebSocket = /** @type {any} */ (MockWebSocket);
globalThis.Worker = /** @type {any} */ (MockWorker);
globalThis.OffscreenCanvas = /** @type {any} */ (MockOffscreen);
globalThis.window = /** @type {any} */ ({ location: { protocol: 'http:', host: 'localhost:5173' }, devicePixelRatio: 2 });
globalThis.requestAnimationFrame = /** @type {any} */ ((cb) => setTimeout(cb, 0));

const clientModule = await import('../client.js');
const cursorClient = await import('../plugins/cursor/client.js');

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function mock2dCtx() {
	return {
		ops: [],
		fillStyles: [],
		set fillStyle(v) { this.fillStyles.push(v); },
		get fillStyle() { return this.fillStyles[this.fillStyles.length - 1]; },
		globalCompositeOperation: 'source-over',
		clearRect() {}, beginPath() {}, fill() {}, drawImage() {},
		arc(...a) { this.ops.push(['arc', ...a]); }
	};
}

function makeCanvas() {
	const ctx = mock2dCtx();
	return {
		clientWidth: 300,
		clientHeight: 150,
		scrollLeft: 0,
		scrollTop: 0,
		width: 0,
		height: 0,
		ctx,
		_transfers: 0,
		transferControlToOffscreen() {
			if (this._transfers++ > 0) throw new Error('InvalidStateError: surface already transferred');
			return new MockOffscreen();
		},
		getContext(t) { return t === '2d' ? ctx : null; }
	};
}

let topicCounter = 0;
const freshTopic = () => 'board-' + topicCounter++;

beforeEach(async () => {
	try { clientModule.connect().close(); } catch { /* no singleton yet */ }
	MockWorker.instances.length = 0;
	MockWebSocket._last = null;
	await flush(2);
});

const initsOf = (w) => w.posted.filter((p) => p.msg.type === 'init');
const ofType = (w, type) => w.posted.filter((p) => p.msg.type === type);

describe('handle shape and caching', () => {
	it('returns a handle for a canvas call, a store otherwise, and caches by topic+canvas', () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas });
		expect(typeof handle.mount).toBe('function');
		expect(typeof handle.viewport).toBe('function');
		expect(typeof handle.configure).toBe('function');
		expect(typeof handle.destroy).toBe('function');
		expect(handle.feed).toBeUndefined();
		expect(handle.store).toBeUndefined();
		expect(cursorClient.cursor(topic, { canvas })).toBe(handle);
		const plain = cursorClient.cursor(topic);
		expect(typeof plain.subscribe).toBe('function');
		expect(plain.mount).toBeUndefined();
	});

	it('rejects unknown gpu and rendering values at call time', () => {
		expect(() => cursorClient.cursor(freshTopic(), { canvas: makeCanvas(), gpu: 'cuda' })).toThrow(/unknown gpu mode/);
		expect(() => cursorClient.cursor(freshTopic(), { canvas: makeCanvas(), rendering: 'gpu' })).toThrow(/unknown rendering mode/);
	});

	it('rejects a non-boolean hideSelf at call time', () => {
		expect(() => cursorClient.cursor(freshTopic(), { canvas: makeCanvas(), hideSelf: 'yes' })).toThrow(/hideSelf must be a boolean/);
	});
});

describe('self identity', () => {
	it("captures the main connection's 'you' into the plain store's self readable", async () => {
		const topic = freshTopic();
		const store = cursorClient.cursor(topic);
		const seen = [];
		const unsub = store.self.subscribe((v) => seen.push(v));
		expect(seen).toEqual([null]); // null until the server assigns a key
		await flush();

		MockWebSocket._last.emit({ topic: '__cursor:' + topic, event: 'you', data: { key: 'k9' } });
		expect(seen[seen.length - 1]).toBe('k9');
		unsub();
	});

	it('passes hideSelf through init and ships the self key to the worker when it lands', async () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas, hideSelf: true });
		expect(handle.self).toBe(null);
		const teardown = handle.mount();
		await flush();

		const worker = MockWorker.instances[0];
		expect(initsOf(worker)[0].msg.hideSelf).toBe(true);
		// The post-init config push runs before the key is known.
		const before = ofType(worker, 'config');
		expect(before[before.length - 1].msg.selfKey).toBe(null);

		MockWebSocket._last.emit({ topic: '__cursor:' + topic, event: 'you', data: { key: 'k7' } });
		await flush();
		expect(handle.self).toBe('k7');
		const after = ofType(worker, 'config');
		expect(after.length).toBeGreaterThan(before.length);
		expect(after[after.length - 1].msg.selfKey).toBe('k7');
		teardown();
	});
});

describe('worker mount', () => {
	it('spawns one module worker after the main connection opens, transfers the canvas once, and pumps the viewport', async () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas });
		const teardown = handle.mount();
		await flush();

		expect(MockWorker.instances).toHaveLength(1);
		const worker = MockWorker.instances[0];
		expect(worker.url).toContain('cursor-worker.js');
		expect(worker.opts).toEqual({ type: 'module' });

		const inits = initsOf(worker);
		expect(inits).toHaveLength(1);
		const init = inits[0].msg;
		expect(init.topic).toBe(topic);
		expect(init.url).toBe('ws://localhost:5173/ws');
		expect(init.devicePixelRatio).toBe(2);
		expect(init.canvas).toBeInstanceOf(MockOffscreen);
		expect(inits[0].transfer).toContain(init.canvas);
		expect(canvas._transfers).toBe(1);

		// The element itself is the default viewport source.
		const vps = ofType(worker, 'viewport');
		expect(vps.length).toBeGreaterThanOrEqual(1);
		expect(vps[0].msg.rect).toEqual({ x: 0, y: 0, w: 300, h: 150, zoom: 1 });

		teardown();
	});

	it('shares the pipeline across mounts; the last teardown pauses; a remount re-inits without re-transferring', async () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas });
		const t1 = handle.mount();
		await flush();
		const worker = MockWorker.instances[0];
		const t2 = handle.mount();
		await flush();
		expect(MockWorker.instances).toHaveLength(1);
		expect(initsOf(worker)).toHaveLength(1);

		t1();
		expect(ofType(worker, 'pause')).toHaveLength(0); // still one mount alive
		t2();
		expect(ofType(worker, 'pause')).toHaveLength(1);

		const t3 = handle.mount();
		await flush();
		expect(MockWorker.instances).toHaveLength(1); // same worker
		const inits = initsOf(worker);
		expect(inits).toHaveLength(2);
		expect(inits[1].msg.canvas).toBeUndefined(); // transfer happened once
		expect(canvas._transfers).toBe(1);
		t3();
	});

	it('throws on rendering "worker" when the worker pipeline is unavailable', () => {
		const saved = globalThis.Worker;
		delete globalThis.Worker;
		try {
			const handle = cursorClient.cursor(freshTopic(), { canvas: makeCanvas(), rendering: 'worker' });
			expect(() => handle.mount()).toThrow(/requires Worker/);
		} finally {
			globalThis.Worker = saved;
		}
	});

	it('one canvas renders one topic at a time', async () => {
		const canvas = makeCanvas();
		const a = cursorClient.cursor(freshTopic(), { canvas });
		const ta = a.mount();
		await flush();
		const b = cursorClient.cursor(freshTopic(), { canvas });
		expect(() => b.mount()).toThrow(/one canvas renders one topic/);
		ta();
	});

	it('a teardown invoked twice decrements exactly once - a sibling mount keeps its pipeline', async () => {
		const canvas = makeCanvas();
		const handle = cursorClient.cursor(freshTopic(), { canvas });
		const t1 = handle.mount();
		await flush();
		const worker = MockWorker.instances[0];
		const t2 = handle.mount();
		t1();
		t1(); // defensive double-call must not steal t2's mount
		expect(ofType(worker, 'pause')).toHaveLength(0);
		t2();
		expect(ofType(worker, 'pause')).toHaveLength(1);
	});

	it('mount after destroy throws the terminal-handle error', async () => {
		const canvas = makeCanvas();
		const handle = cursorClient.cursor(freshTopic(), { canvas });
		const teardown = handle.mount();
		await flush();
		void teardown;
		handle.destroy();
		expect(() => handle.mount()).toThrow(/destroyed/);
	});

	it('destroy terminates the worker and a later mount on the transferred canvas fails with the real constraint', async () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas });
		const teardown = handle.mount();
		await flush();
		const worker = MockWorker.instances[0];
		void teardown;
		handle.destroy();
		expect(worker.terminated).toBe(true);
		expect(ofType(worker, 'destroy')).toHaveLength(1);

		const again = cursorClient.cursor(topic, { canvas });
		expect(again).not.toBe(handle);
		expect(() => { again.mount(); }).toThrow(/transferred/);
	});
});

describe('feed, roster, and display config', () => {
	it('reconstructs the feed Map from transferred buffers, joined with the cached roster', async () => {
		const canvas = makeCanvas();
		const handle = cursorClient.cursor(freshTopic(), { canvas, mainThreadFeed: { rate: 20 } });
		expect(handle.feed).toBeDefined();
		const teardown = handle.mount();
		await flush();
		const worker = MockWorker.instances[0];

		worker.emit({ type: 'roster', users: [['k1', { name: 'Ada' }]] });
		worker.emit({
			type: 'feed',
			keys: ['k1'],
			positions: new Float32Array([12.5, 34.5]),
			colors: new Uint32Array([0xdeadbeef])
		});
		const map = get(handle.feed);
		expect(map.size).toBe(1);
		expect(map.get('k1')).toEqual({ user: { name: 'Ada' }, data: { x: 12.5, y: 34.5 }, colorRGBA: 0xdeadbeef });
		teardown();
	});

	it('resolves configure() against the roster on the main thread and ships packed results; callbacks are contained', async () => {
		const canvas = makeCanvas();
		const handle = cursorClient.cursor(freshTopic(), { canvas });
		const teardown = handle.mount();
		await flush();
		const worker = MockWorker.instances[0];

		handle.configure({
			colorOf: (user) => {
				if (user.boom) throw new Error('app bug');
				return user.color;
			},
			hide: (user) => user.self === true
		});
		worker.emit({
			type: 'roster',
			users: [
				['a', { color: '#ff0000' }],
				['b', { color: 0x11223344 }],
				['c', { boom: true }],
				['d', { color: '#0f0', self: true }]
			]
		});
		// Two pushes: configure() resolves immediately against the (empty)
		// roster to clear stale state, then again when the roster lands.
		const configs = ofType(worker, 'config');
		expect(configs).toHaveLength(2);
		const cfg = configs[configs.length - 1].msg;
		expect(cfg.colors).toContainEqual(['a', 0xff0000ff]);
		expect(cfg.colors).toContainEqual(['b', 0x11223344]);
		expect(cfg.colors).toContainEqual(['d', 0x00ff00ff]);
		expect(cfg.colors.some(([k]) => k === 'c')).toBe(false); // contained throw
		expect(cfg.hidden).toEqual(['d']);
		teardown();
	});
});

describe('main-thread fallback', () => {
	it('rendering "main" never spawns a worker, exposes the classic store, and paints via the shared renderers', async () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas, rendering: 'main' });
		expect(handle.store).toBeDefined();
		const teardown = handle.mount();
		await flush();
		expect(MockWorker.instances).toHaveLength(0);

		// Drive the classic store through the MAIN connection's socket.
		const mock = MockWebSocket._last;
		mock.emit({ topic: '__cursor:' + topic, event: 'catalog', data: [{ key: 'u1', user: { name: 'Ada' } }] });
		mock.emit({ topic: '__cursor:' + topic, event: 'update', data: { key: 'u1', data: { x: 40, y: 50 } } });
		await flush(30);

		const arcs = canvas.ctx.ops.filter((o) => o[0] === 'arc');
		expect(arcs.length).toBeGreaterThanOrEqual(1);
		// dpr 2: view coords scale into device pixels inside the renderer.
		expect(arcs[arcs.length - 1].slice(1, 3)).toEqual([80, 100]);
		expect(get(handle.store).get('u1')).toEqual({ user: { name: 'Ada' }, data: { x: 40, y: 50 } });
		teardown();
	});

	it('hideSelf excludes the local cursor from the fallback paint but not from the store', async () => {
		const canvas = makeCanvas();
		const topic = freshTopic();
		const handle = cursorClient.cursor(topic, { canvas, rendering: 'main', hideSelf: true });
		const teardown = handle.mount();
		await flush();

		const mock = MockWebSocket._last;
		mock.emit({ topic: '__cursor:' + topic, event: 'you', data: { key: 'me' } });
		mock.emit({ topic: '__cursor:' + topic, event: 'catalog', data: [{ key: 'me', user: {} }, { key: 'other', user: {} }] });
		mock.emit({ topic: '__cursor:' + topic, event: 'bulk', data: [{ key: 'me', data: { x: 10, y: 10 } }, { key: 'other', data: { x: 40, y: 50 } }] });
		await flush(30);

		const arcs = canvas.ctx.ops.filter((o) => o[0] === 'arc');
		expect(arcs.length).toBeGreaterThanOrEqual(1);
		// Only the remote cursor painted (dpr 2 scales view coords); the local
		// cursor at (10,10) -> (20,20) never reached the renderer.
		expect(arcs.every((a) => a[1] === 80 && a[2] === 100)).toBe(true);
		// The data surface stays complete - hideSelf filters pixels, not data.
		expect(get(handle.store).has('me')).toBe(true);
		expect(handle.self).toBe('me');
		teardown();
	});

	it('falls back transparently under rendering "auto" when the worker pipeline is missing', async () => {
		const savedWorker = globalThis.Worker;
		const savedOff = globalThis.OffscreenCanvas;
		delete globalThis.Worker;
		delete globalThis.OffscreenCanvas;
		try {
			const canvas = makeCanvas();
			const topic = freshTopic();
			const handle = cursorClient.cursor(topic, { canvas });
			const teardown = handle.mount();
			await flush();
			expect(MockWorker.instances).toHaveLength(0);

			const mock = MockWebSocket._last;
			mock.emit({ topic: '__cursor:' + topic, event: 'catalog', data: [{ key: 'u1', user: {} }] });
			mock.emit({ topic: '__cursor:' + topic, event: 'update', data: { key: 'u1', data: { x: 10, y: 10 } } });
			await flush(30);
			expect(canvas.ctx.ops.some((o) => o[0] === 'arc')).toBe(true);
			teardown();
		} finally {
			globalThis.Worker = savedWorker;
			globalThis.OffscreenCanvas = savedOff;
		}
	});
});
