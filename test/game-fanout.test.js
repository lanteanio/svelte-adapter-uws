// Conformance test for the compact game-lane FAN-OUT (PROTOCOL.md section 6.7,
// the `game.fanout:1` capability; the egress mirror of the `game:1` ingress twin
// in relay-oracle.test.js). The JSON `game` fan-out is the ORACLE: a subscriber
// that negotiated `game.fanout:1` receives the value-codec `0x03` frame, and it
// MUST decode to the identical `{event, data, id?}` a JSON subscriber of the same
// room receives, with the identical room seq. The sender is excluded on both
// forms. test-vectors/game-fanout-compact.json is the byte-level target for the
// frozen payload and the deterministic WebTransport (id 0) frame.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestServer } from '../src/testing.js';
import { buildBinaryFrame, parseBinaryFrame } from '../src/runtime/wire.js';
import { encodeValue, decodeValue } from '../src/runtime/wire-value.js';
import { GAME_INGRESS_SCHEMA_VERSION, GAME_FANOUT_SCHEMA_VERSION } from '../src/runtime/handler/game-ingress.js';

const vectors = JSON.parse(readFileSync(new URL('../test-vectors/game-fanout-compact.json', import.meta.url), 'utf8'));
const caseById = Object.fromEntries(vectors.cases.map((c) => [c.id, c]));

const TOPIC = 'arena:1';

function relayHandler() {
	return {
		message(ws, { msg, platform }) {
			if (!msg || typeof msg !== 'object') return;
			if (msg.type === 'arm' && typeof msg.room === 'string') platform.grantPublish(ws, msg.room);
			else if (msg.type === 'disarm') platform.revokePublish(ws);
		}
	};
}

// Collect BOTH text and binary frames (the oracle test discards binary; the
// egress twin is exactly the binary a subscriber receives).
async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const messages = [];
	const binary = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) binary.push(new Uint8Array(data));
		else messages.push(JSON.parse(data.toString()));
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, messages, binary };
}

const tick = () => new Promise((r) => setTimeout(r, 50));
const send = (client, frame) => client.ws.send(JSON.stringify(frame));
const gamePayload = (event, data, id) => encodeValue(id === undefined ? [event, data] : [event, data, id]);
const sendBinaryGame = (client, ingressId, ingressSeq, event, data, id) =>
	client.ws.send(Buffer.from(buildBinaryFrame(GAME_INGRESS_SCHEMA_VERSION, ingressId, ingressSeq, gamePayload(event, data, id))));
const dataEvents = (client) => client.messages.filter((m) => !m.type && typeof m.topic === 'string' && typeof m.event === 'string');
const wireIds = (client) => client.messages.filter((m) => m && m.type === 'wire-id');
// A subscriber's received 0x03 fan-out frames, decoded to { topicId, seq, value }.
const fanoutFrames = (client) => client.binary
	.map((b) => parseBinaryFrame(b))
	.filter((p) => p !== null)
	.map((p) => ({ topicId: p.topicId, seq: p.seq, schemaVersion: p.schemaVersion, payload: p.payload, value: decodeValue(p.payload) }));

let server;
let clients = [];

async function closeAll() {
	for (const c of clients) { try { c.ws.close(); } catch {} }
	clients = [];
	await server?.close();
	server = undefined;
}

afterEach(closeAll);

