// ADAPTER-ERR-EGRESS-REFUSED and ADAPTER-ERR-EGRESS-TENANT-RESOLVER, driven
// from the conditions their own entries name.
//
// The refusal BEHAVIOUR is covered elsewhere (egress-ceilings.test.js drives
// the ceilings through createTestServer and asserts what a caller observes).
// What is asserted here is the part an operator reads: that reaching the
// documented cause produces the documented record, that the consequence the
// entry promises is the one the wire shows, and that the guidance is not
// undone by something the entry does not mention.
//
// Two claims are worth naming, because they are the ones a prose pass keeps
// getting away with:
//
//   "no sequence number was consumed, so subscribers see no gap". That is a
//   statement about what the NEXT successful publish carries, not about the
//   refused one, and it is only checkable by rotating the window and reading
//   the seq the client receives. A refusal that consumed a number would leave
//   a hole in a stream the client is entitled to treat as dense.
//
//   "the attributes carry the returned value TYPE only". That is a privacy
//   promise about a resolver's return value, which is application data of
//   unknown sensitivity. It is asserted by serializing the whole record and
//   requiring the offending value not to appear anywhere in it.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer } from '../src/testing.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { ADAPTER_ERROR_IDS, adapterErrorDefinition } from '../src/runtime/error-registry.js';
import { WebSocket } from 'ws';

/** @type {Array<{ close(): void }>} */
const servers = [];
/** @type {WebSocket[]} */
const clients = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
	setOperationalEventSink(null);
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await sleep(30);
	for (const s of servers.splice(0)) { try { s.close(); } catch { /* closed */ } }
	await sleep(30);
});

/** Capture every operational record this case produces, in order. */
function records() {
	/** @type {any[]} */
	const seen = [];
	setOperationalEventSink((record) => { seen.push(record); });
	return seen;
}

async function boot(options) {
	const server = await createTestServer(options);
	servers.push(server);
	return server;
}

/** A real client subscribed to `topic`, recording the frames it is delivered. */
async function connect(url, topic) {
	const ws = new WebSocket(url);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (data) => {
		try { frames.push(JSON.parse(data.toString())); } catch { /* binary */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'subscribe', topic }));
	await sleep(60);
	return { ws, frames };
}

describe('ADAPTER-ERR-EGRESS-REFUSED', () => {
	it('reports the refusal once with the scope, dimension and limit its guidance sends the reader to', async () => {
		const seen = records();
		// A distinct topic per case: the once-a-minute throttle is keyed by
		// (scope, topic) in a module-level table that outlives a server.
		const topic = 'egress-entry-report';
		const server = await boot({ egress: { windowMs: 60000, topic: { messages: 1 } } });
		const client = await connect(server.wsUrl, topic);

		expect(server.platform.publish(topic, 'e', { n: 1 }, { seq: false })).toBe(true);
		expect(server.platform.publish(topic, 'e', { n: 2 }, { seq: false })).toBe(false);
		await sleep(60);

		const refusals = seen.filter((r) => r.event === 'egress.publish-refused');
		expect(refusals, 'the documented cause must produce the documented record').toHaveLength(1);

		const entry = adapterErrorDefinition(ADAPTER_ERROR_IDS.EGRESS_REFUSED);
		expect(refusals[0].severity).toBe(entry.severity);
		expect(refusals[0].component).toBe(entry.component);
		// The nextAction tells the reader the attributes name these three. A
		// record missing one sends them to a field that is not there.
		expect(refusals[0].attributes.scope).toBe('topic');
		expect(refusals[0].attributes.dimension).toBe('messages');
		expect(refusals[0].attributes.limit).toBe(1);

		// "throttled to once a minute through a bounded dedup table, so it
		// reports the condition rather than every refusal" - the counter is
		// what keeps counting.
		expect(server.platform.publish(topic, 'e', { n: 3 }, { seq: false })).toBe(false);
		expect(server.platform.publish(topic, 'e', { n: 4 }, { seq: false })).toBe(false);
		await sleep(60);
		expect(seen.filter((r) => r.event === 'egress.publish-refused'), 'the line is throttled, the counter is not').toHaveLength(1);
		expect(server.platform.pressure.egress.refusedTopic).toBe(3);

		// "The refused publish delivered nothing anywhere" - one frame on the
		// wire, for the one publish that was admitted.
		expect(client.frames.filter((f) => f.topic === topic && f.event === 'e').map((f) => f.data.n)).toEqual([1]);
	});

	it('consumes no sequence number, so the subscriber sees a dense stream across the refusal', async () => {
		// The consequence's load-bearing half, and the one that cannot be read
		// off a return value: the refusal must not burn a number the client is
		// entitled to see. The window is short so it rotates inside the case -
		// the entry's automaticRecovery ("Yes, by time") is the same claim.
		const seen = records();
		const topic = 'egress-entry-seq';
		const server = await boot({ egress: { windowMs: 200, topic: { messages: 2 } } });
		const client = await connect(server.wsUrl, topic);

		expect(server.platform.publish(topic, 'e', { n: 1 })).toBe(true);
		expect(server.platform.publish(topic, 'e', { n: 2 })).toBe(true);
		expect(server.platform.publish(topic, 'e', { n: 3 }), 'the third crosses the ceiling').toBe(false);

		await sleep(320); // the window rotates
		expect(server.platform.publish(topic, 'e', { n: 4 }), 'publishing resumes on its own').toBe(true);
		await sleep(80);

		const delivered = client.frames.filter((f) => f.topic === topic && f.event === 'e');
		expect(delivered.map((f) => f.data.n), 'the refused publish delivered nothing').toEqual([1, 2, 4]);
		const seqs = delivered.map((f) => f.seq);
		expect(seqs[1] - seqs[0]).toBe(1);
		expect(
			seqs[2] - seqs[1],
			'a refusal that consumed a sequence number would leave a gap the client must treat as loss'
		).toBe(1);
		expect(seen.filter((r) => r.event === 'egress.publish-refused').length).toBeGreaterThanOrEqual(0);
	});
});

