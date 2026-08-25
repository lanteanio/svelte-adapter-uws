// The relay RECEIVE paths, driven against the REAL built runtime.
//
// WHY THIS EXISTS. relay-gap.test.js proves the detector itself behaves by
// driving recordOriginStream / takeConfirmedGaps directly, and then guards the
// joins that turn it into a working detector with AST structural checks over
// src/runtime/handler/lifecycle.js - because that module imports a build-time
// placeholder ('WS_HANDLER', via ws-handler-bridge.js) and so cannot be
// imported from source in a unit run.
//
// A structural guard proves a call is WRITTEN, not that it RUNS. It is
// satisfied by a call sitting behind a condition that is never true, and by a
// call whose arguments have drifted so that nothing useful is recorded - both
// of which lose every gap while the suite stays green.
//
// The BUILT runtime has no such obstacle. The adapter emits handler/ as
// separate modules with the placeholder already resolved, so once
// startRealRuntime has booted a real listening app, the very same lifecycle.js
// instance that server is running can be driven directly. These tests call the
// real relayPublish / relayPublishBatched - the two functions index.js hands a
// sibling worker's frame to - and assert the gap the runtime would report to an
// operator.
//
// TWO THINGS THIS FILE HAS TO DO DELIBERATELY, because getting either wrong
// makes every assertion below pass against a broken runtime:
//
// 1. `seq` AND `ord` ARE ALWAYS DISTINCT. They are different counters: `ord` is
//    the dense per-topic relay ordinal the detector runs on, `seq` is the
//    publish sequence, which skips under `{relay:false}`, interleaves under
//    seq-authority stamping, and is absent entirely for `{seq:false}` topics.
//    Passing the same number for both would let a runtime that recorded `seq`
//    where it means `ord` - which fabricates gaps on healthy workers - pass
//    every test here.
//
// 2. THE ATTACH INSTANT IS LATCHED. `relayAttach.at` is Infinity until
//    markRelayAttached() runs, and in production that call comes from
//    runtime/index.js, which this harness never loads (it imports the built
//    handler directly). Left at Infinity, `birth > attachedAt` is false for
//    every frame, so first sightings ALL baseline silently and the
//    classification branch that decides "legitimate late join" vs "we were
//    attached and lost the prefix" never executes. Latching it here is what
//    makes that branch reachable - and over-reporting is the dangerous
//    direction, since a worker that reports a healthy stream as lost gets
//    restarted.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { variantOut } from './fixture/variants.js';

