// Conformance test for the client-driven relay (the `game` lane, PROTOCOL.md
// section 3.10; platform.grantPublish/revokePublish/publishGrant/publishGame).
//
// This is the ORACLE the native daemon (and any second implementation) mirrors
// wire-for-wire, so the wire it asserts is frozen: a client `game` frame carries
// NO topic (the server derives it from the connection's publish grant); the
// server stamps a monotonic per-room seq and fans the frame out to the room's
// other subscribers as a data-event with the sender's `id` echoed and the SENDER
// EXCLUDED; an ungranted or malformed frame is answered to the sender with
// `game-denied`. The committed transcript in test-vectors/game-relay.json is the
// byte-level A/B target; this test both drives the reference server imperatively
// and asserts its output equals that transcript.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestServer } from '../src/testing.js';
import { buildBinaryFrame } from '../src/runtime/wire.js';
import { encodeValue } from '../src/runtime/wire-value.js';
import { GAME_INGRESS_KIND, GAME_INGRESS_SCHEMA_VERSION } from '../src/runtime/handler/game-ingress.js';

const golden = JSON.parse(readFileSync(new URL('../test-vectors/game-relay.json', import.meta.url), 'utf8'));

const TOPIC = 'arena:1';

// A test app that grants publish on an `arm` app-frame and revokes on `disarm`.
// `game` / `subscribe` never reach the app handler (the demux consumes them);
// only the unknown-type `arm` / `disarm` frames fall through here, so this is the
// realistic "the framework authorizes publish at join" shape.
function relayHandler() {
	return {
		message(ws, { msg, platform }) {
			if (!msg || typeof msg !== 'object') return;
			if (msg.type === 'arm' && typeof msg.room === 'string') platform.grantPublish(ws, msg.room);
			else if (msg.type === 'disarm') platform.revokePublish(ws);
		}
	};
}

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const messages = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		messages.push(JSON.parse(data.toString()));
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, messages };
}

const tick = () => new Promise((r) => setTimeout(r, 50));
const send = (client, frame) => client.ws.send(JSON.stringify(frame));
// A `game:1` binary ingress frame: [0x03][schemaVersion][ingressId][seq][payload],
// payload = encodeValue([event, data]) or ([event, data, id]) (PROTOCOL.md 6.6).
const gamePayload = (event, data, id) => encodeValue(id === undefined ? [event, data] : [event, data, id]);
const sendBinaryGame = (client, ingressId, ingressSeq, event, data, id) =>
	client.ws.send(Buffer.from(buildBinaryFrame(GAME_INGRESS_SCHEMA_VERSION, ingressId, ingressSeq, gamePayload(event, data, id))));
// The room fan-out is a data-event: no `type`, identified by `topic` + `event`.
const dataEvents = (client) => client.messages.filter((m) => !m.type && typeof m.topic === 'string' && typeof m.event === 'string');
const denials = (client) => client.messages.filter((m) => m && m.type === 'game-denied');

let server;
let clients = [];

async function closeAll() {
	for (const c of clients) { try { c.ws.close(); } catch {} }
	clients = [];
	await server?.close();
	server = null;
}

