// The cursor render worker against a REAL uWS server (createTestServer) and
// the REAL cursor server plugin - no protocol mocks anywhere on the path.
//
// What only this file can prove:
//   - the upgrade echoes the cursor lane subprotocol (node's WebSocket
//     enforces the echo exactly like browsers: a missing echo fails the
//     handshake, so a green open IS the proof);
//   - {type:'cursor-snapshot'} against the real plugin subscribes the socket
//     server-side (no wire subscribe frame exists in worker traffic);
//   - the server's publishWire path delivers BINARY frames to the worker
//     (its hello carries the codec caps) while a caps-less client gets JSON,
//     and the worker's decode arrives at the same positions;
//   - a server with `binary: false` keeps the worker correct on pure JSON.

import { describe, it, expect, afterEach } from 'vitest';
import { attachCursorWorker } from '../plugins/cursor/cursor-worker.js';
import { createCursor } from '../plugins/cursor/server.js';
import { parseBinaryFrame } from '../files/wire.js';
import {
	decodeCursor,
	CursorDecodeDict,
	CURSOR_CAPABILITY,
	CURSOR_CAPABILITY_DICT,
	CURSOR_CAPABILITY_TIME,
	CURSOR_SCHEMA_VERSION_TIME
} from '../plugins/cursor/codec.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../testing.js') : {};

let server;
let controllers;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, timeout = 3000, step = 20) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const v = pred();
		if (v) return v;
		if (Date.now() > deadline) throw new Error('until() timed out');
		await sleep(step);
	}
}

function mockCanvas() {
	const ctx = {
		fillStyle: '',
		globalCompositeOperation: 'source-over',
		clearRect() {}, beginPath() {}, arc() {}, fill() {}, drawImage() {}
	};
	return { width: 0, height: 0, getContext: (t) => (t === '2d' ? ctx : null) };
}

function bootWorker(url, topic = 'board') {
	const scope = { posted: [], postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }, onmessage: null };
	const ctrl = attachCursorWorker(scope);
	controllers.push(ctrl);
	ctrl.handleMessage({ type: 'init', topic, url, canvas: mockCanvas(), gpu: 'canvas2d', devicePixelRatio: 1 });
	return { scope, ctrl };
}

async function moverClient(url, topic = 'board') {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'cursor-snapshot', topic }));
	await sleep(60); // server-side subscribe settles
	return {
		ws,
		move: (x, y) => ws.send(JSON.stringify({ type: 'cursor', topic, data: { x, y } }))
	};
}

function cursorServer(options = {}) {
	const cursors = createCursor({ throttle: 0, topicThrottle: 0, ...options });
	return createTestServer({
		handler: {
			message(ws, ctx) {
				if (cursors.hooks.message(ws, ctx)) return;
			},
			close: cursors.hooks.close
		}
	}).then((s) => ({ server: s, cursors }));
}

