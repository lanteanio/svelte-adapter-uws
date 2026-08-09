// The per-topic sequence registry ceiling, against the REAL built runtime.
//
// `maxTopicSeqEntries` bounds two registries: the publish counters
// (`topicSeqs`) and the highest-observed map (`maxSeenSeq`). The unit suite in
// test/seq-bound.test.js drives the bound over plain maps, which proves the
// eviction mechanism and nothing about who calls it - and the defect this file
// exists to catch lived entirely in the callers: five publish lanes wrote
// `maxSeenSeq` directly, so the observed registry grew past the configured
// ceiling while the counter registry, and every model of it, stayed honest.
//
// So these assertions read the runtime's OWN registries after driving its own
// publish surfaces, at a four-entry ceiling baked into a dedicated fixture
// build. Nothing here is subscribed and no cross-worker reporter is running, so
// every candidate is evictable and the ceiling is exact: an over-cap reading is
// the bound failing, not the documented clustered overshoot.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectRealClient, hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { variantOut } from './fixture/variants.js';
import { WS_CAPS, WS_SUBSCRIPTIONS } from '../src/runtime/utils/ws-symbols.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** The ceiling this variant is built with (test/fixture/variants.js). */
const CAP = 4;
const OUT = variantOut('seqcap');
/** Advertised by the scripted socket so the batch lane takes its per-socket walk. */
const WIRE_CAP = 'probe.ceiling:1';

