import { describe, it, expect } from 'vitest';
import { runSimSwarm } from '../src/sim.js';

describe('runSimSwarm - aggregation + reproduce key', () => {
	it('runs a clean swarm and reports all passed', async () => {
		const { summary, runs } = await runSimSwarm({ count: 5, startSeed: 1 });
		expect(summary.total).toBe(5);
		expect(summary.passed).toBe(5);
		expect(summary.failed).toBe(0);
		expect(summary.firstFailingSeed).toBeNull();
		expect(summary.ok).toBe(true);
		expect(runs.map((r) => r.seed)).toEqual(['1', '2', '3', '4', '5']);
		for (const r of runs) {
			expect(r.ok).toBe(true);
			expect(r.fingerprint).toMatch(/^[0-9a-f]{8}$/);
		}
	});

	it('accepts an explicit seed list and stringifies numeric seeds', async () => {
		const { summary, runs } = await runSimSwarm({ seeds: ['a', 'b', 7] });
		expect(summary.total).toBe(3);
		expect(runs.map((r) => r.seed)).toEqual(['a', 'b', '7']);
	});

	it('is deterministic: two swarms produce identical runs and summary', async () => {
		const a = await runSimSwarm({ count: 4, startSeed: 100 });
		const b = await runSimSwarm({ count: 4, startSeed: 100 });
		expect(b.runs).toEqual(a.runs);
		expect(b.summary).toEqual(a.summary);
	});

	it('surfaces a failing seed as the reproduce key (restart-budget exhaustion)', async () => {
		const crashScenario = async (api) => {
			api.worker(0).connect();
			api.worker(1).connect();
			await api.advance();
			api.flapWorker(1, { recover: false });
			await api.advance(300000);
		};
		const { summary, runs } = await runSimSwarm({
			seeds: ['boom'],
			base: { workers: 2, scenario: crashScenario }
		});
		expect(summary.failed).toBe(1);
		expect(summary.firstFailingSeed).toBe('boom');
		expect(summary.failingSeeds).toEqual(['boom']);
		expect(summary.ok).toBe(false);
		expect(runs[0].ok).toBe(false);
		expect(runs[0].fatals).toBe(1);
	});

	it('onResult streams every run in order', async () => {
		const seen = [];
		await runSimSwarm({ count: 3, startSeed: 1, onResult: (run, i) => seen.push([i, run.seed]) });
		expect(seen).toEqual([[0, '1'], [1, '2'], [2, '3']]);
	});
});

describe('runSimSwarm - faultMode fault enablement', () => {
	it('faultMode:off leaves every run unfaulted (byte-identical to a plain swarm)', async () => {
		const off = await runSimSwarm({ count: 4, startSeed: 1, faultMode: 'off' });
		const plain = await runSimSwarm({ count: 4, startSeed: 1 });
		expect(off.runs.every((r) => r.faulted === false)).toBe(true);
		expect(off.runs).toEqual(plain.runs);
	});

	it('faultMode:on faults every run and changes the fingerprints vs unfaulted', async () => {
		const faultProfile = { drop: 0.3, duplicate: 0.2, reorder: 0.6, maxJitterMs: 30 };
		const on = await runSimSwarm({ count: 4, startSeed: 1, faultMode: 'on', faultProfile });
		const off = await runSimSwarm({ count: 4, startSeed: 1 });
		expect(on.runs.every((r) => r.faulted === true)).toBe(true);
		expect(on.summary.faulted).toBe(4);
		// Faults change the delivery interleaving -> a different structural
		// fingerprint, proving the profile is actually applied; invariants still hold.
		const changed = on.runs.some((r, i) => r.fingerprint !== off.runs[i].fingerprint);
		expect(changed).toBe(true);
		expect(on.summary.ok).toBe(true);
	});

	it('faultMode:random faults a reproducible, non-trivial subset', async () => {
		const faultProfile = { drop: 0.3, reorder: 0.6, maxJitterMs: 30 };
		const a = await runSimSwarm({ count: 24, startSeed: 1, faultMode: 'random', faultProfile, faultProbability: 0.5 });
		const b = await runSimSwarm({ count: 24, startSeed: 1, faultMode: 'random', faultProfile, faultProbability: 0.5 });
		expect(a.summary.faulted).toBeGreaterThan(0);
		expect(a.summary.faulted).toBeLessThan(24);
		// The faulted subset is identical across runs (seeded per seed).
		expect(b.runs.map((r) => r.faulted)).toEqual(a.runs.map((r) => r.faulted));
		expect(a.summary.faulted).toBe(a.runs.filter((r) => r.faulted).length);
	});
});

describe('runSimSwarm - determinism re-check (checkRatio)', () => {
	it('re-checks every run at checkRatio 1 and all reproduce', async () => {
		const { summary, runs } = await runSimSwarm({ count: 4, startSeed: 1, checkRatio: 1 });
		expect(summary.determinismChecks).toBe(4);
		expect(summary.determinismFailures).toBe(0);
		expect(summary.determinismFailingSeeds).toEqual([]);
		expect(runs.every((r) => r.reproduced === true)).toBe(true);
		expect(summary.ok).toBe(true);
	});

	it('checkRatio 0 (default) re-checks nothing', async () => {
		const { summary, runs } = await runSimSwarm({ count: 4, startSeed: 1 });
		expect(summary.determinismChecks).toBe(0);
		expect(runs.every((r) => r.reproduced === null)).toBe(true);
	});
});
