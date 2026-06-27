// Shared binary fan-out, against the real createTestServer platform. A stateless
// codec marked `shared: true` fans a high-fan-out topic out via cohort uWS topics:
// the byte-identical 0x03 frame goes to the binary cohort (`topic\0bin`) in ONE
// native app.publish, the JSON envelope to the JSON cohort (`topic\0json`) in
// another - no per-connection walk. The frame is identical for every binary
// subscriber because the topic-id is a SERVER-WIDE shared id (partitioned above the
// per-connection id space), announced when a connection joins the binary cohort.
//
// Cohort delivery rides native fan-out, so these use REAL ws clients (a scripted
// fake is not a native subscriber and would never receive an app.publish). Clients
// subscribe via the real `{type:'subscribe'}` wire message so the cohort-join path
// runs at subscribe time.

import { describe, it, expect, afterEach } from 'vitest';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { SHARED_WIRE_ID_BASE } from '../src/runtime/handler/shared-wire-id.js';
import { setCohortHooks, trackedSubscribe, trackedUnsubscribe, WS_SUBSCRIPTIONS } from '../src/runtime/utils.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;
const { createTestServer } = uWS ? await import('../src/testing.js') : {};

const TOPIC = 'lobby:world';
const CAP = 'test.shared:1';
const SCHEMA = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

function sharedCodec() {
	return {
		capability: CAP,
		schemaVersion: SCHEMA,
		shared: true,
		encode: (event, data) => enc.encode(JSON.stringify({ event, data }))
	};
}
function decodePayload(payload) { return JSON.parse(dec.decode(payload)); }

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

let server;
let serverB;
let clients;

/** A real ws client recording inbound frames, split into wire-id announces, JSON
 * envelopes, and binary frames. Advertises `caps` and subscribes to TOPIC over the
 * real wire protocol so the server runs its cohort-join path. */
