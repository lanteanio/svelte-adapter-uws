// A batch is whole or it is nothing - on the DEFAULT single-worker runtime,
// which is where the promise was not being kept.
//
// WHY THIS EXISTS. Both batch surfaces ran an atomic pre-pass whose only
// question was the TOPOLOGY one, and `clusterSequenceValuesAccepted` answers
// accepted immediately when the runtime is not multi-worker - without reading
// the value. So on the default deployment the pre-pass vetted nothing a caller
// had actually written, and a bad `seq` on message k surfaced from inside the
// per-message publish, after 0..k-1 had gone out. The comment above that
// pre-pass said the opposite.
//
// The two surfaces fail differently and both are asserted here:
//   batch()          delivers the earlier messages, then throws.
//   publishBatched() delivers nothing - its stamping loop throws before the
//                    send at the end - but the earlier entries have already
//                    ADVANCED THE TOPIC COUNTER. That is the worse of the two:
//                    the counter skips a value no client ever saw, so a client
//                    watermark can sit above a number that was never sent, and
//                    republishing it after the payload is fixed reads as
//                    already-seen. Nothing on the wire marks it.
//
// The counter assertions are what make this suite able to fail for the second
// surface at all: there is no delivered frame to count there, so a case that
// only checked delivery would pass against the defect.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * A real `ws` client that records every frame and drives the fixture probe.
 *
 * `caps` decides which publishBatched lane the runtime takes, and the two lanes
 * fail differently, so it is not a detail: without the `batch` capability every
 * interested subscriber would be unable to decode a shared batch frame, and the
 * call degrades to a per-event publish loop - the same shape `batch()` already
 * has. Advertising it is what routes the call onto the FAST path, whose
 * stamping loop is the only place the topic counter moves ahead of a frame that
 * was never sent.
 *
 * @param {string} wsUrl
 * @param {string[]} [caps]
 */
