// Sender exclusion on publishWire against a REAL uWS server (createTestServer,
// which runs the testing.js platform mirror of src/runtime/handler.js): a publish
// carrying { excludeWs } must never deliver that frame to that socket, on the
// binary path, on the per-connection JSON fallback, and on the declined-frame
// fallback - while every other subscriber still receives the frame and the
// relay observer still sees the publish exactly once (exclusion is local; a
// relayed publish crosses instances where the excluded socket does not exist).
//
// Sockets join the topic server-side via trackedSubscribe (native membership
// plus the subscription registry the per-subscriber walk delivers by), exactly
// like a plugin's snapshot handshake does.

import { describe, it, expect, afterEach } from 'vitest';
import { createSmoothWireCodec, SMOOTH_TOPIC_PREFIX, SMOOTH_CAPABILITY } from '../src/plugins/smooth/server.js';
import { SmoothDecodeDict, decodeSmooth } from '../src/plugins/smooth/codec.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { trackedSubscribe } from '../src/runtime/utils.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../src/testing.js') : {};

const TOPIC = SMOOTH_TOPIC_PREFIX + 'test';

let server;
let clients;

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

/**
 * A server whose message hook subscribes a socket to a topic on a
 * {type:'sub-smooth'} frame and records the server-side socket under the
 * frame's `who` tag, so tests can target it with excludeWs. `relayLog`
 * captures each originating publish at the relay seam.
 */
function noechoServer(relayLog) {
	const sockets = new Map();
	return createTestServer({
		__onPublish: (entry) => relayLog.push(entry),
		handler: {
			message(ws, ctx) {
				const msg = ctx.msg;
				if (msg && msg.type === 'sub-smooth' && typeof msg.topic === 'string') {
					trackedSubscribe(ws, msg.topic);
					if (typeof msg.who === 'string') sockets.set(msg.who, ws);
				}
			}
		}
	}).then((s) => ({ server: s, sockets }));
}

/**
 * A raw ws client that records every inbound frame, optionally advertises
 * capabilities, and joins TOPIC server-side under `who`.
 */
async function connectClient(url, who, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = { json: [], binary: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) frames.binary.push(new Uint8Array(data));
		else { try { frames.json.push(JSON.parse(data.toString())); } catch { /* ignore */ } }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	ws.send(JSON.stringify({ type: 'sub-smooth', topic: TOPIC, who }));
	await sleep(60); // server-side subscribe settles
	clients.push(ws);
	return {
		ws,
		frames,
		updates: () => frames.json.filter((m) => m.topic === TOPIC),
		counts: () => ({ json: frames.json.length, binary: frames.binary.length })
	};
}

