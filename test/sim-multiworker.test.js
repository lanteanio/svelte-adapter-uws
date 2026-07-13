import { describe, it, expect } from 'vitest';
import { runSim, runSimMany, replaySim, FIXED_EPOCH } from '../src/sim.js';
import { computeStateHash } from '../src/runtime/invariants.js';
import { checkStateConvergence } from '../src/runtime/sim-cluster.js';

// Build a synthetic worker cohort for the convergence predicate: each worker gets
// one client whose delivered frames carry the given per-topic seq (the wire body
// shape the in-memory relay emits), tagged with the uncorrupted routingTopic.
function cohort(workerSeqs) {
	return workerSeqs.map(({ id, seqs }) => ({
		id,
		clients: [{
			frames: Object.keys(seqs).map((topic) => ({
				routingTopic: topic,
				payload: JSON.stringify({ topic, event: 'tick', data: null, seq: seqs[topic] })
			}))
		}]
	}));
}

// Helper: flatten a worker's per-client decoded frames into one array.
const flat = (clusterFrames, worker) => clusterFrames[worker].clients.flat().filter(Boolean);
const ticks = (frames, topic = 'room') => frames.filter((f) => f && f.event === 'tick' && f.topic === topic);

describe('runSim multi-worker - cross-worker convergence', () => {
	it('delivers a publish on one worker to subscribers on every other worker (default scenario)', async () => {
		const r = await runSim({ workers: 3, clients: 2, topics: ['room'], seed: 'conv-1' });
		expect(r.invariantViolations).toEqual([]);
		expect(r.fatals).toEqual([]);
		expect(r.schedulerUncaught).toEqual([]);
		// worker 0 published 3 ticks; each worker has 2 clients => 6 tick frames per worker.
		for (let w = 0; w < 3; w++) expect(ticks(flat(r.clusterFrames, w)).length).toBe(6);
		// the relay forwarded each of the 3 messages to the 2 other workers.
		expect(r.metrics.relay.forwarded).toBe(6);
		expect(r.metrics.relay.delivered).toBe(6);
		expect(r.metrics.relay.dropped).toBe(0);
	});

	it('carries a fast-path publishBatched across the relay (receiver re-runs its own fan-out detection)', async () => {
		const r = await runSim({
			workers: 2, seed: 'conv-batch',
			scenario: async (api) => {
				api.worker(0).connect();
				api.worker(1).connect();
				await api.advance();
				for (const w of [0, 1]) for (const c of api.worker(w).clients()) c.subscribe('room');
				await api.advance();
				api.worker(0).publishBatched([
					{ topic: 'room', event: 'a', data: 1 },
					{ topic: 'room', event: 'b', data: 2 }
				]);
				await api.advance();
			}
		});
		expect(r.invariantViolations).toEqual([]);
		// worker 1's client receives both batched events relayed from worker 0.
		const got = flat(r.clusterFrames, 1).filter((f) => f && (f.event === 'a' || f.event === 'b'));
		expect(got.length).toBe(2);
	});

	it('excludes a relay:false event from the cross-worker batch while still fanning it out locally', async () => {
		const r = await runSim({
			workers: 2, seed: 'relay-false-batch',
			scenario: async (api) => {
				const c0 = api.worker(0).connect();
				const c1 = api.worker(1).connect();
				await api.advance();
				// announce the 'batch' capability so the fast batch path engages on both sides.
				c0.send({ type: 'hello', caps: ['batch'] });
				c1.send({ type: 'hello', caps: ['batch'] });
				c0.subscribe('room');
				c1.subscribe('room');
				await api.advance();
				api.worker(0).publishBatched([
					{ topic: 'room', event: 'keep', data: 1 },
					{ topic: 'room', event: 'drop', data: 2, options: { relay: false } }
				]);
				await api.advance();
			}
		});
		expect(r.invariantViolations).toEqual([]);
		// worker 0 (local fan-out) keeps both events; worker 1 (relayed) sees only the
		// non-relay:false one - the production cross-worker de-dup gate.
		const w0 = JSON.stringify(r.clusterFrames[0].clients);
		const w1 = JSON.stringify(r.clusterFrames[1].clients);
		expect(w0).toContain('keep');
		expect(w0).toContain('drop');
		expect(w1).toContain('keep');
		expect(w1).not.toContain('drop');
	});

	it('never delivers a frame to a client for a topic it did not subscribe to', async () => {
		const r = await runSim({
			workers: 3, seed: 'no-misdeliver',
			scenario: async (api) => {
				api.worker(0).connect();
				api.worker(1).connect();
				api.worker(2).connect();
				await api.advance();
				// only worker 1's client subscribes to 'room'.
				api.worker(1).clients()[0].subscribe('room');
				await api.advance();
				api.worker(0).publish('room', 'tick', { n: 0 });
				await api.advance();
			}
		});
		expect(r.invariantViolations).toEqual([]);
		expect(ticks(flat(r.clusterFrames, 1)).length).toBe(1);
		expect(ticks(flat(r.clusterFrames, 0)).length).toBe(0);
		expect(ticks(flat(r.clusterFrames, 2)).length).toBe(0);
	});
});

