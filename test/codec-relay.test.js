// Codec-aware cross-worker relay re-encode, against the real createTestServer
// platform (the testing.js mirror of src/runtime/handler).
//
// A clustered publish originates on one worker and relays a JSON envelope to the
// others. Without the codec-aware path, a binary-capable subscriber on a DIFFERENT
// worker than the publisher receives that JSON envelope - so on an N-worker box
// (N-1)/N of binary subs lose the binary wire. The fix carries the codec's
// capability + raw payload alongside the envelope; the receiving worker re-derives
// the codec from its registry and re-encodes binary locally against its OWN
// connections (relayPublishWire). This exercises that receive path directly: register
// a codec, then drive relayPublishWire with an origin-stamped seq and assert the
// local capable subscribers get a 0x03 frame carrying the origin seq (no re-stamp),
// the non-capable ones get the JSON envelope, and the cheap fallbacks return false.

import { describe, it, expect, afterEach } from 'vitest';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { trackedSubscribe, WS_SUBSCRIPTIONS, WS_CAPS } from '../src/runtime/utils.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../src/testing.js') : {};

const TOPIC = 'room:relay';
const CAP = 'test.relay:1';
const SCHEMA = 1;
const STATEFUL_CAP = 'test.relay.stateful:1';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Minimal stateless codec: the payload is the UTF-8 JSON of `{ event, data }`, so a
 * test can decode it back and confirm the receiver re-encoded the relayed publish.
 */
function makeCodec() {
	return {
		capability: CAP,
		schemaVersion: SCHEMA,
		encode: (event, data) => enc.encode(JSON.stringify({ event, data }))
	};
}

/**
 * Minimal stateful codec: each per-connection state holds an independent counter
 * advanced on every encode, so two connections diverge - proving the relay used the
 * per-connection stateful path, not one shared encode.
 */
function makeStatefulCodec() {
	return {
		capability: STATEFUL_CAP,
		schemaVersion: SCHEMA,
		encode: (event, data, state) => {
			if (state) state.n = (state.n || 0) + 1;
			return enc.encode(JSON.stringify({ event, data, n: state ? state.n : null }));
		},
		state: {
			onAttach: () => ({ n: 0 }),
			onDetach: () => {}
		}
	};
}

function decodePayload(payload) {
	return JSON.parse(dec.decode(payload));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let serverB;
let clients;

/** A server whose message hook subscribes a socket to a topic on demand. */
function relayServer(extra = {}) {
	return createTestServer({
		...extra,
		handler: {
			message(ws, ctx) {
				const msg = ctx.msg;
				if (msg && msg.type === 'sub' && typeof msg.topic === 'string') trackedSubscribe(ws, msg.topic);
			}
		}
	});
}

/**
 * A real ws client that advertises `caps` (so the platform's capability accounting
 * is non-zero - relayPublishWire's local-binary-subscriber gate) and joins TOPIC.
 * Assertions are made on the scripted fakes; this client only makes capCounts live.
 */
async function connectCapableClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'hello', caps }));
	ws.send(JSON.stringify({ type: 'sub', topic: TOPIC }));
	await sleep(60); // server-side hello + subscribe settle
	clients.push(ws);
	return ws;
}

/**
 * A scripted fake connection shaped like the subset of the uWS socket the publish
 * walk touches: getUserData() with subscription + capability slots, and a send()
 * recording each frame (text vs binary) and returning 1 (sent).
 */
function scriptedWs(caps) {
	const ud = {};
	ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
	if (caps) ud[WS_CAPS] = new Set(caps);
	const sent = { text: [], binary: [] };
	return {
		sent,
		envelopes() { return sent.text.filter((t) => t.startsWith('{"topic"')).map((t) => JSON.parse(t)); },
		getUserData() { return ud; },
		send(payload, isBinary) {
			if (isBinary) sent.binary.push(new Uint8Array(payload));
			else sent.text.push(String(payload));
			return 1;
		},
		close() { /* server.close() ends every tracked connection */ }
	};
}

