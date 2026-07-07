// DST golden-set regression gate (buildSimGoldens / checkSimGoldens). The unit
// block drives the pure comparator with synthetic swarm results (no full sim);
// the integration block runs the REAL deterministic swarm over the committed
// corpus and asserts every fingerprint still matches HEAD (the actual gate),
// plus a determinism/portability re-run.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSimGoldens, checkSimGoldens, runSimSwarm } from '../src/sim.js';

const digest = (over = {}) => ({ violations: 0, fatals: 0, uncaught: 0, violationCategories: [], buggified: false, ...over });

function mkRun(seed, fingerprint, over = {}) {
	return { seed: String(seed), ok: true, buggified: false, fingerprint, violations: 0, fatals: 0, uncaught: 0, violationCategories: [], reproduced: null, ...over };
}
function mkSwarm(runs, summaryOver = {}) {
	return { summary: { buggify: 'off', gitCommit: null, ...summaryOver }, runs };
}
function mkGolden(entries, over = {}) {
	return { schemaVersion: 1, gitCommit: null, recordedAt: null, swarm: { buggify: 'off' }, entries, ...over };
}

describe('checkSimGoldens', () => {
	const baseEntries = [
		{ seed: '1', weight: 1, fingerprint: 'aaaaaaaa', digest: digest() },
		{ seed: '2', weight: 1, fingerprint: 'bbbbbbbb', digest: digest() },
		{ seed: '10', weight: 1, fingerprint: 'cccccccc', digest: digest() }
	];

	it('passes with driftWeight 0 when every fingerprint matches', () => {
		const golden = mkGolden(baseEntries);
		const swarm = mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'bbbbbbbb'), mkRun('10', 'cccccccc')]);
		const report = checkSimGoldens(golden, swarm);
		expect(report.ok).toBe(true);
		expect(report.driftWeight).toBe(0);
		expect(report.counts).toEqual({ changed: 0, missing: 0, added: 0, matched: 3 });
		expect(report.totalWeight).toBe(3);
	});

	it('fails when a weight-1 seed drifts', () => {
		const golden = mkGolden(baseEntries);
		const swarm = mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'DIFFERENT'), mkRun('10', 'cccccccc')]);
		const report = checkSimGoldens(golden, swarm);
		expect(report.ok).toBe(false);
		expect(report.driftWeight).toBe(1);
		expect(report.counts.changed).toBe(1);
		expect(report.drifts[0]).toMatchObject({ seed: '2', kind: 'changed' });
		expect(report.drifts[0].golden.fingerprint).toBe('bbbbbbbb');
		expect(report.drifts[0].actual.fingerprint).toBe('DIFFERENT');
	});

	it('does not fail when only a weight-0 (watch-list) seed drifts', () => {
		const golden = mkGolden([
			{ seed: '1', weight: 1, fingerprint: 'aaaaaaaa', digest: digest() },
			{ seed: '2', weight: 0, fingerprint: 'bbbbbbbb', digest: digest() }
		]);
		const swarm = mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'DRIFTED')]);
		const report = checkSimGoldens(golden, swarm);
		expect(report.ok).toBe(true); // weight 0 is reported but never gates
		expect(report.driftWeight).toBe(0);
		expect(report.counts.changed).toBe(1);
		expect(report.drifts).toHaveLength(1);
	});

	it('tolerates drift up to maxDriftWeight and fails above it', () => {
		const golden = mkGolden([
			{ seed: '1', weight: 2, fingerprint: 'aaaaaaaa', digest: digest() },
			{ seed: '2', weight: 3, fingerprint: 'bbbbbbbb', digest: digest() }
		]);
		const swarm = mkSwarm([mkRun('1', 'X'), mkRun('2', 'bbbbbbbb')]);
		expect(checkSimGoldens(golden, swarm, { maxDriftWeight: 2 }).ok).toBe(true); // drift 2 <= 2
		expect(checkSimGoldens(golden, swarm, { maxDriftWeight: 1 }).ok).toBe(false); // drift 2 > 1
	});

	it('classifies a seed absent from the run as missing and gates on it', () => {
		const golden = mkGolden(baseEntries);
		const swarm = mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('10', 'cccccccc')]); // seed 2 absent
		const report = checkSimGoldens(golden, swarm);
		expect(report.ok).toBe(false);
		expect(report.counts.missing).toBe(1);
		const miss = report.drifts.find((d) => d.seed === '2');
		expect(miss).toMatchObject({ kind: 'missing', actual: null });
	});

	it('counts an extra run seed as added but never gates on it', () => {
		const golden = mkGolden([{ seed: '1', weight: 1, fingerprint: 'aaaaaaaa', digest: digest() }]);
		const swarm = mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('99', 'zzzzzzzz')]);
		const report = checkSimGoldens(golden, swarm);
		expect(report.ok).toBe(true);
		expect(report.counts.added).toBe(1);
	});

	it('sorts drifts by weight descending then numeric seed', () => {
		const golden = mkGolden([
			{ seed: '2', weight: 1, fingerprint: 'a', digest: digest() },
			{ seed: '10', weight: 5, fingerprint: 'b', digest: digest() },
			{ seed: '3', weight: 1, fingerprint: 'c', digest: digest() }
		]);
		const swarm = mkSwarm([mkRun('2', 'X'), mkRun('10', 'Y'), mkRun('3', 'Z')]);
		const report = checkSimGoldens(golden, swarm);
		expect(report.drifts.map((d) => d.seed)).toEqual(['10', '2', '3']); // w5 first, then w1 by numeric seed
	});

	it('fails on a swarm-config mismatch (incomparable fingerprints)', () => {
		const golden = mkGolden(baseEntries, { swarm: { buggify: 'off' } });
		const swarm = mkSwarm([mkRun('1', 'aaaaaaaa'), mkRun('2', 'bbbbbbbb'), mkRun('10', 'cccccccc')], { buggify: 'random' });
		const report = checkSimGoldens(golden, swarm);
		expect(report.ok).toBe(false);
		expect(report.configMismatch).toMatch(/buggify mode differs/);
	});
});

