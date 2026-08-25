// Deterministic simulation runner. Drives the same createTestServer dispatch
// that runs over real uWS, but over an in-memory app under a virtual clock and a
// seeded fault engine, so a seed plus a commit is the entire bug report:
// runSim() explores an interleaving, runSim with the same seed reproduces it
// bit-for-bit, and replaySim() self-gates that determinism.
//
// Public subpath: `svelte-adapter-uws/sim`.

import { createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH } from './runtime/sim-core.js';
import { createInMemoryApp, createInMemoryUwsHelpers } from './runtime/sim-inmemory.js';
import { setRuntimeEnv, resetRuntimeEnv } from './runtime/runtime.js';
import { createTestServer } from './testing.js';
import { WS_SUBSCRIPTIONS, resetProcessEpoch, processEpoch } from './runtime/utils.js';
import { checkSubscriptionBookkeeping } from './runtime/invariants.js';
import { createConsistencyAuditor } from './runtime/auditor.js';
import { createResourceTracker } from './runtime/leak-detect.js';
import { structuralResourceProbes } from './runtime/leak-probes.js';
import { createClusterRelay, createClusterBus, createSupervisor, clusterFinalState, checkNoMisdelivery, checkStateConvergence } from './runtime/sim-cluster.js';
import { runSteadyState, faultClasses } from './runtime/steadystate.js';

// Building blocks for composing a custom multi-instance runner over the SAME
// virtual clock and seam (e.g. a redis/postgres-backed sim in a downstream
// package): the seam install/teardown, the per-process epoch latch, and the
// in-memory uWS helper bundle, alongside the scheduler / rng / fault-engine /
// app factories. createTestServer is exported from svelte-adapter-uws/testing.
export {
	createScheduler, createSeededRng, createFaultEngine, createInMemoryApp,
	createInMemoryUwsHelpers, setRuntimeEnv, resetRuntimeEnv, resetProcessEpoch,
	DEFAULT_SEED, FIXED_EPOCH
};

// The reusable resource-leak harness. The pure trend kernel + multi-series
// tracker + assertion (leak-detect.js) and the live-collection probe factories
// (leak-probes.js) are the single source of truth downstream packages re-export,
// so a framework leak test and the adapter's own DST harness share one detector.
export { detectGrowth, createResourceTracker, assertNoResourceGrowth, LeakError } from './runtime/leak-detect.js';
export { structuralResourceProbes, processResourceProbes, createResourceGrowthAuditor } from './runtime/leak-probes.js';

/**
 * Build the plain state snapshot the shared invariant predicates read from the
 * live in-memory app. Structure only: per-connection subscribed set (the one
 * fan-out reads) and bookkeeping set (the one counted against the cap), keyed by
 * the connection's sim id. `bookkeeping` is `null` when the userData slot is not
 * a Set, so the shape check in `checkSubscriptionBookkeeping` fires identically.
 *
 * @param {ReturnType<typeof createInMemoryApp>} app
 * @returns {import('./runtime/invariants.js').StateSnapshot}
 */
function buildInvariantSnapshot(app) {
	const connections = [];
	for (const ws of app._connections) {
		const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
		connections.push({
			id: ws._simId,
			// Cohort topics (`topic\0bin` / `topic\0json`, shared binary fan-out) live in
			// native membership but NOT in WS_SUBSCRIPTIONS by design, so filter them out
			// of the fan-out projection or checkSubscriptionBookkeeping would false-fire
			// (bookkeeping reads WS_SUBSCRIPTIONS). `\0` never appears in a user topic.
			subscribed: [...ws._topics].filter((t) => !t.includes('\0')),
			bookkeeping: subs instanceof Set ? [...subs] : null
		});
	}
	return { connections };
}

/**
 * Build a consistency auditor that drives the SAME shared predicate the live
 * worker runs, against the live in-memory app, so the simulator and production
 * share one invariant path (no separate inline check). The auditor's `snapshot`
 * returns the full connections-only shape from `buildInvariantSnapshot` (no
 * `total`, so the round-robin window stays at offset 0 and every step sees every
 * connection - the sim is not bounded the way a million-connection worker is).
 *
 * Predicate set is the single `checkSubscriptionBookkeeping` the sim has always
 * run - NOT `defaultInvariants` - because the snapshot supplies neither
 * `totalSubscriptions` nor `topicCounts`, so the extra predicates would have no
 * inputs and switching to them would silently change the recorded violation set.
 *
 * Sinks are sim-LOCAL non-throwing capture functions, NOT the assertions.js
 * sinks: under vitest assertions.js `assert`/`fatal` THROW, which would abort the
 * scheduler mid-step. The auditor's `runOnce()` return value (the Violation[])
 * is the sim's input; the sim owns de-dup. No `hardCategories` - the sim never
 * escalates (its job is to surface violations, and a hard escalation would need a
 * result field the SimResult shape does not carry).
 *
 * @param {() => ReturnType<typeof createInMemoryApp>} getApp
 * @returns {{ runOnce(): Array<{ category: string, context: any }> }}
 */
function createSimAuditor(getApp) {
	return createConsistencyAuditor({
		snapshot: () => buildInvariantSnapshot(getApp()),
		assert: () => {},
		fatal: () => {},
		predicates: [checkSubscriptionBookkeeping]
	});
}

/**
 * A deterministic, sorted snapshot of the server's structural state. Sorted so
 * two runs of the same seed produce byte-identical snapshots for the self-gate.
 * Carries NO payload bytes or user data - structure only.
 * @param {ReturnType<typeof createInMemoryApp>} app
 */
function snapshot(app) {
	const connections = [];
	/** @type {Record<string, number>} */
	const topicCounts = {};
	for (const ws of app._connections) {
		const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
		// Exclude shared fan-out cohort topics (`topic\0bin` / `topic\0json`) from the
		// determinism snapshot: they are a transport detail kept out of WS_SUBSCRIPTIONS,
		// so the logical-topic view stays consistent with the bookkeeping set.
		const logicalTopics = [...ws._topics].filter((t) => !t.includes('\0'));
		connections.push({
			id: ws._simId,
			subscribed: logicalTopics.slice().sort(),
			bookkeeping: subs instanceof Set ? [...subs].sort() : null
		});
		for (const t of logicalTopics) topicCounts[t] = (topicCounts[t] || 0) + 1;
	}
	connections.sort((a, b) => a.id - b.id);
	// Canonical (sorted) key order so JSON.stringify(finalState) is byte-stable.
	const sortedTopicCounts = {};
	for (const t of Object.keys(topicCounts).sort()) sortedTopicCounts[t] = topicCounts[t];
	return { connections, topicCounts: sortedTopicCounts, openConnections: connections.length };
}