async function connectClient(url, caps) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = { wireIds: [], json: [], binary: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) { frames.binary.push(new Uint8Array(data)); return; }
		try {
			const obj = JSON.parse(data.toString());
			if (obj && obj.type === 'wire-id') frames.wireIds.push(obj);
			else if (obj && obj.topic !== undefined && obj.event !== undefined) frames.json.push(obj);
		} catch { /* ignore non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	ws.send(JSON.stringify({ type: 'subscribe', topic: TOPIC }));
	await sleep(60); // server-side hello + subscribe settle
	clients.push(ws);
	return { ws, frames };
}

describeUWS('shared binary fan-out via cohort topics', () => {
	clients = [];
	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
		await serverB?.close();
		serverB = null;
	});

	it('fans a shared publish out as the 0x03 frame to the binary cohort and the envelope to the JSON cohort, with a server-wide id', async () => {
		server = await createTestServer({});
		const bin = await connectClient(server.wsUrl, [CAP]);
		const json = await connectClient(server.wsUrl, []); // no capability -> JSON cohort

		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1, n: 42 }, sharedCodec());

		// Binary client: a wire-id announce for the topic carrying a SERVER-WIDE id
		// (partitioned above the per-connection id space), then the 0x03 frame.
		await until(() => bin.frames.binary.length >= 1);
		expect(bin.frames.wireIds.length).toBe(1);
		const announced = bin.frames.wireIds[0];
		expect(announced.topic).toBe(TOPIC);
		expect(announced.id).toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);
		const frame = parseBinaryFrame(bin.frames.binary[0]);
		expect(frame).toBeTruthy();
		expect(frame.schemaVersion).toBe(SCHEMA);
		expect(frame.topicId).toBe(announced.id); // the shared id, not a per-connection one
		expect(decodePayload(frame.payload)).toEqual({ event: 'snapshot', data: { tick: 1, n: 42 } });

		// JSON client: the envelope, never a binary frame, carrying the SAME seq.
		await until(() => json.frames.json.length >= 1);
		expect(json.frames.binary.length).toBe(0);
		const env = json.frames.json[0];
		expect(env.topic).toBe(TOPIC);
		expect(env.event).toBe('snapshot');
		expect(env.data).toEqual({ tick: 1, n: 42 });
		expect(frame.seq).toBe(env.seq); // both cohorts carry the one stamped seq
	});

	it('cohorts a NEW binary joiner that subscribes after the topic is already shared', async () => {
		server = await createTestServer({});
		const first = await connectClient(server.wsUrl, [CAP]);
		// First publish promotes the topic to shared + migrates `first`.
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());
		await until(() => first.frames.binary.length >= 1);

		// A new binary client subscribes AFTER the topic is shared - it must be
		// cohorted at subscribe time, not left out.
		const late = await connectClient(server.wsUrl, [CAP]);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());

		await until(() => late.frames.binary.length >= 1);
		const frame = parseBinaryFrame(late.frames.binary[0]);
		expect(decodePayload(frame.payload)).toEqual({ event: 'snapshot', data: { tick: 2 } });
		// `first` received both publishes on its binary wire.
		await until(() => first.frames.binary.length >= 2);
		expect(decodePayload(parseBinaryFrame(first.frames.binary[1]).payload).data).toEqual({ tick: 2 });
	});

	it('an unsubscribed client leaves its cohort and stops receiving shared publishes', async () => {
		server = await createTestServer({});
		const a = await connectClient(server.wsUrl, [CAP]);
		const b = await connectClient(server.wsUrl, [CAP]);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());
		await until(() => a.frames.binary.length >= 1 && b.frames.binary.length >= 1);

		// `b` unsubscribes - leaveSharedCohort drops its cohort memberships.
		b.ws.send(JSON.stringify({ type: 'unsubscribe', topic: TOPIC }));
		await sleep(80);

		server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());
		await until(() => a.frames.binary.length >= 2);
		// `a` got the second publish; `b` did not (it left the cohort).
		expect(decodePayload(parseBinaryFrame(a.frames.binary[1]).payload).data).toEqual({ tick: 2 });
		await sleep(80); // give any stray delivery a chance to (not) arrive
		expect(b.frames.binary.length).toBe(1);
	});

	it('falls back to the per-connection walk when the publish excludes a socket', async () => {
		// excludeWs forces the walk (a single app.publish cannot skip one socket), so
		// delivery still reaches a capable subscriber as binary - just not via cohorts.
		server = await createTestServer({});
		const a = await connectClient(server.wsUrl, [CAP]);
		// Exclude a socket that is not `a` (a fresh fake never delivered to), so `a`
		// still receives. The point is the shared path does not engage with excludeWs.
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec(), { excludeWs: { getUserData() { return {}; } } });
		await until(() => a.frames.binary.length >= 1);
		const frame = parseBinaryFrame(a.frames.binary[0]);
		expect(decodePayload(frame.payload)).toEqual({ event: 'snapshot', data: { tick: 1 } });
	});

	it('a relayed shared publish re-runs the cohort split on the receiving server (clustered path)', async () => {
		// Receiver B: shared codec registered, real binary + JSON clients on TOPIC.
		serverB = await createTestServer({});
		serverB.platform.registerWireCodec(sharedCodec());
		const bBin = await connectClient(serverB.wsUrl, [CAP]);
		const bJson = await connectClient(serverB.wsUrl, []);

		// Origin A: shared codec registered; its relay frames bridge into B.__relayReceive
		// (the cross-worker carry). A has no binary subscribers, so A itself does not
		// cohort - the cohort split happens on B when it re-derives the codec.
		let relayed = null;
		server = await createTestServer({
			__onPublish: (f) => { relayed = f; serverB.platform.__relayReceive(f); }
		});
		server.platform.registerWireCodec(sharedCodec());
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 9 }, sharedCodec());

		// The relay carried the codec fields (registry-gated), not envelope-only.
		expect(relayed).toBeTruthy();
		expect(relayed.capability).toBe(CAP);

		// B re-split into cohorts: the binary client got the 0x03 frame stamped with
		// B's OWN server-wide id and the origin seq; the JSON client got the envelope.
		await until(() => bBin.frames.binary.length >= 1);
		const frame = parseBinaryFrame(bBin.frames.binary[0]);
		expect(frame.topicId).toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);
		expect(frame.seq).toBe(relayed.seq); // origin seq preserved across the relay
		expect(decodePayload(frame.payload)).toEqual({ event: 'snapshot', data: { tick: 9 } });
		await until(() => bJson.frames.json.length >= 1);
		expect(bJson.frames.binary.length).toBe(0);
		expect(bJson.frames.json[0].data).toEqual({ tick: 9 });
	});
});

describe('cohort hooks make the trackedSubscribe membership primitive shared-aware', () => {
	afterEach(() => setCohortHooks(null, null));

	it('trackedSubscribe / trackedUnsubscribe invoke the installed hooks after updating WS_SUBSCRIPTIONS', () => {
		const joins = [];
		const leaves = [];
		setCohortHooks(
			(ws, ud, topic) => joins.push({ topic, inSubs: ud[WS_SUBSCRIPTIONS].has(topic) }),
			(ws, ud, topic) => leaves.push({ topic, inSubs: ud[WS_SUBSCRIPTIONS].has(topic) })
		);
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = { subscribe() {}, unsubscribe() {}, getUserData() { return ud; } };
		trackedSubscribe(ws, 'room');
		trackedUnsubscribe(ws, 'room');
		// The join hook runs AFTER subs.add (so joinSharedCohort sees the membership),
		// the leave hook AFTER subs.delete - matching the production install.
		expect(joins).toEqual([{ topic: 'room', inSubs: true }]);
		expect(leaves).toEqual([{ topic: 'room', inSubs: false }]);
	});

	it('is a no-op with no hooks installed (default membership behavior preserved)', () => {
		setCohortHooks(null, null);
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = { subscribe() {}, unsubscribe() {}, getUserData() { return ud; } };
		expect(() => { trackedSubscribe(ws, 'x'); trackedUnsubscribe(ws, 'x'); }).not.toThrow();
		expect(ud[WS_SUBSCRIPTIONS].has('x')).toBe(false);
	});
});