describeUWS('cursor render worker against a real server', () => {
	afterEach(async () => {
		for (const ctrl of controllers) ctrl.handleMessage({ type: 'destroy' });
		controllers = [];
		await server?.close();
		server = null;
	});
	controllers = [];

	it('handshakes through the lane subprotocol, snapshots, and ingests moves as BINARY frames', async () => {
		const made = await cursorServer();
		server = made.server;

		const { ctrl } = bootWorker(server.wsUrl);
		const mover = await moverClient(server.wsUrl);
		mover.move(523.5, 128.25);

		await until(() => ctrl._state.positionMap.size === 1);
		const [pos] = [...ctrl._state.positionMap.values()];
		expect(pos.x).toBeCloseTo(523.5, 2);
		expect(pos.y).toBeCloseTo(128.25, 2);
		// The roster arrived alongside (join), satisfying the visibility rule.
		expect(ctrl._state.userMap.size).toBe(1);
		// Binary proof: the worker advertised the codec caps, so the server's
		// publishWire announced a topic id before the first 0x03 frame.
		expect(ctrl._wireIds.size).toBeGreaterThanOrEqual(1);
		expect([...ctrl._wireIds.values()]).toContain('__cursor:board');

		mover.ws.close();
	});

	it('reports its viewport on its own socket and the real tracker records it', async () => {
		const made = await cursorServer();
		server = made.server;

		const { ctrl } = bootWorker(server.wsUrl);
		await until(() => ctrl._ws && ctrl._ws.readyState === 1);
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 800, h: 600, zoom: 1 } });

		await until(() => made.cursors.stats().viewportsReported === 1);
		expect(made.cursors.stats().viewportsReported).toBe(1);
	});

	it('stays correct on a JSON-only server (binary disabled): same positions, zero wire ids', async () => {
		const made = await cursorServer({ binary: false });
		server = made.server;

		const { ctrl } = bootWorker(server.wsUrl);
		const mover = await moverClient(server.wsUrl);
		mover.move(10.5, 20.5);

		await until(() => ctrl._state.positionMap.size === 1);
		const [pos] = [...ctrl._state.positionMap.values()];
		expect(pos.x).toBeCloseTo(10.5, 2);
		expect(ctrl._wireIds.size).toBe(0);

		mover.ws.close();
	});

	it('stamps position frames at schemaVersion 3 for a time-capable subscriber', async () => {
		const made = await cursorServer();
		server = made.server;

		// A raw observer advertising the time capability, inspecting frames at
		// the byte level - the sharpest proof the negotiated wire is the
		// stamped one and the stamp is the server's wall clock.
		const { WebSocket } = await import('ws');
		const obs = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => { obs.on('open', resolve); obs.on('error', reject); });
		const binary = [];
		const jsonEvents = [];
		obs.on('message', (data, isBinary) => {
			if (isBinary) binary.push(new Uint8Array(data));
			else { try { jsonEvents.push(JSON.parse(data.toString())); } catch { /* ignore */ } }
		});
		obs.send(JSON.stringify({ type: 'hello', caps: [CURSOR_CAPABILITY, CURSOR_CAPABILITY_DICT, CURSOR_CAPABILITY_TIME] }));
		obs.send(JSON.stringify({ type: 'cursor-snapshot', topic: 'board' }));
		await sleep(60);

		const before = Date.now();
		const mover = await moverClient(server.wsUrl);
		mover.move(50.5, 60.25);

		await until(() => binary.length >= 1);
		const after = Date.now();

		// The snapshot's clock seed arrived as the JSON time event, first.
		const time = jsonEvents.find((m) => m.topic === '__cursor:board' && m.event === 'time');
		expect(time).toBeTruthy();
		expect(time.data.t).toBeGreaterThanOrEqual(before - 60_000);

		// Every binary position frame decodes at schemaVersion 3 with a stamp
		// inside the observation window.
		const dict = new CursorDecodeDict();
		let stamped = 0;
		for (const bytes of binary) {
			const parsed = parseBinaryFrame(bytes);
			expect(parsed).toBeTruthy();
			expect(parsed.schemaVersion).toBe(CURSOR_SCHEMA_VERSION_TIME);
			const decoded = decodeCursor(parsed.payload, dict, parsed.schemaVersion);
			expect(decoded).toBeTruthy();
			if (decoded.event === 'update' || decoded.event === 'bulk') {
				expect(decoded.t).toBeGreaterThanOrEqual(before - 1000);
				expect(decoded.t).toBeLessThanOrEqual(after + 1000);
				stamped++;
			}
		}
		expect(stamped).toBeGreaterThanOrEqual(1);

		mover.ws.close();
		obs.close();
	});

	it('a smoothing worker builds stamped rings and a clock estimate against the real server', async () => {
		const made = await cursorServer();
		server = made.server;

		const scope = { posted: [], postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }, onmessage: null };
		const ctrl = attachCursorWorker(scope);
		controllers.push(ctrl);
		ctrl.handleMessage({
			type: 'init',
			topic: 'board',
			url: server.wsUrl,
			canvas: mockCanvas(),
			gpu: 'canvas2d',
			devicePixelRatio: 1,
			smooth: { delayMs: 'auto', extrapolateMs: 250, snapGapMs: 500 }
		});
		// The render loop samples (and advances the clock) only once a
		// viewport exists - in production the pump sends one right after init.
		ctrl.handleMessage({ type: 'viewport', rect: { x: 0, y: 0, w: 800, h: 600, zoom: 1 } });

		const mover = await moverClient(server.wsUrl);
		mover.move(5, 6);
		await until(() => ctrl._smoother && ctrl._smoother.size >= 1);
		// The render loop's frames have run estServerNow by now; same-machine
		// offset is near zero but the estimate exists and is sane.
		await until(() => ctrl._smoother.clock.offset() !== null);
		expect(Math.abs(ctrl._smoother.clock.offset())).toBeLessThan(60_000);

		mover.ws.close();
	});

	it('a fresh snapshot after reconnect rebuilds the same state (re-init on the same server)', async () => {
		const made = await cursorServer();
		server = made.server;

		const { ctrl } = bootWorker(server.wsUrl);
		const mover = await moverClient(server.wsUrl);
		mover.move(1, 2);
		await until(() => ctrl._state.positionMap.size === 1);

		// Pause + re-init simulates the unmount/remount cycle; the snapshot
		// handshake (not resume) restores the roster and positions.
		ctrl.handleMessage({ type: 'pause' });
		expect(ctrl._state.positionMap.size).toBe(0);
		ctrl.handleMessage({ type: 'init', topic: 'board', url: server.wsUrl, gpu: 'canvas2d', devicePixelRatio: 1 });

		await until(() => ctrl._state.positionMap.size === 1);
		const [pos] = [...ctrl._state.positionMap.values()];
		expect(pos.x).toBeCloseTo(1, 2);

		mover.ws.close();
	});
});