/**
 * The default scenario when a caller passes none: connect N clients, subscribe
 * each to every topic, then publish a few events per topic, advancing the clock
 * between phases so frames flow. A self-contained exercise of the
 * connect/subscribe/publish path.
 */
async function defaultScenario(api, opts) {
	const conns = [];
	for (let i = 0; i < opts.clients; i++) conns.push(api.connect());
	await api.advance();
	for (const c of conns) for (const t of opts.topics) c.subscribe(t);
	await api.advance();
	for (const t of opts.topics) for (let n = 0; n < 3; n++) api.publish(t, 'tick', { n });
	await api.advance();
}

// Number of open/close cycles churnScenario runs. Enough samples that the trend
// kernel has a well-populated post-warmup window on the structural series.
const CHURN_CYCLES = 12;

/**
 * A connection-churn scenario: repeatedly connect a batch of clients, subscribe
 * them, publish, then CLOSE them, advancing between phases. A healthy close path
 * sheds every per-connection and per-topic bookkeeping entry, so the structural
 * resource series (sampled when `leakProbe` is set) oscillates around a flat
 * baseline rather than trending upward. Exported so a leak test can use it as the
 * scenario, and as a template for a downstream churn harness.
 *
 * @param {any} api the sim api (single-worker)
 * @param {{ clients: number, topics: string[] }} opts
 */
export async function churnScenario(api, opts) {
	const topics = opts.topics;
	const perCycle = Math.max(1, opts.clients);
	for (let cycle = 0; cycle < CHURN_CYCLES; cycle++) {
		const conns = [];
		for (let i = 0; i < perCycle; i++) conns.push(api.connect());
		await api.advance();
		for (const c of conns) for (const t of topics) c.subscribe(t);
		await api.advance();
		for (const t of topics) api.publish(t, 'tick', { cycle });
		await api.advance();
		for (const c of conns) c.close();
		await api.advance();
	}
}

/**
 * The default structural resource sources the simulator trends when
 * `leakProbe` is set: live population sizes that a correct close path returns to
 * baseline. Both are read functions over the in-memory app, so they carry NO
 * app-external state and reproduce bit-for-bit across runs of the same seed.
 * Only `.size`-style live populations here - never a monotonic counter (see the
 * exclusion list in leak-probes.js).
 *
 * @param {ReturnType<typeof createInMemoryApp>} app
 * @returns {Record<string, () => number>}
 */
function structuralSimSources(app) {
	return {
		// Live connection count: rises on connect, must fall on close.
		connections: () => app._connections.size,
		// Total membership across all live connections (per-connection topic Sets):
		// a subscribe/close path that stops shedding shows here.
		subscriptions: () => {
			let n = 0;
			for (const ws of app._connections) n += ws._topics.size;
			return n;
		}
	};
}

/**
 * Run one simulation.
 *
 * @param {{
 *   seed?: string,
 *   clients?: number,
 *   topics?: string[],
 *   steps?: number,
 *   faults?: import('./runtime/sim-core.js').createFaultEngine extends (...a:any)=>any ? any : any,
 *   handler?: object,
 *   scenario?: (api: any, opts: { clients: number, topics: string[] }) => void | Promise<void>,
 *   tz?: string,
 *   startEpoch?: number,
 *   gitCommit?: string,
 *   allowSystemTopicSubscribe?: boolean,
 *   allowNonAsciiTopics?: boolean,
 *   upgradeAdmission?: object,
 *   protection?: string,
 *   leakProbe?: boolean
 * }} [config]
 * @returns {Promise<any>} a SimResult
 */
