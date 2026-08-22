// Publish-egress ceilings driven through createTestServer - the real fan-out
// entry points over real uWS sockets. What is asserted is what a CALLER of
// the platform observes (return values, delivered frames) plus the harness's
// live egress totals and a metrics registry counter, never internal state
// reached around the API.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer } from '../src/testing.js';
import { WebSocket } from 'ws';

/** @type {Array<{ close(): void }>} */
const servers = [];
/** @type {WebSocket[]} */
const clients = [];

afterEach(async () => {
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await sleep(30);
	for (const s of servers.splice(0)) { try { s.close(); } catch { /* closed */ } }
	await sleep(30);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function boot(options) {
	const server = await createTestServer(options);
	servers.push(server);
	return server;
}

/**
 * A real client, subscribed to `topic`, optionally advertising binary caps.
 * @param {string} url
 * @param {string} topic
 * @param {string[]} [caps]
 */
async function connect(url, topic, caps) {
	const ws = new WebSocket(url);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	/** @type {Uint8Array[]} */
	const binary = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) { binary.push(new Uint8Array(data)); return; }
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
	if (topic) ws.send(JSON.stringify({ type: 'subscribe', topic }));
	await sleep(120);
	return { ws, frames, binary };
}

/** A registry double that records counter increments by name and labels. */
function recordingMetrics() {
	/** @type {Array<{ name: string, labels: any }>} */
	const incs = [];
	return {
		incs,
		counter(name) {
			return { inc: (labels) => incs.push({ name, labels }) };
		},
		gauge() { return { set() {} }; },
		histogram() { return { observe() {} }; }
	};
}

describe('topic ceilings refuse pre-hoc through the real publish entry point', () => {
	it('a messages ceiling refuses the crossing publish, moves the counter, and delivers nothing', async () => {
		const metrics = recordingMetrics();
		const server = await boot({ metrics, egress: { windowMs: 60000, topic: { messages: 2 } } });
		const c = await connect(server.wsUrl, 'feed');

		expect(server.platform.publish('feed', 'e', { n: 1 })).toBe(true);
		expect(server.platform.publish('feed', 'e', { n: 2 })).toBe(true);
		expect(server.platform.publish('feed', 'e', { n: 3 })).toBe(false);

		await sleep(120);
		const delivered = c.frames.filter((f) => f.topic === 'feed');
		expect(delivered.map((f) => f.data.n)).toEqual([1, 2]);
		expect(server.platform.pressure.egress.refusedTopic).toBe(1);
		expect(metrics.incs).toContainEqual({ name: 'egress_refused_total', labels: { scope: 'topic' } });
	});

	it('a deliveries ceiling refuses a publish that would cross it before any frame', async () => {
		const server = await boot({ egress: { windowMs: 60000, topic: { deliveries: 1 } } });
		const a = await connect(server.wsUrl, 'feed');
		const b = await connect(server.wsUrl, 'feed');

		// Two recipients would cross the 1-delivery ceiling: refused whole,
		// with neither client receiving anything - no mid-walk shedding.
		expect(server.platform.publish('feed', 'e', { n: 1 })).toBe(false);
		await sleep(120);
		expect(a.frames.filter((f) => f.topic === 'feed')).toEqual([]);
		expect(b.frames.filter((f) => f.topic === 'feed')).toEqual([]);
		expect(server.platform.pressure.egress.refusedTopic).toBe(1);
	});

	it('the bytes ceiling admits the crossing publish and refuses from the next', async () => {
		const server = await boot({ egress: { windowMs: 60000, topic: { bytes: 10 } } });
		await connect(server.wsUrl, 'feed');
		expect(server.platform.publish('feed', 'e', { pad: 'x'.repeat(64) })).toBe(true);
		expect(server.platform.publish('feed', 'e', { n: 2 })).toBe(false);
	});

	it('an under-ceiling workload passes untouched and the window rotates', async () => {
		const server = await boot({ egress: { windowMs: 100, topic: { messages: 1 } } });
		await connect(server.wsUrl, 'feed');
		expect(server.platform.publish('feed', 'e', null)).toBe(true);
		expect(server.platform.publish('feed', 'e', null)).toBe(false);
		await sleep(150);
		expect(server.platform.publish('feed', 'e', null)).toBe(true);
	});

	it('increments egress_window_evicted_total when the ledger drops a live window', async () => {
		// The counter exists because the symptom of an evicted window is FEWER
		// refusals, which reads exactly like traffic that fits. This drives the
		// real registry through the real publish entry point rather than the
		// ledger's hook, so the wiring between them is covered too.
		const metrics = recordingMetrics();
		const server = await boot({ metrics, egress: { windowMs: 60000, topic: { messages: 4 } } });

		// More distinct live topics inside one window than the ledger's key cap.
		// No subscriber is needed: a publish to a topic nobody holds still seats
		// and charges its window.
		for (let i = 0; i < 4600; i++) server.platform.publish('t:' + i, 'e', null);

		const evictions = metrics.incs.filter((e) => e.name === 'egress_window_evicted_total');
		expect(evictions.length, 'a saturated ledger must report the windows it gave up').toBeGreaterThan(0);
		expect(evictions.every((e) => e.labels.scope === 'topic')).toBe(true);
	});

	it('refuses a crossing publish however a caller names the batch-admission marker', async () => {
		// The marker that lets a batch entry charge without re-deciding is a
		// module-private Symbol precisely so it cannot arrive on
		// caller-supplied options: a string key would hand every server-side
		// publish a documented way past every ceiling, and a Symbol.for key
		// would hand it to anyone who can guess the registry name.
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 1 } } });
		const c = await connect(server.wsUrl, 'feed');
		expect(server.platform.publish('feed', 'e', { n: 1 })).toBe(true);

		const forgeries = [
			{ _egressAdmitted: true },
			{ EGRESS_ADMITTED: true },
			{ egressAdmitted: true },
			{ [Symbol.for('adapter-uws.egress-admitted')]: true },
			{ [Symbol('adapter-uws.egress-admitted')]: true }
		];
		for (const options of forgeries) {
			expect(server.platform.publish('feed', 'e', { n: 2 }, options)).toBe(false);
		}

		await sleep(120);
		const delivered = c.frames.filter((f) => f.topic === 'feed');
		expect(delivered.map((f) => f.data.n)).toEqual([1]);
	});
});

