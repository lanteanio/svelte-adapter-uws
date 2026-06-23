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
import { WS_SUBSCRIPTIONS, resetProcessEpoch } from './runtime/utils.js';
import { checkSubscriptionBookkeeping } from './runtime/invariants.js';
import { createConsistencyAuditor } from './runtime/auditor.js';
import { createClusterRelay, createClusterBus, createSupervisor, clusterFinalState, checkNoMisdelivery, checkStateConvergence } from './runtime/sim-cluster.js';

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
			subscribed: [...ws._topics],
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
		connections.push({
			id: ws._simId,
			subscribed: [...ws._topics].sort(),
			bookkeeping: subs instanceof Set ? [...subs].sort() : null
		});
		for (const t of ws._topics) topicCounts[t] = (topicCounts[t] || 0) + 1;
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
 *   protection?: string
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
		const auditor = createSimAuditor(() => app);
		function checkInvariants() {
			for (const v of auditor.runOnce()) {
				const key = v.category + ':' + JSON.stringify(v.context);
				if (!seen.has(key)) { seen.add(key); violations.push(v); }
			}
		}

		let totalSteps = 0;
		const clientList = [];
		const api = {
			rng,
			now: () => scheduler.now(),
			server,
			app,
			connect(opts) { const c = app.connect(opts); clientList.push(c); return c; },
			publish: (topic, event, data, opts) => server.platform.publish(topic, event, data, opts),
			publishBatched: (messages, opts) => server.platform.publishBatched(messages, opts),
			async advance(rounds) {
				totalSteps += await scheduler.run({ maxSteps: rounds ?? maxSteps, onStep: checkInvariants });
			}
		};

		const scenario = config.scenario || defaultScenario;
		await scenario(api, { clients, topics });
		// Final drain to quiescence so any deferred frames / timers settle.
		totalSteps += await scheduler.run({ maxSteps, onStep: checkInvariants });
		checkInvariants();

		const finalState = snapshot(app);
		const frames = clientList.reduce((sum, c) => sum + c.frames().length, 0);
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
		function checkInvariants() {
			for (const w of workers.values()) for (const v of w.auditor.runOnce()) recordViolation(v);
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
			// Per-worker topic generation, re-latched from the virtual clock on each
			// (re)spawn so a restarted worker presents a fresh generation - modeling
			// production's per-worker processEpoch. The +id tie-breaks the initial
			// cohort (all spawned at startEpoch); a respawn re-latches from the advanced
			// clock, which can in principle coincide with a live worker's generation,
			// exactly as two production boots in the same millisecond can.
			const epoch = scheduler.now() + id;
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
						return w ? w.server.platform.publish(topic, event, data, opts) : false;
					},
					publishBatched: (messages, opts) => {
						const w = workers.get(id);
						return w ? w.server.platform.publishBatched(messages, opts) : undefined;
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
		// timer settles before the snapshot.
		totalSteps += await scheduler.run({ maxSteps, onStep: checkInvariants });
		checkInvariants();

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
	result.reproduced = sameViolations && sameState && sameFatals && sameCluster && sameMetrics && sameVirtualTime;
	return result;
}

/**
 * Deterministic structural fingerprint of a run (the "unseed"): folds the
 * byte-stable result fields into one 8-hex-char FNV-1a digest. Same seed ->
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
 * `buggify` is the fault-enablement knob: 'off' (default - each run uses
 * `base.faults` as given, byte-identical to runSimMany), 'on' (every run layers
 * `faultProfile` over the base faults), or 'random' (a per-seed seeded coin at
 * `buggifyProbability`, default 0.25, decides whether that run is faulted - so
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
 *   buggify?: 'off' | 'on' | 'random',
 *   faultProfile?: object,
 *   buggifyProbability?: number,
 *   checkRatio?: number,
 *   gitCommit?: string,
 *   onResult?: (run: any, index: number) => void
 * }} [config]
 * @returns {Promise<{ summary: any, runs: any[] }>}
 */
export async function runSimSwarm(config = {}) {
	const base = config.base || {};
	const buggify = config.buggify || 'off';
	const buggifyProbability = config.buggifyProbability ?? 0.25;
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

		// Per-seed fault enablement, seeded from the seed so the buggified set is
		// itself reproducible across swarm runs.
		let buggified = buggify === 'on';
		if (buggify === 'random') buggified = createSeededRng(seed + ':buggify').float() < buggifyProbability;
		const faults = buggified ? { ...(base.faults || {}), ...faultProfile } : (base.faults || {});

		const result = await runSim({ ...base, seed, faults });
		if (gitCommit === null) gitCommit = result.gitCommit;

		const failed = runFailed(result);

		// Deterministically-chosen determinism re-check (the unseed-check ratio).
		let reproduced = null;
		if (checkRatio > 0 && createSeededRng(seed + ':check').float() < checkRatio) {
			determinismChecks++;
			reproduced = (await replaySim(result)).reproduced === true;
			if (!reproduced) determinismFailingSeeds.push(seed);
		}

		const run = {
			seed,
			ok: !failed && reproduced !== false,
			buggified,
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
		buggify,
		buggified: runs.filter((r) => r.buggified).length,
		determinismChecks,
		determinismFailures,
		determinismFailingSeeds,
		gitCommit,
		ok: failingSeeds.length === 0 && determinismFailures === 0
	};
	return { summary, runs };
}