export async function runSim(config = {}) {
	// Multi-worker runs take the cluster path; the single-worker body below is left
	// byte-identical so every existing sim is unaffected.
	if (Number.isInteger(config.workers) && config.workers > 1) return runClusterSim(config);
	const seed = config.seed ?? DEFAULT_SEED;
	const clients = config.clients ?? 2;
	const topics = config.topics ?? ['room'];
	const maxSteps = config.steps ?? 100000;

	const rng = createSeededRng(seed);
	const scheduler = createScheduler({ startEpoch: config.startEpoch ?? FIXED_EPOCH, tz: config.tz });
	const faultEngine = createFaultEngine({ rng, faults: config.faults || {} });

	// Install the seeded virtual environment across the seam for the duration of
	// the run, then always restore the native environment.
	setRuntimeEnv(scheduler.buildEnv(rng), { force: true });
	// Re-latch the per-process seq-space generation from the virtual clock so the
	// `subscribed` ack epoch (and any timestamp derived from it) reproduces
	// bit-for-bit across runs / processes, not the real wall time at module load.
	resetProcessEpoch();
	try {
		const app = createInMemoryApp({ scheduler, faultEngine });
		const uws = createInMemoryUwsHelpers(app);
		const server = await createTestServer({
			handler: config.handler || {},
			allowSystemTopicSubscribe: config.allowSystemTopicSubscribe === true,
			allowNonAsciiTopics: config.allowNonAsciiTopics === true,
			upgradeAdmission: config.upgradeAdmission,
			protection: config.protection,
			__app: app,
			__uws: uws
		});

		/** @type {Array<{ category: string, context: any }>} */
		const violations = [];
		const seen = new Set();
		function recordViolation(v) {
			if (!v) return;
			const key = v.category + ':' + JSON.stringify(v.context);
			if (!seen.has(key)) { seen.add(key); violations.push(v); }
		}
		const auditor = createSimAuditor(() => app);
		// Opt-in structural resource sampling. Reads only live Map/Set-derived
		// sizes (deterministic), so the resulting reports join the reproducer gate.
		// Null (and zero cost) unless the caller sets `leakProbe`.
		const leakTracker = config.leakProbe
			? createResourceTracker(structuralResourceProbes(structuralSimSources(app)))
			: null;
		// Whole-run trajectory recorder (folded into the steady-state pass at
		// end-of-run). Each per-step accumulator is O(1), the same posture as
		// leakTracker.sample above.
		//
		// The virtual clock, sampled once per round: dedup'd on the value so the
		// series stays bounded by the count of distinct virtual times (dropping an
		// equal consecutive reading cannot hide a backward step). Monotonic by
		// construction; recorded so a future clock regression is caught.
		/** @type {number[]} */
		const clockSamples = [];
		let lastClock = null;
		function observeClock(nowMs) {
			if (nowMs !== lastClock) { clockSamples.push(nowMs); lastClock = nowMs; }
		}
		// The publish-time subscriber set per broadcast: captured when the publish
		// fans out (NOT at end-of-run) so a later subscribe/unsubscribe cannot make
		// the starvation hypothesis misfire. Reads the same native membership
		// `app.publish` fans out on, so the log is exactly the eligible-receiver set.
		/** @type {Array<{ topic: string, subscribers: number[] }>} */
		const publishLog = [];
		function recordPublish(topic) {
			if (typeof topic !== 'string') return;
			const subscribers = [];
			for (const ws of app._connections) if (ws._topics.has(topic)) subscribers.push(ws._simId);
			publishLog.push({ topic, subscribers });
		}
		function checkInvariants() {
			for (const v of auditor.runOnce()) recordViolation(v);
			if (leakTracker) leakTracker.sample();
			observeClock(scheduler.now());
		}

		let totalSteps = 0;
		const clientList = [];
		const api = {
			rng,
			now: () => scheduler.now(),
			server,
			app,
			connect(opts) { const c = app.connect(opts); clientList.push(c); return c; },
			publish: (topic, event, data, opts) => { recordPublish(topic); return server.platform.publish(topic, event, data, opts); },
			publishBatched: (messages, opts) => {
				if (Array.isArray(messages)) for (const m of messages) recordPublish(m && m.topic);
				return server.platform.publishBatched(messages, opts);
			},
			async advance(rounds) {
				totalSteps += await scheduler.run({ maxSteps: rounds ?? maxSteps, onStep: checkInvariants });
			}
		};

		const scenario = config.scenario || defaultScenario;
		await scenario(api, { clients, topics });
		// Final drain to quiescence so any deferred frames / timers settle. Capture
		// the drained/pending signals here (before teardown): a healthy run reaches a
		// fixpoint within the budget and leaves zero refed work.
		const quiesceSteps = await scheduler.run({ maxSteps, onStep: checkInvariants });
		totalSteps += quiesceSteps;
		checkInvariants();
		const drained = quiesceSteps < maxSteps;
		const pendingAtQuiesce = scheduler.pending();

		const finalState = snapshot(app);
		const frames = clientList.reduce((sum, c) => sum + c.frames().length, 0);

		// End-of-run steady-state pass: fold whole-run predicate violations into the
		// same de-dup'd list the per-step auditor feeds. Extraction is O(frames), the
		// same order as building clientFrames below.
		const deliveredPairs = clientList.map((c) => ({
			id: c.serverWs ? c.serverWs._simId : null,
			raw: c.frames(),
			decoded: c.json()
		}));
		for (const v of runSteadyState({
			clockSamples,
			drained,
			pending: pendingAtQuiesce,
			terminal: finalState,
			publishLog,
			clients: deliveredPairs,
			faults: faultClasses(config.faults)
		})) recordViolation(v);

		await server.close();
		totalSteps += await scheduler.run({ maxSteps, onStep: checkInvariants });

		const result = {
			seed,
			gitCommit: config.gitCommit ?? (typeof process !== 'undefined' ? process.env.GIT_COMMIT : null) ?? null,
			// The full set of run-determining inputs, so a serialized
			// { seed, gitCommit, config } reconstructs the run in a fresh process.
			config: {
				clients,
				topics,
				steps: maxSteps,
				faults: config.faults || {},
				tz: config.tz ?? null,
				startEpoch: config.startEpoch ?? FIXED_EPOCH,
				allowSystemTopicSubscribe: config.allowSystemTopicSubscribe === true,
				allowNonAsciiTopics: config.allowNonAsciiTopics === true
			},
			steps: totalSteps,
			virtualTimeMs: scheduler.now() - (config.startEpoch ?? FIXED_EPOCH),
			invariantViolations: violations,
			fatals: [],
			schedulerUncaught: scheduler.uncaught.map((u) => String(u.error && u.error.message || u.error)),
			metrics: { clients: clientList.length, framesDelivered: frames },
			// Per-client decoded frames, for assertions and for inspecting a failing
			// seed. Excluded from the reproducer comparison (which is violations +
			// structural state only).
			clientFrames: clientList.map((c) => c.json()),
			// Structural resource-growth trend per series (only when leakProbe is set).
			// Deterministic (structural sizes only), so replaySim compares it too.
			resourceGrowth: leakTracker ? leakTracker.analyze().metrics : undefined,
			finalState,
			// Non-serializable carriers for in-process replaySim (the CODE is what
			// a cross-process reproducer pins via gitCommit).
			_handler: config.handler,
			_scenario: config.scenario,
			_seedConfig: config
		};
		return result;
	} finally {
		resetRuntimeEnv();
		resetProcessEpoch();
	}
}

/**
 * The default multi-worker scenario: connect `clients` clients on every worker,
 * subscribe each to every topic, then publish a few events per topic FROM worker 0
 * so the relay carries them to subscribers on the other workers. Advancing between
 * phases lets the relay batch + the cross-worker delivery settle.
 */
async function defaultClusterScenario(api, opts) {
	for (let w = 0; w < opts.workers; w++) {
		for (let i = 0; i < opts.clients; i++) api.worker(w).connect();
	}
	await api.advance();
	for (let w = 0; w < opts.workers; w++) {
		for (const c of api.worker(w).clients()) for (const t of opts.topics) c.subscribe(t);
	}
	await api.advance();
	for (const t of opts.topics) for (let n = 0; n < 3; n++) api.worker(0).publish(t, 'tick', { n });
	await api.advance();
}

/**
 * Run one multi-worker simulation. N createTestServer instances share ONE virtual
 * clock and ONE seam env; a fault-gated relay bus + a restart-budget supervisor
 * model the production primary (src/runtime/index.js) and the cross-worker relay
 * (src/runtime/handler.js), neither of which is drivable in-sim. The seam + the per-cohort
 * process epoch are established ONCE before any worker is built and torn down once.
 *
 * @param {object} config see runSim, plus `workers`, `clusterMode`
 *   ('reuseport' | 'acceptor'), and `relayFaults` (the IPC-bus fault spec).
 * @returns {Promise<any>} a multi-worker SimResult
 */
