// Coverage for binary ingress (client->server 0x03): the generic server-side
// registry + binding + route seam (src/runtime/handler/ingress.js) and the
// smooth command payload codec that is its first consumer. The load-bearing
// property is the route-target invariant: a decoded ingress batch equals the
// Array<{id,cmd}> the JSON volatile-RPC path would have delivered.

import { describe, it, expect, afterEach } from 'vitest';
import {
	registerIngress,
	getIngress,
	_resetIngressRegistry,
	bindIngress,
	dispatchIngressFrame,
	ingressOkFrame,
	ingressBoundFrame,
	WIRE_INGRESS_CAP
} from '../src/runtime/handler/ingress.js';
import { buildBinaryFrame, parseBinaryFrame } from '../src/runtime/wire.js';
import {
	encodeSmoothCommandBatch,
	decodeSmoothCommandBatch,
	SMOOTH_COMMAND_CAPABILITY,
	SMOOTH_COMMAND_SCHEMA_VERSION
} from '../src/plugins/smooth/codec.js';
import { WS_INGRESS_BINDINGS } from '../src/runtime/utils.js';
import { mockWs } from './_helpers.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../src/testing.js') : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeout = 1500) {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeout) throw new Error('waitUntil timed out');
		await sleep(10);
	}
}

async function connectClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw, isBinary) => {
		const frame = isBinary
			? { binary: true, parsed: null }
			: { binary: false, parsed: (() => { try { return JSON.parse(raw.toString()); } catch { return null; } })() };
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
		}
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	return {
		ws,
		frames,
		send: (obj) => ws.send(JSON.stringify(obj)),
		sendBinary: (bytes) => ws.send(bytes),
		waitFor(pred, timeout = 1500) {
			const existing = frames.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeout);
				waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
			});
		}
	};
}

afterEach(() => {
	_resetIngressRegistry();
});

describe('ingress constants + control frames', () => {
	it('pins the capability token', () => {
		expect(WIRE_INGRESS_CAP).toBe('wire.ingress:1');
	});
	it('builds the ack frames', () => {
		expect(ingressOkFrame()).toBe('{"type":"ingress-ok"}');
		expect(ingressBoundFrame(7)).toBe('{"type":"ingress-bound","id":7}');
		expect(JSON.parse(ingressBoundFrame(42))).toEqual({ type: 'ingress-bound', id: 42 });
	});
});

describe('ingress kind registry', () => {
	it('registers and resolves a handler by kind', () => {
		const handler = { decode: () => 1, route: () => {} };
		registerIngress('k:1', handler);
		expect(getIngress('k:1')).toBe(handler);
	});
	it('ignores an incomplete handler', () => {
		registerIngress('bad:1', { decode: () => 1 }); // no route
		expect(getIngress('bad:1')).toBe(null);
	});
	it('last registration for a kind wins', () => {
		const a = { decode: () => 'a', route: () => {} };
		const b = { decode: () => 'b', route: () => {} };
		registerIngress('k:1', a);
		registerIngress('k:1', b);
		expect(getIngress('k:1')).toBe(b);
	});
	it('resolves null for an unknown kind', () => {
		expect(getIngress('nope:1')).toBe(null);
	});
});

describe('bindIngress', () => {
	it('stores a binding for a known kind and returns true', () => {
		registerIngress('k:1', { decode: (p) => p, route: () => {} });
		const ud = {};
		const ws = mockWs(ud);
		expect(bindIngress(ud, ws, 5, 'k:1', { any: 'target' })).toBe(true);
		const map = ud[WS_INGRESS_BINDINGS];
		expect(map.has(5)).toBe(true);
		expect(map.get(5).target).toEqual({ any: 'target' });
	});
	it('refuses an unknown kind (no binding, no ack) so the client keeps JSON', () => {
		const ud = {};
		expect(bindIngress(ud, mockWs(ud), 5, 'unknown:1', {})).toBe(false);
		expect(ud[WS_INGRESS_BINDINGS]).toBeUndefined();
	});
	it('runs an optional per-binding state factory', () => {
		let attached = 0;
		registerIngress('stateful:1', {
			decode: () => 1,
			route: () => {},
			state: { onAttach: () => { attached++; return { dict: true }; } }
		});
		const ud = {};
		bindIngress(ud, mockWs(ud), 1, 'stateful:1', {});
		expect(attached).toBe(1);
		expect(ud[WS_INGRESS_BINDINGS].get(1).state).toEqual({ dict: true });
	});
});

