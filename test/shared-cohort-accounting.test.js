// What a re-join of a shared cohort does, and what the outcome counter counts.
//
// 1. joinSharedCohort acquired a shared wire-id reference on every call, and
//    the cohort set it records membership in is a Set, so a second join of a
//    topic the connection already held (a plugin's trackedSubscribe of a
//    socket the client subscribed over the wire) took a reference the single
//    leave released once. The id then outlived its last member: the egress
//    split over-counted the binary cohort and every later publish built a
//    frame for nobody.
// 2. The same call could leave a connection on BOTH cohorts. A connection
//    whose own first announce was refused past its backpressure limit is
//    served the JSON cohort and recorded in no set, so a later successful
//    join added the binary cohort beside it and that connection received
//    every shared publish twice - as the 0x03 frame and as the envelope.
//    The module's own contract is one cohort per connection; the successful
//    join now moves the connection instead of adding to it.
// 3. The outcome counter is NOT one per logical publish, and the last case
//    here pins that as the contract it is. `ws_publish_outcomes_total` is
//    documented (index.d.ts, README) as the result of each native TopicTree
//    publish: an excluding publish takes the per-socket walk and reports
//    nothing, a batch reports once for the N events its single frame carries,
//    and a publish that splits its topic into cohorts makes one native call
//    per cohort it publishes to and reports one outcome for each. Inside that
//    split the two calls are not symmetric - the binary call is guarded on a
//    live cohort reference, the JSON call is not - so the last two cases pin
//    both numbers it can report. Merging them into one would make this the
//    only lane answering a different question.
//
// Layers: the built cohort module with the real wire-id table, the test
// server through what a client can see, and the built runtime's own /metrics
// scrape.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
import { trackedSubscribe, WS_CAPS, WS_STATS, WS_SHARED_COHORTS } from '../src/runtime/utils.js';

