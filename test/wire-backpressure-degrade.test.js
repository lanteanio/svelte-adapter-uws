// Backpressure degradation of the stateful binary wire, against the real
// createTestServer platform (the testing.js mirror of src/runtime/handler.js).
//
// A stateful codec mutates its per-connection encoder dictionary DURING
// encode (interns keys, advances the delta-stamp baseline), then sends. uWS
// silently drops frames past maxBackpressure (send returns 2), so a dropped
// frame that carried a key assignment or a stamp delta leaves the client
// decoder permanently desynced. The platform's answer is to poison that
// connection's wire for that capability: it is then served the shared JSON
// envelope (full keys, absolute values - correct, just unoptimized) until it
// reconnects, while every other connection keeps its binary wire.
//
// The real-server harness cannot force a deterministic uWS backpressure drop
// (it would need a slow real socket past maxBackpressure), so each scenario
// injects a scripted fake connection into the server's live connection set:
// its `send` returns a scripted uWS status (1 sent, 0 enqueued, 2 dropped)
// per frame, while a REAL capable ws client rides alongside to keep the
// capability accounting live and to prove neighbor isolation.

import { describe, it, expect, afterEach } from 'vitest';
import { createSmoothWireCodec, SMOOTH_TOPIC_PREFIX, SMOOTH_CAPABILITY } from '../src/plugins/smooth/server.js';
import { SmoothDecodeDict, decodeSmooth } from '../src/plugins/smooth/codec.js';
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

const TOPIC = SMOOTH_TOPIC_PREFIX + 'degrade';

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

/** A server whose message hook subscribes a socket to a topic on demand. */
function degradeServer() {
	return createTestServer({
		handler: {
			message(ws, ctx) {
				const msg = ctx.msg;
				if (msg && msg.type === 'sub-smooth' && typeof msg.topic === 'string') {
					trackedSubscribe(ws, msg.topic);
				}
			}
		}
	});
}

/**
 * A real ws client that advertises the smooth capability, joins TOPIC
 * server-side, and records every inbound frame.
 */
async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = { json: [], binary: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) frames.binary.push(new Uint8Array(data));
		else { try { frames.json.push(JSON.parse(data.toString())); } catch { /* ignore */ } }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'hello', caps: [SMOOTH_CAPABILITY] }));
	ws.send(JSON.stringify({ type: 'sub-smooth', topic: TOPIC }));
	await sleep(60); // server-side subscribe settles
	clients.push(ws);
	return { ws, frames };
}

/**
 * A scripted fake connection, shaped exactly like the subset of the uWS
 * socket the publish walks touch: getUserData() with subscription +
 * capability slots, and a send() whose uWS status comes from `script` in
 * call order (default 1 = sent, once the script is spent).
 */
function scriptedWs(script) {
	const ud = {};
	ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
	ud[WS_CAPS] = new Set([SMOOTH_CAPABILITY]);
	const sent = { text: [], binary: [] };
	return {
		sent,
		envelopes() { return sent.text.filter((t) => t.startsWith('{"topic"')).map((t) => JSON.parse(t)); },
		getUserData() { return ud; },
		send(payload, isBinary) {
			if (isBinary) sent.binary.push(new Uint8Array(payload));
			else sent.text.push(String(payload));
			return script.length > 0 ? script.shift() : 1;
		},
		close() { /* server.close() ends every tracked connection */ }
	};
}

