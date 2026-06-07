// Deterministic simulation runner. Drives the same createTestServer dispatch
// that runs over real uWS, but over an in-memory app under a virtual clock and a
// seeded fault engine, so a seed plus a commit is the entire bug report:
// runSim() explores an interleaving, runSim with the same seed reproduces it
// bit-for-bit, and replaySim() self-gates that determinism.
//
// Public subpath: `svelte-adapter-uws/sim`.

import { createScheduler, createSeededRng, createFaultEngine, DEFAULT_SEED, FIXED_EPOCH } from './files/sim-core.js';
import { createInMemoryApp, createInMemoryUwsHelpers } from './files/sim-inmemory.js';
import { setRuntimeEnv, resetRuntimeEnv } from './files/runtime.js';
import { createTestServer } from './testing.js';
import { WS_SUBSCRIPTIONS, resetProcessEpoch } from './files/utils.js';

export { createScheduler, createSeededRng, createFaultEngine, createInMemoryApp, DEFAULT_SEED, FIXED_EPOCH };

/**
 * Subscription-bookkeeping invariant: a connection's subscription set (the one
 * fan-out reads) must agree with its WS_SUBSCRIPTIONS bookkeeping set (the one
 * counted against the cap). The dispatch maintains the two in lockstep, so in
 * this single-dispatch model the check is a regression guard against a code path
 * that mutates one without the other (a missing subscribe, a dropped Set type),
 * not a model of an independent transport that silently caps or drops a
 * subscription. Pure function of a snapshot-able state; returns the first
 * violation. The richer cross-checked invariant set is a later addition.
 *
 * @param {ReturnType<typeof createInMemoryApp>} app
 * @returns {{ category: string, context: any } | null}
 */
function checkSubscriptionBookkeeping(app) {
	for (const ws of app._connections) {
		const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
		if (!(subs instanceof Set)) return { category: 'subs.shape', context: { ws: ws._simId } };
		if (subs.size !== ws._topics.size) {
			return { category: 'subs.bookkeeping', context: { ws: ws._simId, bookkeeping: subs.size, subscribed: ws._topics.size } };
		}
		for (const t of subs) {
			if (!ws._topics.has(t)) return { category: 'subs.bookkeeping.missing', context: { ws: ws._simId, topic: t } };
		}
	}
	return null;
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
 *   faults?: import('./files/sim-core.js').createFaultEngine extends (...a:any)=>any ? any : any,
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
		function checkInvariants() {
			const v = checkSubscriptionBookkeeping(app);
			if (v) {
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
	result.reproduced = sameViolations && sameState;
	return result;
}
