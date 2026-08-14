// ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK and ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT,
// driven from the conditions they claim.
//
// Both entries promise the same fail-closed collapse - every topic in the
// batch denied INTERNAL_ERROR - from two different failure points: the hook
// throwing, and the hook's RESULT throwing while its properties are read. The
// second entry additionally carries repair guidance, and guidance is exactly
// what a counting gate cannot judge: advice that names a return shape the
// normalization does not honor would disarm authorization while reading as a
// fix. The array case below exists because the entry used to give precisely
// that advice.
//
// Real runtime, real socket: src/testing.js reimplements this path by hand and
// does not emit the operational events at all. The fixture variant exports
// ONLY `subscribeBatch`, so every wire subscribe routes through the code these
// entries document.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** @param {string} id */
const entryFor = (id) => ADAPTER_ERROR_REGISTRY.find((e) => e.id === id);
const hookEntry = entryFor(ADAPTER_ERROR_IDS.SUBSCRIBE_BATCH_HOOK);
const resultEntry = entryFor(ADAPTER_ERROR_IDS.SUBSCRIBE_BATCH_RESULT);

describeUWS('subscribeBatch failure entries', () => {
	let server;
	let client;
	/** @type {any[]} */
	const events = [];
	/** @type {() => void} */
	let disposeSink;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'subbatch' });
		// Process-wide Symbol.for slot: a sink installed from the source module
		// observes what the BUILT runtime emits.
		disposeSink = setOperationalEventSink((record) => { events.push(record); });
		client = await connectRealClient(server.wsUrl);
	}, 400000);

	afterAll(async () => {
		client?.close();
		disposeSink?.();
		await server?.stop();
	});

	/** Collect this connection's denial/ack frames for one batch ref. */
	async function outcomesFor(ref, topics) {
		/** @type {Record<string, string>} */
		const outcomes = {};
		for (const topic of topics) {
			const frame = await client.waitFor((f) =>
				(f?.type === 'subscribe-denied' || f?.type === 'subscribed') && f.ref === ref && f.topic === topic
			);
			expect(frame, `no ack or denial arrived for ${topic}`).not.toBeNull();
			outcomes[topic] = frame.parsed.type === 'subscribed' ? 'subscribed' : frame.parsed.reason;
		}
		return outcomes;
	}

	it('lands the hook decisions per topic when nothing fails, so the collapses below are collapses', async () => {
		client.send({ type: 'subscribe-batch', topics: ['deny:vip', 'open-a'], ref: 201 });
		expect(await outcomesFor(201, ['deny:vip', 'open-a'])).toEqual({
			'deny:vip': 'FORBIDDEN',
			'open-a': 'subscribed'
		});
	});

	describe('ADAPTER-ERR-SUBSCRIBE-BATCH-HOOK', () => {
		it('denies every topic the hook received when the hook throws, not only the one at fault', async () => {
			// nextAction: "a fault touching a single topic presents as a client
			// that can subscribe to nothing". One faulting topic, three casualties.
			const before = events.length;
			const topics = ['open-b', 'batch-throw:x', 'open-c'];
			client.send({ type: 'subscribe-batch', topics, ref: 202 });
			expect(await outcomesFor(202, topics)).toEqual({
				'open-b': 'INTERNAL_ERROR',
				'batch-throw:x': 'INTERNAL_ERROR',
				'open-c': 'INTERNAL_ERROR'
			});

			// Denied for real: the innocent topic holds no server-side membership.
			client.send({ type: 'count', topic: 'open-b' });
			const count = await client.waitFor((f) => f?.event === 'count' && f.data?.topic === 'open-b');
			expect(count, 'the count probe must answer').not.toBeNull();
			expect(count.parsed.data.count).toBe(0);

			const mine = events.slice(before).filter((r) => r.event === 'subscribe.batch-hook-failed');
			expect(mine.length).toBe(1);
			expect(mine[0].component).toBe('runtime.subscribe');
			// `direct` emission: the record's message IS the registry's search key.
			expect(mine[0].message).toBe(hookEntry.problemPrefix);
			expect(mine[0].attributes?.error?.message).toContain('subscribeBatch probe fault');
		});

		it('scopes "the batch" to what the hook received: a topic invalid on its face never joins the collapse', async () => {
			// The entry's cause names the hook, and the hook receives pre-validated
			// topics - so a malformed topic in the same frame keeps its own verdict
			// even while the hook's batch collapses around it.
			const topics = ['open-d', 'batch-throw:y', 'bad\ntopic'];
			client.send({ type: 'subscribe-batch', topics, ref: 203 });
			expect(await outcomesFor(203, topics)).toEqual({
				'open-d': 'INTERNAL_ERROR',
				'batch-throw:y': 'INTERNAL_ERROR',
				'bad\ntopic': 'INVALID_TOPIC'
			});
		});
	});

	describe('ADAPTER-ERR-SUBSCRIBE-BATCH-RESULT', () => {
		it('denies every topic when reading the result throws, exactly as though the hook itself had thrown', async () => {
			// cause: "typically a getter or a proxy" - this is the getter.
			const before = events.length;
			const topics = ['open-e', 'poison-read:x'];
			client.send({ type: 'subscribe-batch', topics, ref: 204 });
			// "exactly as though the hook itself had thrown": same reason on the
			// wire for every topic, so from the client the two failures are one.
			expect(await outcomesFor(204, topics)).toEqual({
				'open-e': 'INTERNAL_ERROR',
				'poison-read:x': 'INTERNAL_ERROR'
			});
			expect(resultEntry.consequence).toMatch(/exactly as though the hook itself had thrown/);

			// What distinguishes them is the event, which is the operator's half.
			const mine = events.slice(before).filter((r) => r.event === 'subscribe.batch-result-read-failed');
			expect(mine.length).toBe(1);
			expect(mine[0].component).toBe('runtime.subscribe');
			expect(mine[0].message).toBe(resultEntry.problemPrefix);
			expect(mine[0].attributes?.error?.message).toContain('subscribeBatch result read fault');
			expect(events.slice(before).filter((r) => r.event === 'subscribe.batch-hook-failed')).toEqual([]);
		});

		it('silently allows everything when the hook returns an array, which is why the guidance must not prescribe one', async () => {
			// The contract shape is a record keyed by topic. An array is read
			// index-keyed - these two denials name topics '0' and '1' - so every
			// real topic lands unopposed, with no error and no event: authorization
			// disarmed by the exact value the repair guidance used to recommend.
			const before = events.length;
			const topics = ['array-shape:a', 'array-shape:b'];
			client.send({ type: 'subscribe-batch', topics, ref: 205 });
			expect(await outcomesFor(205, topics)).toEqual({
				'array-shape:a': 'subscribed',
				'array-shape:b': 'subscribed'
			});
			expect(events.slice(before).filter((r) =>
				r.event === 'subscribe.batch-hook-failed' || r.event === 'subscribe.batch-result-read-failed'
			)).toEqual([]);

			// Bind the guidance to what just happened, in both directions: it must
			// name the shape the normalization honors, and it must never again
			// offer the one it ignores.
			expect(resultEntry.nextAction).toMatch(/plain object keyed by topic/);
			expect(resultEntry.nextAction).not.toMatch(/object or array/);
			expect(resultEntry.nextAction).toMatch(/free of side effects/);
		});
	});
});
