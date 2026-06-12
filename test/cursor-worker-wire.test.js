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
