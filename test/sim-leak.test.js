import { describe, it, expect } from 'vitest';
import {
	runSim,
	replaySim,
	churnScenario,
	createResourceTracker,
	structuralResourceProbes,
	assertNoResourceGrowth,
	LeakError
} from '../src/sim.js';

describe('DST resource-leak harness - structural probes in the simulator', () => {
	it('churnScenario sheds every entry: leakProbe reports zero leaks', async () => {
		const r = await runSim({
			seed: 'churn-clean',
			scenario: churnScenario,
			leakProbe: true,
			clients: 3,
			topics: ['room']
		});
		// A healthy close path returns every structural series to baseline.
		expect(Array.isArray(r.resourceGrowth)).toBe(true);
		expect(r.resourceGrowth.length).toBeGreaterThan(0);
		expect(r.resourceGrowth.every((m) => !m.leaking)).toBe(true);
		// Sanity: the churn actually opened and fully drained connections.
		expect(r.invariantViolations).toEqual([]);
		expect(r.finalState.openConnections).toBe(0);
		// And the harness is non-vacuous here: it did trend a live `connections`
		// series (it was populated, not empty).
		const conns = r.resourceGrowth.find((m) => m.name === 'connections');
		expect(conns).toBeTruthy();
		expect(conns.max).toBeGreaterThan(0);
	});

	it('is non-vacuous: a handler that retains a per-connection entry across close IS detected', async () => {
		// The leak: `open` records the connection but `close` never releases it, so
		// `leaked` grows by one per connection and never sheds.
		const leaked = new Map();
		const handler = {
			open(ws) { leaked.set(ws, true); },
			close() { /* leak: intentionally does NOT delete from `leaked` */ }
		};
		// A reusable tracker over the handler-owned structure, sampled once per
		// churn cycle - exactly the downstream harness shape.
		const tracker = createResourceTracker(structuralResourceProbes({ leaked }));
		const scenario = async (api, opts) => {
			for (let cycle = 0; cycle < 12; cycle++) {
				const conns = [];
				for (let i = 0; i < opts.clients; i++) conns.push(api.connect());
				await api.advance();
				for (const c of conns) c.close();
				await api.advance();
				tracker.sample();
			}
		};
		await runSim({ seed: 'leak-planted', scenario, handler, clients: 2, topics: ['room'] });

		expect(leaked.size).toBeGreaterThan(0);
		let caught;
		try { assertNoResourceGrowth(tracker); } catch (err) { caught = err; }
		expect(caught).toBeInstanceOf(LeakError);
		expect(caught.leaks.map((l) => l.name)).toContain('leaked');
	});

	it('control: the SAME churn with a correct close path does not leak', async () => {
		// Identical to the planted-leak case except `close` releases the entry, so
		// `leaked` oscillates around zero and is not flagged. This isolates the
		// signal to the missing cleanup, not the churn shape.
		const held = new Map();
		const handler = {
			open(ws) { held.set(ws, true); },
			close(ws) { held.delete(ws); }
		};
		const tracker = createResourceTracker(structuralResourceProbes({ held }));
		const scenario = async (api, opts) => {
			for (let cycle = 0; cycle < 12; cycle++) {
				const conns = [];
				for (let i = 0; i < opts.clients; i++) conns.push(api.connect());
				await api.advance();
				for (const c of conns) c.close();
				await api.advance();
				tracker.sample();
			}
		};
		await runSim({ seed: 'leak-control', scenario, handler, clients: 2, topics: ['room'] });
		expect(held.size).toBe(0);
		expect(() => assertNoResourceGrowth(tracker)).not.toThrow();
	});

	it('replaySim reproduces resourceGrowth bit-for-bit', async () => {
		const cfg = { seed: 'churn-replay', scenario: churnScenario, leakProbe: true, clients: 3, topics: ['room'] };
		const first = await runSim(cfg);
		const replay = await replaySim(first);
		expect(replay.reproduced).toBe(true);
		expect(replay.resourceGrowth).toEqual(first.resourceGrowth);
	});

	it('two runs of the same seed produce an identical resourceGrowth trend', async () => {
		const a = await runSim({ seed: 'churn-det', scenario: churnScenario, leakProbe: true, clients: 2, topics: ['room'] });
		const b = await runSim({ seed: 'churn-det', scenario: churnScenario, leakProbe: true, clients: 2, topics: ['room'] });
		expect(JSON.stringify(b.resourceGrowth)).toBe(JSON.stringify(a.resourceGrowth));
	});
});