describeUWS('stateful wire degrades to JSON when backpressure drops a frame', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
	});

	it('a dropped key-assign frame poisons the capability: the next publish arrives as the full-key JSON envelope while other connections keep binary', async () => {
		server = await degradeServer();
		const codec = createSmoothWireCodec();
		const a = await connectClient(server.wsUrl);

		// announce -> 1 (sent), first binary frame (carrying the key
		// assignment for 'p1') -> 2 (dropped past maxBackpressure).
		const fake = scriptedWs([1, 2]);
		server.wsConnections.add(fake);

		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 1.5, y: 2.5 } }, codec);
		expect(fake.sent.binary.length).toBe(1);
		expect(fake.envelopes().length).toBe(0);

		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 3.5, y: 4.5 } }, codec);

		// The poisoned connection got the shared JSON envelope: full key,
		// absolute values - the entity is NOT frozen on this connection.
		expect(fake.sent.binary.length).toBe(1);
		const envs = fake.envelopes();
		expect(envs.length).toBe(1);
		expect(envs[0].topic).toBe(TOPIC);
		expect(envs[0].event).toBe('update');
		expect(envs[0].data).toEqual({ key: 'p1', data: { x: 3.5, y: 4.5 } });

		// The real client kept its binary wire across both publishes, and one
		// persistent decode dictionary decodes both frames - its per-connection
		// state was untouched by the neighbor's poisoning.
		await until(() => a.frames.binary.length >= 2);
		const dict = new SmoothDecodeDict();
		for (const [i, coords] of [{ x: 1.5, y: 2.5 }, { x: 3.5, y: 4.5 }].entries()) {
			const parsed = parseBinaryFrame(a.frames.binary[i]);
			expect(parsed).toBeTruthy();
			const decoded = decodeSmooth(parsed.payload, dict, parsed.schemaVersion);
			expect(decoded).toBeTruthy();
			expect(decoded.event).toBe('update');
			expect(decoded.data.key).toBe('p1');
			expect(decoded.data.data.x).toBeCloseTo(coords.x, 4);
			expect(decoded.data.data.y).toBeCloseTo(coords.y, 4);
		}
	});

	it('reconnect restores binary: a fresh connection for the degraded client negotiates a fresh dictionary', async () => {
		server = await degradeServer();
		const codec = createSmoothWireCodec();
		await connectClient(server.wsUrl);

		const fake = scriptedWs([1, 2]);
		server.wsConnections.add(fake);
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 1, y: 2 } }, codec);
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 3, y: 4 } }, codec);
		expect(fake.sent.binary.length).toBe(1);
		expect(fake.envelopes().length).toBe(1);

		// Reconnect: the old connection goes away, the same client returns on
		// a new connection with fresh userData (fresh dictionary, fresh ids).
		server.wsConnections.delete(fake);
		const fresh = scriptedWs([]);
		server.wsConnections.add(fresh);

		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 5, y: 6 } }, codec);
		expect(fresh.envelopes().length).toBe(0);
		expect(fresh.sent.binary.length).toBe(1);
		const parsed = parseBinaryFrame(fresh.sent.binary[0]);
		expect(parsed).toBeTruthy();
		const decoded = decodeSmooth(parsed.payload, new SmoothDecodeDict(), parsed.schemaVersion);
		expect(decoded).toBeTruthy();
		expect(decoded.data).toEqual({ key: 'p1', data: { x: 5, y: 6 } });
	});

	it('send result 0 (enqueued behind backpressure) does NOT poison: the wire stays binary and the dictionary stays continuous', async () => {
		server = await degradeServer();
		const codec = createSmoothWireCodec();
		await connectClient(server.wsUrl);

		// announce -> 1, first binary frame -> 0 (enqueued, delivers in order).
		const fake = scriptedWs([1, 0]);
		server.wsConnections.add(fake);

		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 1, y: 2 } }, codec);
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 3, y: 4 } }, codec);

		expect(fake.envelopes().length).toBe(0);
		expect(fake.sent.binary.length).toBe(2);
		// One decode dictionary decodes both frames in order: the second frame
		// references the key assigned by the first, so encoder state survived.
		const dict = new SmoothDecodeDict();
		for (const [i, coords] of [{ x: 1, y: 2 }, { x: 3, y: 4 }].entries()) {
			const parsed = parseBinaryFrame(fake.sent.binary[i]);
			const decoded = decodeSmooth(parsed.payload, dict, parsed.schemaVersion);
			expect(decoded).toBeTruthy();
			expect(decoded.data).toEqual({ key: 'p1', data: coords });
		}
	});

	it('a dropped wire-id announce poisons too: that frame and every later one arrive as JSON', async () => {
		server = await degradeServer();
		const codec = createSmoothWireCodec();
		await connectClient(server.wsUrl);

		// The very first send (the wire-id announce) is dropped: the client
		// can never resolve the topic id, so binary is undecodable for good.
		const fake = scriptedWs([2]);
		server.wsConnections.add(fake);

		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 1, y: 2 } }, codec);
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 3, y: 4 } }, codec);

		expect(fake.sent.binary.length).toBe(0);
		const envs = fake.envelopes();
		expect(envs.length).toBe(2);
		expect(envs[0].data).toEqual({ key: 'p1', data: { x: 1, y: 2 } });
		expect(envs[1].data).toEqual({ key: 'p1', data: { x: 3, y: 4 } });
		// No second announce attempt either: the mapping is never re-announced.
		expect(fake.sent.text.filter((t) => t.includes('"wire-id"')).length).toBe(1);
	});

	it('sendWire mirrors the contract: a dropped stateful frame returns 2 and degrades later sends and publishes to JSON', async () => {
		server = await degradeServer();
		const codec = createSmoothWireCodec();
		await connectClient(server.wsUrl);

		// announce -> 1, binary snapshot frame -> 2 (dropped).
		const fake = scriptedWs([1, 2]);
		server.wsConnections.add(fake);

		const first = server.platform.sendWire(fake, TOPIC, 'update', { key: 'p1', data: { x: 1, y: 2 } }, codec);
		expect(first).toBe(2);
		expect(fake.sent.binary.length).toBe(1);

		// Later single-target sends fall back to JSON...
		const second = server.platform.sendWire(fake, TOPIC, 'update', { key: 'p1', data: { x: 3, y: 4 } }, codec);
		expect(second).toBe(1);
		// ...and so do broadcasts: the poisoned state is shared platform-wide.
		server.platform.publishWire(TOPIC, 'update', { key: 'p1', data: { x: 5, y: 6 } }, codec);

		expect(fake.sent.binary.length).toBe(1);
		const envs = fake.envelopes();
		expect(envs.length).toBe(2);
		expect(envs[0].data).toEqual({ key: 'p1', data: { x: 3, y: 4 } });
		expect(envs[1].data).toEqual({ key: 'p1', data: { x: 5, y: 6 } });
	});
});
