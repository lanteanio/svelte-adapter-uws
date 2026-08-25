// Pressure-lane properties that need the BUILT modules - the same instances a
// running server uses (the source tree cannot be imported in a unit run:
// pressure-metrics.js reaches config.js, which reads a build-time
// placeholder):
//
//   1. grantSizeFor sizes replenish windows from the sampler's cached heap
//      ratio, never a live process.memoryUsage() syscall - a syscall there
//      would sit on the per-frame replenish path and tie grant sizes to the
//      host heap while every other input under the sim is virtualized.
//   2. The sampled ratio measures the nearest memory wall rather than V8
//      arena fullness, recomputed here from the raw primitives.
//   3. The grant window stays calibrated to that ratio: both boundaries of
//      the pair are read from the shipped threshold and the shipped reader,
//      never supplied by the case.
//   4. The listener sweeps iterate a snapshot: a listener that registers
//      another listener from inside its callback must not extend the sweep
//      it is running in.

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const builtDir = path.join(fileURLToPath(new URL('./fixture', import.meta.url)), 'build', 'handler');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function builtModules() {
	expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
	const state = await import(pathToFileURL(path.join(builtDir, 'state.js')).href);
	const metrics = await import(pathToFileURL(path.join(builtDir, 'pressure-metrics.js')).href);
	return { state, metrics };
}

describe('grant sizing reads the cached sampler ratio', () => {
	it('sizes from counters.lastHeapUsedRatio without a live memory syscall', async () => {
		const { state, metrics } = await builtModules();
		const prev = state.counters.lastHeapUsedRatio;
		const spy = vi.spyOn(process, 'memoryUsage');
		try {
			state.counters.lastHeapUsedRatio = 0;
			const idle = metrics.grantSizeFor().count;
			state.counters.lastHeapUsedRatio = 0.95;
			const tight = metrics.grantSizeFor().count;
			expect(spy, 'the replenish path must not touch process.memoryUsage').not.toHaveBeenCalled();
			expect(tight, 'a hot cached ratio narrows the window').toBeLessThan(idle);
			expect(idle, 'the pre-first-sample cache (0) hands out the full base window').toBe(256);
		} finally {
			state.counters.lastHeapUsedRatio = prev;
			spy.mockRestore();
		}
	});
});

describe('the sampled memory ratio measures the nearest wall, not the arena', () => {
	it('folds heap and resident set against their walls, worst-of', async () => {
		const { state, metrics } = await builtModules();
		try {
			metrics.startPressureSampling({ sampleIntervalMs: 100 }, undefined);
			const deadline = Date.now() + 5000;
			while (state.counters.lastHeapUsedRatio === 0 && Date.now() < deadline) await sleep(20);
			metrics.stopPressureSampling();
			const sampled = state.counters.lastHeapUsedRatio;
			expect(sampled, 'the sampler never wrote a reading').toBeGreaterThan(0);

			// Recompute the expected quantity from the raw primitives, not from
			// the adapter: node's own isolate limit, and the cgroup limit read
			// straight off the root files where this machine has one (the walk
			// beyond the root only matters under a host cgroup namespace, which
			// neither the dev machines nor the CI containers use). The tolerance
			// absorbs memory movement between the sampler's tick and this read.
			const v8mod = await import('node:v8');
			const fs = await import('node:fs');
			let cgroupLimit = null;
			for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
				try {
					const text = fs.readFileSync(p, 'utf8').trim();
					if (/^\d+$/.test(text) && Number(text) < 2 ** 62) { cgroupLimit = Number(text); break; }
				} catch { /* not this layout */ }
			}
			const limit = v8mod.default.getHeapStatistics().heap_size_limit;
			const mem = process.memoryUsage();
			const expected = Math.max(
				mem.heapUsed / limit,
				cgroupLimit === null ? 0 : mem.rss / cgroupLimit
			);
			expect(Math.abs(sampled - expected)).toBeLessThan(0.15);
			// The arena-fullness reading this replaced sits far above the wall
			// reading on a test process. Assert the drop only where the walls
			// are roomy - a memory-limited CI container can legitimately sit
			// near its wall, and the recomputation above already binds it.
			if (expected < 0.35) expect(sampled).toBeLessThan(0.5);
		} finally {
			metrics.stopPressureSampling();
		}
	}, 20000);
});