describe('runSim multi-worker - determinism self-gate', () => {
	it('two runs with the same seed produce identical aggregate state, cluster frames, and metrics', async () => {
		const a = await runSim({ workers: 3, seed: 'mw-gate' });
		const b = await runSim({ workers: 3, seed: 'mw-gate' });
		expect(b.finalState).toEqual(a.finalState);
		expect(b.clusterFrames).toEqual(a.clusterFrames);
		expect(b.metrics).toEqual(a.metrics);
		expect(b.virtualTimeMs).toBe(a.virtualTimeMs);
		expect(b.fatals).toEqual(a.fatals);
	});

	it('replaySim reproduces a clean multi-worker run', async () => {
		const original = await runSim({ workers: 3, seed: 'mw-replay' });
		expect((await replaySim(original)).reproduced).toBe(true);
	});

	it('replaySim reproduces a multi-worker run under relay drop + reorder faults', async () => {
		const original = await runSim({ workers: 4, seed: 'mw-replay-faults', relayFaults: { drop: 0.3, reorder: 0.6, duplicate: 0.2, maxJitterMs: 30 } });
		expect((await replaySim(original)).reproduced).toBe(true);
	});

	it('different seeds diverge observably under relay faults, same seed still reproduces', async () => {
		const a = await runSim({ workers: 3, seed: 'mw-x', relayFaults: { drop: 0.5, reorder: 0.7, maxJitterMs: 40 } });
		const b = await runSim({ workers: 3, seed: 'mw-y', relayFaults: { drop: 0.5, reorder: 0.7, maxJitterMs: 40 } });
		const a2 = await runSim({ workers: 3, seed: 'mw-x', relayFaults: { drop: 0.5, reorder: 0.7, maxJitterMs: 40 } });
		expect(a2.clusterFrames).toEqual(a.clusterFrames);
		const differ =
			JSON.stringify(a.clusterFrames) !== JSON.stringify(b.clusterFrames) ||
			a.metrics.relay.dropped !== b.metrics.relay.dropped;
		expect(differ).toBe(true);
	});
});

describe('runSim multi-worker - faults preserve invariants', () => {
	it('dropping / reordering / corrupting relay frames never corrupts per-worker bookkeeping', async () => {
		const r = await runSim({
			workers: 4, clients: 3, topics: ['a', 'b'], seed: 'mw-faults',
			faults: { drop: 0.2, reorder: 0.5, maxJitterMs: 25 },
			relayFaults: { drop: 0.25, reorder: 0.6, duplicate: 0.2, corrupt: 0.1, maxJitterMs: 30 }
		});
		// Per-worker bookkeeping must stay intact under every relay fault. A dropped
		// relay frame legitimately leaves one worker's delivered-seq run below the
		// others (a real cross-worker divergence the convergence check reports), so
		// that category is expected here; the bookkeeping invariants must not fire.
		const bookkeeping = r.invariantViolations.filter((v) => v.category !== 'cluster.state-divergence');
		expect(bookkeeping).toEqual([]);
		expect(r.schedulerUncaught).toEqual([]);
	});

	it('workers:1 is byte-identical to a non-cluster run', async () => {
		const cluster = await runSim({ workers: 1, seed: 'identity' });
		const plain = await runSim({ seed: 'identity' });
		// workers:1 takes the single-worker path verbatim - same single-snapshot shape.
		expect(cluster.finalState).toEqual(plain.finalState);
		expect(cluster.clientFrames).toEqual(plain.clientFrames);
		expect(cluster.metrics).toEqual(plain.metrics);
	});
});