describe('buildSimGoldens', () => {
	it('projects a swarm result into a sorted corpus that round-trips through checkSimGoldens', () => {
		const swarm = mkSwarm([
			mkRun('10', 'ffff', { violations: 0, buggified: true }),
			mkRun('2', 'eeee'),
			mkRun('1', 'dddd')
		], { gitCommit: 'abc123' });
		const corpus = buildSimGoldens(swarm, { swarm: { buggify: 'off' }, recordedAt: '2026-01-01T00:00:00.000Z' });
		expect(corpus.schemaVersion).toBe(1);
		expect(corpus.gitCommit).toBe('abc123');
		expect(corpus.recordedAt).toBe('2026-01-01T00:00:00.000Z');
		expect(corpus.entries.map((e) => e.seed)).toEqual(['1', '2', '10']); // numeric-aware sort
		expect(corpus.entries.every((e) => e.weight === 1)).toBe(true);
		// The corpus it built must match the swarm it was built from.
		expect(checkSimGoldens(corpus, swarm).ok).toBe(true);
	});

	it('honors per-seed weight overrides', () => {
		const swarm = mkSwarm([mkRun('1', 'aaaa'), mkRun('2', 'bbbb')]);
		const corpus = buildSimGoldens(swarm, { weights: { 2: 0 } });
		expect(corpus.entries.find((e) => e.seed === '2').weight).toBe(0);
		expect(corpus.entries.find((e) => e.seed === '1').weight).toBe(1);
	});
});

// The real gate: run the committed corpus config through the deterministic swarm
// and assert every fingerprint still matches HEAD. If this fails, either a real
// regression landed or an intentional behavior change needs re-blessing
// (`npm run sim:golden -- --update`).
describe('DST golden corpus matches HEAD', () => {
	const CORPORA = [
		new URL('./dst-goldens/adapter-single.golden.json', import.meta.url),
		new URL('./dst-goldens/adapter-cluster.golden.json', import.meta.url)
	];

	for (const corpusUrl of CORPORA) {
		const corpus = JSON.parse(readFileSync(corpusUrl, 'utf8'));
		const name = corpusUrl.pathname.split('/').pop();

		it(`${name}: every committed fingerprint reproduces at HEAD`, async () => {
			const swarm = corpus.swarm || {};
			const result = await runSimSwarm({
				seeds: corpus.entries.map((e) => e.seed),
				buggify: swarm.buggify,
				buggifyProbability: swarm.buggifyProbability,
				faultProfile: swarm.faultProfile,
				base: swarm.base
			});
			const report = checkSimGoldens(corpus, result);
			if (!report.ok) {
				const detail = report.configMismatch || report.drifts.slice(0, 5).map((d) => `${d.seed}:${d.kind}`).join(', ');
				throw new Error(`${name} drifted (driftWeight ${report.driftWeight}): ${detail}. Re-bless with \`npm run sim:golden -- --update\` if intentional.`);
			}
			expect(report.ok).toBe(true);
			expect(report.counts.matched).toBe(corpus.entries.length);
		}, 60000);
	}

	it('adapter-single: two swarms produce byte-identical fingerprints (portability)', async () => {
		const corpus = JSON.parse(readFileSync(CORPORA[0], 'utf8'));
		const swarm = corpus.swarm || {};
		const cfg = {
			seeds: corpus.entries.slice(0, 12).map((e) => e.seed),
			buggify: swarm.buggify,
			buggifyProbability: swarm.buggifyProbability,
			faultProfile: swarm.faultProfile,
			base: swarm.base
		};
		const a = await runSimSwarm(cfg);
		const b = await runSimSwarm(cfg);
		expect(a.runs.map((r) => r.fingerprint)).toEqual(b.runs.map((r) => r.fingerprint));
	}, 60000);
});
