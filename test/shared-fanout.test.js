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
import { trackedSubscribe, trackedUnsubscribe, WS_CAPS, WS_COHORT_JOIN, WS_COHORT_LEAVE, WS_PLATFORM, WS_SHARED_COHORTS, WS_SUBSCRIPTIONS } from '../src/runtime/utils.js';

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
	const frames = { wireIds: [], json: [], binary: [], acks: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) { frames.binary.push(new Uint8Array(data)); return; }
		try {
			const obj = JSON.parse(data.toString());
			if (obj && obj.type === 'wire-id') frames.wireIds.push(obj);
			else if (obj && (obj.type === 'subscribed' || obj.type === 'subscribe-denied')) frames.acks.push(obj);
			else if (obj && obj.topic !== undefined && obj.event !== undefined) frames.json.push(obj);
		} catch { /* ignore non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	// Settled by the server's own ack, not by a sleep: the hello is processed
	// ahead of the subscribe on the same socket, so the ack proves both landed.
	ws.send(JSON.stringify({ type: 'subscribe', topic: TOPIC, ref: 1 }));
	await until(() => frames.acks.find((a) => a.ref === 1 && a.type === 'subscribed'));
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

	it('a joiner whose announce the socket refuses past its backpressure limit is served the JSON cohort, not none', async () => {
		server = await createTestServer({});
		const bin = await connectClient(server.wsUrl, [CAP]);
		// A scripted connection shaped like the subset of the socket the cohort
		// join touches: subscribed to TOPIC, capable, and a send that answers 2
		// (dropped past maxBackpressure) to the announce. The harness runs a
		// real uWS app, so a slow reader produces that status on its own; it is
		// scripted here because a real socket cannot be made to refuse one frame
		// on cue.
		const ud = {};
		ud[WS_SUBSCRIPTIONS] = new Set([TOPIC]);
		ud[WS_CAPS] = new Set([CAP]);
		const subscribed = [];
		const sent = [];
		const refused = {
			getUserData() { return ud; },
			send(payload) { sent.push(String(payload)); return 2; },
			subscribe(topic) { subscribed.push(topic); },
			close() { /* server.close() ends every tracked connection */ }
		};
		server.wsConnections.add(refused);

		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());

		// The announce went out and came back refused with the connection still
		// open, so the joiner is put in the JSON cohort rather than left in no
		// cohort at all, which is what production does with the same answer.
		expect(sent.filter((text) => text.includes('"wire-id"')).length).toBe(1);
		expect(subscribed).toEqual([TOPIC + '\0json']);
		expect(ud[WS_SHARED_COHORTS]?.has(TOPIC)).toBeFalsy();
		// The capable neighbour is unaffected: its announce, then the binary frame.
		await until(() => bin.frames.binary.length >= 1);
		expect(bin.frames.wireIds.length).toBe(1);
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
		// Exclude a REAL member, `b`, and hold the server-side socket for it: the
		// harness hands the app the socket in the message hook, and a publish
		// that excluded a fake would pass under either lane. `a` still receives
		// (the walk delivers it) and `b` must not.
		let excluded;
		server = await createTestServer({
			handler: {
				message(ws, { data }) {
					if (JSON.parse(Buffer.from(data).toString()).type === 'mark') excluded = ws;
				}
			}
		});
		const a = await connectClient(server.wsUrl, [CAP]);
		const b = await connectClient(server.wsUrl, [CAP]);
		b.ws.send(JSON.stringify({ type: 'mark' }));
		await until(() => excluded);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec(), { excludeWs: excluded });
		await until(() => a.frames.binary.length >= 1);
		const frame = parseBinaryFrame(a.frames.binary[0]);
		expect(decodePayload(frame.payload)).toEqual({ event: 'snapshot', data: { tick: 1 } });
		await sleep(50);
		expect(b.frames.binary.length, 'the excluded member receives nothing').toBe(0);
		expect(b.frames.json.length).toBe(0);
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