const describeUWS = hasUWS ? describe : describe.skip;
const CAP = 'fixture.shared:1';
const TOPIC = 'cohort-accounting';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(pred, what = 'the condition', timeout = 3000, step = 20) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = pred();
		if (value) return value;
		// Named, because every wait here is for something the server should
		// have sent: a bare timeout says which line stopped, never which frame
		// never came.
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
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
	// The ack, not merely an answer: `subscribe-denied` carries the same ref,
	// and settling on one would let a denied client go on to fail somewhere
	// further away from the reason.
	await until(() => frames.acks.find((a) => a.ref === 1 && a.type === 'subscribed'), `the subscribed ack for ${topic}`);
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

	/**
	 * A socket the cohort module can drive. `sendResult` is what uWS's own
	 * `send` returns: 1 for written, 2 for refused past the backpressure
	 * limit, which is the refusal `sendControl` maps to CONTROL_REFUSED.
	 * `topics` is the membership as the native layer would hold it.
	 */
	function fakeSocket(sendResult = 1) {
		const ud = { [WS_CAPS]: new Set([CAP]), [WS_STATS]: { messagesOut: 0, bytesOut: 0 } };
		const sent = [];
		const topics = new Set();
		const ws = {
			sendResult,
			getUserData: () => ud,
			send(payload) { sent.push(payload); return ws.sendResult; },
			subscribe(t) { topics.add(t); return true; },
			unsubscribe(t) { topics.delete(t); return true; }
		};
		return { ws, ud, sent, topics, cohorts: () => [...topics].map((t) => t.slice(t.indexOf('\0') + 1)) };
	}

	it('a second join of a held topic acquires nothing and announces nothing', () => {
		const { ws, ud, sent, cohorts } = fakeSocket();
		cohort.joinSharedCohort(ws, ud, TOPIC, CAP);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(1);
		expect(sent.filter((p) => p.includes('"wire-id"'))).toHaveLength(1);
		expect(ud[WS_SHARED_COHORTS].has(TOPIC)).toBe(true);
		expect(cohorts()).toEqual(['bin']);

		cohort.joinSharedCohort(ws, ud, TOPIC, CAP);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(1);
		expect(sent.filter((p) => p.includes('"wire-id"'))).toHaveLength(1);
		expect(cohorts()).toEqual(['bin']);
	});

	it('a join after a refused announce moves the connection instead of adding to it', () => {
		// The refusal path serves JSON and records no membership, so the later
		// join is the first one the set knows about. Without the move, the
		// connection sits on both cohorts and every shared publish reaches it
		// twice - as the 0x03 frame and as the envelope.
		const socket = fakeSocket(2);
		cohort.joinSharedCohort(socket.ws, socket.ud, TOPIC, CAP);
		expect(socket.cohorts(), 'a refused announce is served JSON').toEqual(['json']);
		expect(table.sharedWireIdRefs(TOPIC), 'the refused announce hands its reference back').toBe(0);
		expect(socket.ud[WS_SHARED_COHORTS]).toBeUndefined();

		socket.ws.sendResult = 1;
		cohort.joinSharedCohort(socket.ws, socket.ud, TOPIC, CAP);
		expect(socket.cohorts(), 'exactly one cohort per connection').toEqual(['bin']);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(1);
	});

	it('a connection without the capability is served JSON and holds no reference', () => {
		const socket = fakeSocket();
		socket.ud[WS_CAPS] = new Set();
		cohort.joinSharedCohort(socket.ws, socket.ud, TOPIC, CAP);
		expect(socket.cohorts()).toEqual(['json']);
		expect(table.sharedWireIdRefs(TOPIC)).toBe(0);
		expect(socket.sent).toEqual([]);
	});

	it('a member that loses its capability is moved out of the binary cohort, not added to JSON', async () => {
		// The case the fresh-socket one above structurally cannot reach: this
		// connection IS in the binary cohort when the JSON branch runs. Both
		// ways in are the connection's own history, not a test contrivance - a
		// re-sent hello REPLACES the capability set, and a refused per-
		// connection announce poisons the capability - and the re-join is the
		// same plugin trackedSubscribe the held-topic guard above is about.
		// Left on both cohorts, this connection receives every shared publish
		// twice, and the egress split keeps charging it as a binary member.
		const wireState = await import('./fixture/build/handler/wire-state.js');
		for (const lose of [
			(socket) => { socket.ud[WS_CAPS] = new Set(); },
			(socket) => wireState.poisonWireState(socket.ws, socket.ud, CAP)
		]) {
			const socket = fakeSocket();
			cohort.joinSharedCohort(socket.ws, socket.ud, TOPIC, CAP);
			expect(socket.cohorts()).toEqual(['bin']);
			expect(table.sharedWireIdRefs(TOPIC)).toBe(1);

			lose(socket);
			cohort.joinSharedCohort(socket.ws, socket.ud, TOPIC, CAP);
			expect(socket.cohorts(), 'exactly one cohort per connection').toEqual(['json']);
			expect(table.sharedWireIdRefs(TOPIC), 'the binary cohort no longer counts it').toBe(0);
			expect(socket.ud[WS_SHARED_COHORTS].has(TOPIC), 'and neither does the membership set').toBe(false);
			table._resetSharedWireIds();
		}
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

describeUWS('the test server announces one wire id per cohort membership', () => {
	let server;
	const clients = [];

	afterEach(async () => {
		for (const c of clients) c.close();
		clients.length = 0;
		await server?.close();
		server = null;
	});

	// A client cannot re-join a topic its connection already holds: all three
	// lanes that could answer the held topic first, each mirroring
	// runtime/handler.js - `platform.subscribe` returns on `subs.has(topic)`,
	// the single recover lane re-checks after its resume await and acks, and
	// the batch landing reads its own per-iteration `held` before joining. A
	// plugin's trackedSubscribe can: it reaches the harness's cohort join through
	// the platform slot, so the held-topic guard in `joinCohortT` is what keeps
	// this re-join to one announce. What the client sees here is that guard:
	// one announce per membership, and a fresh id for the cohort that forms
	// after the last member left - which happens only if the reference count
	// really reached zero.
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
		await until(() => a.frames.binary.length >= 1, 'the first shared frame');
		expect(a.frames.wireIds).toHaveLength(1);
		const firstId = a.frames.wireIds[0].id;

		// A plugin-style tracked join of the held topic is idempotent on the
		// registry and reaches the cohort join, which must not announce again.
		a.send({ type: 'tracked-join', topic: TOPIC });
		const joined = await until(() => a.frames.probes.find((p) => p.event === 'tracked-joined'), 'the tracked-join answer');
		expect(joined.data.ok).toBe(true);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 2 }, sharedCodec());
		await until(() => a.frames.binary.length >= 2, 'the second shared frame');
		expect(a.frames.wireIds).toHaveLength(1);

		a.send({ type: 'unsubscribe', topic: TOPIC });
		await sleep(50);
		const b = await connectClient(server.wsUrl, [CAP]);
		clients.push(b);
		await until(() => b.frames.wireIds.length >= 1, 'the new cohort announce');
		expect(b.frames.wireIds[0].id, 'a reclaimed id is retired, so the next cohort draws a new one').not.toBe(firstId);
		server.platform.publishWire(TOPIC, 'snapshot', { tick: 3 }, sharedCodec());
		await until(() => b.frames.binary.length >= 1, 'a shared frame on the new id');
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

describeUWS('the outcome counter counts native calls, not logical publishes', () => {
	let server;
	let client;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'metrics' });
	}, 400000);

	afterAll(async () => {
		client?.close();
		await server?.stop();
	});

	it('a shared publish reports both of its native calls, and the empty cohort is one of them', async () => {
		client = await connectClient(server.wsUrl, [CAP]);
		// The first shared publish marks the topic shared and cohorts the
		// existing subscriber; its own outcomes land in the before-scrape.
		client.send({ type: 'shared-publish', topic: TOPIC, n: 1 });
		await until(() => client.frames.binary.length >= 1, 'the first shared frame');

		const before = await scrapeLabelled(server.httpUrl);
		client.send({ type: 'shared-publish', topic: TOPIC, n: 2 });
		await until(() => client.frames.binary.length >= 2, 'the measured shared frame');
		const after = await scrapeLabelled(server.httpUrl);

		// TWO, and the trade is deliberate. The one capable member puts every
		// subscriber in the binary cohort, so the JSON call finds nobody and
		// records `no_subscribers` beside the binary call's `delivered`. That
		// is what a per-native-call counter says, and index.d.ts and the README
		// say it: an excluding publish reports nothing at all, a batch reports
		// once for N events. An operator reads `no_subscribers` on a shared
		// topic as "one cohort is empty" and takes the publish count from
		// `ws_publishes_total`. Merging these two into one would leave this the
		// only lane answering a different question, so the number is a
		// contract, not an accident, and a change to it is a change to the
		// metric. Note WHICH cohort being empty makes it two: the JSON publish
		// is unconditional, so an empty JSON cohort still costs its call and
		// its `no_subscribers` - as it does here. A topic with no binary
		// cohort reports ONE, because that call is the guarded one.
		expect(outcomesTotal(before), 'the first shared publish must already have been counted').toBeGreaterThan(0);
		expect(outcomesTotal(after) - outcomesTotal(before)).toBe(2);
	});

	it('the same split reports one once its binary cohort is empty', async () => {
		// The other number the split can report, and the case has to reach the
		// SPLIT to say anything about it: with no connection advertising the
		// capability at all, `publishWire` takes the JSON fast path above the
		// split instead (platform.js, `!capCounts.has(wire.capability)`), which
		// also makes one call - so a caps-less client alone would measure 1 and
		// prove nothing about the branch under test.
		//
		// So: a capable client forms the binary cohort on its own topic, then
		// UNSUBSCRIBES. Its connection stays open, so the capability count
		// still routes the publish into the split; its reference is released,
		// so the binary call inside the split is skipped. The binary frame it
		// received before unsubscribing is what proves the cohort had formed.
		const topic = 'cohort-emptied';
		const capable = await connectClient(server.wsUrl, [CAP], topic);
		const jsonOnly = await connectClient(server.wsUrl, [], topic);
		try {
			capable.send({ type: 'shared-publish', topic, n: 1 });
			await until(() => capable.frames.binary.length >= 1, 'the binary frame that proves the cohort formed');
			await until(() => jsonOnly.frames.json.length >= 1, 'the envelope on the JSON cohort');
			expect(jsonOnly.frames.binary, 'a JSON-only client is sent the envelope, never the frame').toHaveLength(0);
			expect(jsonOnly.frames.wireIds, 'and is announced no shared id').toHaveLength(0);

			capable.send({ type: 'unsubscribe', topic });
			await sleep(60);

			const before = await scrapeLabelled(server.httpUrl);
			jsonOnly.send({ type: 'shared-publish', topic, n: 2 });
			await until(() => jsonOnly.frames.json.length >= 2, 'the measured shared envelope');
			const after = await scrapeLabelled(server.httpUrl);

			expect(outcomesTotal(after) - outcomesTotal(before), 'the emptied binary cohort costs no call').toBe(1);
			expect(capable.frames.binary, 'and the departed member is sent nothing more').toHaveLength(1);
		} finally {
			jsonOnly.close();
			capable.close();
		}
	});
});