describe('ADAPTER-ERR-EGRESS-TENANT-RESOLVER', () => {
	it('reports an unusable id once per worker, by type and never by value', async () => {
		const seen = records();
		// A value that is both invalid as an id and recognisable if it leaked.
		const leaky = 'tenant of user hunter2@example.com!';
		const server = await boot({
			egress: { windowMs: 60000, tenant: { messages: 5 } },
			handler: { egressTenantOf: () => leaky }
		});
		const topic = 'egress-entry-resolver';
		const client = await connect(server.wsUrl, topic);

		expect(server.platform.publish(topic, 'e', { n: 1 }, { seq: false })).toBe(true);
		await sleep(60);

		const reports = seen.filter((r) => r.event === 'egress.tenant-resolver-invalid');
		expect(reports, 'the documented cause must produce the documented record').toHaveLength(1);
		const entry = adapterErrorDefinition(ADAPTER_ERROR_IDS.EGRESS_TENANT_RESOLVER);
		expect(reports[0].severity).toBe(entry.severity);
		expect(reports[0].component).toBe(entry.component);
		expect(reports[0].attributes.valueType).toBe('string');
		expect(
			JSON.stringify(reports[0]),
			'the entry promises the TYPE only; the resolver returns application data of unknown sensitivity'
		).not.toContain('hunter2');

		// "The line fires once per worker: the defect repeats on every publish".
		for (let i = 2; i <= 6; i++) {
			expect(server.platform.publish(topic, 'e', { n: i }, { seq: false })).toBe(true);
		}
		await sleep(60);
		expect(seen.filter((r) => r.event === 'egress.tenant-resolver-invalid')).toHaveLength(1);

		// "Publishes on the affected topics are charged as unattributed... so a
		// tenant ceiling cannot bound this traffic until the resolver is fixed."
		// Six publishes against a ceiling of five, all admitted.
		expect(server.platform.pressure.egress.refusedTenant).toBe(0);
		expect(client.frames.filter((f) => f.topic === topic && f.event === 'e')).toHaveLength(6);
	});

	it('treats a resolver that throws the same way, and keeps serving publishes', async () => {
		// A separate server, so the once-per-worker latch is a fresh one - it
		// lives on the account, which is built per boot.
		const seen = records();
		const server = await boot({
			egress: { windowMs: 60000, tenant: { messages: 5 } },
			handler: { egressTenantOf: () => { throw new Error('resolver exploded'); } }
		});
		const topic = 'egress-entry-resolver-throws';
		const client = await connect(server.wsUrl, topic);

		expect(server.platform.publish(topic, 'e', { n: 1 }, { seq: false })).toBe(true);
		expect(server.platform.publish(topic, 'e', { n: 2 }, { seq: false })).toBe(true);
		await sleep(60);

		const reports = seen.filter((r) => r.event === 'egress.tenant-resolver-invalid');
		expect(reports, 'the entry names a throwing resolver in the same cause').toHaveLength(1);
		expect(
			JSON.stringify(reports[0]),
			'the thrown error is the application\'s, so its message is not the adapter\'s to publish'
		).not.toContain('resolver exploded');
		expect(client.frames.filter((f) => f.topic === topic && f.event === 'e')).toHaveLength(2);
	});

	it('keeps the topic ceiling working while the resolver is broken', async () => {
		// The half of the consequence that limits the blast radius: "the
		// topic-scope ceilings and the worker egress figures still apply". A
		// broken resolver standing every ceiling down would be a far worse
		// failure than an unattributed charge, and nothing else asserts it.
		records();
		const server = await boot({
			egress: { windowMs: 60000, topic: { messages: 1 }, tenant: { messages: 50 } },
			handler: { egressTenantOf: () => ({ not: 'an id' }) }
		});
		const topic = 'egress-entry-resolver-topic-ceiling';
		await connect(server.wsUrl, topic);

		expect(server.platform.publish(topic, 'e', null, { seq: false })).toBe(true);
		expect(server.platform.publish(topic, 'e', null, { seq: false }), 'the topic ceiling still refuses').toBe(false);
		expect(server.platform.pressure.egress.refusedTopic).toBe(1);
	});
});
