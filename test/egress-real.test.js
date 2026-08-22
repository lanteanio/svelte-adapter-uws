// Publish-egress ceilings against the BUILT runtime, through the egress
// fixture variant: real sockets, the production charge point, the production
// count map, and the production refusal shapes. Everything asserted is what
// the CLIENT observes - probe-result frames echoing what a server-side caller
// of the publish family saw, and the frames that did or did not arrive.
//
// The variant's build-time ceilings (test/fixture/variants.js):
//   windowMs 60000, topic { messages: 3, deliveries: 4 }, tenant { messages: 2 }
// The window is a minute so a slow runner cannot rotate a refusal away.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * A real `ws` client with frame recording and a probe helper.
 * @param {string} wsUrl
 * @param {Record<string, string>} [headers]
 */
async function connectClient(wsUrl, headers = {}) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl, { headers });
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (data) => {
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return {
		ws,
		frames,
		/** @param {unknown} msg */
		send(msg) { ws.send(JSON.stringify(msg)); },
		/** @param {string} topic */
		async subscribe(topic) {
			// The runtime acks only a ref-carrying subscribe frame.
			const ref = randomUUID();
			this.send({ type: 'subscribe', topic, ref });
			const ack = await this.waitFor((f) => f.type === 'subscribed' && f.topic === topic && f.ref === ref);
			expect(ack, `subscribe ack for ${topic} must arrive`).toBeTruthy();
		},
		/**
		 * Drive one server-side platform call and await its echoed result.
		 * @param {string} type
		 * @param {string} topic
		 */
		async probe(type, topic) {
			const nonce = randomUUID();
			this.send({ type, topic, nonce });
			const reply = await this.waitFor((f) => f.event === `${type}-result` && f.data?.nonce === nonce);
			expect(reply, `${type} reply must arrive`).toBeTruthy();
			return reply.data;
		},
		/**
		 * @param {(f: any) => boolean} predicate
		 * @param {number} [ms]
		 */
		async waitFor(predicate, ms = 3000) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = frames.find(predicate);
				if (hit) return hit;
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		close() { try { ws.terminate(); } catch { /* already gone */ } }
	};
}

describeUWS('egress ceilings against the built runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'egress' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('the topic messages ceiling refuses the crossing publish; the client sees exactly the admitted frames', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('plain:feed');
			const r1 = await client.probe('publish-probe', 'plain:feed');
			const r2 = await client.probe('publish-probe', 'plain:feed');
			const r3 = await client.probe('publish-probe', 'plain:feed');
			const r4 = await client.probe('publish-probe', 'plain:feed');
			expect([r1.result, r2.result, r3.result]).toEqual([true, true, true]);
			expect(r4.result, 'the fourth publish crosses messages: 3').toBe(false);
			const delivered = client.frames.filter((f) => f.topic === 'plain:feed' && f.event === 'probe-event');
			expect(delivered.length, 'the refused publish delivered nothing').toBe(3);
		} finally {
			client.close();
		}
	});

	it('the tenant ceiling pools the egressTenantOf namespace across topics', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('t:acme:a');
			await client.subscribe('t:acme:b');
			const r1 = await client.probe('publish-probe', 't:acme:a');
			const r2 = await client.probe('publish-probe', 't:acme:b');
			expect([r1.result, r2.result]).toEqual([true, true]);
			// The third acme publish crosses tenant messages: 2, on a DIFFERENT
			// topic than either charge - the pooling is the assertion.
			const r3 = await client.probe('publish-probe', 't:acme:a');
			expect(r3.result).toBe(false);
		} finally {
			client.close();
		}
	});

	it('a broken tenant resolver charges unattributed instead of misattributing', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('t:broken:x');
			// The resolver returns an id outside the shared rule for this
			// namespace, so these publishes are unattributed: no tenant window
			// applies and the topic ceilings (messages: 3) are what refuse.
			const results = [];
			for (let i = 0; i < 4; i++) {
				results.push((await client.probe('publish-probe', 't:broken:x')).result);
			}
			expect(results).toEqual([true, true, true, false]);
		} finally {
			client.close();
		}
	});

	it('the deliveries ceiling counts real recipients through the production count map', async () => {
		const a = await connectClient(server.wsUrl);
		const b = await connectClient(server.wsUrl);
		const c = await connectClient(server.wsUrl);
		try {
			await a.subscribe('plain:room');
			await b.subscribe('plain:room');
			await c.subscribe('plain:room');
			// Three subscribers: the first publish charges 3 of the 4-delivery
			// window; the second would cross (3 + 3 > 4) and is refused whole.
			const r1 = await a.probe('publish-probe', 'plain:room');
			const r2 = await a.probe('publish-probe', 'plain:room');
			expect(r1.result).toBe(true);
			expect(r2.result).toBe(false);
			await new Promise((r) => setTimeout(r, 150));
			for (const cl of [a, b, c]) {
				const got = cl.frames.filter((f) => f.topic === 'plain:room' && f.event === 'probe-event');
				expect(got.length, 'each subscriber saw exactly the one admitted publish').toBe(1);
			}
		} finally {
			a.close();
			b.close();
			c.close();
		}
	});

	it('the game lane charges the SENDER attribution tenant and refuses with { seq: null, delivered: 0 }', async () => {
		const sender = await connectClient(server.wsUrl, { 'x-attr-tenant': 'gamer' });
		const receiver = await connectClient(server.wsUrl);
		try {
			await sender.subscribe('plain:arena');
			await receiver.subscribe('plain:arena');
			const g1 = await sender.probe('game-probe', 'plain:arena');
			const g2 = await sender.probe('game-probe', 'plain:arena');
			const g3 = await sender.probe('game-probe', 'plain:arena');
			expect(g1.delivered).toBe(1);
			expect(g2.delivered).toBe(1);
			// tenant messages: 2 - the sender's third game publish is refused
			// with nothing stamped and nothing delivered.
			expect(g3).toMatchObject({ seq: null, delivered: 0 });
			await new Promise((r) => setTimeout(r, 150));
			const got = receiver.frames.filter((f) => f.topic === 'plain:arena' && f.event === 'game-event');
			expect(got.length).toBe(2);
		} finally {
			sender.close();
			receiver.close();
		}
	});

	it('sendTo is refused whole once the topic window is spent', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('plain:direct');
			const p1 = await client.probe('sendto-probe', 'plain:direct');
			expect(p1.count).toBe(1);
			// Exhaust the topic messages window...
			await client.probe('publish-probe', 'plain:direct');
			await client.probe('publish-probe', 'plain:direct');
			const p2 = await client.probe('sendto-probe', 'plain:direct');
			expect(p2.count, 'a refused sendTo sends nothing and returns 0').toBe(0);
		} finally {
			client.close();
		}
	});
});