describeUWS('publishWire sender exclusion against a real server', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	it('excludes a binary-capable socket: the JSON peer receives, the excluded socket gets nothing, and the relay fires once per publish', async () => {
		const relayLog = [];
		const made = await noechoServer(relayLog);
		server = made.server;
		const codec = createSmoothWireCodec();

		const a = await connectClient(server.wsUrl, 'A', [SMOOTH_CAPABILITY]);
		const b = await connectClient(server.wsUrl, 'B');
		const wsA = made.sockets.get('A');
		expect(wsA).toBeTruthy();

		const aBefore = a.counts();
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 1.5, y: 2.5 } }, codec, { excludeWs: wsA });

		await until(() => b.updates().length >= 1);
		expect(b.updates()[0].event).toBe('update');
		expect(b.updates()[0].data).toEqual({ key: 'p1', data: { x: 1.5, y: 2.5 } });
		// Not a binary frame, not a JSON fallback, not even a wire-id announce:
		// the excluded socket received nothing at all from this publish.
		expect(a.counts()).toEqual(aBefore);
		// The relay observed the excluded publish exactly once.
		expect(relayLog.filter((e) => e.topic === TOPIC).length).toBe(1);

		// Without exclusion the same publish reaches both: binary for the
		// capable socket, JSON for the other.
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 3.5, y: 4.5 } }, codec);
		await until(() => a.frames.binary.length >= 1 && b.updates().length >= 2);
		const parsed = parseBinaryFrame(a.frames.binary[0]);
		expect(parsed).toBeTruthy();
		const decoded = decodeSmooth(parsed.payload, new SmoothDecodeDict(), parsed.schemaVersion);
		expect(decoded).toBeTruthy();
		expect(decoded.event).toBe('update');
		expect(decoded.data.key).toBe('p1');
		expect(decoded.data.data.x).toBeCloseTo(3.5, 4);
		expect(decoded.data.data.y).toBeCloseTo(4.5, 4);
		expect(b.updates()[1].data).toEqual({ key: 'p1', data: { x: 3.5, y: 4.5 } });
		expect(relayLog.filter((e) => e.topic === TOPIC).length).toBe(2);
	});

	it('excludes a JSON-only socket even when no connected client holds the capability', async () => {
		const relayLog = [];
		const made = await noechoServer(relayLog);
		server = made.server;
		const codec = createSmoothWireCodec();

		const a = await connectClient(server.wsUrl, 'A');
		const b = await connectClient(server.wsUrl, 'B');
		const wsA = made.sockets.get('A');
		expect(wsA).toBeTruthy();

		const aBefore = a.counts();
		server.platform.publishWire(TOPIC, 'update', { key: 'p2', data: { x: 7, y: 8 } }, codec, { excludeWs: wsA });

		await until(() => b.updates().length >= 1);
		expect(b.updates()[0].data).toEqual({ key: 'p2', data: { x: 7, y: 8 } });
		expect(a.counts()).toEqual(aBefore);
		expect(relayLog.filter((e) => e.topic === TOPIC).length).toBe(1);

		// Without exclusion the capability-less fast path reaches both as JSON.
		server.platform.publishWire(TOPIC, 'update', { key: 'p2', data: { x: 9, y: 10 } }, codec);
		await until(() => a.updates().length >= 1 && b.updates().length >= 2);
		expect(a.updates()[0].data).toEqual({ key: 'p2', data: { x: 9, y: 10 } });
		expect(a.frames.binary.length).toBe(0);
		expect(relayLog.filter((e) => e.topic === TOPIC).length).toBe(2);
	});

	it('excludes through a stateless codec, both when the codec encodes and when it declines to JSON', async () => {
		const relayLog = [];
		const made = await noechoServer(relayLog);
		server = made.server;
		// Minimal stateless codec: one opaque byte for 'update', JSON-decline
		// for everything else.
		const codec = {
			capability: 'wire.test:1',
			schemaVersion: 1,
			encode: (event) => (event === 'update' ? Uint8Array.of(7) : null)
		};

		const a = await connectClient(server.wsUrl, 'A', [codec.capability]);
		const b = await connectClient(server.wsUrl, 'B');
		const wsA = made.sockets.get('A');
		expect(wsA).toBeTruthy();

		const aBefore = a.counts();
		server.platform.publishWire(TOPIC, 'update', { n: 1 }, codec, { excludeWs: wsA });
		await until(() => b.updates().length >= 1);
		expect(b.updates()[0].data).toEqual({ n: 1 });
		expect(a.counts()).toEqual(aBefore);

		// Declined frame (encode returns null) with exclusion: the JSON
		// envelope still skips the excluded socket.
		server.platform.publishWire(TOPIC, 'roster', { all: true }, codec, { excludeWs: wsA });
		await until(() => b.updates().length >= 2);
		expect(b.updates()[1].event).toBe('roster');
		expect(a.counts()).toEqual(aBefore);

		// Without exclusion the capable socket receives the binary frame.
		server.platform.publishWire(TOPIC, 'update', { n: 2 }, codec);
		await until(() => a.frames.binary.length >= 1 && b.updates().length >= 3);
		const parsed = parseBinaryFrame(a.frames.binary[0]);
		expect(parsed).toBeTruthy();
		expect([...parsed.payload]).toEqual([7]);
		expect(relayLog.filter((e) => e.topic === TOPIC).length).toBe(3);
	});
});