describe('the charge is serialized bytes times recipients', () => {
	const MULTIBYTE_ENVELOPE = '{"topic":"feed","event":"e","data":{"v":"ä"}}';

	it('a BYTES ceiling charges the envelope UTF-8 bytes for every subscriber', async () => {
		// A byte budget must not under-count a multi-byte payload, so an account
		// with a bytes ceiling measures the encoded length. `ä` is one character
		// and two bytes, which is exactly the gap a char-length charge misses.
		const server = await boot({ egress: { topic: { bytes: 1_000_000 } } });
		await connect(server.wsUrl, 'feed');
		await connect(server.wsUrl, 'feed');

		const before = { ...server.platform.pressure.egress };
		expect(server.platform.publish('feed', 'e', { v: 'ä' }, { seq: false })).toBe(true);
		const after = server.platform.pressure.egress;
		expect(after.deliveries - before.deliveries).toBe(2);
		expect(after.bytes - before.bytes).toBe(Buffer.byteLength(MULTIBYTE_ENVELOPE) * 2);
		expect(Buffer.byteLength(MULTIBYTE_ENVELOPE)).toBe(MULTIBYTE_ENVELOPE.length + 1);
	});

	it('an account with no BYTES ceiling charges the character length and pays no walk', async () => {
		// With nothing deciding on the value, measuring encoded length is
		// O(envelope) on the hottest primitive in the adapter for a number
		// nothing reads. The unit is then the character length - identical for
		// the ASCII envelopes the adapter builds, and free.
		const server = await boot({});
		await connect(server.wsUrl, 'feed');
		await connect(server.wsUrl, 'feed');

		const before = { ...server.platform.pressure.egress };
		expect(server.platform.publish('feed', 'e', { v: 'ä' }, { seq: false })).toBe(true);
		const after = server.platform.pressure.egress;
		expect(after.deliveries - before.deliveries).toBe(2);
		expect(after.bytes - before.bytes).toBe(MULTIBYTE_ENVELOPE.length * 2);
	});

	it('an ASCII envelope charges the same either way', async () => {
		// The approximation is only ever an approximation for non-ASCII: the
		// two units must not diverge on the payloads apps actually send.
		const armed = await boot({ egress: { topic: { bytes: 1_000_000 } } });
		await connect(armed.wsUrl, 'feed');
		const beforeArmed = { ...armed.platform.pressure.egress };
		expect(armed.platform.publish('feed', 'e', { v: 'plain' }, { seq: false })).toBe(true);
		const armedBytes = armed.platform.pressure.egress.bytes - beforeArmed.bytes;

		const bare = await boot({});
		await connect(bare.wsUrl, 'feed');
		const beforeBare = { ...bare.platform.pressure.egress };
		expect(bare.platform.publish('feed', 'e', { v: 'plain' }, { seq: false })).toBe(true);
		expect(bare.platform.pressure.egress.bytes - beforeBare.bytes).toBe(armedBytes);
	});

	it('excludeWs reduces the walk-path charge by exactly the excluded subscriber', async () => {
		const server = await boot({});
		const excluded = await connect(server.wsUrl, 'feed');
		await connect(server.wsUrl, 'feed');
		await connect(server.wsUrl, 'feed');

		// The exclusion needs the SERVER-side socket for the client's
		// connection; take it from the subscriber walk.
		/** @type {any} */
		let serverSideExcluded = null;
		let seen = 0;
		server.platform.forEachSubscriber('feed', (ws) => { if (seen++ === 0) serverSideExcluded = ws; });
		expect(serverSideExcluded).not.toBeNull();
		void excluded;

		const wire = { capability: 'egress-x', schemaVersion: 1, encode: () => null };
		const before = { ...server.platform.pressure.egress };
		server.platform.publishWire('feed', 'e', { n: 1 }, wire, { seq: false, excludeWs: serverSideExcluded });
		const after = server.platform.pressure.egress;
		expect(after.deliveries - before.deliveries).toBe(2);
	});

	it('a binary walk charges the 0x03 frame bytes, not the JSON envelope', async () => {
		const server = await boot({});
		const cap = 'egress-bin';
		const payload = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
		const wire = { capability: cap, schemaVersion: 1, encode: () => payload };
		const binaryClient = await connect(server.wsUrl, 'feed', [cap]);

		const before = { ...server.platform.pressure.egress };
		expect(server.platform.publishWire('feed', 'e', { big: 'x'.repeat(200) }, wire, { seq: false })).toBe(true);
		const after = server.platform.pressure.egress;
		// One recipient, frame = tag + schemaVersion + id varint + seq varint
		// + payload = 3 + 1 + 8. The 200-char JSON envelope must NOT be the
		// charged size on this lane.
		expect(after.deliveries - before.deliveries).toBe(1);
		expect(after.bytes - before.bytes).toBe(12);
		await sleep(120);
		expect(binaryClient.binary.length).toBeGreaterThan(0);
	});

	it('a batched fast path charges per event at the shared recipient set', async () => {
		const server = await boot({});
		await connect(server.wsUrl, 'feed', ['batch']);
		await connect(server.wsUrl, 'feed', ['batch']);

		const before = { ...server.platform.pressure.egress };
		server.platform.publishBatched([
			{ topic: 'feed', event: 'a', data: { n: 1 }, options: { seq: false } },
			{ topic: 'feed', event: 'b', data: { n: 2 }, options: { seq: false } },
			{ topic: 'feed', event: 'c', data: { n: 3 }, options: { seq: false } }
		]);
		const after = server.platform.pressure.egress;
		expect(after.deliveries - before.deliveries).toBe(6);
	});
});