describeUWS('codec-aware cross-worker relay re-encode (relayPublishWire)', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
		await serverB?.close();
		serverB = null;
	});

	it('re-encodes binary for capable local subs and JSON for the rest, preserving the origin seq', async () => {
		server = await relayServer();
		server.platform.registerWireCodec(makeCodec());
		await connectCapableClient(server.wsUrl, [CAP]);

		const binFake = scriptedWs([CAP]);
		const jsonFake = scriptedWs(null);
		server.wsConnections.add(binFake);
		server.wsConnections.add(jsonFake);

		// The origin worker stamped seq 99; the receiver must NOT re-stamp (a fresh
		// per-topic stamp here would be a small value, never 99).
		const ok = server.platform.relayPublishWire(TOPIC, 'move', { x: 1, y: 2 }, CAP, 99, false);
		expect(ok).toBe(true);

		// Capable fake: one binary 0x03 frame carrying the origin seq + re-encoded payload.
		expect(binFake.sent.binary.length).toBe(1);
		const frame = parseBinaryFrame(binFake.sent.binary[0]);
		expect(frame).toBeTruthy();
		expect(frame.schemaVersion).toBe(SCHEMA);
		expect(frame.seq).toBe(99); // origin seq, not re-stamped
		expect(decodePayload(frame.payload)).toEqual({ event: 'move', data: { x: 1, y: 2 } });

		// JSON-only fake: the envelope, never a binary frame.
		expect(jsonFake.sent.binary.length).toBe(0);
		const envs = jsonFake.envelopes();
		expect(envs.length).toBe(1);
		expect(envs[0].topic).toBe(TOPIC);
		expect(envs[0].event).toBe('move');
		expect(envs[0].data).toEqual({ x: 1, y: 2 });
	});

	it('returns false when no codec is registered for the capability (caller uses the JSON envelope)', async () => {
		server = await relayServer();
		// No registerWireCodec call - the receiving worker has no codec for CAP.
		await connectCapableClient(server.wsUrl, [CAP]);
		const binFake = scriptedWs([CAP]);
		server.wsConnections.add(binFake);

		const ok = server.platform.relayPublishWire(TOPIC, 'move', { x: 1 }, CAP, 5, false);
		expect(ok).toBe(false);
		// relayPublishWire itself sends nothing; the envelope fan-out is the caller's path.
		expect(binFake.sent.binary.length).toBe(0);
		expect(binFake.sent.text.length).toBe(0);
	});

	it('returns false when no local connection advertises the capability', async () => {
		server = await relayServer();
		server.platform.registerWireCodec(makeCodec());
		// No capable client -> capCounts.has(CAP) is false even though a codec exists.
		const jsonFake = scriptedWs(null);
		server.wsConnections.add(jsonFake);

		const ok = server.platform.relayPublishWire(TOPIC, 'move', { x: 1 }, CAP, 5, false);
		expect(ok).toBe(false);
		expect(jsonFake.sent.text.length).toBe(0);
		expect(jsonFake.sent.binary.length).toBe(0);
	});

	it('does not re-relay: the re-encode runs with relay:false so no new relay frame is emitted', async () => {
		const relayed = [];
		server = await relayServer({ __onPublish: (frame) => relayed.push(frame) });
		server.platform.registerWireCodec(makeCodec());
		await connectCapableClient(server.wsUrl, [CAP]);
		const binFake = scriptedWs([CAP]);
		server.wsConnections.add(binFake);

		relayed.length = 0; // ignore any relay activity from the hello/subscribe path
		const ok = server.platform.relayPublishWire(TOPIC, 'move', { x: 1 }, CAP, 8, false);
		expect(ok).toBe(true);
		expect(binFake.sent.binary.length).toBe(1);
		// The local re-encode used relay:false: a re-relay would loop cross-worker.
		expect(relayed.length).toBe(0);
	});

	it('a stateful codec re-encodes per local connection on relay (independent dictionaries)', async () => {
		server = await relayServer();
		server.platform.registerWireCodec(makeStatefulCodec());
		await connectCapableClient(server.wsUrl, [STATEFUL_CAP]);

		const a = scriptedWs([STATEFUL_CAP]);
		const b = scriptedWs([STATEFUL_CAP]);
		server.wsConnections.add(a);
		server.wsConnections.add(b);

		server.platform.relayPublishWire(TOPIC, 'move', { v: 1 }, STATEFUL_CAP, 1, false);
		server.platform.relayPublishWire(TOPIC, 'move', { v: 2 }, STATEFUL_CAP, 2, false);

		// Each connection encoded against ITS OWN state: the per-connection counter
		// advanced independently to 2, proving a per-connection re-encode rather than
		// one shared frame. The origin seq rides on the wire unchanged.
		expect(a.sent.binary.length).toBe(2);
		expect(b.sent.binary.length).toBe(2);
		const aFrame = parseBinaryFrame(a.sent.binary[1]);
		const bFrame = parseBinaryFrame(b.sent.binary[1]);
		expect(aFrame.seq).toBe(2);
		expect(bFrame.seq).toBe(2);
		expect(decodePayload(aFrame.payload).n).toBe(2);
		expect(decodePayload(bFrame.payload).n).toBe(2);
		expect(decodePayload(aFrame.payload).data).toEqual({ v: 2 });
	});

	it('end-to-end: a wire publish on one server relays + re-encodes binary on another (full carry chain)', async () => {
		// Receiver server B: registers the codec, has a real capable client (so its
		// capCounts is live) plus scripted fakes for deterministic frame capture.
		serverB = await relayServer();
		serverB.platform.registerWireCodec(makeCodec());
		await connectCapableClient(serverB.wsUrl, [CAP]);
		const bBin = scriptedWs([CAP]);
		const bJson = scriptedWs(null);
		serverB.wsConnections.add(bBin);
		serverB.wsConnections.add(bJson);

		// Origin server A: registers the codec; its relay emit bridges straight into
		// B's __relayReceive (mirroring the primary forward + IPC channel), so a wire
		// publish on A drives the full carry path: publishWire relay emit -> frame with
		// {capability,event,data,seq} -> __relayReceive -> codec-aware re-encode on B.
		let relayed = null;
		server = await relayServer({
			__onPublish: (frame) => { relayed = frame; serverB.platform.__relayReceive(frame); }
		});
		server.platform.registerWireCodec(makeCodec());

		server.platform.publishWire(TOPIC, 'move', { x: 5, y: 6 }, makeCodec());

		// The relay frame carried the registry-gated codec fields (not envelope-only).
		expect(relayed).toBeTruthy();
		expect(relayed.capability).toBe(CAP);
		expect(relayed.event).toBe('move');
		expect(relayed.data).toEqual({ x: 5, y: 6 });
		const originSeq = relayed.seq;

		// B re-encoded binary for its capable sub (origin seq preserved) and delivered
		// the JSON envelope to the non-capable one - the (N-1)/N cross-worker gap closed.
		expect(bBin.sent.binary.length).toBe(1);
		const frame = parseBinaryFrame(bBin.sent.binary[0]);
		expect(frame.seq).toBe(originSeq);
		expect(decodePayload(frame.payload)).toEqual({ event: 'move', data: { x: 5, y: 6 } });
		expect(bJson.sent.binary.length).toBe(0);
		const envs = bJson.envelopes();
		expect(envs.length).toBe(1);
		expect(envs[0].data).toEqual({ x: 5, y: 6 });
	});
});
