// A seq the wire cannot carry is a programming error, and the caller must meet
// it on the deploy that introduced it - not on the first quiet hour afterwards.
//
// WHY THIS EXISTS. The publish lanes validated the seq as a side effect of
// STAMPING, and the stamp is the last thing they do: the egress ceiling decides
// first. So with a budget armed and its window crossed, `platform.publish(t, e,
// d, { seq: '5' })` answered `false` - which is also the ordinary, expected
// answer under load, carries no signal that anything is wrong, and is what the
// caller's own retry logic is written around. The TypeError arrived only once
// traffic dropped and the ceiling relaxed, pointing at a deploy that might be
// weeks old. Validating the value before the admission decision makes the
// refusal unconditional.
//
// WHAT MAKES THESE ASSERTIONS COUNT. Each case first PROVES the ceiling is
// shedding at the moment it matters - a valid publish on the same topic in the
// same window answering `false` - so a run where the budget was never armed
// cannot report this as verified. The probe echoes the thrown error and the
// return value separately, so `false` and a refusal are not confusable.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.
// The `egress` variant's build-time ceilings (test/fixture/variants.js):
//   windowMs 60000, topic { messages: 3, deliveries: 4 }, tenant { messages: 2 }

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * A real `ws` client that can drive the fixture's publish probes.
 * @param {string} wsUrl
 */
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
		ws,
		frames,
		/** @param {unknown} msg */
		send(msg) { ws.send(JSON.stringify(msg)); },
		/** @param {string} topic */
		async subscribe(topic) {
			const ref = randomUUID();
			this.send({ type: 'subscribe', topic, ref });
			const ack = await this.waitFor((f) => f.type === 'subscribed' && f.topic === topic && f.ref === ref);
			expect(ack, `subscribe ack for ${topic} must arrive`).toBeTruthy();
		},
		/**
		 * One server-side `platform.publish(topic, ..., { seq: false })`, its
		 * return value echoed back.
		 * @param {string} topic
		 */
		async publish(topic) {
			const nonce = randomUUID();
			this.send({ type: 'publish-probe', topic, nonce });
			const reply = await this.waitFor((f) => f.event === 'publish-probe-result' && f.data?.nonce === nonce);
			expect(reply, 'publish-probe reply must arrive').toBeTruthy();
			return reply.data.result;
		},
		/**
		 * One server-side publish carrying the named seq, with the thrown error
		 * and the return value reported separately.
		 * @param {string} topic
		 * @param {unknown} seq
		 * @returns {Promise<{ result: boolean | null, error: { name: string, message: string } | null }>}
		 */
		async publishSeq(topic, seq) {
			const nonce = randomUUID();
			this.send({ type: 'seq-probe', topic, seq, nonce });
			const reply = await this.waitFor((f) => f.event === 'seq-probe-result' && f.data?.nonce === nonce);
			expect(reply, 'seq-probe reply must arrive').toBeTruthy();
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

describeUWS('a seq refusal does not depend on the egress ceiling', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'egress' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('refuses an uncarryable seq while the ceiling is shedding, instead of answering false', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('plain:shed');
			// Cross messages: 3 on this topic, then prove the shed is live: a
			// publish with nothing wrong with it is answered `false` here. Without
			// this the case would pass on a runtime whose budget never armed.
			expect([
				await client.publish('plain:shed'),
				await client.publish('plain:shed'),
				await client.publish('plain:shed')
			]).toEqual([true, true, true]);
			expect(await client.publish('plain:shed'), 'the fourth publish must be shed').toBe(false);

			// The same window, the same exhausted topic: a string seq is a value
			// the wire cannot carry, and the caller has to be told so.
			const refused = await client.publishSeq('plain:shed', '5');
			expect(refused.error, 'an uncarryable seq must throw even while shedding').toBeTruthy();
			expect(refused.error?.name).toBe('TypeError');
			expect(refused.error?.message).toContain('publish seq must be');
			expect(refused.result, 'a refusal is thrown, never reported as a shed').toBeNull();
		} finally {
			client.close();
		}
	});

	it('gives the same refusal on a topic with budget to spare, and spends none of it', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('plain:spare');
			// Same value, untouched window: the message and the error type must
			// match the shedding case exactly - that agreement IS the contract.
			const refused = await client.publishSeq('plain:spare', '5');
			expect(refused.error?.name).toBe('TypeError');
			expect(refused.error?.message).toContain('publish seq must be');

			// A refused value is not a publish, so it charges nothing: the full
			// messages: 3 allowance is still there afterwards. This is what pins
			// the check AHEAD of the admission rather than merely beside it -
			// validating after admitting would have spent one of the three.
			expect([
				await client.publish('plain:spare'),
				await client.publish('plain:spare'),
				await client.publish('plain:spare')
			]).toEqual([true, true, true]);
			expect(await client.publish('plain:spare'), 'the fourth crosses messages: 3').toBe(false);

			// And nothing the refused call named reached a subscriber.
			const delivered = client.frames.filter((f) => f.topic === 'plain:spare' && f.event === 'probe-event');
			expect(delivered.length, 'only the three admitted publishes were delivered').toBe(3);
		} finally {
			client.close();
		}
	});

	it('refuses every uncarryable spelling the same way while shedding', async () => {
		const client = await connectClient(server.wsUrl);
		try {
			await client.subscribe('plain:spellings');
			for (let i = 0; i < 3; i++) await client.publish('plain:spellings');
			expect(await client.publish('plain:spellings'), 'the ceiling must be shedding').toBe(false);

			// The refusals split by fault, not by ceiling: a spelling fault gets
			// the legal-forms message, a magnitude fault gets the range one, and
			// both arrive as a throw rather than as the shed's `false`.
			for (const [seq, fragment] of [
				['5', 'publish seq must be'],
				[1.5, 'publish seq must be'],
				[0, 'publish seq must be'],
				[-1, 'publish seq must be'],
				[Number.MAX_SAFE_INTEGER + 2, "exceeds the wire's safe-integer range"]
			]) {
				const refused = await client.publishSeq('plain:spellings', seq);
				expect(refused.error?.name, `seq ${String(seq)} must throw`).toBe('TypeError');
				expect(refused.error?.message, `seq ${String(seq)} message`).toContain(fragment);
				expect(refused.result, `seq ${String(seq)} must not report a shed`).toBeNull();
			}
		} finally {
			client.close();
		}
	});
});