describe('batch and direct lanes refuse as one pre-hoc decision', () => {
	it('publishBatched refuses the whole fast-path batch and delivers nothing', async () => {
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 2 } } });
		const c = await connect(server.wsUrl, 'feed', ['batch']);
		server.platform.publishBatched([
			{ topic: 'feed', event: 'a', data: { n: 1 }, options: { seq: false } },
			{ topic: 'feed', event: 'b', data: { n: 2 }, options: { seq: false } },
			{ topic: 'feed', event: 'c', data: { n: 3 }, options: { seq: false } }
		]);
		await sleep(120);
		expect(c.frames.filter((f) => f.type === 'batch' || f.topic === 'feed')).toEqual([]);
		expect(server.platform.pressure.egress.refusedTopic).toBe(1);
	});

	it('sendTo is refused whole and returns 0', async () => {
		const server = await boot({ egress: { windowMs: 60000, topic: { deliveries: 1 } } });
		const a = await connect(server.wsUrl, 'feed');
		const b = await connect(server.wsUrl, 'feed');
		expect(server.platform.sendTo(() => true, 'feed', 'e', { n: 1 })).toBe(0);
		await sleep(120);
		expect(a.frames.filter((f) => f.topic === 'feed')).toEqual([]);
		expect(b.frames.filter((f) => f.topic === 'feed')).toEqual([]);
	});

	it('adviseReconnect sits outside every ceiling: an operator drain is never refused', async () => {
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 1, deliveries: 1, bytes: 1 } } });
		const a = await connect(server.wsUrl, 'feed');
		const advised = server.platform.adviseReconnect({ windowMs: 5000, close: false });
		expect(advised).toBe(1);
		await sleep(120);
		expect(a.frames.some((f) => f.type === 'reconnect')).toBe(true);
	});
});

