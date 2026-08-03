#!/usr/bin/env node
/**
 * The verification lanes, named once so "it passed locally" and "CI is green"
 * cannot mean different things.
 *
 * Each hosted job runs exactly one lane and nothing else, so what a contributor
 * runs before proposing a change is the same command, in the same order, with
 * the same environment - rather than a sequence reconstructed by reading two
 * workflow files. A step added to a lane lands in both places at once, which is
 * the property that keeps them equal.
 *
 *   fast   the static gates. Seconds, no network, no fixture.
 *   suite  the doctor with the native runtime demanded, packed publishing
 *          checks, then the whole REQUIRE_UWS test run. The HTTP/WS smoke
 *          checkpoint runs inside that test run (test/smoke-command.test.js),
 *          so this lane does not spawn it a second time.
 *   sim    the seed swarm and the golden corpus - the simulation job.
 *   pr     suite + sim: everything the hosted gate runs, and nothing it does not.
 *   full   pr + the Playwright e2e run, which no workflow runs, so whoever
 *          changes a browser-facing surface is the only person who will.
 *
 * Environment defaults are applied only where the caller set nothing, so the
 * nightly sweep's own DST_COUNT survives being run through the same lane.
 *
 * @module scripts/verify
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{ script: string, args?: string[], env?: Record<string, string> }} Step
 * @type {Record<string, Step[]>}
 */
export const LANES = {
	fast: [
		{ script: 'check' }
	],
	suite: [
		// Before the suite, not after: a missing addon or an uninstalled fixture
		// reads as a diagnosis here and as a Vite build failure ten minutes in
		// otherwise.
		{ script: 'doctor', args: ['--require-uws'] },
		// Validate the packed ESM/export-map surface with the ecosystem tools
		// consumers use, in addition to our source-tree declaration checker.
		{ script: 'check:publish' },
		// `npm test` is pretest (the static gates) plus the vitest run.
		{ script: 'test', env: { REQUIRE_UWS: '1' } }
	],
	sim: [
		// The seed count the pull-request gate uses. The nightly sweep sets its
		// own and keeps it.
		{ script: 'sim:swarm', env: { DST_COUNT: '300' } },
		{ script: 'sim:golden' }
	]
};

/**
 * Run one npm script. npm sets npm_execpath to its own entry when it runs a
 * script, so the same npm is reused rather than whatever PATH resolves, and
 * driving it through node avoids the .cmd/shell-quoting split.
 * @param {Step} step
 * @returns {number} exit status
 */
function run(step) {
	const args = ['run', step.script, ...(step.args && step.args.length ? ['--', ...step.args] : [])];
	const env = { ...process.env };
	for (const [key, value] of Object.entries(step.env || {})) {
		if (env[key] === undefined) env[key] = value;
	}
	const exec = process.env.npm_execpath;
	const useExec = typeof exec === 'string' && exec.endsWith('.js') && existsSync(exec);
	const result = useExec
		? spawnSync(process.execPath, [exec, ...args], { cwd: root, stdio: 'inherit', env })
		: spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
			cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32'
		});
	if (result.error) {
		console.error(`verify: could not run \`npm ${args.join(' ')}\`: ${result.error.message}`);
		return 1;
	}
	return result.status === null ? 1 : result.status;
}

function main() {
	const lane = process.argv[2];
	const steps = LANES[lane];
	if (!steps) {
		console.error(`verify: unknown lane '${lane || ''}'. Lanes: ${Object.keys(LANES).join(', ')}, pr, full.`);
		console.error('  pr and full compose the others and are npm scripts of their own.');
		process.exit(1);
	}

	console.log(`verify:${lane} - ${steps.map((s) => s.script).join(', ')}`);
	for (const step of steps) {
		const status = run(step);
		if (status !== 0) {
			console.error(`\nverify:${lane} FAILED at \`npm run ${step.script}\` (exit ${status}).`);
			process.exit(status);
		}
	}
	console.log(`verify:${lane} OK`);
}

// Importable for its own test suite; only the CLI invocation runs a lane.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
