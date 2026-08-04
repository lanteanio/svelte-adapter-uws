// publishWireBatch advanced authoritative state per entry, inside the loop that
// can still fail.
//
// completeEnvelope runs JSON.stringify, so any payload whose toJSON throws
// aborts the batch part-way. The topic watermark, the per-topic publish stats
// and the publish-rate counter had already moved for the entries that got
// through - a batch that put nothing on any wire still raised them. If the
// watermark feeds the resume dedup floor, republishing those same seqs after
// fixing the payload gets them discarded as already-seen: a silent gap, which is
// the outcome the seq lane exists to prevent.
//
// Read against the REAL built runtime's own module state rather than a harness
// mirror, because the defect is in the shipped stamping loop.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('publishWireBatch aborting mid-batch', () => {
	let server;
	let state;
	let platform;

	beforeAll(async () => {
		// Boot first so the runtime's uWS app exists - publishWireBatch fans out
		// through it - then reach the SAME module instances the booted handler
		// uses, which is where the state under test lives.
		server = await startRealRuntime();
		state = await import('./fixture/build/handler/state.js');
		({ platform } = await import('./fixture/build/handler/platform.js'));
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('leaves the watermark, the topic stats and the publish counter untouched', () => {
		const topic = 'wire-batch-abort-probe';
		const wire = {
			capability: 'probe.batch-abort:1',
			schemaVersion: 1,
			state: {},
			encode: () => null
		};

		// A successful single-entry batch first, so the topic already has a stats
		// entry. Otherwise a failed batch merely CREATING an empty one would look
		// like a mutation and the assertion would be about the wrong thing.
		platform.publishWireBatch(topic, 'update', [{ data: { n: 0 } }], wire, { seq: false });

		const watermarkBefore = state.maxSeenSeq.get(topic);
		const statsBefore = { ...state.topicPublishStats.get(topic) };
		const publishedBefore = state.counters.publishCountWindow;

		// Entry 0 serialises, entry 1 cannot. This is the two-entry shape the
		// defect needs: one entry through, one abort.
		const poison = { toJSON() { throw new Error('payload cannot serialise'); } };
		expect(() => platform.publishWireBatch(
			topic, 'update', [{ data: { n: 1 } }, { data: poison }], wire, {}
		)).toThrow();

		expect(state.maxSeenSeq.get(topic), 'topic watermark moved for a batch that reached no wire')
			.toBe(watermarkBefore);
		expect(state.topicPublishStats.get(topic), 'topic publish stats counted an unsent batch')
			.toEqual(statsBefore);
		expect(state.counters.publishCountWindow, 'publish-rate counter counted an unsent batch')
			.toBe(publishedBefore);
	});

	it('still advances all three once every entry serialises', () => {
		// The guard must not have been implemented by simply never advancing.
		const topic = 'wire-batch-advance-probe';
		const wire = {
			capability: 'probe.batch-advance:1',
			schemaVersion: 1,
			state: {},
			encode: () => null
		};

		platform.publishWireBatch(topic, 'update', [{ data: { n: 0 } }], wire, {});
		const watermarkBefore = state.maxSeenSeq.get(topic);
		const statsBefore = { ...state.topicPublishStats.get(topic) };
		const publishedBefore = state.counters.publishCountWindow;

		platform.publishWireBatch(topic, 'update', [{ data: { n: 1 } }, { data: { n: 2 } }], wire, {});

		expect(state.maxSeenSeq.get(topic)).toBeGreaterThan(watermarkBefore);
		expect(state.topicPublishStats.get(topic).m).toBe(statsBefore.m + 2);
		expect(state.counters.publishCountWindow).toBe(publishedBefore + 2);
	});
});