describe('tenant attribution', () => {
	it('egressTenantOf pools topics under one tenant ceiling; unattributed topics stay outside it', async () => {
		const server = await boot({
			egress: { windowMs: 60000, tenant: { messages: 2 } },
			handler: { egressTenantOf: (topic) => (topic.startsWith('acme/') ? 'acme' : null) }
		});
		await connect(server.wsUrl, 'acme/a');
		await connect(server.wsUrl, 'acme/b');
		await connect(server.wsUrl, 'free/z');

		expect(server.platform.publish('acme/a', 'e', null, { seq: false })).toBe(true);
		expect(server.platform.publish('acme/b', 'e', null, { seq: false })).toBe(true);
		expect(server.platform.publish('acme/a', 'e', null, { seq: false })).toBe(false);
		expect(server.platform.pressure.egress.refusedTenant).toBe(1);
		// Unattributed traffic hits only topic ceilings, and none is set.
		for (let i = 0; i < 5; i++) {
			expect(server.platform.publish('free/z', 'e', null, { seq: false })).toBe(true);
		}
	});

	it('the game lane charges the SENDER attribution tenant, not the topic resolver', async () => {
		const server = await boot({
			egress: { windowMs: 60000, tenant: { messages: 1 } },
			handler: {
				// The topic resolver names a DIFFERENT tenant on purpose: if the
				// game lane consulted it, the wrong window would fill.
				egressTenantOf: () => 'globex',
				attribution: (user) => (user.tenant ? { tenantId: user.tenant } : null),
				upgrade: ({ headers }) => ({ tenant: headers['x-tenant'] || '' })
			}
		});

		const sender = new WebSocket(server.wsUrl, { headers: { 'x-tenant': 'acme' } });
		clients.push(sender);
		await new Promise((resolve, reject) => { sender.on('open', resolve); sender.on('error', reject); });
		sender.send(JSON.stringify({ type: 'subscribe', topic: 'room' }));
		const receiver = await connect(server.wsUrl, 'room');
		await sleep(120);

		/** @type {any} */
		let senderWs = null;
		server.platform.forEachSubscriber('room', (ws, ud) => { if (ud.tenant === 'acme') senderWs = ws; });
		expect(senderWs).not.toBeNull();

		const first = server.platform.publishGame(senderWs, 'room', 'input', { n: 1 }, 7);
		expect(first.delivered).toBe(1);
		const second = server.platform.publishGame(senderWs, 'room', 'input', { n: 2 }, 8);
		expect(second).toEqual({ seq: null, delivered: 0 });
		expect(server.platform.pressure.egress.refusedTenant).toBe(1);
		await sleep(120);
		const gameFrames = receiver.frames.filter((f) => f.topic === 'room' && f.event === 'input');
		expect(gameFrames.map((f) => f.data.n)).toEqual([1]);
		// globex was never charged by the game lane: the resolver's tenant
		// still has its whole window, so a server-side publish passes once
		// and only then hits the globex ceiling - proving the game lane
		// keyed on the sender's attribution, not the topic resolver.
		expect(server.platform.publish('room', 'e', null, { seq: false })).toBe(true);
		expect(server.platform.publish('room', 'e', null, { seq: false })).toBe(false);
	});
});

