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

	it('delivers the surviving frames to a subscriber and says nothing about the lost one', async () => {
		// WHAT A CLIENT ON THE WORKER THAT LOST FRAMES ACTUALLY RECEIVES.
		//
		// The detector's own behaviour is covered above. This case asks the
		// separate question the operator-facing report leaves open: the worker
		// knows it lost frames, so does anything on the wire tell the clients
		// whose state is now wrong?
		//
		// A single runtime driven through relayPublish is the right instrument
		// rather than a real two-worker cluster: relayPublish IS the function
		// index.js hands a sibling's frame to, the subscriber here is a real
		// socket on the receiving worker, and a hole can be placed exactly where
		// the assertion needs it. A live cluster cannot be made to drop one
		// interior frame on demand, so the same case there would be a race.
		state.streamTracking.enabled = true;
		const topic = 'relay-recv-client-view';

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

		// Ordinal 2 is lost in transit between the sibling and this worker.
		relayOne(topic, 1, 21);
		relayOne(topic, 3, 21);
		await new Promise((r) => setTimeout(r, 250));

		const delivered = frames.filter((f) => f.topic === topic && f.event === 'tick');
		expect(delivered.map((f) => f.data.ord), 'the surviving relayed frames must reach the subscriber').toEqual([1, 3]);

		// The worker now confirms it lost the frame in between. Everything the
		// runtime does about that happens here.
		expect(gapsFor(topic), 'the loss must be confirmed, or the silence below proves nothing').toEqual([
			{ topic, origin: 21, from: 2, to: 2, count: 1 }
		]);

		await new Promise((r) => setTimeout(r, 250));
		const after = frames.filter((f) => f.topic === topic || f.type === 'resync' || f.type === 'rehydrate');
		expect(
			after.map((f) => f.event ?? f.type),
			'the subscribe ack and the two frames that survived - nothing tells this subscriber its state is short'
		).toEqual(['subscribed', 'tick', 'tick']);
		expect(ws.readyState, 'the connection is not closed either').toBe(WebSocket.OPEN);

		// And the publish sequences the client did receive step over the lost
		// one, so its own resume watermark advances past a frame it never had:
		// a later reconnect asks for everything after the higher sequence and
		// the hole between them is never re-requested.
		expect(
			delivered.map((f) => f.seq),
			'the delivered sequences skip the lost frame, which is what the resume watermark will carry'
		).toEqual([seqFor(1), seqFor(3)]);

		ws.close();
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
