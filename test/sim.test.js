import { describe, it, expect } from 'vitest';
import { runSim, runSimMany, replaySim, FIXED_EPOCH } from '../src/sim.js';

describe('runSim - smoke (zero config)', () => {
	it('delivers published events to subscribed clients with no invariant violations', async () => {
		const r = await runSim();
		expect(r.invariantViolations).toEqual([]);
		expect(r.fatals).toEqual([]);
		expect(r.schedulerUncaught).toEqual([]);
		expect(r.metrics.clients).toBe(2);
		expect(r.finalState.openConnections).toBe(2);
		expect(r.finalState.topicCounts).toEqual({ room: 2 });
	});

	it('each client receives welcome, subscribe ack, and every published event', async () => {
		const r = await runSim({ clients: 2, topics: ['room'] });
		for (const frames of r.clientFrames) {
			const types = frames.map((f) => f && f.type).filter(Boolean);
			expect(types).toContain('welcome');
			expect(types).toContain('subscribed');
			const ticks = frames.filter((f) => f && f.event === 'tick' && f.topic === 'room');
			expect(ticks.length).toBe(3);
			expect(ticks.map((t) => t.data.n)).toEqual([0, 1, 2]);
		}
	});
});

describe('runSim - determinism self-gate', () => {
	it('two runs with the same seed produce identical violations, state, and frame counts', async () => {
		const a = await runSim({ seed: 'gate-1' });
		const b = await runSim({ seed: 'gate-1' });
		expect(b.invariantViolations).toEqual(a.invariantViolations);
		expect(b.finalState).toEqual(a.finalState);
		expect(b.metrics).toEqual(a.metrics);
		expect(b.clientFrames).toEqual(a.clientFrames);
		expect(b.virtualTimeMs).toBe(a.virtualTimeMs);
	});

	it('different seeds can diverge in their delivery interleaving under faults', async () => {
		const a = await runSim({ seed: 'x', faults: { reorder: 0.8, maxJitterMs: 40 } });
		const b = await runSim({ seed: 'y', faults: { reorder: 0.8, maxJitterMs: 40 } });
		// The same seed must still reproduce exactly...
		const a2 = await runSim({ seed: 'x', faults: { reorder: 0.8, maxJitterMs: 40 } });
		expect(a2.clientFrames).toEqual(a.clientFrames);
		// ...and at least one seed pair differs somewhere observable (ordering/timing).
		const differ =
			JSON.stringify(a.clientFrames) !== JSON.stringify(b.clientFrames) ||
			a.virtualTimeMs !== b.virtualTimeMs;
		expect(differ).toBe(true);
	});

	it('stamps a deterministic opaque token into the subscribed ack epoch, not the real wall time', async () => {
		const r = await runSim({ seed: 'epoch', clients: 1, topics: ['room'] });
		const sub = r.clientFrames[0].find((f) => f && f.type === 'subscribed');
		expect(sub).toBeTruthy();
		// The epoch is the per-process generation token, latched from the seeded
		// RNG the sim installs. It is an opaque u32, NOT the wall clock: the old
		// wall-clock latch would have made it the fixed virtual baseline (and, in
		// production, leaked the process start time).
		expect(Number.isInteger(sub.epoch)).toBe(true);
		expect(sub.epoch).toBeGreaterThanOrEqual(0);
		expect(sub.epoch).toBeLessThanOrEqual(0xffffffff);
		expect(sub.epoch).not.toBe(FIXED_EPOCH);
		// And it is deterministic: the same seed reproduces the same token, which
		// is what lets a simulation replay a schedule bit-for-bit.
		const again = await runSim({ seed: 'epoch', clients: 1, topics: ['room'] });
		const sub2 = again.clientFrames[0].find((f) => f && f.type === 'subscribed');
		expect(sub2.epoch).toBe(sub.epoch);
	});

	it('replaySim reproduces a clean run', async () => {
		const original = await runSim({ seed: 'replay-1' });
		const replay = await replaySim(original);
		expect(replay.reproduced).toBe(true);
	});

	it('replaySim reproduces a faulted run (drops + duplicates + reorder)', async () => {
		const original = await runSim({ seed: 'replay-2', faults: { drop: 0.3, duplicate: 0.2, reorder: 0.5, maxJitterMs: 30 } });
		const replay = await replaySim(original);
		expect(replay.reproduced).toBe(true);
	});
});

describe('runSim - faults preserve server-side invariants', () => {
	it('dropping and reordering wire frames never corrupts subscription bookkeeping', async () => {
		const r = await runSim({ seed: 'faults', clients: 4, topics: ['a', 'b'], faults: { drop: 0.25, reorder: 0.6, duplicate: 0.2, maxJitterMs: 25 } });
		// Transport faults are below the dispatch; server bookkeeping must stay sound.
		expect(r.invariantViolations).toEqual([]);
		expect(r.schedulerUncaught).toEqual([]);
	});
});

describe('runSimMany', () => {
	it('runs a seed sweep and each result is internally reproducible', async () => {
		const results = await runSimMany({ seeds: ['s0', 's1', 's2', 's3'], base: { clients: 3, topics: ['t'] } });
		expect(results.length).toBe(4);
		for (const r of results) {
			expect(r.invariantViolations).toEqual([]);
			const replay = await replaySim(r);
			expect(replay.reproduced).toBe(true);
		}
	});
});

describe('runSim - custom scenario + handler', () => {
	it('honors a user subscribe hook denial without breaking bookkeeping', async () => {
		const r = await runSim({
			seed: 'hook',
			handler: {
				subscribe(ws, topic) { return topic === 'denied' ? 'FORBIDDEN' : null; }
			},
			scenario: async (api) => {
				const c = api.connect();
				await api.advance();
				c.subscribe('allowed');
				c.subscribe('denied');
				await api.advance();
			}
		});
		expect(r.invariantViolations).toEqual([]);
		const frames = r.clientFrames[0];
		const denied = frames.find((f) => f && f.type === 'subscribe-denied' && f.topic === 'denied');
		const ok = frames.find((f) => f && f.type === 'subscribed' && f.topic === 'allowed');
		expect(ok).toBeTruthy();
		expect(denied).toBeTruthy();
		// only the allowed topic is actually subscribed
		expect(r.finalState.topicCounts).toEqual({ allowed: 1 });
	});
});
