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

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
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

// Warm the fixture BEFORE any case body runs. The first case spies on
// `process.memoryUsage` and asserts it is never called, so a build landing
// inside that spy window fails it - observed twice here, each time on the first
// run after a source edit invalidated the build, and never on a warm run. The
// build is a cache hit for every case once this has run, so no case owns it.
beforeAll(async () => {
	await builtModules();
}, 120000);

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

// The SECOND signal the grant window consumes, pinned the same way and for the
// same reason. `leaseGrantSize` narrows on `subscriberRatio > 25`, and the
// pressure sampler reports the worker saturated on its own `subscriberRatio`
// threshold - both read one producer, `counters.totalSubscriptions` over the
// live connection count. Nothing connected the two numbers, so either could
// move without the other and no case would notice: the unit cases for the sizer
// supply their own ratio, and the sampler's cases supply their own threshold.
//
// WHAT THIS BLOCK BINDS, exactly: the two NUMBERS, each read from its shipped
// surface, at a denominator of one - the fixture holds no live connections, so
// the counter is the sizer's ratio, and that is also the one state where the
// sampler's basis diverges from the sizer's (`connections > 0 ? ... : 0`
// against `size || 1`). The claim that both consumers divide the same counter
// by the same LIVE denominator therefore cannot be made here at all; it is
// pinned on a real worker in test/pressure-calibration-real.test.js, where the
// connection count exists and can be moved.
//
// When the counter under this ratio clamps to zero the ratio reads zero too,
// and this arm of the sizer silently stops engaging at any load - a drifted
// producer disables its consumer with nothing failing, which is why the
// relationship wants a pin in both files.
describe('the grant window is calibrated to the subscriber signal it consumes', () => {
	/**
	 * The subscriber ratio at which the sizer starts narrowing, derived by
	 * driving the SHIPPED sizer rather than restating its gate. `grantSizeFor`
	 * reads `totalSubscriptions / (wsConnections.size || 1)`, and the fixture
	 * holds no live connections here, so the counter IS the ratio.
	 */
	function subscriberEngagementPoint(state, metrics) {
		const before = state.counters.totalSubscriptions;
		state.counters.totalSubscriptions = 0;
		const base = metrics.grantSizeFor().count;
		let below = 0;
		try {
			for (let ratio = 1; ratio <= 4096; ratio++) {
				state.counters.totalSubscriptions = ratio;
				if (metrics.grantSizeFor().count < base) return { base, at: ratio, below };
				below = ratio;
			}
			return { base, at: Infinity, below };
		} finally {
			state.counters.totalSubscriptions = before;
		}
	}

	it('narrows no later than the threshold that same signal fires at', async () => {
		const { state, metrics } = await builtModules();
		const prevSubs = state.counters.totalSubscriptions;
		const prevHeap = state.counters.lastHeapUsedRatio;
		try {
			// Neutralise the OTHER arm, so what this measures is the subscriber
			// gate rather than whatever the heap arm happens to be doing.
			state.counters.lastHeapUsedRatio = 0;
			const threshold = metrics.resolvePressureThresholds(undefined).subscriberRatio;
			expect(typeof threshold, 'the subscriber threshold must be a live number to calibrate against').toBe('number');
			const { base, at } = subscriberEngagementPoint(state, metrics);
			expect(at, 'the window narrows at no subscriber ratio the signal can produce').toBeLessThan(Infinity);
			expect(at, 'a worker at its own subscriber threshold still hands out the full window').toBeLessThanOrEqual(threshold);
			state.counters.totalSubscriptions = threshold;
			expect(metrics.grantSizeFor().count, 'the window at the threshold must be below the base').toBeLessThan(base);
		} finally {
			state.counters.totalSubscriptions = prevSubs;
			state.counters.lastHeapUsedRatio = prevHeap;
		}
	});

	it('hands out the full window to a worker carrying no subscriptions', async () => {
		// The other side of the same gate. Without this the pin above is
		// satisfied by a sizer that narrows everywhere, including on an idle
		// worker - which is the drift that shipped last time, in the opposite
		// direction.
		const { state, metrics } = await builtModules();
		const prevSubs = state.counters.totalSubscriptions;
		const prevHeap = state.counters.lastHeapUsedRatio;
		try {
			state.counters.lastHeapUsedRatio = 0;
			state.counters.totalSubscriptions = 0;
			const idle = metrics.grantSizeFor().count;
			const { base } = subscriberEngagementPoint(state, metrics);
			expect(idle, 'an idle worker keeps the full base window').toBe(base);
		} finally {
			state.counters.totalSubscriptions = prevSubs;
			state.counters.lastHeapUsedRatio = prevHeap;
		}
	});

	it('the sampler publishes zero, not the raw counter, for a worker with no connections', async () => {
		// The divergence that forces the shared-basis pin onto a live worker:
		// with no connections the sampler answers 0 where the sizer reads the
		// whole counter. The comment blocks here and in
		// test/pressure-calibration-real.test.js both lean on that guard, and
		// this is where it fails if it is ever dropped - without it the tick
		// below publishes a division of 100 by nothing, not 0.
		const { state, metrics } = await builtModules();
		const prevSubs = state.counters.totalSubscriptions;
		const prevConns = state.counters.lastConnections;
		const prevRatio = state.pressureSnapshot.subscriberRatio;
		const stampBefore = state.pressureSnapshot.sampledAt;
		try {
			expect(state.wsConnections.size, 'this pin needs a worker with no live connections').toBe(0);
			state.counters.totalSubscriptions = 100;
			// Poison both fields the tick must write, so the asserts below
			// cannot be satisfied by a sampler that stopped writing them: the
			// snapshot field starts at a value no sampler produces, and the
			// stale connection count is positive so a sampler that reads the
			// previous tick's count instead of the live set publishes 100/7,
			// not the 0 this case demands.
			state.pressureSnapshot.subscriberRatio = -1;
			state.counters.lastConnections = 7;
			metrics.startPressureSampling({ sampleIntervalMs: 100 }, undefined);
			const deadline = Date.now() + 5000;
			while (state.pressureSnapshot.sampledAt === stampBefore && Date.now() < deadline) await sleep(20);
			metrics.stopPressureSampling();
			expect(state.pressureSnapshot.sampledAt, 'the sampler never ticked inside the budget').not.toBe(stampBefore);
			expect(state.counters.lastConnections, 'the tick did not see the empty connection set').toBe(0);
			expect(state.pressureSnapshot.subscriberRatio,
				'a worker with no connections must publish a zero ratio, not the raw counter').toBe(0);
		} finally {
			metrics.stopPressureSampling();
			state.counters.totalSubscriptions = prevSubs;
			state.counters.lastConnections = prevConns;
			state.pressureSnapshot.subscriberRatio = prevRatio;
		}
	}, 20000);
});