describe('runSim multi-worker - restart-budget outcomes', () => {
	it('surfaces restart-budget-exhausted as a reproducible fatal when a worker crash-loops', async () => {
		const r = await runSim({
			workers: 2, seed: 'budget-exhaust',
			scenario: async (api) => {
				api.worker(0).connect();
				api.worker(1).connect();
				await api.advance();
				api.flapWorker(1, { recover: false });
				await api.advance(300000);
			}
		});
		expect(r.fatals.length).toBe(1);
		expect(r.fatals[0]).toMatchObject({ worker: 1, reason: 'restart-budget-exhausted', attempts: 50 });
		// the backoff schedule is the deterministic 100->double->cap-at-5000 sequence.
		expect(r.fatals[0].schedule.slice(0, 7)).toEqual([100, 200, 400, 800, 1600, 3200, 5000]);
		expect(r.metrics.restarts).toBe(50);
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('an intermittently-recovering flap resets the budget and never exhausts (flap-then-converge)', async () => {
		const r = await runSim({
			workers: 2, seed: 'flap-converge',
			scenario: async (api) => {
				api.worker(0).connect();
				api.worker(1).connect();
				await api.advance();
				api.flapWorker(1);              // recovers, resets the budget
				await api.advance();
				api.worker(0).publish('room', 'tick', { n: 0 });
				await api.advance();
			}
		});
		expect(r.fatals).toEqual([]);
		expect(r.metrics.restarts).toBe(1);
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('a wedged worker is terminated after the heartbeat timeout, then recovers', async () => {
		const r = await runSim({
			workers: 2, seed: 'wedge',
			scenario: async (api) => {
				api.worker(0).connect();
				await api.advance();
				api.wedgeWorker(1);
				await api.advanceTime(45000);   // past HEARTBEAT_TIMEOUT_MS (30s)
			}
		});
		expect(r.metrics.wedges).toBe(1);
		expect(r.metrics.restarts).toBe(1);   // terminated then respawned
		expect(r.fatals).toEqual([]);
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('an init-wedged worker (never reaches ready) is escalated by the boot deadline, then recovers', async () => {
		// The steady-state timeout only judges a ready worker and the per-slot restart
		// supervisor leaves a still-booting slot alone, so before the boot deadline a
		// worker wedged during its init hook stayed 'starting' forever - permanent
		// capacity loss. The boot deadline escalates it and the respawn boots cleanly.
		const r = await runSim({
			workers: 2, seed: 'init-wedge',
			scenario: async (api) => {
				api.worker(0).connect();
				await api.advance();
				api.initWedgeWorker(1);
				await api.advanceTime(75000);   // past WORKER_BOOT_TIMEOUT_MS (60s)
			}
		});
		expect(r.metrics.initWedges).toBe(1);
		expect(r.metrics.restarts).toBe(1);    // boot-deadline escalation -> respawn
		expect(r.metrics.workersLive).toBe(2); // slot recovered, no permanent capacity loss
		expect(r.fatals).toEqual([]);
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('a still-booting worker under the boot deadline is left alone (pins the pre-deadline boundary)', async () => {
		// Same init-wedge, but time only advances partway to the 60s boot deadline: the
		// worker must still be booting, not yet escalated. Pins the lower boundary of
		// the deadline; the full slow-but-healthy (keeps-acking) guarantee is proven at
		// the unit layer in worker-boot-deadline.test.js.
		const r = await runSim({
			workers: 2, seed: 'init-wedge-underdeadline',
			scenario: async (api) => {
				api.worker(0).connect();
				await api.advance();
				api.initWedgeWorker(1);
				await api.advanceTime(30000);   // under WORKER_BOOT_TIMEOUT_MS (60s)
			}
		});
		expect(r.metrics.initWedges).toBe(1);
		expect(r.metrics.restarts).toBe(0);    // not yet escalated
		expect(r.fatals).toEqual([]);
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('WORKER_BOOT_TIMEOUT_MS=0 disables the boot deadline - a wedged boot is left stranded', async () => {
		// The documented opt-out: with the deadline disabled the pre-fix behavior
		// returns (a wedged boot is never escalated) even long past the default 60s.
		// Guards the `bootTimeoutMs > 0` gate in classifyWorkerHealth.
		const r = await runSim({
			workers: 2, seed: 'init-wedge-disabled', workerBootTimeoutMs: 0,
			scenario: async (api) => {
				api.worker(0).connect();
				await api.advance();
				api.initWedgeWorker(1);
				await api.advanceTime(120000);  // well past the default deadline - still ignored
			}
		});
		expect(r.metrics.initWedges).toBe(1);
		expect(r.metrics.restarts).toBe(0);    // deadline disabled: never escalated
		expect(r.fatals).toEqual([]);
		expect((await replaySim(r)).reproduced).toBe(true);
	});
});

describe('runSim multi-worker - acceptor mode', () => {
	it('pauses the acceptor listen socket when every worker is down', async () => {
		const r = await runSim({
			workers: 2, clusterMode: 'acceptor', seed: 'acceptor-pause',
			scenario: async (api) => {
				api.worker(0).connect();
				api.worker(1).connect();
				await api.advance();
				api.flapWorker(0, { recover: false });
				api.flapWorker(1, { recover: false });
				await api.advance(300000);
			}
		});
		expect(r.metrics.listenPaused).toBe(true);
		expect(r.fatals.length).toBe(2);
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('reuseport never reports a listen pause (no acceptor socket)', async () => {
		const r = await runSim({
			workers: 2, clusterMode: 'reuseport', seed: 'reuseport-nopause',
			scenario: async (api) => {
				api.worker(0).connect();
				await api.advance();
				api.flapWorker(0, { recover: false });
				api.flapWorker(1, { recover: false });
				await api.advance(300000);
			}
		});
		expect(r.metrics.listenPaused).toBe(false);
	});
});

describe('runSim multi-worker - per-worker epoch', () => {
	it('each worker presents a distinct topic generation in its subscribed ack', async () => {
		const r = await runSim({
			workers: 2, seed: 'epoch-divergence',
			scenario: async (api) => {
				api.worker(0).connect();
				api.worker(1).connect();
				await api.advance();
				for (const w of [0, 1]) for (const c of api.worker(w).clients()) c.subscribe('room');
				await api.advance();
			}
		});
		const ep0 = flat(r.clusterFrames, 0).find((f) => f && f.type === 'subscribed');
		const ep1 = flat(r.clusterFrames, 1).find((f) => f && f.type === 'subscribed');
		expect(ep0.epoch).toBe(FIXED_EPOCH);       // worker 0 = base
		expect(ep1.epoch).toBe(FIXED_EPOCH + 1);   // worker 1 = base + id
		expect(ep0.epoch).not.toBe(ep1.epoch);
	});
});

describe('runSimMany multi-worker', () => {
	it('runs a multi-worker seed sweep and each result reproduces', async () => {
		const results = await runSimMany({ seeds: ['m0', 'm1', 'm2'], base: { workers: 3, clients: 2, topics: ['t'], relayFaults: { reorder: 0.5, maxJitterMs: 30 } } });
		expect(results.length).toBe(3);
		for (const r of results) {
			expect(r.invariantViolations).toEqual([]);
			expect((await replaySim(r)).reproduced).toBe(true);
		}
	});
});

describe('computeStateHash', () => {
	it('is byte-stable: the same projection hashes identically twice and is unsigned 32-bit', () => {
		const a = computeStateHash({ topicSeqs: { room: 3, lobby: 1 } });
		const b = computeStateHash({ topicSeqs: { room: 3, lobby: 1 } });
		expect(b).toBe(a);
		expect(typeof a).toBe('number');
		expect(a >>> 0).toBe(a);   // unsigned 32-bit integer (no sign bit, no fraction)
	});

	it('is order-independent: a different insertion order yields the same hash', () => {
		const forward = { topicSeqs: { a: 1, b: 2, c: 3 } };
		const reverse = { topicSeqs: {} };
		reverse.topicSeqs.c = 3;
		reverse.topicSeqs.b = 2;
		reverse.topicSeqs.a = 1;
		expect(computeStateHash(reverse)).toBe(computeStateHash(forward));
	});

	it('reads only topicSeqs: excluded fields never change the hash', () => {
		const base = computeStateHash({ topicSeqs: { room: 3 } });
		const noisy = computeStateHash({
			topicSeqs: { room: 3 },
			// none of these structure-excluded fields may contribute
			payload: 'hello',
			event: 'tick',
			data: { x: 1 },
			connectionId: 'ws-42',
			subscriberCount: 99,
			presence: { user: 'kevin' }
		});
		expect(noisy).toBe(base);
	});

	it('two independently-built equal projections hash equal', () => {
		const one = {};
		one.room = 3; one.lobby = 5;
		const two = {};
		two.lobby = 5; two.room = 3;
		expect(computeStateHash({ topicSeqs: two })).toBe(computeStateHash({ topicSeqs: one }));
	});

	it('any single change moves the hash (seq, added topic, renamed topic)', () => {
		const base = computeStateHash({ topicSeqs: { room: 3 } });
		expect(computeStateHash({ topicSeqs: { room: 4 } })).not.toBe(base);             // changed seq
		expect(computeStateHash({ topicSeqs: { room: 3, lobby: 0 } })).not.toBe(base);   // extra zero-seq topic
		expect(computeStateHash({ topicSeqs: { area: 3 } })).not.toBe(base);             // renamed topic
	});

	it('empty projection is a stable value distinct from any single-entry hash, and seq 0 differs from an absent topic', () => {
		const empty = computeStateHash({ topicSeqs: {} });
		expect(empty).toBe(computeStateHash({ topicSeqs: {} }));   // stable
		expect(empty).not.toBe(computeStateHash({ topicSeqs: { room: 0 } }));   // count-base differs
		// a present zero-seq topic is not the same state as an absent one
		expect(computeStateHash({ topicSeqs: { room: 0 } })).not.toBe(computeStateHash({ topicSeqs: {} }));
	});
});

describe('checkStateConvergence predicate', () => {
	it('returns null when every worker received the same stamped seq run', () => {
		const v = checkStateConvergence(cohort([
			{ id: 0, seqs: { room: 3 } },
			{ id: 1, seqs: { room: 3 } },
			{ id: 2, seqs: { room: 3 } }
		]));
		expect(v).toBeNull();
	});

	it('flags the minority worker whose seq run trails the majority', () => {
		const v = checkStateConvergence(cohort([
			{ id: 0, seqs: { room: 3 } },
			{ id: 1, seqs: { room: 3 } },
			{ id: 2, seqs: { room: 2 } }   // received one fewer
		]));
		expect(v).not.toBeNull();
		expect(v.category).toBe('cluster.state-divergence');
		expect(v.context.topics).toEqual(['room']);
		expect(v.context.workers).toEqual([2]);
		expect(v.context.expectedHash).not.toBe(v.context.divergentHash);
	});

	it('ignores a worker with no delivered seq run (it does not participate)', () => {
		// worker 2 received nothing for the topic; it must not be compared against subscribers.
		const v = checkStateConvergence([
			...cohort([{ id: 0, seqs: { room: 3 } }, { id: 1, seqs: { room: 3 } }]),
			{ id: 2, clients: [{ frames: [] }] }
		]);
		expect(v).toBeNull();
	});

	it('does not let a corrupt (undecodable) frame body change the projection', () => {
		// worker 2 received the seq-3 frame plus a later corrupt frame for the same
		// topic; the corrupt body cannot decode, so its max stays 3 and it converges.
		const v = checkStateConvergence([
			...cohort([{ id: 0, seqs: { room: 3 } }, { id: 1, seqs: { room: 3 } }]),
			{ id: 2, clients: [{ frames: [
				{ routingTopic: 'room', payload: JSON.stringify({ topic: 'room', event: 'tick', data: null, seq: 3 }) },
				{ routingTopic: 'room', payload: '{"topic":"room","ev' }   // truncated/corrupt body
			] }] }
		]);
		expect(v).toBeNull();
	});

	it('names one deterministic offender group on a perfect even split', () => {
		const v = checkStateConvergence(cohort([
			{ id: 0, seqs: { room: 3 } },
			{ id: 1, seqs: { room: 3 } },
			{ id: 2, seqs: { room: 2 } },
			{ id: 3, seqs: { room: 2 } }
		]));
		expect(v).not.toBeNull();
		// 2-2 split: the offender is the group holding the numerically-largest id.
		expect(v.context.workers).toEqual([2, 3]);
		expect(v.context.expectedHash).not.toBe(v.context.divergentHash);
	});
});

describe('runSim multi-worker - state-convergence detection', () => {
	// A scenario where every worker subscribes to a shared topic and worker 0
	// publishes a run of three events, so each subscribing worker should receive the
	// same stamped seq run. A seeded relay drop makes exactly one worker miss one of
	// those frames, so its delivered-seq run trails - a reproducible divergence.
	const sharedScenario = async (api) => {
		for (let w = 0; w < 3; w++) api.worker(w).connect();
		await api.advance();
		for (let w = 0; w < 3; w++) for (const c of api.worker(w).clients()) c.subscribe('room');
		await api.advance();
		for (let n = 0; n < 3; n++) api.worker(0).publish('room', 'tick', { n });
		await api.advance();
	};
	// Seed + drop rate chosen empirically against the actual seeded relay stream so
	// exactly one subscribing worker misses one of the three stamped frames.
	const divergeConfig = { workers: 3, seed: 'div-3', relayFaults: { drop: 0.2 }, scenario: sharedScenario };

	it('detects a dropped-frame seq divergence and the violation reproduces bit-for-bit', async () => {
		const r = await runSim(divergeConfig);
		const divs = r.invariantViolations.filter((v) => v.category === 'cluster.state-divergence');
		expect(divs.length).toBe(1);
		expect(divs[0].context.topics).toEqual(['room']);
		expect(divs[0].context.workers).toEqual([2]);   // the worker that missed a frame
		expect(divs[0].context.expectedHash).not.toBe(divs[0].context.divergentHash);
		// the new violation flows through invariantViolations, which replaySim compares.
		expect((await replaySim(r)).reproduced).toBe(true);
	});

	it('reports the same minority worker on every run (divergence is a function of the seed)', async () => {
		const minorities = [];
		for (let i = 0; i < 3; i++) {
			const r = await runSim(divergeConfig);
			const d = r.invariantViolations.find((v) => v.category === 'cluster.state-divergence');
			minorities.push(d ? d.context.workers : null);
		}
		expect(minorities[1]).toEqual(minorities[0]);
		expect(minorities[2]).toEqual(minorities[0]);
		expect(minorities[0]).toEqual([2]);
	});

	it('a clean relay (no drop) reports zero divergence - the predicate does not false-positive', async () => {
		const r = await runSim({ workers: 3, seed: 'div-3', relayFaults: {}, scenario: sharedScenario });
		const divs = r.invariantViolations.filter((v) => v.category === 'cluster.state-divergence');
		expect(divs.length).toBe(0);
		expect((await replaySim(r)).reproduced).toBe(true);
	});
});