// The window a flow-controlled client is granted is sized from this same
// memory ratio, so the sizer and the signal are one calibrated pair: the
// window must still be the full base at what a healthy worker reads, and must
// already be narrowing by the point the signal itself calls that worker
// pressured. Neither boundary is visible to a case that supplies its own
// ratio - the unit cases in test/lease-flow.test.js each choose their input
// and assert only the SHAPE, which stays true wherever the boundaries sit.
// These two read the shipped threshold and drive the shipped reader instead,
// so the pair cannot drift apart silently.
describe('the grant window is calibrated to the memory signal it consumes', () => {
	/**
	 * The ratio at which the sizer starts narrowing, derived from the shipped
	 * sizer rather than restated here: the lowest reading whose window is no
	 * longer the full base. Deriving it is what keeps this file honest if the
	 * sizer's own gate moves.
	 */
	function engagementPoint(state, metrics) {
		const base = (state.counters.lastHeapUsedRatio = 0, metrics.grantSizeFor().count);
		let below = 0;
		for (let r = 0; r <= 1.0001; r += 0.01) {
			const at = r > 1 ? 1 : r;
			state.counters.lastHeapUsedRatio = at;
			if (metrics.grantSizeFor().count < base) return { base, at, below };
			below = at;
		}
		return { base, at: Infinity, below: 1 };
	}

	it('narrows no later than the threshold that same signal fires at', async () => {
		const { state, metrics } = await builtModules();
		const prev = state.counters.lastHeapUsedRatio;
		try {
			// Read the shipped default rather than restating it, so moving the
			// threshold moves this input too.
			const threshold = metrics.resolvePressureThresholds(undefined).memoryHeapUsedRatio;
			expect(typeof threshold, 'the memory threshold must be a live number to calibrate against').toBe('number');
			const { base, at } = engagementPoint(state, metrics);
			expect(at, 'the window narrows at no reading the signal can produce, up to and including 1').toBeLessThanOrEqual(1);
			expect(at, 'a worker at its own memory threshold still hands out the full window').toBeLessThanOrEqual(threshold);
			state.counters.lastHeapUsedRatio = threshold;
			expect(metrics.grantSizeFor().count, 'the window at the threshold must be below the base').toBeLessThan(base);
		} finally {
			state.counters.lastHeapUsedRatio = prev;
		}
	});

	it('keeps the full window for a worker the shipped reader puts below that point', async () => {
		const { state, metrics } = await builtModules();
		const prev = state.counters.lastHeapUsedRatio;
		try {
			// The producer itself, not a number this file invented: the built
			// wall reader against this process's real memory.
			const wall = await import(pathToFileURL(path.join(builtDir, '..', 'utils', 'memory-wall.js')).href);
			const ratio = wall.createMemoryWallReader().ratio(process.memoryUsage());
			// A dead producer would answer 0 and sail through the branch below,
			// so bind the reading to being a reading at all first.
			expect(ratio, 'the reader must return a live wall reading').toBeGreaterThan(0);
			const { base, at, below } = engagementPoint(state, metrics);
			state.counters.lastHeapUsedRatio = ratio;
			const window = metrics.grantSizeFor().count;
			// Which side applies is a property of the machine, not of the code:
			// a roomy host reads under the engagement point and must keep the
			// full window, while a worker genuinely close to its container wall
			// SHOULD be throttled - and on that machine the narrowing side is
			// the claim worth pinning. The sweep locates the point on a grid,
			// so a reading inside the one-step bracket around it is only known
			// to be no LARGER than the base; asserting equality there would
			// make this environment-dependent again the moment the sizer's own
			// boundary moves off the grid.
			if (ratio <= below) {
				expect(window, 'a worker under the engagement point keeps the full window').toBe(base);
			} else if (ratio >= at) {
				expect(window, 'a worker at or past the engagement point is narrowed').toBeLessThan(base);
			} else {
				expect(window, 'a reading inside the engagement bracket never exceeds the base').toBeLessThanOrEqual(base);
			}
		} finally {
			state.counters.lastHeapUsedRatio = prev;
		}
	});
});