async function runClusterSim(config) {
	const seed = config.seed ?? DEFAULT_SEED;
	const workersN = config.workers;
	const clients = config.clients ?? 2;
	const topics = config.topics ?? ['room'];
	const maxSteps = config.steps ?? 100000;
	const startEpoch = config.startEpoch ?? FIXED_EPOCH;
	const mode = config.clusterMode === 'acceptor' ? 'acceptor' : 'reuseport';

	// The global seam stream (uuid / random for framework code, shared by all
	// workers). Per-worker ws faults and the relay bus draw from their OWN derived
	// streams so a fault-config change never perturbs the seam's uuid stream.
	const rng = createSeededRng(seed);
	const scheduler = createScheduler({ startEpoch, tz: config.tz });
	const relayRng = createSeededRng(seed + ':relay');
	const busMetrics = { forwarded: 0, delivered: 0, dropped: 0 };
	const bus = createClusterBus({
		faultEngine: createFaultEngine({ rng: relayRng, faults: config.relayFaults || {} }),
		metrics: busMetrics
	});

	setRuntimeEnv(scheduler.buildEnv(rng), { force: true });
	resetProcessEpoch();
	try {
		/** @type {Array<{ category: string, context: any }>} */
		const violations = [];
		const seen = new Set();
		/** @type {Map<number, { id: number, app: any, server: any, relay: any, epoch: number, clients: any[], auditor: { runOnce(): any[] } }>} */
		const workers = new Map();
		// Distinct topic generation per worker INCARNATION, not per worker id. A
		// production restart re-latches a fresh random token, which is what makes
		// a client's held offset die against the restarted worker; deriving the
		// sim's token from the id alone handed a respawn its predecessor's
		// generation, so a restarted worker claimed continuity with a sequence
		// space it had just reset and no scenario could exercise the rehydrate
		// that follows. Counting incarnations in creation order keeps the
		// initial cohort's tokens exactly what the id-derived form produced, so
		// a run without a respawn is unchanged.
		let incarnations = 0;
		// Every client ever opened, tagged by its worker at connect time. A respawn
		// replaces workers.get(id) with a fresh (empty) wobj, so this accumulates the
		// terminated worker's facades across restarts: clusterFrames intentionally
		// retains that pre-restart delivery history, while finalState reads the current
		// (possibly fresh) worker via the workers map.
		/** @type {Array<{ workerId: number, facade: any, subTopics: Set<string> }>} */
		const allClients = [];
		/** @type {any[]} */
		const fatals = [];
		let listenPaused = false;

		function recordViolation(v) {
			if (!v) return;
			const key = v.category + ':' + JSON.stringify(v.context);
			if (!seen.has(key)) { seen.add(key); violations.push(v); }
		}
		// Whole-run trajectory recorder (folded into the steady-state pass at
		// end-of-run), same O(1)-per-step posture as the single-worker path.
		/** @type {number[]} */
		const clockSamples = [];
		let lastClock = null;
		function observeClock(nowMs) {
			if (nowMs !== lastClock) { clockSamples.push(nowMs); lastClock = nowMs; }
		}
		// The publish-time subscriber set per broadcast, captured across EVERY
		// worker's native membership (a publish on one worker relays to subscribers
		// on the others), keyed globally by `workerId:simId` since each worker's
		// `_simId` space restarts at 0. `originators` tracks which workers published
		// each topic so a topic with more than one publisher (two interleaved seq
		// spaces) suppresses the delivery-monotonic hypothesis.
		/** @type {Array<{ topic: string, subscribers: string[] }>} */
		const publishLog = [];
		/** @type {Map<string, Set<number>>} */
		const originators = new Map();
		function recordPublish(fromWorkerId, topic) {
			if (typeof topic !== 'string') return;
			const subscribers = [];
			for (const w of workers.values()) {
				for (const ws of w.app._connections) if (ws._topics.has(topic)) subscribers.push(w.id + ':' + ws._simId);
			}
			publishLog.push({ topic, subscribers });
			let set = originators.get(topic);
			if (!set) { set = new Set(); originators.set(topic, set); }
			set.add(fromWorkerId);
		}
		function checkInvariants() {
			for (const w of workers.values()) for (const v of w.auditor.runOnce()) recordViolation(v);
			observeClock(scheduler.now());
		}

		async function makeWorker(id) {
			const wRng = createSeededRng(seed + ':ws:' + id);
			const wFaultEngine = createFaultEngine({ rng: wRng, faults: config.faults || {} });
			const app = createInMemoryApp({ scheduler, faultEngine: wFaultEngine });
			const uws = createInMemoryUwsHelpers(app);
			const relay = createClusterRelay({ workerId: id, bus });
			const server = await createTestServer({
				handler: config.handler || {},
				allowSystemTopicSubscribe: config.allowSystemTopicSubscribe === true,
				allowNonAsciiTopics: config.allowNonAsciiTopics === true,
				upgradeAdmission: config.upgradeAdmission,
				protection: config.protection,
				__app: app,
				__uws: uws,
				__onPublish: relay.onPublish
			});
			// Per-incarnation topic generation - the opaque token a subscribe ack
			// carries. Production latches a random u32 per worker (never the wall
			// clock, which would leak the process start time); the sim models the
			// same domain deterministically by offsetting the seeded process
			// token by a count of the workers built so far, so every worker AND
			// every respawn of one presents a DISTINCT opaque u32 that
			// reproduces across runs.
			const epoch = (processEpoch() + incarnations++) >>> 0;
			server.platform.topicEpoch = (t) => { void t; return epoch; };
			bus.register(id, server.platform.__relayReceive);
			const wobj = { id, app, server, relay, epoch, clients: [], auditor: createSimAuditor(() => app) };
			workers.set(id, wobj);
			return wobj;
		}

		// Worker ids whose respawn should fail (a worker that crashes on init); used
		// to drive the restart-budget-exhausted outcome via flapWorker(id, { recover:false }).
		const crashLooping = new Set();

		const supervisor = createSupervisor({
			mode,
			bootTimeoutMs: config.workerBootTimeoutMs,
			hooks: {
				terminate(id) {
					const w = workers.get(id);
					if (!w) return;
					w.relay.abandon();
					bus.unregister(id);
					bus.cancelFor(id);
					// Close every live connection on the worker (the worker-flap
					// one-shot), the in-sim analog of the worker thread dying.
					try { w.server.platform.__chaos({ scenario: 'worker-flap', code: 1012, reason: 'worker restart' }); } catch {}
				},
				async spawn(id) {
					if (crashLooping.has(id)) throw new Error('worker crashed on init');
					await makeWorker(id);
				},
				onFatal(entry) { fatals.push(entry); },
				onListenPause(p) { listenPaused = p; }
			}
		});

		// Build the cohort. The seam + epoch are already latched, so all initial
		// workers share startEpoch (+id for distinctness).
		for (let id = 0; id < workersN; id++) {
			const w = await makeWorker(id);
			supervisor.addWorker(id);
			supervisor.markReady(id);
			void w;
		}

		let totalSteps = 0;
		const api = {
			rng,
			now: () => scheduler.now(),
			workersCount: workersN,
			worker(id) {
				return {
					connect: (opts) => {
						const w = workers.get(id);
						if (!w) return null;
						const facade = w.app.connect(opts);
						const subTopics = new Set();
						const origSub = facade.subscribe.bind(facade);
						facade.subscribe = (topic, ref) => { subTopics.add(topic); return origSub(topic, ref); };
						w.clients.push(facade);
						allClients.push({ workerId: id, facade, subTopics });
						return facade;
					},
					clients: () => (workers.get(id) ? workers.get(id).clients.slice() : []),
					publish: (topic, event, data, opts) => {
						const w = workers.get(id);
						if (!w) return false;
						recordPublish(id, topic);
						return w.server.platform.publish(topic, event, data, opts);
					},
					publishBatched: (messages, opts) => {
						const w = workers.get(id);
						if (!w) return undefined;
						if (Array.isArray(messages)) for (const m of messages) recordPublish(id, m && m.topic);
						return w.server.platform.publishBatched(messages, opts);
					}
				};
			},
			flapWorker: (id, opts) => {
				// recover:false models a worker that crashes on every restart - it
				// never re-readies, so the budget marches to exhaustion.
				if (opts && opts.recover === false) crashLooping.add(id);
				supervisor.flap(id);
			},
			wedgeWorker: (id) => supervisor.wedge(id),
			initWedgeWorker: (id) => supervisor.initWedge(id),
			async advance(rounds) {
				totalSteps += await scheduler.run({ maxSteps: rounds ?? maxSteps, onStep: checkInvariants });
			},
			async advanceTime(ms) {
				// Pull the virtual clock forward by `ms` even when only unref'd timers
				// (the heartbeat interval) are pending, so time-driven supervisor
				// behaviour - wedged-worker detection at HEARTBEAT_TIMEOUT_MS - is
				// observable in an otherwise idle cohort. A refed wake keeps the run
				// loop advancing; everything due in the window fires along the way.
				scheduler._scheduleTimer(() => {}, Math.max(0, ms | 0), [], false);
				totalSteps += await scheduler.run({ maxSteps, onStep: checkInvariants });
			}
		};

		const scenario = config.scenario || defaultClusterScenario;
		await scenario(api, { clients, topics, workers: workersN });
		// Drain to quiescence so every relay batch + in-flight delivery + restart
		// timer settles before the snapshot. Capture the drained/pending signals
		// here (before teardown) for the natural-quiescence hypothesis.
		const quiesceSteps = await scheduler.run({ maxSteps, onStep: checkInvariants });
		totalSteps += quiesceSteps;
		checkInvariants();
		const drained = quiesceSteps < maxSteps;
		const pendingAtQuiesce = scheduler.pending();

		// Quiescent no-misdelivery check: every data frame a client received names a
		// topic it actually subscribed to (catches a relay routing leak).
		const byWorker = new Map();
		for (const id of workers.keys()) byWorker.set(id, []);
		for (const c of allClients) {
			if (!byWorker.has(c.workerId)) byWorker.set(c.workerId, []);
			// Raw frames carry the uncorrupted routingTopic the check needs (the decoded
			// body topic can be mangled by the corrupt fault).
			byWorker.get(c.workerId).push({ subscribed: c.subTopics, frames: c.facade.frames() });
		}
		recordViolation(checkNoMisdelivery([...byWorker].map(([id, cl]) => ({ id, clients: cl }))));

		// Quiescent cross-worker convergence check: workers that subscribe to a shared
		// topic should have received the same originator-stamped seq run for it, so
		// their per-topic delivered-seq projections hash identically. Only meaningful
		// once every relay delivery has settled (not per step, where a mid-flight
		// worker legitimately trails), so it runs here over the same byWorker grouping.
		recordViolation(checkStateConvergence([...byWorker].map(([id, cl]) => ({ id, clients: cl }))));

		// Build the deterministic, sorted result aggregates.
		const workerSummaries = [...workers.values()].map((w) => ({
			id: w.id,
			snapshot: snapshot(w.app),
			framesDelivered: w.clients.reduce((s, c) => s + c.frames().length, 0)
		}));
		const finalState = clusterFinalState(workerSummaries);
		const clusterFrames = [...byWorker]
			.map(([id]) => id)
			.sort((a, b) => a - b)
			.map((id) => ({
				worker: id,
				clients: allClients.filter((c) => c.workerId === id).map((c) => c.facade.json())
			}));
		const totalFrames = allClients.reduce((s, c) => s + c.facade.frames().length, 0);

		// End-of-run steady-state pass over the whole-run trajectory, folded into the
		// same de-dup'd list. delivery-monotonic is guarded by the combined per-worker
		// wire + cross-worker relay fault classes, and by a topic published from more
		// than one worker (two interleaved seq spaces read as non-monotonic at a
		// subscriber); starvation is additionally guarded by cluster disruption (a
		// flapped / wedged / restarted / budget-exhausted worker legitimately drops
		// in-flight deliveries to its clients). The terminal orphan-topic check reads
		// the merged per-worker topic index.
		const steadyFaults = faultClasses(config.faults, config.relayFaults);
		steadyFaults.disrupted = fatals.length > 0 || supervisor.metrics.flaps > 0
			|| supervisor.metrics.wedges > 0 || supervisor.metrics.initWedges > 0 || supervisor.metrics.restarts > 0;
		steadyFaults.multiOriginator = [...originators.values()].some((s) => s.size > 1);
		/** @type {Record<string, number>} */
		const mergedTopicCounts = {};
		for (const w of workerSummaries) {
			for (const t of Object.keys(w.snapshot.topicCounts)) {
				mergedTopicCounts[t] = (mergedTopicCounts[t] || 0) + w.snapshot.topicCounts[t];
			}
		}
		const deliveredPairs = allClients.map((c) => ({
			id: c.workerId + ':' + (c.facade.serverWs ? c.facade.serverWs._simId : 'x'),
			raw: c.facade.frames(),
			decoded: c.facade.json()
		}));
		// A cross-worker subscriber is delivered its topic by the DEFERRED relay, so a
		// client captured in the publish-time set that unsubscribes inside the relay
		// window (after the origin publish, before the relay lands) legitimately
		// receives nothing. Restrict the cluster starvation check to clients still
		// subscribed to the topic at end-of-run (subscribed at BOTH endpoints): this
		// drops that relay-window-unsubscribe false positive while still catching a
		// client that stayed subscribed the whole run yet never received. Single-worker
		// delivery is synchronous with the publish fan-out, so its publishLog needs no
		// such restriction (see runSim) and stays byte-identical.
		/** @type {Set<string>} `${workerId}:${simId} ${topic}` still subscribed at end-of-run */
		const endSubscribed = new Set();
		for (const w of workerSummaries) {
			for (const conn of w.snapshot.connections) {
				for (const t of conn.subscribed) endSubscribed.add(w.id + ':' + conn.id + ' ' + t);
			}
		}
		const eligiblePublishLog = publishLog.map((entry) => ({
			topic: entry.topic,
			subscribers: entry.subscribers.filter((subId) => endSubscribed.has(subId + ' ' + entry.topic))
		}));
		for (const v of runSteadyState({
			clockSamples,
			drained,
			pending: pendingAtQuiesce,
			terminal: { topicCounts: mergedTopicCounts },
			publishLog: eligiblePublishLog,
			clients: deliveredPairs,
			faults: steadyFaults
		})) recordViolation(v);

		supervisor.shutdown();
		for (const w of workers.values()) { try { await w.server.close(); } catch {} }
		totalSteps += await scheduler.run({ maxSteps, onStep: checkInvariants });

		return {
			seed,
			gitCommit: config.gitCommit ?? (typeof process !== 'undefined' ? process.env.GIT_COMMIT : null) ?? null,
			config: {
				workers: workersN,
				clusterMode: mode,
				clients,
				topics,
				steps: maxSteps,
				faults: config.faults || {},
				relayFaults: config.relayFaults || {},
				tz: config.tz ?? null,
				startEpoch,
				allowSystemTopicSubscribe: config.allowSystemTopicSubscribe === true,
				allowNonAsciiTopics: config.allowNonAsciiTopics === true
			},
			steps: totalSteps,
			virtualTimeMs: scheduler.now() - startEpoch,
			invariantViolations: violations,
			fatals,
			schedulerUncaught: scheduler.uncaught.map((u) => String(u.error && u.error.message || u.error)),
			metrics: {
				workers: workersN,
				clients: allClients.length,
				framesDelivered: totalFrames,
				relay: { forwarded: busMetrics.forwarded, delivered: busMetrics.delivered, dropped: busMetrics.dropped },
				restarts: supervisor.metrics.restarts,
				flaps: supervisor.metrics.flaps,
				wedges: supervisor.metrics.wedges,
				initWedges: supervisor.metrics.initWedges,
				// Live ready workers at quiescence. A concurrent recovering flap can leave
				// the cohort below `workers` (a recovery clears the shared restart-timer set,
				// cancelling a sibling's pending respawn - faithful to the production primary's
				// single restart budget), so this surfaces a silent deficit that `restarts`
				// (which counts only fired respawns) would not.
				workersLive: supervisor.liveReady(),
				listenPaused
			},
			clusterFrames,
			clientFrames: allClients.map((c) => c.facade.json()),
			finalState,
			_handler: config.handler,
			_scenario: config.scenario,
			_seedConfig: config
		};
	} finally {
		resetRuntimeEnv();
		resetProcessEpoch();
	}
}