describe('the connection\'s platform makes the trackedSubscribe membership primitive shared-aware', () => {
	it('trackedSubscribe / trackedUnsubscribe run the platform\'s cohort slots after updating WS_SUBSCRIPTIONS', () => {
		const joins = [];
		const leaves = [];
		// The per-connection platform is a clone of the surface's base platform,
		// so the slots are inherited, not own - the lookup must walk the chain.
		const base = {
			[WS_COHORT_JOIN]: (ws, ud, topic) => joins.push({ topic, inSubs: ud[WS_SUBSCRIPTIONS].has(topic) }),
			[WS_COHORT_LEAVE]: (ws, ud, topic) => leaves.push({ topic, inSubs: ud[WS_SUBSCRIPTIONS].has(topic) })
		};
		const ud = { [WS_SUBSCRIPTIONS]: new Set(), [WS_PLATFORM]: Object.create(base) };
		const ws = { subscribe() {}, unsubscribe() {}, getUserData() { return ud; } };
		trackedSubscribe(ws, 'room');
		trackedUnsubscribe(ws, 'room');
		// The join runs AFTER subs.add (so joinSharedCohort sees the membership),
		// the leave AFTER subs.delete - as both surfaces install them.
		expect(joins).toEqual([{ topic: 'room', inSubs: true }]);
		expect(leaves).toEqual([{ topic: 'room', inSubs: false }]);
	});

	it('changes membership only on a platform without the slots, or with no platform', () => {
		for (const platform of [{}, undefined]) {
			const ud = { [WS_SUBSCRIPTIONS]: new Set(), [WS_PLATFORM]: platform };
			const ws = { subscribe() {}, unsubscribe() {}, getUserData() { return ud; } };
			expect(trackedSubscribe(ws, 'x')).toBe(true);
			expect(ud[WS_SUBSCRIPTIONS].has('x')).toBe(true);
			expect(trackedUnsubscribe(ws, 'x')).toBe(true);
			expect(ud[WS_SUBSCRIPTIONS].has('x')).toBe(false);
		}
	});
});

