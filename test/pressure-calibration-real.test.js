// The subscriber signal, pinned against BOTH of its consumers on one live
// worker: real connections, real subscribe accounting, and the ratio the
// sampler itself published.
//
// WHY THIS IS NOT IN pressure-sampler-isolation.test.js. A built-module case
// can set `counters.totalSubscriptions` directly, but with no live connections
// the two consumers do not even share a basis: the sampler computes
// `connections > 0 ? total / connections : 0` (pressure-metrics.js:180) and so
// reads 0, while `grantSizeFor` computes `total / (wsConnections.size || 1)`
// and so reads the whole counter. Zero connections is the ONE state where they
// diverge, which makes it the one state a calibration pin must not run in: it
// exercises the sizer against a number the sampler would never produce, and the
// pair it claims to bind can still drift apart underneath it.
//
// So this boots a real worker, opens real sockets, and subscribes them through
// the real accounting path. The denominator is then a live connection count and
// the numerator a counter that real subscribes grew - and because the
// connection count is real it can also be MOVED, which is what lets the last
// case pin the sizer's own denominator instead of restating its formula.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');

const CLIENTS = 4;
const TOPICS_PER_CLIENT = 3;

describeUWS('the subscriber signal and both of its consumers agree on one live worker', () => {
	/** @type {any} */ let rt;
	/** @type {any} */ let state;
	/** @type {any} */ let metrics;
	/** @type {any[]} */ let clients = [];

	/**
	 * The raw counter value at which the shipped sizer starts narrowing, under
	 * the LIVE connection count. Synchronous end to end, so no sampler tick can
	 * interleave with the neutralised heap arm or the swept counter; both are
	 * restored before returning.
	 */
	function rawEngagementPoint() {
		const before = state.counters.totalSubscriptions;
		const prevHeap = state.counters.lastHeapUsedRatio;
		try {
			state.counters.lastHeapUsedRatio = 0; // isolate the subscriber arm
			state.counters.totalSubscriptions = 0;
			const base = metrics.grantSizeFor().count;
			for (let total = 1; total <= 4 * 4096; total++) {
				state.counters.totalSubscriptions = total;
				if (metrics.grantSizeFor().count < base) return { base, at: total };
			}
			return { base, at: Infinity };
		} finally {
			state.counters.totalSubscriptions = before;
			state.counters.lastHeapUsedRatio = prevHeap;
		}
	}

	/** Poll `cond` until it holds or `ms` elapses; the caller asserts after. */
	async function settle(cond, ms) {
		const deadline = Date.now() + ms;
		while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	}

	beforeAll(async () => {
		rt = await startRealRuntime();
		// The SAME module instances the running server uses: the built handler
		// imports these by the same resolved paths, so this is the live state,
		// not a second copy.
		state = await import(pathToFileURL(path.join(builtDir, 'state.js')).href);
		metrics = await import(pathToFileURL(path.join(builtDir, 'pressure-metrics.js')).href);

		// The sampler starts at the handler's module EVAL, not in start(), and a
		// prior suite's shutdown() stops it. With file parallelism on that is
		// moot (each file evaluates its own module graph), but with one shared
		// module registry the import above is a cache hit and this suite would
		// inherit a stopped sampler and fail every case. Re-arming is documented
		// idempotent and, for this variant (no pressure options), identical to
		// the boot call; passing no sources keeps whatever kernel-signal probe
		// the eval established.
		metrics.startPressureSampling(undefined, undefined);

		let ref = 1;
		for (let c = 0; c < CLIENTS; c++) {
			const client = await connectRealClient(rt.wsUrl);
			clients.push(client);
			for (let t = 0; t < TOPICS_PER_CLIENT; t++) {
				const topic = `calib-${c}-${t}`;
				const mine = ref++;
				client.send({ type: 'subscribe', topic, ref: mine });
				// Wait for the ack rather than sleeping: the ack is the server
				// confirming the membership the counter is about.
				const ok = await client.waitFor((p) => p && p.type === 'subscribed' && p.topic === topic && p.ref === mine, 5000);
				expect(ok, `client ${c} never got an ack for ${topic}`).not.toBeNull();
			}
		}

		// The sampler runs on its own cadence from boot, so a tick can land
		// INSIDE the loop above - after the fourth connection opened, before
		// its subscribes were counted. Such a tick already satisfies a
		// connections-only wait while having published a ratio over a partial
		// counter. Both fields are written in one synchronous sampler pass, so
		// requiring both binds the wait to a tick that saw the finished state.
		await settle(() => state.counters.lastConnections === CLIENTS
			&& state.pressureSnapshot.subscriberRatio === TOPICS_PER_CLIENT, 8000);
	}, 90000);

	afterAll(async () => {
		for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
		clients = [];
		await rt?.stop();
	});

	it('the sampler measured the real connections and the real subscription count', () => {
		// Bind the producer to reality first. Without this the two assertions
		// below could both hold over numbers no live worker ever produces.
		expect(state.counters.lastConnections, 'the sampler never saw the live connections').toBe(CLIENTS);
		expect(state.counters.totalSubscriptions, 'real subscribes did not reach the counter')
			.toBe(CLIENTS * TOPICS_PER_CLIENT);
	});

	it('publishes the live counter over the live connection count', () => {
		// One side of the shared-basis claim: the ratio the sampler PUBLISHED
		// (read from the snapshot it wrote, not recomputed through the sampler)
		// is the live counter over the live connection count. The sizer's own
		// denominator is deliberately not touched here - a formula for it in
		// this file would just agree with itself - it is pinned by moving the
		// denominator in the last case.
		const published = state.pressureSnapshot.subscriberRatio;
		expect(published, 'the sampler published no subscriber ratio').toBeGreaterThan(0);
		expect(published, 'the published ratio is not the live counter over the live connections')
			.toBeCloseTo(state.counters.totalSubscriptions / state.wsConnections.size, 10);
		expect(published).toBeCloseTo(TOPICS_PER_CLIENT, 10);
	});

	it('narrows the grant window no later than the ratio the same signal fires at', () => {
		// Sweep the live counter against the LIVE connection count, so the
		// engagement point comes out in the same ratio the sampler publishes
		// rather than in a raw counter value that only means something at a
		// denominator of one.
		const conns = state.wsConnections.size;
		expect(conns, 'the sweep needs live connections to be a ratio at all').toBe(CLIENTS);
		const { base, at } = rawEngagementPoint();
		expect(at, 'the window narrows at no ratio this signal can produce').toBeLessThan(Infinity);
		const engagementRatio = at / conns;

		const threshold = metrics.resolvePressureThresholds(undefined).subscriberRatio;
		expect(typeof threshold, 'the subscriber threshold must be a live number').toBe('number');
		expect(engagementRatio, 'a worker at its own subscriber threshold still hands out the full window')
			.toBeLessThanOrEqual(threshold);

		// And the other side, so the pin is not satisfied by a sizer that
		// narrows everywhere: at the threshold ratio the window is below base.
		const before = state.counters.totalSubscriptions;
		const prevHeap = state.counters.lastHeapUsedRatio;
		try {
			state.counters.lastHeapUsedRatio = 0;
			state.counters.totalSubscriptions = threshold * conns;
			expect(metrics.grantSizeFor().count, 'the window at the threshold ratio must be below the base')
				.toBeLessThan(base);
		} finally {
			state.counters.totalSubscriptions = before;
			state.counters.lastHeapUsedRatio = prevHeap;
		}
	});

	it('publishes rates normalized by its own interval, from counters real publishes grew', async () => {
		// The rate producers' basis is a per-second normalization of window
		// counters drained each tick. A single fixed threshold cannot drift
		// against a second consumer, but its producer can still change basis
		// under it - and a raw window count instead of a per-second rate reads
		// IDENTICALLY at the default one-second cadence. So this runs the
		// sampler at a quarter-second cadence, where the two diverge fourfold,
		// and grows the counters through real platform publishes rather than
		// by assignment.
		const platform = (await import(pathToFileURL(path.join(builtDir, 'platform.js')).href)).platform;
		const N = 8;
		const topic = 'rate-basis';
		try {
			metrics.startPressureSampling({ sampleIntervalMs: 250 }, undefined);
			// Synchronous from here through the reads below, so no tick can
			// split the window: every publish lands in one sample.
			const windowBefore = state.counters.publishCountWindow;
			for (let i = 0; i < N; i++) platform.publish(topic, 'tick', { i });
			expect(state.counters.publishCountWindow - windowBefore,
				'real publishes did not reach the window counter').toBe(N);
			const stats = state.topicPublishStats.get(topic);
			expect(stats, 'real publishes did not reach the per-topic stats').toBeTruthy();
			expect(stats.m, 'the per-topic message count missed the real publishes').toBe(N);
			const envelopeLen = stats.b;
			const windowCount = state.counters.publishCountWindow;

			// The snapshot can hold a NONZERO stale rate from the boot window
			// (the fixture's open hook publishes on connect), so waiting on the
			// rate alone can exit before any tick of the re-armed sampler. The
			// unique topic can only surface in the fold when the tick that
			// drained THIS window ran.
			await settle(() => state.pressureSnapshot.topPublishers.some((t) => t.topic === topic), 5000);
			const interval = 250 / 1000;
			// The sampler retains the raw count it drained; the published rate
			// must be that count over the interval it was configured with.
			expect(state.counters.lastPublishCount, 'the drained window is not the one the real publishes grew')
				.toBe(windowCount);
			expect(state.pressureSnapshot.publishRate,
				'the published rate is not the drained window count over the sample interval')
				.toBeCloseTo(state.counters.lastPublishCount / interval, 10);
			const top = state.pressureSnapshot.topPublishers.find((t) => t.topic === topic);
			expect(top, 'the topic never surfaced in the published top-publishers fold').toBeTruthy();
			expect(top.messagesPerSec, 'the per-topic message rate is not per-second')
				.toBeCloseTo(N / interval, 10);
			expect(top.bytesPerSec, 'the per-topic byte rate is not per-second')
				.toBeCloseTo(envelopeLen / interval, 10);

			// And the window DRAINS: a later tick with no publishes reads zero,
			// which is what makes this a rate over one window rather than a
			// cumulative counter.
			await settle(() => state.pressureSnapshot.publishRate === 0, 5000);
			expect(state.pressureSnapshot.publishRate, 'the window never drained').toBe(0);
			// Both windows: the tick that drained the publish counter folded
			// the topic map in the same pass, so a stats map that survives its
			// tick (a cumulative per-topic ledger) leaves the topic here.
			expect(state.pressureSnapshot.topPublishers.some((t) => t.topic === topic),
				'the per-topic window did not drain').toBe(false);
		} finally {
			metrics.startPressureSampling(undefined, undefined);
		}
	}, 20000);

	it('narrows at a point that moves with the live connection count', async () => {
		// The other side of the shared-basis claim: the sizer DIVIDES BY the
		// live connection count. Nothing so far pins that - a sizer that read
		// the raw counter would only narrow earlier in ratio terms, which the
		// "no later than" case above allows. So measure the raw narrowing
		// point, move the denominator by closing real connections, and require
		// the narrowing point to move with it. A sizer with a dropped or
		// hardcoded denominator fails on one of the two states.
		const at4 = rawEngagementPoint().at;
		expect(at4, 'the window never narrowed under the full connection count').toBeLessThan(Infinity);

		for (const c of clients.splice(1)) c.close();
		// Real closes reverse the closed clients' subscriptions through the
		// real accounting path, and the sampler's next tick republishes over
		// the shrunk denominator. Wait for all three, then assert each.
		await settle(() => state.wsConnections.size === 1
			&& state.counters.totalSubscriptions === TOPICS_PER_CLIENT
			&& state.counters.lastConnections === 1, 15000);
		expect(state.wsConnections.size, 'the closed connections never left the live map').toBe(1);
		expect(state.counters.totalSubscriptions, 'closing did not reverse the closed clients\' subscriptions')
			.toBe(TOPICS_PER_CLIENT);
		expect(state.counters.lastConnections, 'the sampler never saw the shrunk connection count').toBe(1);
		expect(state.pressureSnapshot.subscriberRatio, 'the republished ratio is not the counter over one connection')
			.toBeCloseTo(TOPICS_PER_CLIENT, 10);

		const at1 = rawEngagementPoint().at;
		expect(at1, 'the window never narrowed under one connection').toBeLessThan(Infinity);
		// With a shared gate g, a worker with n connections narrows at the
		// first counter value past n*g, so the two measured points bracket:
		// n*(at1-1) < at4 <= n*at1. The lower bound is what kills a sizer that
		// ignores or hardcodes the connection count (either way at4 = at1,
		// which cannot exceed n*(at1-1) for any gate past 1); the upper bound
		// kills super-linear scaling, where a squared denominator overshoots.
		expect(at4, 'the narrowing point did not scale up with the connection count')
			.toBeGreaterThan(CLIENTS * (at1 - 1));
		expect(at4, 'the narrowing point overshot the connection-count scaling')
			.toBeLessThanOrEqual(CLIENTS * at1);
	}, 30000);
});