/**
 * Run many simulations. Accepts either an array of full configs, or
 * `{ seeds, base }` to run `base` once per seed.
 *
 * @param {Array<object> | { seeds: string[], base?: object }} spec
 * @returns {Promise<any[]>}
 */
export async function runSimMany(spec) {
	if (Array.isArray(spec)) {
		const out = [];
		for (const cfg of spec) out.push(await runSim(cfg));
		return out;
	}
	const base = spec.base || {};
	const out = [];
	for (const seed of spec.seeds) out.push(await runSim({ ...base, seed }));
	return out;
}

/**
 * Re-run a reproducer and assert the same invariant violations appear. This is
 * the determinism self-gate: a deterministic run reproduces its violation set
 * exactly; a change that alters the outcome flips `reproduced` to false.
 *
 * @param {any} reproducer a SimResult returned by runSim
 * @returns {Promise<any>} the fresh SimResult, plus `reproduced: boolean`
 */
export async function replaySim(reproducer) {
	const cfg = {
		...(reproducer._seedConfig || {}),
		seed: reproducer.seed,
		handler: reproducer._handler,
		scenario: reproducer._scenario,
		gitCommit: reproducer.gitCommit
	};
	const result = await runSim(cfg);
	const sameViolations = JSON.stringify(result.invariantViolations) === JSON.stringify(reproducer.invariantViolations);
	const sameState = JSON.stringify(result.finalState) === JSON.stringify(reproducer.finalState);
	// fatals (restart-budget outcomes) and, for a multi-worker run, the per-worker
	// delivered frames are part of the reproduced gate: a relay or supervisor whose
	// outcome drifts across runs flips `reproduced` to false. Single-worker results
	// carry fatals:[] and no clusterFrames, so this stays a no-op there.
	const sameFatals = JSON.stringify(result.fatals ?? []) === JSON.stringify(reproducer.fatals ?? []);
	const sameCluster = JSON.stringify(result.clusterFrames ?? null) === JSON.stringify(reproducer.clusterFrames ?? null);
	// metrics (relay accounting, restart/flap/wedge counts, live workers, listen pause)
	// and the virtual end-time are run-determining outputs that a no-subscriber or
	// relay-only drift can move without touching any client frame - so the gate covers
	// them too. metrics has a fixed key order in both paths, so JSON.stringify is stable.
	const sameMetrics = JSON.stringify(result.metrics) === JSON.stringify(reproducer.metrics);
	const sameVirtualTime = result.virtualTimeMs === reproducer.virtualTimeMs;
	// Structural resource-growth trend (leakProbe runs only; undefined otherwise,
	// which compares equal). Fed by structural sizes only, so it is deterministic
	// and a close/eviction path that drifts across runs flips `reproduced`.
	const sameResourceGrowth = JSON.stringify(result.resourceGrowth ?? null) === JSON.stringify(reproducer.resourceGrowth ?? null);
	result.reproduced = sameViolations && sameState && sameFatals && sameCluster && sameMetrics && sameVirtualTime && sameResourceGrowth;
	return result;
}