describe('dispatchIngressFrame', () => {
	it('decodes and routes a 0x03 frame to the bound destination', () => {
		const routed = [];
		registerIngress('echo:1', {
			decode: (payload, schemaVersion) => ({ schemaVersion, text: new TextDecoder().decode(payload) }),
			route: (ws, target, value, platform, seq) => routed.push({ target, value, platform, seq })
		});
		const ud = { platformMarker: 1 };
		const ws = mockWs(ud);
		bindIngress(ud, ws, 9, 'echo:1', { room: 'r1' });

		const payload = new TextEncoder().encode('hello');
		const frame = buildBinaryFrame(3 /* schemaVersion */, 9 /* ingress id */, 1 /* seq */, payload);
		dispatchIngressFrame(ws, ud, frame, { p: 'platform' });

		expect(routed).toHaveLength(1);
		expect(routed[0].target).toEqual({ room: 'r1' });
		expect(routed[0].value).toEqual({ schemaVersion: 3, text: 'hello' });
		expect(routed[0].seq).toBe(1);
		expect(routed[0].platform).toEqual({ p: 'platform' });
	});

	it('drops a frame for an unbound id without routing', () => {
		const routed = [];
		registerIngress('echo:1', { decode: (p) => p, route: () => routed.push(1) });
		const ud = {};
		const ws = mockWs(ud);
		bindIngress(ud, ws, 9, 'echo:1', {});
		// id 4 was never bound.
		dispatchIngressFrame(ws, ud, buildBinaryFrame(1, 4, 1, new Uint8Array([1])), null);
		expect(routed).toHaveLength(0);
	});

	it('drops a frame whose decode declines (returns null)', () => {
		const routed = [];
		registerIngress('decline:1', { decode: () => null, route: () => routed.push(1) });
		const ud = {};
		const ws = mockWs(ud);
		bindIngress(ud, ws, 1, 'decline:1', {});
		dispatchIngressFrame(ws, ud, buildBinaryFrame(1, 1, 1, new Uint8Array([1])), null);
		expect(routed).toHaveLength(0);
	});

	it('swallows a throwing route (one bad frame never crashes the demux)', () => {
		registerIngress('boom:1', { decode: (p) => p, route: () => { throw new Error('boom'); } });
		const ud = {};
		const ws = mockWs(ud);
		bindIngress(ud, ws, 1, 'boom:1', {});
		expect(() => dispatchIngressFrame(ws, ud, buildBinaryFrame(1, 1, 1, new Uint8Array([1])), null)).not.toThrow();
	});

	it('is a no-op when the connection has no bindings', () => {
		const ud = {};
		expect(() => dispatchIngressFrame(mockWs(ud), ud, buildBinaryFrame(1, 1, 1, new Uint8Array([1])), null)).not.toThrow();
	});
});

describe('smooth command payload codec', () => {
	it('pins the ingress kind + schema', () => {
		expect(SMOOTH_COMMAND_CAPABILITY).toBe('smooth.command:1');
		expect(SMOOTH_COMMAND_SCHEMA_VERSION).toBe(1);
	});

	it('round-trips a single-command batch', () => {
		const batch = [{ id: 1, cmd: { dx: 1, dy: -1 } }];
		const decoded = decodeSmoothCommandBatch(encodeSmoothCommandBatch(batch), SMOOTH_COMMAND_SCHEMA_VERSION);
		expect(decoded).toEqual(batch);
	});

	it('round-trips a multi-command batch with delta-coded ids', () => {
		const batch = [
			{ id: 100, cmd: [1, 2, 3] },
			{ id: 101, cmd: [4, 5, 6] },
			{ id: 105, cmd: 'jump' }
		];
		const decoded = decodeSmoothCommandBatch(encodeSmoothCommandBatch(batch));
		expect(decoded).toEqual(batch);
	});

	it('equals the JSON path exactly (the route-target invariant)', () => {
		// The batch the JSON volatile-RPC path delivers is JSON.parse(JSON.stringify(batch)).
		const batch = [{ id: 7, cmd: { keys: 0b1010, aim: [12.5, -3.25], jump: true, note: 'grüße' } }];
		const viaJson = JSON.parse(JSON.stringify(batch));
		const viaIngress = decodeSmoothCommandBatch(encodeSmoothCommandBatch(batch));
		expect(viaIngress).toEqual(viaJson);
	});

	it('encodes an empty batch and decodes back to []', () => {
		expect(decodeSmoothCommandBatch(encodeSmoothCommandBatch([]))).toEqual([]);
	});

	it('drops invalid / non-monotonic entries during encode', () => {
		const batch = [
			{ id: 5, cmd: 'a' },
			{ id: 3, cmd: 'b' }, // out of order -> dropped
			null,                // invalid -> dropped
			{ id: 6, cmd: 'c' }
		];
		const decoded = decodeSmoothCommandBatch(encodeSmoothCommandBatch(batch));
		expect(decoded).toEqual([{ id: 5, cmd: 'a' }, { id: 6, cmd: 'c' }]);
	});

	it('rejects an unknown schema version', () => {
		expect(decodeSmoothCommandBatch(encodeSmoothCommandBatch([{ id: 1, cmd: 1 }]), 99)).toBe(null);
	});

	it('drops a truncated payload (returns null, never throws)', () => {
		const full = encodeSmoothCommandBatch([{ id: 1, cmd: [1, 2, 3, 4] }]);
		expect(decodeSmoothCommandBatch(full.subarray(0, 2))).toBe(null);
	});

	it('produces a 0x03-framable payload the frame header round-trips', () => {
		const batch = [{ id: 1, cmd: { x: 1 } }];
		const payload = encodeSmoothCommandBatch(batch);
		const frame = buildBinaryFrame(SMOOTH_COMMAND_SCHEMA_VERSION, 3, 0, payload);
		const parsed = parseBinaryFrame(frame);
		expect(parsed.schemaVersion).toBe(SMOOTH_COMMAND_SCHEMA_VERSION);
		expect(parsed.topicId).toBe(3);
		expect(decodeSmoothCommandBatch(parsed.payload, parsed.schemaVersion)).toEqual(batch);
	});
});