// The two calibrated pairs above are every instance of a class: one produced
// runtime signal read by MORE THAN ONE fixed threshold. A lone threshold has
// nothing to drift against - move it and the behaviour moves with it, visibly.
// Two thresholds on one signal can move apart silently, which is what the
// calibration pins exist to stop. That count - exactly two pairs, heap and
// subscribers - is a property of the shipped code, so it is asserted here
// rather than remembered: a third pair cannot appear in the sizer's parameter
// readings, in the wrapper's own state reads, or in the sampler's threshold
// set without failing one of these cases, and the failure message says what
// the new pair owes. A read routed through a helper the wrapper calls sits
// beyond any scan of the wrapper's source - that residual is stated where the
// scan is, not papered over here.
describe('no produced signal gains a second threshold consumer silently', () => {
	/**
	 * Every reading the shipped sizer consults, discovered from the function
	 * itself twice over. A recording Proxy catches any property access however
	 * it is spelled (destructuring included), driven once with every reading
	 * absent and once per level pair of the two known gates over below-gate,
	 * BETWEEN-gate-and-threshold, and past-threshold values - the middle level
	 * because a tiered gate would naturally sit in exactly that band, where
	 * corner values never reach it. A read nested under any mix of those
	 * branches executes under some probe, and a read guarded by a signal the
	 * grid does not know is still caught through the guard's own access, which
	 * the Proxy records whichever branch then runs. Unknown properties read
	 * high, so a threshold guard on one proceeds into its branch. A scan of
	 * the function's own source then catches a literal read the probes cannot
	 * reach. The honest residual: a read that is dead under every probe AND
	 * spelled without the parameter's name escapes the discovery, and
	 * production inputs outside the grid may still reach it - the grid covers
	 * the bands the shipped gates and thresholds define, not every real.
	 */
	function consultedReadings(sizer) {
		const touched = new Set();
		const probe = (levels, fallback) => {
			sizer(new Proxy({}, {
				get(_, prop) {
					if (typeof prop !== 'string') return undefined;
					touched.add(prop);
					return Object.prototype.hasOwnProperty.call(levels, prop) ? levels[prop] : fallback;
				},
				has(_, prop) { if (typeof prop === 'string') touched.add(prop); return true; }
			}));
		};
		probe({}, undefined);
		for (const heapRatio of [0, 0.8, 0.99]) {
			for (const subscriberRatio of [0, 30, 1e9]) {
				probe({ heapRatio, subscriberRatio }, 1e9);
			}
		}
		const src = String(sizer);
		const param = (src.match(/^[^(]*\(\s*([A-Za-z_$][\w$]*)\s*[),]/) || [])[1];
		if (param) {
			for (const m of src.matchAll(new RegExp('\\b' + param + '\\.([A-Za-z_$][\\w$]*)', 'g'))) {
				touched.add(m[1]);
			}
		}
		return touched;
	}

	it('the grant path consults exactly the signals calibrated above', async () => {
		const { state, metrics } = await builtModules();
		const wire = await import(pathToFileURL(path.join(builtDir, '..', 'wire.js')).href);
		const consulted = [...consultedReadings(wire.leaseGrantSize)].sort();
		// `base` and `floor` are window knobs, not produced signals; the other
		// two are the signals whose calibrations are pinned above. A NEW name
		// in this list is a new consumer of a produced signal, and it owes two
		// pins before it lands here: a calibration pair in this file (window
		// engagement against the threshold the same signal fires at, both read
		// from the shipped surfaces), and - if the signal's producer already
		// feeds another threshold - a shared-basis case on a live worker in
		// test/pressure-calibration-real.test.js.
		expect(consulted, 'the sizer consults a reading whose calibration is pinned nowhere')
			.toEqual(['base', 'floor', 'heapRatio', 'subscriberRatio']);
		// And both discovered gates are live, so the discovery above cannot be
		// satisfied by dead code: each narrows the window on its own.
		const base = wire.leaseGrantSize({ heapRatio: 0, subscriberRatio: 0 });
		expect(wire.leaseGrantSize({ heapRatio: 0.99, subscriberRatio: 0 }),
			'the heap reading no longer narrows the window').toBeLessThan(base);
		expect(wire.leaseGrantSize({ heapRatio: 0, subscriberRatio: 1e6 }),
			'the subscriber reading no longer narrows the window').toBeLessThan(base);
		// The wrapper is a consumer surface of its own: it chooses which live
		// state feeds the sizer, and a gate added THERE - reading a counter
		// and adjusting the count after the sizer returned - would never touch
		// the parameter the discovery above watches. Scan the state it reads,
		// against EVERY export of the state module rather than a hand-kept
		// pair of names: the wrapper's module already imports other produced
		// surfaces (the pressure snapshot among them), and a gate spelled off
		// one of those must land in this net too. Require every mention to
		// carry a member: an alias (`const c = counters`) or a destructuring
		// (`const { x } = counters`) is a bare mention, and failing on those
		// is what keeps the scan spelling-proof. A read routed through a
		// helper the wrapper calls is beyond this scan's reach - the residual
		// the block comment above names.
		const surfaces = Object.keys(state).sort((a, b) => b.length - a.length);
		const mention = new RegExp('\\b(' + surfaces.join('|') + ')\\b(?:\\.([A-Za-z_$][\\w$]*))?', 'g');
		const stateReads = new Set();
		const bareMentions = [];
		for (const m of String(metrics.grantSizeFor).matchAll(mention)) {
			if (m[2] === undefined) bareMentions.push(m[1]);
			else stateReads.add(m[1] + '.' + m[2]);
		}
		expect(bareMentions,
			'the wrapper mentions live state without a member - an alias or destructuring this scan cannot follow')
			.toEqual([]);
		expect([...stateReads].sort(), 'the grant path reads live state no calibration case covers')
			.toEqual(['counters.lastHeapUsedRatio', 'counters.totalSubscriptions', 'wsConnections.size']);
	});

	it('the sampler thresholds gate exactly the known signals', async () => {
		const { metrics } = await builtModules();
		const resolved = Object.keys(metrics.resolvePressureThresholds(undefined)).sort();
		// Grouped by how many fixed thresholds read each signal's producer.
		// `sampleIntervalMs` is the cadence, not a threshold. A NEW key here
		// forces the same classification as above: a signal whose producer
		// also feeds the sizer joins the pairs and owes the two pins named
		// there; a signal with this one consumer joins the singles AND owes a
		// basis pin, because a lone threshold still rots when its producer's
		// basis or units change under it. Every single below has one: the
		// publish-window and per-topic rates on a live worker in
		// test/pressure-calibration-real.test.js, the PSI and throttle
		// signals in the kernel-basis cases that follow this block.
		const pairedWithTheSizer = ['memoryHeapUsedRatio', 'subscriberRatio'];
		const singleConsumer = [
			'publishRatePerSec', 'topicPublishRatePerSec', 'topicPublishBytesPerSec',
			'psiCpuSome', 'psiMemoryFull', 'psiIoFull', 'cpuThrottledRatio'
		];
		expect(resolved, 'a threshold appeared that no calibration case classifies')
			.toEqual([...pairedWithTheSizer, ...singleConsumer, 'sampleIntervalMs'].sort());
	});
});

// The single-consumer signals still rot without a partner: a producer's basis
// or units can change under a fixed threshold while every case that supplies
// its own reading stays green - the shape the memory signal's basis change
// took, and it needed no second consumer. So each producer carries a basis
// pin. The heap ratio has its recompute-from-primitives case above, the
// subscriber ratio and the publish-window and per-topic rates live on a real
// worker in test/pressure-calibration-real.test.js, and the two kernel
// sources are pinned here: fixture files at the kernel's own formats drive
// the SHIPPED parser, the SHIPPED running sampler, and the SHIPPED fold, with
// engagement measured exactly at the shipped default and just below it.
// Excluded by classification, durably: egress ceilings are
// operator-configured, so there is no shipped number to calibrate against a
// producer; the folded pressureSnapshot.value has no fixed-threshold consumer
// in the runtime (the introspection export and a gauge read it, nothing gates
// on it).
describe('every kernel signal keeps the basis its threshold was tuned against', () => {
	const enoent = (p) => { const e = new Error('ENOENT: no fixture for ' + p); e.code = 'ENOENT'; throw e; };

	async function kernelModules() {
		const { state, metrics } = await builtModules();
		const os = await import(pathToFileURL(path.join(builtDir, '..', 'utils', 'os-pressure.js')).href);
		return { state, metrics, os };
	}

	afterEach(async () => {
		const { metrics } = await builtModules();
		metrics.stopPressureSampling();
		// These cases replace the module's sampler instance with fixture-fed
		// ones. Hand later suites a probed-absent instance instead of a dead
		// fixture reader, so their kernel readings are cleanly null.
		metrics.startPressureSampling(undefined, { psi: false, cpuThrottle: false });
		metrics.stopPressureSampling();
	});

	it('a PSI reading travels file to reason in avg10 percent, engaging exactly at the shipped default', async () => {
		const { state, metrics, os } = await kernelModules();
		const t = metrics.resolvePressureThresholds(undefined);
		// Distinct values on every line and column, all below the shipped
		// defaults, so a wrong line (some vs full), a wrong column
		// (avg60/avg300), or a swapped file each surface as a wrong number.
		const psiFile = (some, full) =>
			`some avg10=${some} avg60=97.00 avg300=98.00 total=11111\nfull avg10=${full} avg60=95.00 avg300=96.00 total=22222\n`;
		const quietFiles = () => ({
			'/proc/pressure/cpu': psiFile('6.50', '7.50'),
			'/proc/pressure/memory': psiFile('2.50', '1.50'),
			'/proc/pressure/io': psiFile('3.50', '4.50')
		});
		const files = quietFiles();

		// The shipped parser and its line/column selection, alone.
		const parseOnly = os.createOsPressureSampler({ readFile: (p) => files[p] ?? enoent(p) });
		expect(parseOnly.sample(1000).psi, 'the parser must read cpu from some and memory/io from full, at avg10')
			.toEqual({ cpuSome10: 6.5, memoryFull10: 1.5, ioFull10: 4.5 });

		// The same files through the RUNNING sampler: parser, field routing
		// into the sample, fold, and shipped default in one pass.
		const tick = async () => {
			const before = state.pressureSnapshot.sampledAt;
			const deadline = Date.now() + 5000;
			while (state.pressureSnapshot.sampledAt === before && Date.now() < deadline) await sleep(20);
			expect(state.pressureSnapshot.sampledAt, 'the sampler never ticked inside the budget').not.toBe(before);
		};
		try {
			// Every signal this case does not drive is disabled, so the host
			// machine cannot inject its own reason: computePressureReason ranks
			// MEMORY first, and a memory-capped CI container legitimately sits
			// at its wall (the wall case above says so) - which would answer
			// MEMORY where this case expects NONE or PSI.
			metrics.startPressureSampling({
				sampleIntervalMs: 100,
				memoryHeapUsedRatio: false,
				publishRatePerSec: false,
				subscriberRatio: false,
				topicPublishRatePerSec: false,
				topicPublishBytesPerSec: false
			}, { psi: true, cpuThrottle: false, readFile: (p) => files[p] ?? enoent(p) });
			await tick();
			expect(state.pressureSnapshot.psi, 'the running sampler did not carry the parsed readings')
				.toEqual({ cpuSome10: 6.5, memoryFull10: 1.5, ioFull10: 4.5 });
			expect(state.counters.lastBasePressureReason, 'quiet fixture readings must not engage').toBe('NONE');

			for (const [file, key, mk] of [
				['/proc/pressure/cpu', 'psiCpuSome', (v) => psiFile(v, '7.50')],
				['/proc/pressure/memory', 'psiMemoryFull', (v) => psiFile('2.50', v)],
				['/proc/pressure/io', 'psiIoFull', (v) => psiFile('3.50', v)]
			]) {
				expect(typeof t[key], key + ' must be a live number to calibrate against').toBe('number');
				files[file] = mk((t[key] - 0.01).toFixed(2));
				await tick();
				expect(state.counters.lastBasePressureReason, key + ' engaged below its own threshold').toBe('NONE');
				files[file] = mk(t[key].toFixed(2));
				await tick();
				expect(state.counters.lastBasePressureReason, key + ' at its own threshold must engage').toBe('PSI');
				Object.assign(files, quietFiles());
			}
		} finally {
			metrics.stopPressureSampling();
		}
	}, 30000);

	it('a throttle reading is the fraction of its own window, engaging exactly at the shipped default', async () => {
		const { state, metrics, os } = await kernelModules();
		const t = metrics.resolvePressureThresholds(undefined);
		expect(typeof t.cpuThrottledRatio, 'the throttle threshold must be a live number to calibrate against').toBe('number');

		// v1 nanoseconds normalize to microseconds in the shipped parser.
		expect(os.parseCpuStat('nr_periods 9\nnr_throttled 4\nthrottled_time 250000000\n'),
			'the v1 nanosecond field must normalize to microseconds')
			.toEqual({ nrThrottled: 4, throttledUsec: 250000 });

		// Baseline and cap on the shipped sampler alone: the first read
		// establishes the delta baseline, and a delta past the window caps.
		let n = 0;
		const capSampler = os.createOsPressureSampler({
			readFile: (p) => p === '/sys/fs/cgroup/cpu.stat'
				? `nr_throttled ${n + 1}\nthrottled_usec ${(n++) * 10 ** 9}\n` : enoent(p)
		});
		expect(capSampler.sample(100).cpuThrottle, 'the first read must be a baseline, not a spike')
			.toEqual({ throttledRatio: 0, nrThrottledDelta: 0 });
		expect(capSampler.sample(100).cpuThrottle.throttledRatio, 'a delta past the window must cap at 1').toBe(1);

		// The DELTA half of the basis, which the running chain below cannot
		// see: at its observed tick the cumulative count and the per-window
		// delta coincide by construction. Constant increments separate them -
		// a sampler dividing the cumulative count reads double on sample 3.
		let k = 0;
		const deltaSampler = os.createOsPressureSampler({
			readFile: (p) => p === '/sys/fs/cgroup/cpu.stat'
				? `nr_throttled ${k}\nthrottled_usec ${(k++) * 25000}\n` : enoent(p)
		});
		expect(deltaSampler.sample(100).cpuThrottle.throttledRatio).toBe(0);
		expect(deltaSampler.sample(100).cpuThrottle.throttledRatio).toBeCloseTo(0.25, 10);
		expect(deltaSampler.sample(100).cpuThrottle.throttledRatio,
			'the ratio must divide the per-window delta, not the cumulative count').toBeCloseTo(0.25, 10);

		// The RUNNING chain: a constant per-tick delta derived from the
		// shipped default, so every measured window lands exactly on the
		// threshold - then one step below. Constant per-tick growth keeps the
		// ratio independent of which tick is observed.
		const W = 100;
		const run = async (usecPerTick) => {
			let reads = 0;
			// The snapshot field survives a stop, so without this the wait
			// below could exit on the PREVIOUS run's reading.
			state.pressureSnapshot.cpuThrottle = null;
			// Undriven signals disabled for the same host-injection reason as
			// the PSI case: MEMORY outranks CPU_QUOTA in the reason fold.
			metrics.startPressureSampling({
				sampleIntervalMs: W,
				memoryHeapUsedRatio: false,
				publishRatePerSec: false,
				subscriberRatio: false,
				topicPublishRatePerSec: false,
				topicPublishBytesPerSec: false
			}, {
				psi: false, cpuThrottle: true,
				readFile: (p) => p === '/sys/fs/cgroup/cpu.stat'
					? `nr_throttled ${reads}\nthrottled_usec ${(reads++) * usecPerTick}\n` : enoent(p)
			});
			const deadline = Date.now() + 5000;
			while ((state.pressureSnapshot.cpuThrottle?.throttledRatio ?? 0) === 0 && Date.now() < deadline) await sleep(20);
			const seen = {
				ratio: state.pressureSnapshot.cpuThrottle?.throttledRatio,
				reason: state.counters.lastBasePressureReason
			};
			metrics.stopPressureSampling();
			return seen;
		};
		const step = Math.round(t.cpuThrottledRatio * W * 1000);
		const at = await run(step);
		expect(at.ratio, 'the ratio is not the per-window delta over the window the sampler names')
			.toBeCloseTo(t.cpuThrottledRatio, 10);
		expect(at.reason, 'a worker throttled exactly at the default must engage').toBe('CPU_QUOTA');
		const below = await run(step - 1000);
		expect(below.ratio).toBeCloseTo((step - 1000) / (W * 1000), 10);
		expect(below.reason, 'a worker throttled below the default must stay quiet').toBe('NONE');
	}, 30000);
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