describe('compact game fan-out (game.fanout:1)', () => {
	it('a game.fanout subscriber decodes to the identical event the JSON subscriber receives, sender excluded', async () => {
		server = await createTestServer({ handler: relayHandler() });

		// A is the sender (also a subscriber, to prove exclusion). B is a plain
		// JSON subscriber (no game.fanout). C negotiates game.fanout:1 - it gets
		// the compact 0x03 frame where B gets the JSON envelope.
		const A = await connectClient(server.wsUrl);
		const B = await connectClient(server.wsUrl);
		const C = await connectClient(server.wsUrl);
		clients = [A, B, C];

		send(A, { type: 'hello', caps: ['wire.ingress:1'] });
		send(C, { type: 'hello', caps: ['game.fanout:1'] });
		send(A, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(B, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(C, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(A, { type: 'arm', room: TOPIC });
		await tick();
		expect(A.messages.some((m) => m.type === 'ingress-ok')).toBe(true);
		send(A, { type: 'ingress-bind', id: 1, kind: 'game:1' });
		await tick();

		// Case move-with-id: A relays move {dx:1,dy:0} id 5 -> room seq 1.
		sendBinaryGame(A, 1, 1, 'move', { dx: 1, dy: 0 }, 5);
		await tick();

		const oracle1 = { topic: TOPIC, event: 'move', data: { dx: 1, dy: 0 }, seq: 1, id: 5 };
		expect(dataEvents(B)).toEqual([oracle1]);          // JSON subscriber: the oracle envelope
		expect(dataEvents(A)).toEqual([]);                  // sender excluded (JSON)
		expect(B.binary.length).toBe(0);                    // JSON subscriber got NO binary
		expect(A.binary.length).toBe(0);                    // sender excluded (binary too)

		// C received a wire-id announce for the topic, then the compact frame.
		const cWireId = wireIds(C).find((m) => m.topic === TOPIC);
		expect(cWireId).toBeTruthy();
		const cFrames = fanoutFrames(C);
		expect(cFrames.length).toBe(1);
		const f1 = cFrames[0];
		expect(f1.topicId).toBe(cWireId.id);                // header topicId resolves to the announced topic
		expect(f1.schemaVersion).toBe(GAME_FANOUT_SCHEMA_VERSION);
		expect(f1.seq).toBe(1);                             // the room seq the JSON envelope carries
		expect(f1.value).toEqual(['move', { dx: 1, dy: 0 }, 5]); // decodes to [event, data, id]
		// The decoded frame reconstructs the oracle envelope (id preserved on the wire).
		expect({ topic: TOPIC, event: f1.value[0], data: f1.value[1], seq: f1.seq, id: f1.value[2] }).toEqual(oracle1);
		// Frozen payload bytes match the committed vector.
		expect(Buffer.from(f1.payload).toString('hex')).toBe(caseById['move-with-id'].payloadHex);

		// Case move-no-id: room seq 2, no id in the payload (2-element array).
		sendBinaryGame(A, 1, 2, 'move', { dx: 0, dy: 1 }, undefined);
		await tick();
		expect(dataEvents(B)[1]).toEqual({ topic: TOPIC, event: 'move', data: { dx: 0, dy: 1 }, seq: 2 });
		const f2 = fanoutFrames(C)[1];
		expect(f2.seq).toBe(2);
		expect(f2.value).toEqual(['move', { dx: 0, dy: 1 }]);      // no id -> 2-element
		expect(Buffer.from(f2.payload).toString('hex')).toBe(caseById['move-no-id'].payloadHex);
	});

	it('the frozen vector payload + the WebTransport (id 0) frame round-trip', () => {
		// The payload is byte-identical on both carriages; the WT datagram frame is
		// fully deterministic (id 0 = the session's bound room, PROTOCOL.md 14.6).
		for (const id of ['move-with-id', 'move-no-id']) {
			const c = caseById[id];
			const expectArr = c.inputId === undefined ? [c.event, c.data] : [c.event, c.data, c.inputId];
			// payloadHex decodes to the case's [event, data, id?].
			expect(decodeValue(Uint8Array.from(Buffer.from(c.payloadHex, 'hex')))).toEqual(expectArr);
			// wtFrameHex is [0x03][schemaVersion][0][seq][payload], id 0.
			const parsed = parseBinaryFrame(Uint8Array.from(Buffer.from(c.wtFrameHex, 'hex')));
			expect(parsed).toBeTruthy();
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.topicId).toBe(0);
			expect(parsed.seq).toBe(c.seq);
			expect(decodeValue(parsed.payload)).toEqual(expectArr);
			// The WT frame is exactly buildBinaryFrame(1, 0, seq, payload).
			const rebuilt = buildBinaryFrame(GAME_FANOUT_SCHEMA_VERSION, 0, c.seq, encodeValue(expectArr));
			expect(Buffer.from(rebuilt).toString('hex')).toBe(c.wtFrameHex);
		}
	});

	it('a subscriber that did NOT negotiate game.fanout receives only JSON (no binary)', async () => {
		server = await createTestServer({ handler: relayHandler() });
		const A = await connectClient(server.wsUrl);
		const B = await connectClient(server.wsUrl);
		clients = [A, B];

		send(A, { type: 'hello', caps: ['wire.ingress:1'] });
		send(B, { type: 'hello', caps: ['batch'] });        // negotiates something, but NOT game.fanout
		send(A, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(B, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(A, { type: 'arm', room: TOPIC });
		await tick();
		send(A, { type: 'ingress-bind', id: 1, kind: 'game:1' });
		await tick();

		sendBinaryGame(A, 1, 1, 'move', { dx: 1, dy: 0 }, 7);
		await tick();
		expect(dataEvents(B)).toEqual([{ topic: TOPIC, event: 'move', data: { dx: 1, dy: 0 }, seq: 1, id: 7 }]);
		expect(B.binary.length).toBe(0);                    // byte-identical to today: JSON only
	});
});
