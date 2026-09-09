// Two accounting defects in the shared cohort lane, each pinned where it lives.
//
// 1. platform.publishWire's shared branch reported one publish outcome per
//    COHORT: a delivery for the binary cohort and a no-subscribers for the
//    JSON cohort (or the reverse), while ws_publishes_total advanced by one.
//    Every other exit reports one outcome per logical publish, and the
//    outcome family is documented as summing to the publish family. Pinned
//    on the built runtime through its own /metrics scrape.
// 2. joinSharedCohort acquired a shared wire-id reference on every call, and
//    the cohort set it records membership in is a Set, so a second join of a
//    topic the connection already held (a plugin's trackedSubscribe of a
//    socket the client subscribed over the wire) took a reference the single
//    leave released once. The id then outlived its last member: the egress
//    split over-counted the binary cohort and every later publish built a
//    frame for nobody. Pinned on the built cohort module with the real
//    wire-id table, and on the test server through what a client can see -
//    one announce per membership, and a FRESH id for the next cohort after the
//    last member leaves (a reclaimed id is retired, never reused).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { trackedSubscribe, WS_CAPS, WS_STATS, WS_SHARED_COHORTS } from '../src/runtime/utils.js';

const describeUWS = hasUWS ? describe : describe.skip;
const CAP = 'fixture.shared:1';
const TOPIC = 'cohort-accounting';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(pred, timeout = 3000, step = 20) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = pred();
		if (value) return value;
		if (Date.now() > deadline) throw new Error('until() timed out');
		await sleep(step);
	}
}

/**
 * A real ws client that advertises `caps`, subscribes to `topic` and waits for
 * the ack, recording announces, envelopes, probes and binary frames apart.
 */
async function connectClient(url, caps, topic = TOPIC) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = { wireIds: [], json: [], probes: [], binary: [], acks: [] };
	ws.on('message', (data, isBinary) => {
		if (isBinary) { frames.binary.push(new Uint8Array(data)); return; }
		try {
			const obj = JSON.parse(data.toString());
			if (obj?.type === 'wire-id') frames.wireIds.push(obj);
			else if (obj?.type === 'subscribed' || obj?.type === 'subscribe-denied') frames.acks.push(obj);
			else if (obj?.topic === 'probe') frames.probes.push(obj);
			else if (obj?.topic !== undefined && obj?.event !== undefined) frames.json.push(obj);
		} catch { /* not JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'hello', caps }));
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
	await until(() => frames.acks.find((a) => a.ref === 1));
	return {
		ws, frames,
		send(msg) { ws.send(JSON.stringify(msg)); },
		close() { try { ws.close(); } catch { /* closed */ } }
	};
}

const sharedCodec = () => ({ capability: CAP, schemaVersion: 1, shared: true, encode: () => new Uint8Array([7]) });

describeUWS('joinSharedCohort holds one wire-id reference per membership', () => {
	let cohort;
	let table;

	beforeAll(async () => {
		expect(buildFixtureOnce(), 'fixture build must succeed').toBe(true);
		cohort = await import('./fixture/build/handler/cohort.js');
		table = await import('./fixture/build/handler/shared-wire-id.js');
	}, 400000);

	afterEach(() => { table._resetSharedWireIds(); });

	function fakeSocket() {
		const ud = { [WS_CAPS]: new Set([CAP]), [WS_STATS]: { messagesOut: 0, bytesOut: 0 } };
		const sent = [];
		const subscribed = [];
		const ws = {
			getUserData: () => ud,
			send(payload) { sent.push(payload); return 1; },
			subscribe(t) { subscribed.push(t); return true; },
			unsubscribe() { return true; }
		};
		return { ws, ud, sent, subscribed };
	}

	it('a second join of a held topic acquires nothing and announces nothing', () => {
		const { ws, ud, sent } = fakeSocket();
		cohort.joinSharedCohort(ws, ud, TOPIC, CAP);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(1);
		expect(sent.filter((p) => p.includes('"wire-id"'))).toHaveLength(1);
		expect(ud[WS_SHARED_COHORTS].has(TOPIC)).toBe(true);

		cohort.joinSharedCohort(ws, ud, TOPIC, CAP);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(1);
		expect(sent.filter((p) => p.includes('"wire-id"'))).toHaveLength(1);
	});

	it('the single leave releases the last reference and the id is reclaimed', () => {
		const { ws, ud } = fakeSocket();
		cohort.joinSharedCohort(ws, ud, TOPIC, CAP);
		cohort.joinSharedCohort(ws, ud, TOPIC, CAP);
		const id = table.getSharedWireId(TOPIC);
		expect(id).toBeGreaterThanOrEqual(table.SHARED_WIRE_ID_BASE);

		cohort.leaveSharedCohort(ws, ud, TOPIC);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(0);
		expect(table.getSharedWireId(TOPIC)).toBeUndefined();
		// A later cohort draws a fresh id: the reclaimed one is retired.
		const next = fakeSocket();
		cohort.joinSharedCohort(next.ws, next.ud, TOPIC, CAP);
		expect(table.getSharedWireId(TOPIC)).not.toBe(id);
	});

	it('two members hold two references and leave one at a time', () => {
		const a = fakeSocket();
		const b = fakeSocket();
		cohort.joinSharedCohort(a.ws, a.ud, TOPIC, CAP);
		cohort.joinSharedCohort(b.ws, b.ud, TOPIC, CAP);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(2);
		cohort.leaveSharedCohort(a.ws, a.ud, TOPIC);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(1);
		cohort.leaveSharedCohort(b.ws, b.ud, TOPIC);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(0);
	});
});