async function connectClient(wsUrl, caps) {
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
	if (caps) ws.send(JSON.stringify({ type: 'hello', caps }));
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
		 * Drive one server-side batch entry point and await its echoed outcome.
		 * @param {string} entry
		 * @param {string} topic
		 * @param {unknown} [options]
		 */
		async probe(entry, topic, options) {
			const nonce = randomUUID();
			this.send({ type: 'sequence-policy-probe', entry, topic, options, nonce });
			const reply = await this.waitFor((f) => f.event === 'sequence-policy' && f.data?.nonce === nonce);
			expect(reply, `${entry} reply must arrive`).toBeTruthy();
			return reply.data;
		},
		/** Every frame this client received for a topic, by event name. */
		eventsOn(topic) {
			return this.frames.filter((f) => f.topic === topic && f.event !== undefined).map((f) => f.event);
		},
		/** The seq stamped on the one counter-drawing publish for a topic. */
		seqOn(topic, event) {
			const hit = this.frames.find((f) => f.topic === topic && f.event === event);
			return hit === undefined ? null : (hit.seq ?? null);
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

describeUWS('a refused batch entry publishes nothing and spends no sequence', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('refuses batch() before the earlier messages reach a subscriber', async () => {
		const client = await connectClient(server.wsUrl);
		const topic = 'atomic:loop';
		try {
			await client.subscribe(topic);

			// Vacuity guard first: this probe DOES deliver when the batch is
			// clean, so the emptiness asserted below means refused-before-
			// publishing rather than a probe that never worked.
			const clean = await client.probe('loop-batch-prefix', topic, { seq: false });
			expect(clean.ok, 'a clean batch must publish').toBe(true);
			await client.waitFor((f) => f.topic === topic && f.event === 'prefix2');
			expect(client.eventsOn(topic).sort()).toEqual(['prefix0', 'prefix1', 'prefix2']);

			const before = client.frames.length;
			const refused = await client.probe('loop-batch-prefix', topic, { seq: '5' });
			expect(refused.ok, 'a batch carrying an unstampable seq must be refused').toBe(false);
			expect(refused.error).toContain('publish seq must be');

			// Nothing new on the topic. The refusal rides message 2, so a lane
			// that validated per message would have delivered 0 and 1 first.
			const after = client.frames.slice(before)
				.filter((f) => f.topic === topic && String(f.event ?? '').startsWith('prefix'));
			expect(after.map((f) => f.event), 'a refused batch delivered a prefix').toEqual([]);
		} finally {
			client.close();
		}
	}, 60000);

	it('refuses publishBatched() before its stamping loop moves the topic counter', async () => {
		// The `batch` capability routes publishBatched onto its shared-frame
		// fast path. Without it every interested subscriber would be unable to
		// decode the frame and the call degrades to a per-event publish loop -
		// a different lane, with a different failure, and the stamping loop
		// this case is about would never run.
		const client = await connectClient(server.wsUrl, ['batch']);
		// TWO topics, and the split is load-bearing. The counter topic must be
		// touched by NOTHING but the refused batch and the probe that follows
		// it, or the expected value stops being 1 and the case stops being
		// exact. The vacuity guard runs on its own topic for exactly that
		// reason - the probe's first two messages carry no options, so they
		// draw the counter even when the third says `{ seq: false }`.
		const lane = 'atomic:counter-lane';
		const topic = 'atomic:counter';
		try {
			await client.subscribe(lane);
			await client.subscribe(topic);

			// Vacuity guard, and the proof of which lane is running: a clean
			// batch arrives as ONE `{type:'batch'}` frame carrying all three
			// events.
			const clean = await client.probe('batch-prefix', lane, { seq: false });
			expect(clean.ok, 'a clean batch must publish').toBe(true);
			const framed = await client.waitFor((f) => f.type === 'batch');
			expect(framed, 'the batch fast path must be the lane under test').toBeTruthy();
			expect(framed.events.map((e) => e.event)).toEqual(['prefix0', 'prefix1', 'prefix2']);

			const refused = await client.probe('batch-prefix', topic, { seq: 1.5 });
			expect(refused.ok, 'a batch carrying a fractional seq must be refused').toBe(false);
			expect(refused.error).toContain('publish seq must be');
			expect(client.frames.filter((f) => f.type === 'batch').length,
				'a refused batch must not put a second frame on the wire').toBe(1);

			// THE ASSERTION THAT MATTERS, and the only one here that can fail
			// against the defect: the fast path throws before its send either
			// way, so nothing is delivered either way. What differs is that the
			// refused batch's first two entries had already drawn 1 and 2 from
			// this topic's counter on their way to a frame nobody received, so
			// the next publish came back stamped 3. It must be stamped 1 - a
			// batch that published nothing consumed nothing.
			const stamped = await client.probe('publish', topic, { seq: true });
			expect(stamped.ok, 'the follow-up publish must succeed').toBe(true);
			await client.waitFor((f) => f.topic === topic && f.event === 'probe');
			expect(client.seqOn(topic, 'probe'),
				'the refused batch spent sequence numbers no client ever saw').toBe(1);
		} finally {
			client.close();
		}
	}, 60000);

	it('refuses every unstampable spelling on both batch surfaces', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			for (const entry of ['loop-batch-prefix', 'batch-prefix']) {
				for (const [seq, fragment] of [
					['5', 'publish seq must be'],
					[0, 'publish seq must be'],
					[-1, 'publish seq must be'],
					[Number.MAX_SAFE_INTEGER + 2, "exceeds the wire's safe-integer range"]
				]) {
					const topic = `atomic:${entry}:${String(seq)}`;
					const refused = await client.probe(entry, topic, { seq });
					expect(refused.ok, `${entry} seq ${String(seq)} must be refused`).toBe(false);
					expect(refused.error, `${entry} seq ${String(seq)} message`).toContain(fragment);
					expect(client.eventsOn(topic), `${entry} seq ${String(seq)} delivered something`).toEqual([]);
				}
			}
		} finally {
			client.close();
		}
	}, 60000);
});