describe('the game relay lane (conformance oracle)', () => {
	afterEach(closeAll);

	it('grant -> game frame -> fan out with seq + id, sender excluded; revoke/ungranted/malformed -> game-denied', async () => {
		server = await createTestServer({ handler: relayHandler() });

		const A = await connectClient(server.wsUrl);
		const B = await connectClient(server.wsUrl);
		const D = await connectClient(server.wsUrl);
		clients = [A, B, D];

		// A and B join the room (real subscribe path); A is armed to publish.
		send(A, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(B, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(A, { type: 'arm', room: TOPIC });
		await tick();

		// 1. Granted, id present: B receives {topic,event,data,seq:1,id:1}; A (the
		//    sender) receives nothing despite being subscribed (echo suppression).
		send(A, { type: 'game', event: 'move', data: { dx: 1, dy: 0 }, id: 1 });
		await tick();
		expect(dataEvents(B)).toEqual([{ topic: TOPIC, event: 'move', data: { dx: 1, dy: 0 }, seq: 1, id: 1 }]);
		expect(dataEvents(A)).toEqual([]); // sender excluded

		// 2. Granted, no id: seq increments to 2, envelope carries no id field.
		send(A, { type: 'game', event: 'move', data: { dx: 0, dy: 1 } });
		await tick();
		expect(dataEvents(B)).toEqual([
			{ topic: TOPIC, event: 'move', data: { dx: 1, dy: 0 }, seq: 1, id: 1 },
			{ topic: TOPIC, event: 'move', data: { dx: 0, dy: 1 }, seq: 2 }
		]);
		expect('id' in dataEvents(B)[1]).toBe(false);
		expect(dataEvents(A)).toEqual([]);

		// 3. Granted but non-string event: game-denied INVALID to the sender only,
		//    id echoed; no fan-out, and no seq consumed (B sees nothing new).
		send(A, { type: 'game', event: 123, data: { x: 1 }, id: 7 });
		await tick();
		expect(denials(A)).toEqual([{ type: 'game-denied', reason: 'INVALID', id: 7 }]);
		expect(dataEvents(B).length).toBe(2); // unchanged

		// 4. Never granted: game-denied FORBIDDEN to the sender only.
		send(D, { type: 'game', event: 'move', data: null });
		await tick();
		expect(denials(D)).toEqual([{ type: 'game-denied', reason: 'FORBIDDEN' }]);
		expect(dataEvents(B).length).toBe(2); // D's frame never reaches the room

		// 5. After revoke, a formerly-granted connection is FORBIDDEN again, id echoed.
		send(A, { type: 'disarm' });
		await tick();
		send(A, { type: 'game', event: 'move', data: null, id: 9 });
		await tick();
		expect(denials(A)).toEqual([
			{ type: 'game-denied', reason: 'INVALID', id: 7 },
			{ type: 'game-denied', reason: 'FORBIDDEN', id: 9 }
		]);
		expect(dataEvents(B).length).toBe(2); // still no new fan-out
	});

	it('reproduces the committed conformance transcript (test-vectors/game-relay.json) byte-for-byte', async () => {
		server = await createTestServer({ handler: relayHandler() });

		const A = await connectClient(server.wsUrl);
		const B = await connectClient(server.wsUrl);
		const D = await connectClient(server.wsUrl);
		clients = [A, B, D];
		const byName = { A, B, D };

		send(A, { type: 'subscribe', topic: golden.topic, ref: 1 });
		send(B, { type: 'subscribe', topic: golden.topic, ref: 1 });
		send(A, { type: 'arm', room: golden.topic });
		await tick();

		// Per-connection cursor: how many of each frame class we have already
		// asserted, so each step checks only the frames its `in` produced.
		const seenData = { A: 0, B: 0, D: 0 };
		const seenDenied = { A: 0, B: 0, D: 0 };

		for (const step of golden.transcript) {
			if (step.revokeBefore) {
				send(byName[step.revokeBefore], { type: 'disarm' });
				await tick();
			}
			send(byName[step.in.conn], step.in.frame);
			await tick();

			// Group the step's expected outputs by connection.
			const expectByConn = {};
			for (const o of step.out) (expectByConn[o.conn] ??= []).push(o.frame);

			for (const conn of ['A', 'B', 'D']) {
				const wantAll = expectByConn[conn] || [];
				const wantData = wantAll.filter((f) => f.type === undefined);
				const wantDenied = wantAll.filter((f) => f.type === 'game-denied');
				const gotData = dataEvents(byName[conn]).slice(seenData[conn]);
				const gotDenied = denials(byName[conn]).slice(seenDenied[conn]);
				expect(gotData, `${step.step} -> ${conn} data`).toEqual(wantData);
				expect(gotDenied, `${step.step} -> ${conn} denied`).toEqual(wantDenied);
				seenData[conn] += gotData.length;
				seenDenied[conn] += gotDenied.length;
			}
			// `silent` connections produced nothing this step (covered by the empty
			// expectation above, asserted explicitly for the transcript's contract).
			for (const conn of step.silent || []) {
				expect(dataEvents(byName[conn]).slice(seenData[conn]), `${step.step} -> ${conn} silent (data)`).toEqual([]);
				expect(denials(byName[conn]).slice(seenDenied[conn]), `${step.step} -> ${conn} silent (denied)`).toEqual([]);
			}
		}
	});

	it('publishGrant reflects grant then revoke; publishGame injects a server-authored frame excluding the passed sender', async () => {
		// Drive the platform primitives directly (the server-side surface a native
		// author or a bot uses), independent of the wire demux.
		const grants = [];
		server = await createTestServer({
			handler: {
				message(ws, { msg, platform }) {
					if (msg && msg.type === 'probe') {
						platform.grantPublish(ws, TOPIC);
						grants.push(platform.publishGrant(ws)); // 'arena:1'
						platform.revokePublish(ws);
						grants.push(platform.publishGrant(ws)); // null
					}
				}
			}
		});

		const A = await connectClient(server.wsUrl);
		const B = await connectClient(server.wsUrl);
		clients = [A, B];
		send(A, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(B, { type: 'subscribe', topic: TOPIC, ref: 1 });
		await tick();

		send(A, { type: 'probe' });
		await tick();
		expect(grants).toEqual([TOPIC, null]);

		// A server-authored publishGame (senderWs=null) reaches every subscriber of
		// the room, including A and B, and stamps the room's next seq (1: no wire
		// game frame consumed one on this fresh topic).
		const res = server.platform.publishGame(null, TOPIC, 'spawn', { botId: 3 }, 'srv-1');
		await tick();
		expect(res.seq).toBe(1);
		expect(res.delivered).toBe(2);
		const want = { topic: TOPIC, event: 'spawn', data: { botId: 3 }, seq: 1, id: 'srv-1' };
		expect(dataEvents(A)).toEqual([want]);
		expect(dataEvents(B)).toEqual([want]);
	});

	it('the 0x03 binary twin (ingress kind game:1) produces the identical fan-out and denial as the JSON lane', async () => {
		expect(GAME_INGRESS_KIND).toBe('game:1');
		// The committed binary A/B vector is self-consistent: rebuilding the frame
		// from its decoded fields reproduces the exact committed bytes.
		const bt = golden.binaryTwin;
		const rebuilt = Buffer.from(buildBinaryFrame(bt.decoded.schemaVersion, bt.decoded.ingressId, bt.decoded.ingressSeq, encodeValue(bt.decoded.value))).toString('hex');
		expect(rebuilt).toBe(bt.hexFrame);

		server = await createTestServer({ handler: relayHandler() });

		const A = await connectClient(server.wsUrl);
		const B = await connectClient(server.wsUrl);
		const D = await connectClient(server.wsUrl);
		clients = [A, B, D];

		// A negotiates binary ingress, subscribes + arms, then binds an ingress id
		// to kind game:1 (NO target - the topic is the grant). B just subscribes.
		send(A, { type: 'hello', caps: ['wire.ingress:1'] });
		send(A, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(B, { type: 'subscribe', topic: TOPIC, ref: 1 });
		send(A, { type: 'arm', room: TOPIC });
		await tick();
		expect(A.messages.some((m) => m.type === 'ingress-ok')).toBe(true);
		send(A, { type: 'ingress-bind', id: 1, kind: 'game:1' });
		await tick();
		expect(A.messages.some((m) => m.type === 'ingress-bound' && m.id === 1)).toBe(true);

		// Send the EXACT committed vector bytes: it fans out byte-identically to the
		// JSON lane - room seq stamped (1 on this fresh topic), id echoed, sender
		// excluded. Proves the reference server decodes the committed A/B frame.
		A.ws.send(Buffer.from(bt.hexFrame, 'hex'));
		await tick();
		expect(dataEvents(B)).toEqual([{ topic: TOPIC, event: 'move', data: { dx: 1, dy: 0 }, seq: 1, id: 5 }]);
		expect(dataEvents(A)).toEqual([]); // sender excluded

		// No id -> room seq increments, envelope carries no id (same as JSON).
		sendBinaryGame(A, 1, 2, 'move', { dx: 0, dy: 1 }, undefined);
		await tick();
		expect(dataEvents(B)[1]).toEqual({ topic: TOPIC, event: 'move', data: { dx: 0, dy: 1 }, seq: 2 });

		// An ungranted connection's binary frame -> game-denied FORBIDDEN, no fan-out.
		send(D, { type: 'hello', caps: ['wire.ingress:1'] });
		await tick();
		send(D, { type: 'ingress-bind', id: 1, kind: 'game:1' });
		await tick();
		sendBinaryGame(D, 1, 1, 'move', null, undefined);
		await tick();
		expect(denials(D)).toEqual([{ type: 'game-denied', reason: 'FORBIDDEN' }]);
		expect(dataEvents(B).length).toBe(2); // D never reached the room
	});
});
