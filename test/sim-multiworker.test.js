import { describe, it, expect } from 'vitest';
import { runSim, runSimMany, replaySim, FIXED_EPOCH } from '../sim.js';

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
		expect(r.invariantViolations).toEqual([]);
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
