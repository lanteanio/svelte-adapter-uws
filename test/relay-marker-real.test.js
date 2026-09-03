// A forged relay marker against the BUILT runtime, over real sockets.
//
// WHY THIS EXISTS AND WHY IT IS NOT THE HARNESS SUITE. `publishWire`'s relay
// receive path used to be marked with two plain option keys, `_isRelay` and
// `_relaySeq`, which arrive on the same caller-supplied object as every other
// publish option - so an application could set them and be treated as a
// sibling worker's relay. src/testing.js reimplements that lane by hand, so a
// case that only drives createTestServer proves nothing about what
// src/runtime/handler/platform.js does with a forged options object. This
// drives the real one, through the fixture's publish probe, and asserts the
// seq the CLIENT receives.
//
// WHY THE SEQ IS THE WHOLE ASSERTION. One boolean picks between the origin
// side and the relay side, and the sequence-authority check, the seq value
// check, the egress decision, the publish counter, the max-seen record, the
// stamp and the relay decision all read it. A frame carrying the topic
// counter's number was stamped on the origin arm, which is only reachable when
// that boolean is false - so the delivered seq settles every one of them at
// once. The Symbol spellings a caller could otherwise reach for cannot cross a
// JSON probe boundary; they are pinned in relay-marker-authority.test.js
// against the same exported constant this runtime reads.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** The number a forgery tries to stamp. No counter in this suite reaches it. */
const FORGED_SEQ = 4242;

/** A real `ws` client that records every frame and drives the fixture probe. */
async function connectClient(wsUrl) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl);
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
		frames,
		send(msg) { ws.send(JSON.stringify(msg)); },
		async subscribe(topic) {
			const ref = randomUUID();
			this.send({ type: 'subscribe', topic, ref });
			expect(await this.waitFor((f) => f.type === 'subscribed' && f.topic === topic && f.ref === ref),
				`subscribe ack for ${topic}`).toBeTruthy();
		},
		/**
		 * One server-side publishWire through the real platform, with the
		 * options the client names passed to it verbatim.
		 * @param {string} topic
		 * @param {unknown} options
		 */
		async publishWire(topic, options) {
			const nonce = randomUUID();
			this.send({ type: 'sequence-policy-probe', entry: 'wire', topic, options, nonce });
			const reply = await this.waitFor((f) => f.event === 'sequence-policy' && f.data?.nonce === nonce);
			expect(reply, 'the publish probe must answer').toBeTruthy();
			return reply.data;
		},
		/** Every delivered frame for a topic, in arrival order. */
		on(topic) {
			return this.frames.filter((f) => f.topic === topic && f.event === 'probe');
		},
		async waitFor(predicate, ms = 3000) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = this.frames.find(predicate);
				if (hit) return hit;
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		close() { try { ws.terminate(); } catch { /* already gone */ } }
	};
}

describeUWS('a forged relay marker cannot allocate a seq on the real runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('publishes it as an ordinary origin frame carrying the topic counter', async () => {
		const client = await connectClient(server.wsUrl);
		// A topic nothing else in this fixture touches, so the counter starts at
		// zero and the expected sequence below is exact rather than relative.
		const topic = 'relay-marker:forge';
		try {
			await client.subscribe(topic);

			// Both key spellings the relay half used to carry. The first is the
			// complete forgery - it is what the receive path itself passed - and
			// the second is the seq alone, which must stay just as inert.
			const first = await client.publishWire(topic, { _isRelay: true, _relaySeq: FORGED_SEQ });
			expect(first.ok, 'a forged marker must not be refused, only ignored').toBe(true);
			const second = await client.publishWire(topic, { _relaySeq: FORGED_SEQ });
			expect(second.ok).toBe(true);

			await client.waitFor((f) => f.topic === topic && f.event === 'probe' && f.seq === 2);
			const delivered = client.on(topic);
			expect(delivered.length, 'both probes must reach the subscriber').toBe(2);
			// Drawn from the counter, once per call, on a topic that started
			// untouched. Under the defect the first frame carried 4242 and the
			// counter never moved for it.
			expect(delivered.map((f) => f.seq)).toEqual([1, 2]);
		} finally {
			client.close();
		}
	}, 60000);
});