const describeUWS = hasUWS ? describe : describe.skip;
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describeUWS('relay receive paths record every frame (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** The built state module - the SAME instance the running runtime reads. */
	let state = null;
	/** What the runtime's tracking flag was before this file touched it. */
	let trackingWasEnabled = false;
	/** The latched attach instant, so births can be placed either side of it. */
	let attachedAt = 0;

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'default',
			env: { ORIGIN: undefined, TRUSTED_PROXIES: undefined, CLUSTER_WORKERS: undefined }
		});
		const stateFile = path.join(fixtureDir, variantOut('default'), 'handler', 'state.js');
		state = await import(pathToFileURL(stateFile).href);
		trackingWasEnabled = state.streamTracking.enabled;

		// See note 2 in the header. Without this every first sighting baselines.
		server.handler.markRelayAttached();
		attachedAt = state.relayAttach.at;
		expect(Number.isFinite(attachedAt), 'the attach instant must be latched, or the classification branch is dead').toBe(true);
	}, 400000);

	afterAll(async () => {
		if (state) state.streamTracking.enabled = trackingWasEnabled;
		await server?.stop();
	});

	/** A stream this worker was already attached for: its prefix was owed to us. */
	const bornAfterAttach = () => attachedAt + 1000;
	/** A stream that predates our attach: whatever came before was never ours. */
	const bornBeforeAttach = () => attachedAt - 1000;

	/**
	 * A publish sequence deliberately unequal to the ordinal, so a runtime that
	 * recorded one where it means the other is caught. The offset is large enough
	 * that a swap cannot land on a neighbouring ordinal by coincidence.
	 * @param {number} ord
	 */
	const seqFor = (ord) => 1000 + ord * 7;

	/**
	 * Confirmed gaps for one topic. A grace-beating `now` is passed rather than
	 * waiting out GAP_CONFIRM_MS, exactly as the reporter would once the hole had
	 * aged; filtering by topic keeps the cases independent, since
	 * takeConfirmedGaps drains every stream it is given.
	 * @param {string} topic
	 */
	function gapsFor(topic) {
		return state
			.takeConfirmedGaps(state.originStreams, Number.MAX_SAFE_INTEGER, state.GAP_CONFIRM_MS)
			.filter((g) => g.topic === topic);
	}

	/**
	 * One relayed frame arriving from a sibling worker, through the real
	 * single-publish receive path.
	 * @param {string} topic @param {number} ord @param {number} origin
	 * @param {{ seq?: number | null, birth?: number }} [opts]
	 */
	function relayOne(topic, ord, origin, opts = {}) {
		const seq = opts.seq === undefined ? seqFor(ord) : opts.seq;
		const birth = opts.birth === undefined ? bornAfterAttach() : opts.birth;
		// The envelope carries its own `seq` exactly as the origin worker's
		// completeEnvelope wrote it, so what a subscriber here reads off the
		// wire is what production would have delivered. A `{seq:false}` topic
		// relays without the field, and passing `seq: null` reproduces that.
		server.handler.relayPublish(
			topic,
			JSON.stringify(seq == null ? { topic, event: 'tick', data: { ord } } : { topic, event: 'tick', data: { ord }, seq }),
			false,
			seq,
			undefined,
			undefined,
			undefined,
			origin,
			ord,
			birth
		);
	}

	/**
	 * One relayed BATCH frame carrying N events, through the real batched receive
	 * path. Events are `{ topic, ord }` pairs; each gets its own distinct seq.
	 * @param {{ topic: string, ord: number }[]} events
	 * @param {number} origin
	 * @param {{ birth?: number }} [opts]
	 */
	function relayBatch(events, origin, opts = {}) {
		const birth = opts.birth === undefined ? bornAfterAttach() : opts.birth;
		server.handler.relayPublishBatched(
			events.map((e) => ({
				topic: e.topic,
				env: JSON.stringify({ topic: e.topic, event: 'tick', data: { ord: e.ord } }),
				seq: seqFor(e.ord),
				origin,
				ord: e.ord,
				birth
			})),
			false
		);
	}

	it('records the single-publish receive path, so an interior loss is reported', () => {
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-single';

		// Ordinal 1 baselines the stream, 3 arrives, 2 never does.
		relayOne(topic, 1, 7);
		relayOne(topic, 3, 7);

		expect(gapsFor(topic), 'the single relay receive path must record every frame').toEqual([
			{ topic, origin: 7, from: 2, to: 2, count: 1 }
		]);
	});

	it('records the batched receive path for EVERY event, not just the first', () => {
		// A batch is one frame but N logical publishes, so a loss is a hole in
		// each topic's own stream. A runtime that recorded only events[0] would
		// silently lose contiguity for N-1 topics per batch, so the loss here is
		// placed in the SECOND event's topic.
		state.streamTracking.enabled = true;
		const first = 'relay-recv-multi-a';
		const second = 'relay-recv-multi-b';

		relayBatch([{ topic: first, ord: 1 }, { topic: second, ord: 1 }], 8);
		relayBatch([{ topic: first, ord: 2 }, { topic: second, ord: 3 }], 8);

		expect(gapsFor(second), 'every event in a relayed batch must be recorded, not only the first').toEqual([
			{ topic: second, origin: 8, from: 2, to: 2, count: 1 }
		]);
		expect(gapsFor(first), 'the batch sibling arrived contiguously and must report nothing').toEqual([]);
	});

	it('reports the missing prefix of a stream born after this worker attached', () => {
		// The classification branch: ordinal 1 was owed to us and never came.
		// This is the case that is dead unless the attach instant is latched.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-late-prefix';

		relayOne(topic, 3, 12, { birth: bornAfterAttach() });

		expect(gapsFor(topic), 'a stream that began after we attached is missing its prefix').toEqual([
			{ topic, origin: 12, from: 1, to: 2, count: 2 }
		]);
	});

	it('stays silent for a stream that predates this worker attaching', () => {
		// The other half of the same branch, and the one that matters more: this
		// is a legitimate late join, and reporting it would name a whole history
		// as lost and restart a healthy worker.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-early-stream';

		relayOne(topic, 3, 13, { birth: bornBeforeAttach() });

		expect(gapsFor(topic), 'a stream predating our attach was never ours to receive').toEqual([]);
		expect(state.originStreams.has(topic), 'it must still be TRACKED from here on').toBe(true);
	});

	it('reports nothing when every relayed frame arrives, on either path', () => {
		// The negative control: a detector that cried wolf would still satisfy the
		// positive cases above. The stream is asserted to be TRACKED as well as
		// silent, so this cannot pass by recording nothing at all.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-contiguous';

		relayOne(topic, 1, 11);
		relayOne(topic, 2, 11);
		relayBatch([{ topic, ord: 3 }], 11);

		expect(state.originStreams.has(topic), 'the stream must be tracked for the silence to mean anything').toBe(true);
		expect(gapsFor(topic), 'a contiguous stream must report no gap').toEqual([]);
	});

	it('tracks the ordinal even when the frame carries no publish sequence', () => {
		// `{seq:false}` topics relay with a non-number seq, which recordSeen
		// ignores. Contiguity must still be tracked - it runs on the ordinal, and
		// a runtime that keyed it on seq would go blind for these topics.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-seqless';

		relayOne(topic, 1, 14, { seq: null });
		relayOne(topic, 3, 14, { seq: null });

		expect(gapsFor(topic), 'ordinal tracking must not depend on a publish sequence').toEqual([
			{ topic, origin: 14, from: 2, to: 2, count: 1 }
		]);
	});

	/**
	 * Open a real subscriber socket, optionally negotiating caps first, and
	 * resolve once its subscribe is acked. The returned frames array accumulates
	 * every JSON frame the server sends it from here on.
	 * @param {string} topic @param {string[] | null} caps
	 */
	async function subscriberSocket(topic, caps) {
		const ws = new WebSocket(`${server.wsUrl}`);
		/** @type {any[]} */
		const frames = [];
		ws.on('message', (data) => {
			try { frames.push(JSON.parse(data.toString())); } catch { /* binary control frame */ }
		});
		await new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		});
		if (caps !== null) ws.send(JSON.stringify({ type: 'hello', caps }));
		ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no subscribe ack')), 10_000);
			const scan = () => {
				if (!frames.some((f) => f.type === 'subscribed' && f.topic === topic)) return;
				clearTimeout(timer);
				ws.off('message', scan);
				resolve(undefined);
			};
			ws.on('message', scan);
			scan();
		});
		return { ws, frames };
	}

	it('tells an opted-in subscriber it lost frames, and leaves a non-opted one the old silence', async () => {
		// WHAT A CLIENT ON THE WORKER THAT LOST FRAMES ACTUALLY RECEIVES.
		//
		// The detector's own behaviour is covered above. This case holds the
		// client-facing consequence: the worker that proves it lost frames tells
		// exactly the subscribers that negotiated `relay.resync:1`, because their
		// resume watermark has already stepped past the hole and no reconnect can
		// heal it - and keeps the revision's original silence for a connection
		// that never opted in.
		//
		// A single runtime driven through relayPublish is the right instrument
		// rather than a real two-worker cluster: relayPublish IS the function
		// index.js hands a sibling's frame to, the subscribers here are real
		// sockets on the receiving worker, and a hole can be placed exactly where
		// the assertion needs it. A live cluster cannot be made to drop one
		// interior frame on demand, so the same case there would be a race.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-client-view';

		const plain = await subscriberSocket(topic, null);
		const opted = await subscriberSocket(topic, ['relay.resync:1']);

		// Ordinal 2 is lost in transit between the sibling and this worker.
		relayOne(topic, 1, 21);
		relayOne(topic, 3, 21);
		await new Promise((r) => setTimeout(r, 250));

		for (const { frames } of [plain, opted]) {
			const delivered = frames.filter((f) => f.topic === topic && f.event === 'tick');
			expect(delivered.map((f) => f.data.ord), 'the surviving relayed frames must reach every subscriber').toEqual([1, 3]);
			// The publish sequences step over the lost frame, so each client's
			// resume watermark advances past a frame it never had: a later
			// reconnect asks for everything after the higher sequence and the
			// hole between them is never re-requested. This is why the marker
			// below exists - no reconnect heals this on its own.
			expect(
				delivered.map((f) => f.seq),
				'the delivered sequences skip the lost frame, which is what the resume watermark will carry'
			).toEqual([seqFor(1), seqFor(3)]);
		}

		// The worker confirms the loss, then runs the same signal step the
		// reporter drain runs (relay-gap.test.js holds that join structurally).
		const gaps = gapsFor(topic);
		expect(gaps, 'the loss must be confirmed, or nothing below proves anything').toEqual([
			{ topic, origin: 21, from: 2, to: 2, count: 1 }
		]);
		const outcomes = server.handler.signalRelayGaps(gaps);
		expect(outcomes.get(topic), 'one subscriber opted in, so one is signalled').toEqual({ signalled: 1, closed: 0, epoch: expect.any(Number) });

		await new Promise((r) => setTimeout(r, 250));
		const marker = opted.frames.find((f) => f.topic === `__replay:${topic}` && f.event === 'gap');
		expect(marker, 'the opted-in subscriber must be told its view of the topic is short').toBeTruthy();
		expect(marker.data, 'the marker carries the proven-lost count').toEqual({ lost: 1 });
		// The de-herd window is sized to the topic's local subscribers - the two
		// real subscriptions this test created - so a room-wide re-snapshot is
		// staggered rather than synchronized.
		expect(marker.j, 'the marker carries the subscriber-scaled de-herd window').toBe(2);

		const plainAfter = plain.frames.filter((f) => f.topic === topic || (typeof f.topic === 'string' && f.topic.startsWith('__replay:')));
		expect(
			plainAfter.map((f) => f.event ?? f.type),
			'a connection that never advertised the capability keeps the old contract: the survivors and nothing else'
		).toEqual(['subscribed', 'tick', 'tick']);
		expect(plain.ws.readyState, 'the non-opted connection stays open').toBe(WebSocket.OPEN);
		expect(opted.ws.readyState, 'the signalled connection stays open too - the marker was deliverable').toBe(WebSocket.OPEN);

		plain.ws.close();
		opted.ws.close();
	}, 30_000);

	it('does not signal a topic that carries no sequence lane', async () => {
		// The marker's instruction is "stop trusting your offset". A `{seq:false}`
		// topic has no offset to poison, so its subscriber - even an opted-in
		// one - keeps the silence, and its consistency story stays with whatever
		// owns it for that lane.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-seqless-quiet';

		const opted = await subscriberSocket(topic, ['relay.resync:1']);
		const ackBefore = opted.frames.find((f) => f.type === 'subscribed' && f.topic === topic);

		relayOne(topic, 1, 23, { seq: null });
		relayOne(topic, 3, 23, { seq: null });
		await new Promise((r) => setTimeout(r, 250));

		const gaps = gapsFor(topic);
		expect(gaps, 'the ordinal hole is still confirmed - scope is about signalling, not detection').toEqual([
			{ topic, origin: 23, from: 2, to: 2, count: 1 }
		]);
		const outcomes = server.handler.signalRelayGaps(gaps);
		expect(outcomes.has(topic), 'a sequence-less topic is outside the signal scope').toBe(false);

		await new Promise((r) => setTimeout(r, 250));
		expect(
			opted.frames.some((f) => typeof f.topic === 'string' && f.topic.startsWith('__replay:')),
			'no marker reaches the subscriber'
		).toBe(false);
		expect(opted.ws.readyState).toBe(WebSocket.OPEN);
		opted.ws.close();

		// The epoch is out of scope with the marker: there is no offset the
		// generation could invalidate, so a fresh subscriber still reads the
		// same one this topic always carried.
		const after = await subscriberSocket(topic, null);
		const ackAfter = after.frames.find((f) => f.type === 'subscribed' && f.topic === topic);
		expect(ackAfter.epoch, 'a sequence-less topic keeps its generation').toBe(ackBefore.epoch);
		after.ws.close();
	}, 30_000);

	it('heals a subscriber that disconnects inside the confirmation window through the epoch bump', async () => {
		// The marker only reaches sockets still connected at the drain. A
		// subscriber can take the sequences that step over the hole and
		// disconnect BEFORE the grace confirms the loss - it then holds a
		// poisoned offset the walk can never reach, and a later resume would
		// gap-fill from past frames it never received, on whatever worker the
		// reconnect lands. The durable half of the signal covers exactly this:
		// the drain mints the topic a new generation, so the old offset fails
		// the ordinary epoch compare at its next resume and the topic
		// cold-rehydrates instead.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-raced-disconnect';

		const racer = await subscriberSocket(topic, ['relay.resync:1']);
		const ackBefore = racer.frames.find((f) => f.type === 'subscribed' && f.topic === topic);
		expect(typeof ackBefore.epoch, 'the ack must carry the generation the client will present back').toBe('number');

		relayOne(topic, 1, 26);
		relayOne(topic, 3, 26);
		await new Promise((r) => setTimeout(r, 250));
		const delivered = racer.frames.filter((f) => f.topic === topic && f.event === 'tick');
		expect(delivered.map((f) => f.seq), 'the racer holds the watermark that stepped past the hole').toEqual([seqFor(1), seqFor(3)]);

		// Gone before the worker can confirm anything.
		racer.ws.close();
		await new Promise((r) => setTimeout(r, 100));

		const gaps = gapsFor(topic);
		expect(gaps).toEqual([{ topic, origin: 26, from: 2, to: 2, count: 1 }]);
		const outcomes = server.handler.signalRelayGaps(gaps);
		// Nobody left to signal - this IS the race the epoch exists for.
		expect(outcomes.get(topic).signalled, 'the disconnected racer is beyond the marker').toBe(0);
		const minted = outcomes.get(topic).epoch;
		expect(typeof minted).toBe('number');
		expect(minted, 'the topic generation must move, or the racer resumes into a gap-fill').not.toBe(ackBefore.epoch);

		// The compare authority itself - the value every resume compare and
		// subscribe ack reads through `platform.topicEpoch` - now answers the
		// minted generation, so the racer's reconnect presenting the OLD one
		// mismatches and the topic cold-rehydrates rather than trusting the
		// poisoned offset. Read from the built epoch module the running
		// handler itself imports, so this binds the wire observation below to
		// the authority rather than to a second copy of it. (The hook-side
		// mismatch-to-rehydrate contract is held by the resume suites; this
		// file owns the server authority and its wire visibility.)
		const epochModule = await import(pathToFileURL(path.join(fixtureDir, variantOut('default'), 'utils', 'epoch.js')).href);
		expect(epochModule.topicEpochValue(topic), 'the compare authority answers the minted generation').toBe(minted);
		expect(epochModule.topicEpochValue(topic), 'the mint repudiates the epoch the racer recorded').not.toBe(ackBefore.epoch);

		// And a later plain subscriber sees it on the wire.
		const later = await subscriberSocket(topic, null);
		const ackAfter = later.frames.find((f) => f.type === 'subscribed' && f.topic === topic);
		expect(ackAfter.epoch, 'the ack now carries the minted generation').toBe(minted);
		later.ws.close();
	}, 30_000);

	it('closes 1013 a subscriber whose socket refuses the marker', async () => {
		// The escalation the resume flush already owns, on the same reasoning:
		// past its backpressure ceiling this socket cannot be told its state is
		// wrong, and staying connected is the one outcome that leaves it
		// silently wrong forever. A real socket cannot be driven past
		// maxBackpressure deterministically from here, so the refusal is a
		// connection-shaped stand-in on the runtime's own live-connection set -
		// the walk, the caps gate, the membership check, and the close are all
		// the real code paths.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-refused-marker';

		// Seed the sequence lane and the confirmed hole through the real
		// receive path.
		relayOne(topic, 1, 24);
		relayOne(topic, 3, 24);

		const WS_CAPS = Symbol.for('adapter-uws.ws.caps');
		const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subscriptions');
		/** @type {Array<[number, string]>} */
		const ended = [];
		const refusing = {
			getUserData: () => ({
				[WS_CAPS]: new Set(['relay.resync:1']),
				[WS_SUBSCRIPTIONS]: new Set([topic])
			}),
			send: () => 2,
			end: (code, reason) => { ended.push([code, reason]); }
		};
		state.wsConnections.add(refusing);
		try {
			const gaps = gapsFor(topic);
			expect(gaps).toEqual([{ topic, origin: 24, from: 2, to: 2, count: 1 }]);
			const outcomes = server.handler.signalRelayGaps(gaps);
			expect(outcomes.get(topic), 'the refusal is recorded as a close, not a delivery').toEqual({ signalled: 0, closed: 1, epoch: expect.any(Number) });
			expect(ended, 'the connection that could not be signalled is closed 1013').toEqual([[1013, 'Resync required']]);
		} finally {
			state.wsConnections.delete(refusing);
		}
	}, 30_000);

	it('records nothing at all while stream tracking is off', () => {
		// The gate is what keeps a default (single-process, no state-hash
		// reporter) deployment paying one boolean test and allocating nothing on
		// the relay receive path.
		state.streamTracking.enabled = false;
		const topic = 'relay-recv-gated';

		relayOne(topic, 1, 9);
		relayOne(topic, 3, 9);
		relayBatch([{ topic, ord: 5 }], 9);

		expect(state.originStreams.has(topic), 'tracking is off: nothing may be recorded').toBe(false);
	});
});