describeUWS('per-topic sequence registries at a configured ceiling', () => {
	let server;
	let state;
	let platform;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'seqcap' });
		state = await import(`./fixture/${OUT}/handler/state.js`);
		({ platform } = await import(`./fixture/${OUT}/handler/platform.js`));
		// Counted so the batch lane takes its per-socket walk rather than the
		// native fast path, which a scripted socket cannot observe.
		state.capCounts.adjust(null, [WIRE_CAP]);
	}, 400000);

	afterAll(async () => {
		state?.capCounts.adjust([WIRE_CAP], null);
		await server?.stop();
	});

	/** Both registries, named for a readable failure. */
	function sizes() {
		return { topicSeqs: state.topicSeqs.size, maxSeenSeq: state.maxSeenSeq.size };
	}

	function expectBothBounded(where) {
		const held = sizes();
		expect(held.topicSeqs, where + ': counter registry').toBeLessThanOrEqual(CAP);
		expect(held.maxSeenSeq, where + ': observed registry').toBeLessThanOrEqual(CAP);
	}

	const wire = { capability: WIRE_CAP, schemaVersion: 1, encode: () => null };

	/**
	 * Put the registries in the ONE state that can expose a lane which admits a
	 * topic without reporting it: the observed registry full of topics the
	 * counter registry does not hold.
	 *
	 * With both registries in step - the ordinary all-counter workload - the
	 * counter lane's own eviction deletes its victim from both maps and frees
	 * the seen slot the new topic is about to take, so a missing seen report
	 * costs nothing and no assertion can see it. It is only when an external
	 * seq authority owns some of the seen slots that the counter registry sits
	 * BELOW the cap while the observed one is at it, and every counter topic
	 * then adds a seen entry that nothing evicts. That is the shape an
	 * application mixing the two authorities actually runs in, and it is the
	 * shape each surface below is driven from.
	 *
	 * @param {string} tag distinguishes this reset's external topics
	 */
	function primeExternalCeiling(tag) {
		// Clearing the maps bypasses the bound's own eviction, so the counters
		// of the cleared topics vanish without a carried floor. That is safe
		// here ONLY because every prime uses a fresh topic namespace and no
		// cleared name is ever republished - and it is why the no-reuse test
		// below runs BEFORE the first prime rather than after five of them,
		// where a stale floor could let it pass for the wrong reason.
		state.topicSeqs.clear();
		state.maxSeenSeq.clear();
		for (let i = 0; i < CAP; i++) {
			platform.publish('ceiling:' + tag + ':external:' + i, 'tick', { i }, { seq: 700000 + i });
		}
		expect(state.maxSeenSeq.size, tag + ': the observed registry must start full').toBe(CAP);
		expect(state.topicSeqs.size, tag + ': the counter registry must start empty').toBe(0);
	}

	/**
	 * A socket the batch lane's per-connection walk can reach: subscribed to
	 * the topic and advertising the codec's capability.
	 */
	function scriptedWs(topic, caps = [WIRE_CAP]) {
		const ud = {};
		ud[WS_SUBSCRIPTIONS] = new Set([topic]);
		ud[WS_CAPS] = new Set(caps);
		const sent = [];
		return {
			sent,
			getUserData() { return ud; },
			send(payload) { sent.push(String(payload)); return 1; },
			close() { /* not a real connection */ }
		};
	}

	// The order that hides the bypass: an external seq authority fills the
	// observed registry to the ceiling FIRST, so it has no room left, and then
	// ordinary counter publishing adds an entry per new topic. The counter
	// registry stays at four the whole time, which is why a suite watching only
	// that one reports a working bound.
	it('holds one ceiling between an external seq authority and the counter lane', () => {
		for (let i = 0; i < CAP; i++) {
			platform.publish('ceiling:external:' + i, 'tick', { i }, { seq: 900000 + i });
		}
		// The external lane feeds the observed registry alone - the counters it
		// carries are its authority's, not this worker's. Asserted EXACTLY: the
		// premise of this case is that the registry is FULL before the counter
		// lane starts, and an at-most bound is satisfied by an empty map.
		expect(state.maxSeenSeq.size).toBe(CAP);
		expect(state.topicSeqs.size).toBe(0);

		for (let i = 0; i < CAP; i++) platform.publish('ceiling:counter:' + i, 'tick', { i });
		expectBothBounded('external-then-counter');
	});

	it('holds the ceiling under sustained mixed-authority arrival', () => {
		for (let i = 0; i < 200; i++) {
			if (i % 2 === 0) platform.publish('ceiling:mixed-ext:' + i, 'tick', { i }, { seq: 5000000 + i });
			else platform.publish('ceiling:mixed-ctr:' + i, 'tick', { i });
		}
		expectBothBounded('sustained mixed arrival');
	});

	// The ceiling is not bought by breaking the guarantee it protects: a topic
	// evicted and later republished must resume ABOVE the number a client
	// already holds, never repeat it. Asserted on the frame a real socket
	// RECEIVES - the number a client would actually compare its watermark
	// against, not the registry entry the server kept.
	it('never repeats a delivered counter for a topic the ceiling forgot', async () => {
		const topic = 'ceiling:resume-floor';
		platform.publish(topic, 'tick', { n: 1 });
		platform.publish(topic, 'tick', { n: 2 });
		// Nobody is subscribed yet, so this watermark stands for one a client
		// took away earlier in the worker's life and still holds.
		const watermark = state.topicSeqs.get(topic);
		expect(watermark).toBe(2);

		// Far more topics than the ceiling holds, so this one is certainly gone.
		for (let i = 0; i < 40; i++) platform.publish('ceiling:evictor:' + i, 'tick', { i });
		expect(state.topicSeqs.has(topic)).toBe(false);

		const client = await connectRealClient(server.wsUrl);
		try {
			client.send({ type: 'subscribe', topic, ref: 1 });
			expect(await client.waitFor((f) => f && f.type === 'subscribed' && f.topic === topic, 4000)).not.toBe(null);

			platform.publish(topic, 'tick', { n: 3 });
			const delivered = await client.waitFor((f) => f && f.topic === topic && f.event === 'tick', 4000);
			expect(delivered).not.toBe(null);
			expect(delivered.parsed.seq).toBeGreaterThan(watermark);
		} finally {
			client.close();
			// The close is asynchronous, and a socket still in wsConnections
			// changes which branch the batch lane takes in the next test.
			const deadline = Date.now() + 4000;
			while (state.wsConnections.size > 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(state.wsConnections.size, 'the probe connection outlived its test').toBe(0);
		}
	});

	// Every lane that stamps a seq has to report the topics it admits. These
	// are the five surfaces that wrote the observed registry directly, each
	// driven from the primed state above so a lane that forgot to report is
	// visible rather than covered by its sibling's eviction.
	it('holds the ceiling across every publish surface', () => {
		primeExternalCeiling('publish');
		for (let i = 0; i < 20; i++) platform.publish('ceiling:surface-publish:' + i, 'tick', { i });
		expectBothBounded('publish');

		primeExternalCeiling('wire');
		for (let i = 0; i < 20; i++) platform.publishWire('ceiling:surface-wire:' + i, 'update', { i }, wire);
		expectBothBounded('publishWire');

		// A codec with no `state` routes the batch back through publishWire per
		// entry, so a batch suite that forgets one proves nothing about the
		// batch lane. This one carries state, and `attached` is the receipt
		// that the per-socket walk really ran.
		primeExternalCeiling('wire-batch');
		let attached = 0;
		const statefulWire = {
			capability: WIRE_CAP,
			schemaVersion: 1,
			state: { onAttach: () => { attached++; return { schemaVersion: 1 }; } },
			encode: () => null
		};
		/** Drive one batch shape through the walk, on its own fresh topic. */
		function batchOnce(topic, entries) {
			const ws = scriptedWs(topic);
			state.wsConnections.add(ws);
			try {
				platform.publishWireBatch(topic, 'update', entries, statefulWire);
			} finally {
				state.wsConnections.delete(ws);
			}
		}

		// The batch lane records through two different arms, and they are driven
		// from SEPARATE primed states rather than interleaved. Interleaved, each
		// arm's report sweeps the observed registry back to the ceiling on the
		// next call and repairs whatever the other arm failed to report - so one
		// arm can lose its report entirely and the pair still looks bounded.
		//
		// No entry seqs: one counter watermark for the whole batch.
		for (let i = 0; i < 20; i++) {
			batchOnce('ceiling:surface-wire-batch:' + i, [{ data: { v: 'a' } }, { data: { v: 'b' } }]);
		}
		expect(attached, 'the stateful batch walk never ran, so its max-seen record was not exercised').toBeGreaterThan(0);
		expectBothBounded('publishWireBatch');

		// Mixed entry seqs take the per-entry arm instead, and the COUNTER entry
		// leads: an explicit seq ahead of it would admit the topic through the
		// monotone-max guard first, and the compare-free record this arm uses
		// would then only ever meet topics the map already holds - nothing left
		// to report, and a lane that dropped its report would look identical.
		primeExternalCeiling('wire-batch-mixed');
		for (let i = 0; i < 20; i++) {
			batchOnce('ceiling:surface-wire-batch-mixed:' + i, [
				{ data: { v: 'c' } },
				{ data: { v: 'd' }, seq: 800000 + i }
			]);
		}
		expectBothBounded('publishWireBatch mixed entry seqs');

		// publishBatched falls back to per-message publish() whenever a socket
		// interested in a batch topic has not advertised `batch` - and publish()
		// bounds the registry correctly, so that fallback would hide a
		// regression in THIS lane. Its own frame cannot be the receipt: the fast
		// path hands fan-out to uWS's topic tree, which a scripted socket is not
		// in. So the receipt is the condition that decides the branch, asserted
		// rather than assumed - with no connection open, the walk finds nobody
		// incapable and the batched lane is the one that runs.
		primeExternalCeiling('batched');
		expect(state.wsConnections.size, 'a connected socket here can reroute publishBatched through publish()')
			.toBe(0);
		for (let i = 0; i < 20; i++) {
			const topic = 'ceiling:surface-batched:' + i;
			platform.publishBatched([
				{ topic, event: 'tick', data: { v: 'a' } },
				{ topic, event: 'tick', data: { v: 'b' } }
			]);
		}
		expectBothBounded('publishBatched');

		// No sender socket is connected, so the game lane's exclusion walk has
		// nothing to skip; the stamping and recording under test run regardless.
		primeExternalCeiling('game');
		for (let i = 0; i < 20; i++) platform.publishGame(null, 'ceiling:surface-game:' + i, 'tick', { i });
		expectBothBounded('publishGame');
	});

});