describe('listener sweeps iterate a snapshot', () => {
	afterEach(async () => {
		const { metrics } = await builtModules();
		metrics.stopPressureSampling();
	});

	it('a publish-rate listener that adds a listener does not extend the running sweep', async () => {
		const { state, metrics } = await builtModules();
		const sweeps = [];
		let sweepIndex = 0;
		const late = () => sweeps.push(['late', sweepIndex]);
		const early = () => {
			sweepIndex++;
			sweeps.push(['early', sweepIndex]);
			state.publishRateListeners.add(late);
		};
		state.publishRateListeners.add(early);
		try {
			// Threshold crossings on a fast cadence: the first sweep must run
			// only the pre-registered listener; the one it added joins the next.
			state.topicPublishStats.set('sweep-topic', { m: 100000, b: 100000000, d: 100000 });
			metrics.startPressureSampling({ sampleIntervalMs: 100, topicPublishRatePerSec: 10 }, undefined);
			const deadline = Date.now() + 10000;
			while (sweepIndex < 2 && Date.now() < deadline) {
				// Re-seed so every tick crosses the threshold again (the sampler
				// drains the stats map as it reads it).
				state.topicPublishStats.set('sweep-topic', { m: 100000, b: 100000000, d: 100000 });
				await sleep(20);
			}
			metrics.stopPressureSampling();
			expect(sweepIndex, 'the sampler never swept twice inside the budget').toBeGreaterThanOrEqual(2);
			expect(sweeps, 'the newcomer ran inside the sweep that registered it').not.toContainEqual(['late', 1]);
			expect(sweeps, 'the newcomer must join the next sweep').toContainEqual(['late', 2]);
		} finally {
			state.publishRateListeners.delete(early);
			state.publishRateListeners.delete(late);
		}
	}, 20000);

	it('a listener removed mid-sweep still fires once in the sweep already underway', async () => {
		const { state, metrics } = await builtModules();
		const sweeps = [];
		let sweepIndex = 0;
		const victim = () => sweeps.push(['victim', sweepIndex]);
		const remover = () => {
			sweepIndex++;
			sweeps.push(['remover', sweepIndex]);
			state.publishRateListeners.delete(victim);
		};
		state.publishRateListeners.add(remover);
		state.publishRateListeners.add(victim);
		try {
			state.topicPublishStats.set('sweep-topic', { m: 100000, b: 100000000, d: 100000 });
			metrics.startPressureSampling({ sampleIntervalMs: 100, topicPublishRatePerSec: 10 }, undefined);
			const deadline = Date.now() + 10000;
			while (sweepIndex < 2 && Date.now() < deadline) {
				state.topicPublishStats.set('sweep-topic', { m: 100000, b: 100000000, d: 100000 });
				await sleep(20);
			}
			metrics.stopPressureSampling();
			expect(sweepIndex, 'the sampler never swept twice inside the budget').toBeGreaterThanOrEqual(2);
			// Standard emitter semantics on both edges: the sweep underway still
			// delivers to a listener removed during it, and the removal holds
			// from the next sweep on.
			expect(sweeps).toContainEqual(['victim', 1]);
			expect(sweeps).not.toContainEqual(['victim', 2]);
		} finally {
			state.publishRateListeners.delete(remover);
			state.publishRateListeners.delete(victim);
		}
	}, 20000);

	it('a pressure listener that adds a listener does not extend the running transition sweep', async () => {
		const { state, metrics } = await builtModules();
		const sweeps = [];
		let sweepIndex = 0;
		const late = () => sweeps.push(['late', sweepIndex]);
		const early = () => {
			sweepIndex++;
			sweeps.push(['early', sweepIndex]);
			state.pressureListeners.add(late);
		};
		state.pressureListeners.add(early);
		const reasonBefore = state.pressureSnapshot.reason;
		try {
			// Transition sweeps fire on reason CHANGES, so drive two: a publish
			// burst lifts NONE to PUBLISH_RATE (first sweep), then the drained
			// window falls back to NONE (second sweep). Every other signal is
			// disabled so the host machine cannot inject its own transitions.
			state.pressureSnapshot.reason = 'NONE';
			state.counters.publishCountWindow = 1000000;
			metrics.startPressureSampling({
				sampleIntervalMs: 100,
				publishRatePerSec: 10,
				memoryHeapUsedRatio: false,
				subscriberRatio: false,
				topicPublishRatePerSec: false,
				topicPublishBytesPerSec: false,
				psiCpuSome: false,
				psiMemoryFull: false,
				psiIoFull: false,
				cpuThrottledRatio: false
			}, undefined);
			const deadline = Date.now() + 10000;
			while (sweepIndex < 2 && Date.now() < deadline) await sleep(20);
			metrics.stopPressureSampling();
			expect(sweepIndex, 'the sampler never saw two transitions inside the budget').toBeGreaterThanOrEqual(2);
			expect(sweeps, 'the newcomer ran inside the sweep that registered it').not.toContainEqual(['late', 1]);
			expect(sweeps, 'the newcomer must join the next sweep').toContainEqual(['late', 2]);
		} finally {
			state.pressureListeners.delete(early);
			state.pressureListeners.delete(late);
			state.pressureSnapshot.reason = reasonBefore;
		}
	}, 20000);
});