describe('the relay lanes are exempt', () => {
	it('a relayed wire frame is re-encoded locally even while the topic ceiling refuses origin publishes', async () => {
		const cap = 'egress-relay';
		const payload = Uint8Array.of(9, 9, 9);
		const wire = { capability: cap, schemaVersion: 1, encode: () => payload };
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 1 } } });
		server.platform.registerWireCodec(wire);
		const binaryClient = await connect(server.wsUrl, 'feed', [cap]);

		// Exhaust the topic window with an origin publish...
		expect(server.platform.publishWire('feed', 'a', { n: 1 }, wire, { seq: false })).toBe(true);
		expect(server.platform.publishWire('feed', 'b', { n: 2 }, wire, { seq: false })).toBe(false);
		const refusedBefore = server.platform.pressure.egress.refusedTopic;

		// ...then deliver a RELAYED frame for the same topic: never refused,
		// never charged (the origin worker already charged it).
		const before = { ...server.platform.pressure.egress };
		expect(server.platform.relayPublishWire('feed', 'c', { n: 3 }, cap, 41)).toBe(true);
		const after = server.platform.pressure.egress;
		expect(after.deliveries).toBe(before.deliveries);
		expect(after.bytes).toBe(before.bytes);
		expect(after.refusedTopic).toBe(refusedBefore);

		await sleep(120);
		// The client received the origin frame AND the relayed frame.
		expect(binaryClient.binary.length).toBe(2);
	});
});

describe('a batch is admitted whole or not at all', () => {
	it('a stateless-codec batch over the ceiling delivers nothing and reports the refusal', async () => {
		// A stateless codec routes the batch through the per-entry publish
		// path. Deciding per entry there would deliver a PREFIX of the batch
		// and still answer the caller truthfully-looking - the mid-batch
		// shedding this budget forbids, indistinguishable from success.
		const cap = 'egress-stateless-batch';
		const wire = { capability: cap, schemaVersion: 1, encode: () => Uint8Array.of(1) };
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 3 } } });
		server.platform.registerWireCodec(wire);
		const client = await connect(server.wsUrl, 'feed');

		const entries = [1, 2, 3, 4, 5].map((n) => ({ data: { n } }));
		expect(server.platform.publishWireBatch('feed', 'e', entries, wire, { seq: false })).toBe(false);
		expect(server.platform.pressure.egress.refusedTopic).toBe(1);
		await sleep(120);
		expect(client.frames.filter((f) => f.topic === 'feed' && f.event === 'e')).toEqual([]);

		// A batch that fits is delivered whole.
		const fits = [1, 2].map((n) => ({ data: { n } }));
		expect(server.platform.publishWireBatch('feed', 'e', fits, wire, { seq: false })).toBe(true);
		await sleep(120);
		expect(client.frames.filter((f) => f.topic === 'feed' && f.event === 'e').length).toBe(2);
	});

	it('a mixed-topic batch pools its tenant share across the topics it spans', async () => {
		// One tenant's ceiling covers all of its topics at once. Asking per
		// topic against a window nothing has charged yet let a batch of N
		// topics pass N times against the same allowance.
		const server = await boot({
			egress: { windowMs: 60000, tenant: { messages: 6 } },
			handler: { egressTenantOf: () => 'acme' }
		});
		const client = await connect(server.wsUrl, 'a');
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'b' }));
		await sleep(120);

		// Two topics, five events each: ten messages against a six-message
		// tenant ceiling must refuse the whole batch, not admit both topics
		// against an untouched window.
		const messages = [];
		for (let i = 0; i < 5; i++) messages.push({ topic: 'a', event: 'e', data: { i } });
		for (let i = 0; i < 5; i++) messages.push({ topic: 'b', event: 'e', data: { i } });
		server.platform.publishBatched(messages);
		expect(server.platform.pressure.egress.refusedTenant).toBe(1);
		await sleep(120);
		expect(client.frames.filter((f) => f.event === 'e')).toEqual([]);

		// Under the pooled ceiling the same shape is delivered whole.
		server.platform.publishBatched([
			{ topic: 'a', event: 'ok', data: null },
			{ topic: 'b', event: 'ok', data: null }
		]);
		await sleep(120);
		expect(client.frames.filter((f) => f.event === 'ok').length).toBe(2);
	});
});