describeUWS('the test server keeps one cohort reference per membership', () => {
	let server;
	const clients = [];

	afterEach(async () => {
		for (const c of clients) c.close();
		clients.length = 0;
		await server?.close();
		server = null;
	});

	// The harness installs no cohort hooks on the membership primitive, so a
	// plugin's trackedSubscribe cannot re-join a cohort there and the re-join
	// guard in its join is reached only through what production reaches it
	// by. What a client CAN see the harness prove: one announce per
	// membership, one publish per frame, and a fresh id for the cohort that
	// forms after the last member left - which is only the case when the
	// reference count really reached zero.
	it('announces once per membership and draws a fresh id after the last member leaves', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				message(ws, { data, platform }) {
					const msg = JSON.parse(Buffer.from(data).toString());
					if (msg.type === 'tracked-join') {
						platform.send(ws, 'probe', 'tracked-joined', { ok: trackedSubscribe(ws, msg.topic) });
					}
				}
			}
		});
		const a = await connectClient(server.wsUrl, [CAP]);
		clients.push(a);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 1 }, sharedCodec());
		await until(() => a.frames.binary.length >= 1);
		expect(a.frames.wireIds).toHaveLength(1);
		const firstId = a.frames.wireIds[0].id;

		// A plugin-style tracked join of the held topic is idempotent on the
		// registry and, with no cohort hook installed, touches no cohort.
		a.send({ type: 'tracked-join', topic: TOPIC });
		const joined = await until(() => a.frames.probes.find((p) => p.event === 'tracked-joined'));
		expect(joined.data.ok).toBe(true);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());
		await until(() => a.frames.binary.length >= 2);
		expect(a.frames.wireIds).toHaveLength(1);

		a.send({ type: 'unsubscribe', topic: TOPIC });
		await sleep(50);
		const b = await connectClient(server.wsUrl, [CAP]);
		clients.push(b);
		await until(() => b.frames.wireIds.length >= 1);
		expect(b.frames.wireIds[0].id, 'a reclaimed id is retired, so the next cohort draws a new one').not.toBe(firstId);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 3 }, sharedCodec());
		await until(() => b.frames.binary.length >= 1);
		expect(parseBinaryFrame(b.frames.binary[0]).topicId).toBe(b.frames.wireIds[0].id);
	});
});

async function scrapeLabelled(httpUrl) {
	const text = await (await fetch(httpUrl + '/metrics')).text();
	/** @type {Map<string, number>} */
	const values = new Map();
	for (const line of text.split('\n')) {
		const match = /^([a-z_][a-z0-9_]*)(\{[^}]*\})? (-?\d+(?:\.\d+)?)$/.exec(line);
		if (match) values.set(match[1] + (match[2] ?? ''), Number(match[3]));
	}
	return values;
}

// The fixture's registry aggregates labels, so the family renders as one
// label-less line; a registry that keeps the series apart renders one line per
// outcome. Either way the family total is what a publish advances by one.
const outcomesTotal = (values) => {
	let sum = 0;
	for (const [key, value] of values) {
		if (key === 'ws_publish_outcomes_total' || key.startsWith('ws_publish_outcomes_total{')) sum += value;
	}
	return sum;
};

describeUWS('a shared publish reports one outcome on the built runtime', () => {
	let server;
	let client;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'metrics' });
	}, 400000);

	afterAll(async () => {
		client?.close();
		await server?.stop();
	});

	it('the outcome family advances by one per shared publish, whichever cohorts carried it', async () => {
		client = await connectClient(server.wsUrl, [CAP]);
		// The first shared publish marks the topic shared and cohorts the
		// existing subscriber; its own outcome lands in the before-scrape.
		client.send({ type: 'shared-publish', topic: TOPIC, n: 1 });
		await until(() => client.frames.binary.length >= 1);

		const before = await scrapeLabelled(server.httpUrl);
		client.send({ type: 'shared-publish', topic: TOPIC, n: 2 });
		await until(() => client.frames.binary.length >= 2);
		const after = await scrapeLabelled(server.httpUrl);

		// One capable member: the binary cohort delivered, the JSON cohort was
		// empty. Reported per cohort, that read as delivered PLUS
		// no_subscribers for one publish. (ws_publishes_total is folded in from
		// the pressure sampler's window, so it is not read here per publish.)
		expect(outcomesTotal(before), 'the first shared publish must already have been counted').toBeGreaterThan(0);
		expect(outcomesTotal(after) - outcomesTotal(before)).toBe(1);
	});
});
