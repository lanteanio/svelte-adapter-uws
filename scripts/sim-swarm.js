// CI seed-swarm runner. Reads the seed range + knobs from the environment,
// drives runSimSwarm (the deterministic core in src/sim.js), stamps wall-clock
// metadata, and writes a result JSON for a CI workflow to commit and a
// dashboard to render. Lives under scripts/ - outside the determinism seam -
// so it may read the clock and the environment freely.
//
// Environment:
//   DST_SEED          first integer seed (default 1)
//   DST_COUNT         number of consecutive seeds (default 200)
//   DST_FAULTS       off | on | random (default random)
//   DST_FAULT_PROB  fault probability under random mode (default 0.25)
//   DST_CHECK_RATIO   fraction of runs re-checked for determinism (default 0.05)
//   DST_WORKERS       model N workers per run (default 1, single-worker)
//   GIT_COMMIT        overrides the source revision in the report (defaults to
//                     the checkout's HEAD)
//   DST_OUT           output path (default sim-swarm-result.json)
//   DST_MAX_RUNS      cap on retained PASSING runs in the JSON (default 200;
//                     every failing run is always kept, never silently dropped)
//
// Exit code: 0 when the swarm is clean, 1 when any seed failed or a determinism
// re-check did not reproduce - the CI failure signal.

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { runSimSwarm } from '../src/sim.js';
import { resolveGitCommit } from './sim-git-commit.js';

const num = (name, def) => {
	const v = process.env[name];
	if (v === undefined || v === '') return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
};

const startSeed = num('DST_SEED', 1);
const count = num('DST_COUNT', 200);
const faultMode = (process.env.DST_FAULTS || 'random').toLowerCase();
const faultProbability = num('DST_FAULT_PROB', 0.25);
const checkRatio = num('DST_CHECK_RATIO', 0.05);
const workers = num('DST_WORKERS', 1);
const gitCommit = resolveGitCommit();
const out = process.env.DST_OUT || 'sim-swarm-result.json';
const maxRuns = num('DST_MAX_RUNS', 200);

const base = {};
if (workers > 1) base.workers = workers;

// A representative fault profile for faulted runs: drop / duplicate / reorder
// / jitter applied below the dispatch. These never break the server invariants -
// proving that under chaos is exactly the swarm's job.
const faultProfile = { drop: 0.25, duplicate: 0.15, reorder: 0.5, maxJitterMs: 30 };

console.log(
	`sim-swarm: ${count} seeds from ${startSeed}, faultMode=${faultMode}, checkRatio=${checkRatio}` +
	(workers > 1 ? `, workers=${workers}` : '')
);

const startWall = Date.now();
let failingSoFar = 0;
let firstFailureLogged = false;

const { summary, runs } = await runSimSwarm({
	startSeed,
	count,
	base,
	faultMode,
	faultProfile,
	faultProbability,
	checkRatio,
	gitCommit,
	onResult(run, i) {
		if (!run.ok) {
			failingSoFar++;
			if (!firstFailureLogged) {
				firstFailureLogged = true;
				console.error(`\nFAIL seed=${run.seed} (run ${i + 1}/${count}) - reproduce locally with this seed`);
				console.error(
					`  violations=${run.violations} fatals=${run.fatals} uncaught=${run.uncaught}` +
					(run.reproduced === false ? ' [DETERMINISM REGRESSION: replay diverged]' : '') +
					(run.violationCategories.length ? ` categories=[${run.violationCategories.join(', ')}]` : '')
				);
			}
		}
		if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${count} run, ${failingSoFar} failing so far`);
	}
});

const durationMs = Date.now() - startWall;

// Bound the committed file: keep every failing run, plus up to maxRuns passing
// runs as a sample. The summary always carries the full counts (no silent cap).
const failing = runs.filter((r) => !r.ok);
const passing = runs.filter((r) => r.ok);
const keptPassing = passing.slice(0, maxRuns);
const runsTruncated = keptPassing.length < passing.length;

const report = {
	schemaVersion: 1,
	startedAt: new Date(startWall).toISOString(),
	finishedAt: new Date(startWall + durationMs).toISOString(),
	durationMs,
	node: process.version,
	gitCommit: summary.gitCommit,
	config: { startSeed, count, faultMode, faultProbability, checkRatio, workers: workers > 1 ? workers : 1 },
	summary,
	runsTruncated,
	keptPassingRuns: keptPassing.length,
	totalPassingRuns: passing.length,
	runs: [...failing, ...keptPassing]
};

writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(
	`\nsim-swarm: ${summary.passed}/${summary.total} passed, ${summary.failed} failing` +
	(summary.determinismChecks ? `, ${summary.determinismChecks} determinism re-checks (${summary.determinismFailures} regressions)` : '') +
	` in ${durationMs}ms`
);
if (runsTruncated) {
	console.log(`  kept ${keptPassing.length} of ${passing.length} passing runs in ${out}; all ${failing.length} failing runs kept`);
}
console.log(`  wrote ${out}`);

if (!summary.ok) {
	console.error(
		`sim-swarm FAILED: ${summary.failed} failing seed(s)` +
		(summary.firstFailingSeed ? ` (first: ${summary.firstFailingSeed})` : '') +
		(summary.determinismFailures ? `, ${summary.determinismFailures} determinism regression(s)` : '')
	);
	process.exit(1);
}