describeUWS('a tracked join on createTestServer joins that server\'s cohort', () => {
	// The helper sockets live on the server; a plugin reaches them through its
	// own hook, so the case subscribes from inside the server's message hook.
	// Every operation is answered once it has run, so a case waits for the
	// answer instead of sleeping: a frame the operation sends leaves before its
	// answer on the same connection, so a count read after the answer is final.
	const pluginServer = () => createTestServer({
		handler: {
			message(ws, { data, platform }) {
				const msg = JSON.parse(Buffer.from(data).toString());
				if (msg.type === 'plugin-join') trackedSubscribe(ws, msg.topic);
				if (msg.type === 'plugin-leave') trackedUnsubscribe(ws, msg.topic);
				platform.send(ws, 'probe', 'done', { nonce: msg.nonce });
			}
		}
	});

	/** A capable client that holds no wire subscription to TOPIC. */
	async function bareClient(url) {
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(url);
		const frames = { wireIds: [], json: [], binary: [], done: [] };
		ws.on('message', (data, isBinary) => {
			if (isBinary) { frames.binary.push(new Uint8Array(data)); return; }
			try {
				const obj = JSON.parse(data.toString());
				if (obj?.type === 'wire-id') frames.wireIds.push(obj);
				else if (obj?.topic === 'probe') frames.done.push(obj.data.nonce);
				else if (obj?.topic !== undefined && obj?.event !== undefined) frames.json.push(obj);
			} catch { /* not JSON */ }
		});
		await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
		ws.send(JSON.stringify({ type: 'hello', caps: [CAP] }));
		clients.push(ws);
		let nonce = 0;
		/** Run a plugin operation on the server and wait until it has. */
		const op = async (type, topic = TOPIC) => {
			const n = ++nonce;
			ws.send(JSON.stringify({ type, topic, nonce: n }));
			await until(() => frames.done.includes(n));
		};
		return { ws, frames, op };
	}

	/** Wait until every connection on the server has its hello's capability. */
	async function capable(srv) {
		await until(() => srv.wsConnections.size > 0 && [...srv.wsConnections].every((x) => x.getUserData()[WS_CAPS]?.has(CAP)));
	}

	afterEach(async () => {
		for (const ws of clients) { try { ws.close(); } catch { /* already closed */ } }
		clients = [];
		await server?.close();
		server = null;
		await serverB?.close();
		serverB = null;
	});

	it('announces the shared id once and delivers one binary frame per publish, and a second tracked join adds nothing', async () => {
		clients = [];
		server = await pluginServer();
		// The topic becomes shared on its first shared publish, which takes the
		// cohort split only once a capable client is connected. It is made
		// shared before anyone holds it, so the tracked join below is the one
		// that must enter it.
		const c = await bareClient(server.wsUrl);
		await capable(server);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 0 }, sharedCodec());
		await c.op('plugin-join');
		expect(c.frames.wireIds).toHaveLength(1);
		expect(c.frames.wireIds[0].id).toBeGreaterThanOrEqual(SHARED_WIRE_ID_BASE);

		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());
		await c.op('noop');
		expect(c.frames.binary).toHaveLength(1);

		await c.op('plugin-join');
		expect(c.frames.wireIds, 'the second join of the held topic announces nothing').toHaveLength(1);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());
		await c.op('noop');
		expect(c.frames.binary, 'one frame per publish').toHaveLength(2);
		expect(c.frames.json, 'and never the envelope beside it').toHaveLength(0);
		expect(parseBinaryFrame(c.frames.binary[1]).topicId).toBe(c.frames.wireIds[0].id);

		// The tracked leave takes it out of both cohorts.
		await c.op('plugin-leave');
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 3 }, sharedCodec());
		await c.op('noop');
		expect(c.frames.binary).toHaveLength(2);
		expect(c.frames.json).toHaveLength(0);
	});

	it('does not join a cohort of another server in the same process', async () => {
		clients = [];
		server = await pluginServer();
		serverB = await pluginServer();
		// Shared on B only. A's tracked join must consult A's registry, where the
		// topic is not shared, and stay a plain subscriber.
		const a = await bareClient(server.wsUrl);
		const b = await bareClient(serverB.wsUrl);
		await capable(server);
		await capable(serverB);
		serverB.platform.publishWire(TOPIC, 'snapshot', { tick: 0 }, sharedCodec());
		// B's own member proves the topic is shared there: its tracked join is
		// announced, so a cohort exists for A's join to stray into.
		await b.op('plugin-join');
		expect(b.frames.wireIds).toHaveLength(1);
		await a.op('plugin-join');
		expect(a.frames.wireIds, 'no announce from a cohort it never entered').toHaveLength(0);
		const ud = [...server.wsConnections][0].getUserData();
		expect(ud[WS_SUBSCRIPTIONS].has(TOPIC), 'the join itself ran').toBe(true);
		expect(ud[WS_SHARED_COHORTS]?.has(TOPIC) ?? false).toBe(false);
	});
});

// The simulator's socket still answers getUserData after close, which a real
// uWS socket does not, so a tracked leave that runs after the close - from a
// continuation of an async close hook - reaches the cohort leave there. The
// close already released the connection's reference; a second release would
// reclaim the id while another member still holds it, and every later shared
// publish would build no frame for that member.
describeUWS('a tracked leave after close in the simulator', () => {
	it('releases nothing the close already released', async () => {
		const { runSim } = await import('../src/sim.js');
		let lateLeave = null;
		let bBinary = -1;
		await runSim({
			handler: {
				message(ws, { data }) {
					const msg = JSON.parse(Buffer.from(data).toString());
					if (msg.type === 'plugin-join') trackedSubscribe(ws, msg.topic);
				},
				close(ws) { lateLeave = () => trackedUnsubscribe(ws, TOPIC); }
			},
			async scenario(api) {
				const a = api.connect();
				const b = api.connect();
				await api.advance(100);
				for (const c of [a, b]) {
					c.send({ type: 'hello', caps: [CAP] });
					c.send({ type: 'plugin-join', topic: TOPIC });
				}
				await api.advance(100);
				// The first shared publish moves both members into the binary cohort.
				api.server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());
				await api.advance(100);
				a.close();
				await api.advance(100);
				expect(lateLeave, 'the close hook ran').toBeTypeOf('function');
				lateLeave();
				api.server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());
				await api.advance(100);
				bBinary = b.frames().filter((f) => f.isBinary).length;
			}
		});
		expect(bBinary, 'the remaining member gets both shared frames').toBe(2);
	});
});