/**
 * Deterministic structural fingerprint of a run: folds the byte-stable
 * result fields into one 8-hex-char FNV-1a digest. Same seed ->
 * same fingerprint; if it ever differs for a fixed seed, determinism has
 * regressed - a cheap canary that needs no full trace diff.
 *
 * @param {any} result a SimResult
 * @returns {string}
 */
function runFingerprint(result) {
	const canonical = JSON.stringify({
		finalState: result.finalState,
		invariantViolations: result.invariantViolations,
		fatals: result.fatals ?? [],
		clusterFrames: result.clusterFrames ?? null,
		metrics: result.metrics,
		virtualTimeMs: result.virtualTimeMs
	});
	// FNV-1a 32-bit, the same hash family sim-core uses for seeding. Pure: no
	// Date / Math.random / timers, so it stays inside the determinism seam.
	let h = 2166136261 >>> 0;
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The failure oracle for one run: any recorded invariant violation, any
 * hard-tier fatal, or any uncaught scheduler error. Mirrors the production
 * assert()/fatal() surface a swarm exists to flush out.
 * @param {any} result a SimResult
 */
function runFailed(result) {
	return (result.invariantViolations && result.invariantViolations.length > 0)
		|| (result.fatals && result.fatals.length > 0)
		|| (result.schedulerUncaught && result.schedulerUncaught.length > 0);
}

/**
 * Run a swarm of seeds and aggregate pass/fail plus an exact reproduce key for
 * each failing seed. The deterministic core behind the CI seed-swarm: it owns
 * no wall clock and reads no environment (so it stays inside the determinism
 * seam); a runner script supplies the seed range from the environment and
 * stamps the wall-clock metadata onto the report it writes.
 *
 * Seeds: pass an explicit `seeds` list, or `count` consecutive integer seeds
 * from `startSeed` (the one-base-int-plus-a-count contract, where the failing
 * seed string is itself the entire local reproduce command).
 *
 * `faultMode` is the fault-enablement knob: 'off' (default - each run uses
 * `base.faults` as given, byte-identical to runSimMany), 'on' (every run layers
 * `faultProfile` over the base faults), or 'random' (a per-seed seeded coin at
 * `faultProbability`, default 0.25, decides whether that run is faulted - so
 * one swarm covers both the quiet and the chaotic interleavings, reproducibly).
 * With no `faultProfile`, 'on'/'random' are no-ops.
 *
 * `checkRatio` (in [0,1], default 0) re-runs a deterministically-chosen
 * fraction of seeds through replaySim and asserts they reproduce; a run that
 * fails to reproduce is a determinism regression, counted separately from a
 * normal invariant failure. `onResult(run, index)` fires as each run completes
 * (a runner uses it to stream progress and print the first reproduce line).
 *
 * @param {{
 *   seeds?: Array<string | number>,
 *   count?: number,
 *   startSeed?: number,
 *   base?: object,
 *   faultMode?: 'off' | 'on' | 'random',
 *   faultProfile?: object,
 *   faultProbability?: number,
 *   checkRatio?: number,
 *   gitCommit?: string,
 *   onResult?: (run: any, index: number) => void
 * }} [config]
 * @returns {Promise<{ summary: any, runs: any[] }>}
 */
export async function runSimSwarm(config = {}) {
	const base = config.base || {};
	const faultMode = config.faultMode || 'off';
	const faultProbability = config.faultProbability ?? 0.25;
	const checkRatio = config.checkRatio ?? 0;
	const faultProfile = config.faultProfile || {};

	let seeds;
	if (Array.isArray(config.seeds)) {
		seeds = config.seeds.map(String);
	} else {
		const startSeed = Number.isInteger(config.startSeed) ? config.startSeed : 1;
		const count = Number.isInteger(config.count) ? config.count : 50;
		seeds = [];
		for (let i = 0; i < count; i++) seeds.push(String(startSeed + i));
	}

	const runs = [];
	const failingSeeds = [];
	const determinismFailingSeeds = [];
	let determinismChecks = 0;
	let gitCommit = config.gitCommit ?? base.gitCommit ?? null;

	for (let i = 0; i < seeds.length; i++) {
		const seed = seeds[i];

		// Per-seed fault enablement, seeded from the seed so the faulted set is
		// itself reproducible across swarm runs.
		let faulted = faultMode === 'on';
		if (faultMode === 'random') faulted = createSeededRng(seed + ':faultmode').float() < faultProbability;
		const faults = faulted ? { ...(base.faults || {}), ...faultProfile } : (base.faults || {});

		const result = await runSim({ ...base, seed, faults });
		if (gitCommit === null) gitCommit = result.gitCommit;

		const failed = runFailed(result);

		// Deterministically-chosen determinism re-check (the check ratio).
		let reproduced = null;
		if (checkRatio > 0 && createSeededRng(seed + ':check').float() < checkRatio) {
			determinismChecks++;
			reproduced = (await replaySim(result)).reproduced === true;
			if (!reproduced) determinismFailingSeeds.push(seed);
		}

		const run = {
			seed,
			ok: !failed && reproduced !== false,
			faulted,
			fingerprint: runFingerprint(result),
			violations: (result.invariantViolations || []).length,
			fatals: (result.fatals || []).length,
			uncaught: (result.schedulerUncaught || []).length,
			violationCategories: [...new Set((result.invariantViolations || []).map((v) => v.category))].sort(),
			reproduced
		};
		runs.push(run);
		if (failed) failingSeeds.push(seed);
		if (config.onResult) config.onResult(run, i);
	}

	const determinismFailures = determinismFailingSeeds.length;
	const summary = {
		total: seeds.length,
		passed: runs.filter((r) => r.ok).length,
		failed: failingSeeds.length,
		firstFailingSeed: failingSeeds.length ? failingSeeds[0] : null,
		failingSeeds,
		faultMode,
		faulted: runs.filter((r) => r.faulted).length,
		determinismChecks,
		determinismFailures,
		determinismFailingSeeds,
		gitCommit,
		ok: failingSeeds.length === 0 && determinismFailures === 0
	};
	return { summary, runs };
}

/**
 * Numeric-aware seed comparator: "2" sorts before "10". Numeric seeds sort
 * ahead of non-numeric ones, which sort lexically. Keeps the committed golden
 * corpus and the drift report in a stable, human-scannable order.
 * @param {string|number} a
 * @param {string|number} b
 */
function compareSeeds(a, b) {
	const na = Number(a);
	const nb = Number(b);
	const aNum = Number.isFinite(na);
	const bNum = Number.isFinite(nb);
	if (aNum && bNum) return na - nb || String(a).localeCompare(String(b));
	if (aNum) return -1;
	if (bNum) return 1;
	return String(a).localeCompare(String(b));
}

/**
 * Project a runSimSwarm result into a committable golden corpus: one entry per
 * seed carrying the structural fingerprint the swarm already stamped plus a
 * small digest for triage, and corpus-level metadata (the swarm config the
 * fingerprints are only comparable under). Pure - no clock, no environment, no
 * fingerprint recomputation - so it stays inside the determinism seam; a runner
 * outside the seam stamps recordedAt / gitCommit.
 *
 * Entries are sorted by seed (numeric-aware) so the committed file has a stable,
 * reviewable diff. A per-seed weight (default 1) sets how much that seed's drift
 * counts against the gate budget; weight 0 is a watch-list seed (recorded and
 * reported on drift, but never fails the gate).
 *
 * @param {import('./sim.js').SimSwarmResult} swarmResult
 * @param {{ weights?: Record<string, number>, gitCommit?: string|null, recordedAt?: string|null, swarm?: object|null }} [opts]
 * @returns {import('./sim.js').SimGoldenCorpus}
 */
export function buildSimGoldens(swarmResult, opts = {}) {
	const weights = opts.weights || {};
	const entries = swarmResult.runs.map((r) => ({
		seed: String(r.seed),
		weight: weights[r.seed] ?? weights[String(r.seed)] ?? 1,
		fingerprint: r.fingerprint,
		digest: {
			violations: r.violations,
			fatals: r.fatals,
			uncaught: r.uncaught,
			violationCategories: r.violationCategories,
			faulted: r.faulted
		}
	}));
	entries.sort((a, b) => compareSeeds(a.seed, b.seed));
	return {
		schemaVersion: 1,
		gitCommit: opts.gitCommit ?? swarmResult.summary?.gitCommit ?? null,
		recordedAt: opts.recordedAt ?? null,
		swarm: opts.swarm ?? null,
		entries
	};
}

/**
 * Compare a golden corpus against a fresh runSimSwarm result, weighting each
 * drifted seed by its recorded weight. Pure. The runner runs exactly the corpus
 * seeds under the corpus config, so an entry is matched (fingerprint identical),
 * changed (fingerprint differs - deterministic behavior moved), or missing (seed
 * absent from the run); a seed present in the run but absent from the corpus is
 * counted as 'added' but never gates. driftWeight is the summed weight over
 * {changed, missing}; the gate passes when there is no config mismatch and
 * driftWeight is within maxDriftWeight (default 0 - any drift on a weighted seed
 * fails). An intentional behavior change is blessed by regenerating the corpus,
 * whose diff is the reviewable record of what moved.
 *
 * @param {import('./sim.js').SimGoldenCorpus} golden
 * @param {import('./sim.js').SimSwarmResult} swarmResult
 * @param {{ maxDriftWeight?: number }} [opts]
 * @returns {import('./sim.js').SimGoldenReport}
 */
export function checkSimGoldens(golden, swarmResult, opts = {}) {
	const maxDriftWeight = opts.maxDriftWeight ?? 0;
	const actual = new Map();
	for (const r of swarmResult.runs) actual.set(String(r.seed), r);

	// The corpus fingerprints are comparable only to a run produced under the
	// same swarm config - the fault mode above all, since it decides which
	// seeds are faulted. A mismatch means the runner ran the wrong config; fail
	// loudly rather than silently comparing incomparable fingerprints.
	let configMismatch = null;
	const gFaultMode = golden.swarm ? golden.swarm.faultMode : undefined;
	const aFaultMode = swarmResult.summary ? swarmResult.summary.faultMode : undefined;
	if (gFaultMode !== undefined && gFaultMode !== null && aFaultMode !== undefined && gFaultMode !== aFaultMode) {
		configMismatch = "fault mode differs: corpus recorded '" + gFaultMode + "', run used '" + aFaultMode +
			"' - fingerprints are not comparable; regenerate the corpus or fix the runner config";
	}

	const drifts = [];
	let changed = 0;
	let missing = 0;
	let matched = 0;
	let totalWeight = 0;
	let driftWeight = 0;
	for (const entry of golden.entries) {
		const w = entry.weight ?? 1;
		totalWeight += w;
		const a = actual.get(String(entry.seed));
		if (!a) {
			missing++;
			driftWeight += w;
			drifts.push({ seed: entry.seed, weight: w, kind: 'missing', golden: { fingerprint: entry.fingerprint, digest: entry.digest }, actual: null });
			continue;
		}
		if (a.fingerprint === entry.fingerprint) {
			matched++;
		} else {
			changed++;
			driftWeight += w;
			drifts.push({
				seed: entry.seed,
				weight: w,
				kind: 'changed',
				golden: { fingerprint: entry.fingerprint, digest: entry.digest },
				actual: {
					fingerprint: a.fingerprint,
					digest: { violations: a.violations, fatals: a.fatals, uncaught: a.uncaught, violationCategories: a.violationCategories, faulted: a.faulted }
				}
			});
		}
	}

	let added = 0;
	const goldenSeeds = new Set(golden.entries.map((e) => String(e.seed)));
	for (const r of swarmResult.runs) if (!goldenSeeds.has(String(r.seed))) added++;

	drifts.sort((x, y) => (y.weight - x.weight) || compareSeeds(x.seed, y.seed));
	const ok = configMismatch === null && driftWeight <= maxDriftWeight;
	return { ok, totalWeight, driftWeight, maxDriftWeight, drifts, configMismatch, counts: { changed, missing, added, matched } };
}