describe('end-to-end: smooth command through the ingress seam', () => {
	it('decodes a 0x03 command frame and routes the exact batch', () => {
		const enqueued = [];
		// The smooth ingress handler: decode the command batch, route it as the
		// volatile RPC the JSON path would run (here captured instead of executed).
		registerIngress(SMOOTH_COMMAND_CAPABILITY, {
			decode: (payload, schemaVersion) => decodeSmoothCommandBatch(payload, schemaVersion),
			route: (ws, target, batch) => enqueued.push({ target, batch })
		});
		const ud = {};
		const ws = mockWs(ud);
		// Client would announce this bind; here we bind directly.
		bindIngress(ud, ws, 1, SMOOTH_COMMAND_CAPABILITY, { path: 'game/player/__smooth/command', room: ['lobby'] });

		const batch = [{ id: 41, cmd: { mv: 1 } }, { id: 42, cmd: { mv: 0, fire: true } }];
		const frame = buildBinaryFrame(SMOOTH_COMMAND_SCHEMA_VERSION, 1, 3, encodeSmoothCommandBatch(batch));
		dispatchIngressFrame(ws, ud, frame, { platform: true });

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].target).toEqual({ path: 'game/player/__smooth/command', room: ['lobby'] });
		expect(enqueued[0].batch).toEqual(batch);
	});
});

describeUWS('binary ingress over the wire', () => {
	let server;
	const routed = [];

	afterEach(async () => {
		routed.length = 0;
		await server?.close();
		server = null;
	});

	it('negotiates ingress and routes a 0x03 command frame to the registered kind', async () => {
		registerIngress(SMOOTH_COMMAND_CAPABILITY, {
			decode: (payload, schemaVersion) => decodeSmoothCommandBatch(payload, schemaVersion),
			route: (ws, target, batch, platform, seq) => routed.push({ target, batch, seq })
		});
		server = await createTestServer({ handler: { message() {} } });

		const a = await connectClient(server.wsUrl, ['wire.ingress:1']);
		// The server confirms it speaks ingress...
		await a.waitFor((f) => f.parsed?.type === 'ingress-ok');
		// ...the client announces a binding...
		a.send({ type: 'ingress-bind', id: 1, kind: SMOOTH_COMMAND_CAPABILITY, target: { path: 'p', room: ['r'] } });
		await a.waitFor((f) => f.parsed?.type === 'ingress-bound' && f.parsed.id === 1);
		// ...then sends a 0x03 command frame on that id.
		const batch = [{ id: 10, cmd: { mv: 1 } }, { id: 11, cmd: { fire: true } }];
		a.sendBinary(buildBinaryFrame(SMOOTH_COMMAND_SCHEMA_VERSION, 1, 4, encodeSmoothCommandBatch(batch)));

		await waitUntil(() => routed.length > 0);
		expect(routed).toHaveLength(1);
		expect(routed[0].target).toEqual({ path: 'p', room: ['r'] });
		expect(routed[0].batch).toEqual(batch);
		expect(routed[0].seq).toBe(4);
	});

	it('does not send ingress-ok to a client that never advertised the cap', async () => {
		server = await createTestServer({ handler: { message() {} } });
		const a = await connectClient(server.wsUrl, ['batch']); // no wire.ingress:1
		await sleep(150);
		expect(a.frames.some((f) => f.parsed?.type === 'ingress-ok')).toBe(false);
	});

	it('does not ack (ingress-bound) an unregistered kind, so the client keeps JSON', async () => {
		server = await createTestServer({ handler: { message() {} } });
		const a = await connectClient(server.wsUrl, ['wire.ingress:1']);
		await a.waitFor((f) => f.parsed?.type === 'ingress-ok');
		a.send({ type: 'ingress-bind', id: 1, kind: 'never.registered:1', target: {} });
		await sleep(150);
		expect(a.frames.some((f) => f.parsed?.type === 'ingress-bound')).toBe(false);
	});
});
