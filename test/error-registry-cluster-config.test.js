// ADAPTER-ERR-CLUSTER-CONFIG-WORKERS, driven from the condition it claims.
//
// The entry's cause is "set to something other than a positive integer or
// 'auto'" and its consequence a fatal exit before any worker spawns. The
// token must therefore DENOTE a whole number, judged by the rule PORT, the
// shutdown budgets, and the relay ceilings answer to: parseInt absorbs
// '2.5' as 2, '3workers' as 3, and '1e2' as 1, and under that parsing an
// operator squarely inside the documented cause got a silently wrong fleet
// instead of the documented refusal. Tokens that denote their fleet
// exactly - whitespace-padded, signed, or decimal spellings of a whole
// number - keep booting it, as they always did.
//
// The guard lives in the cluster primary's boot path, which only a real
// process reaches - the in-process harness imports the built handler and
// never evaluates the primary entry - so each case spawns the built fixture
// entry and asserts on its exit code or output. The cluster mode is pinned
// to acceptor so the boot markers are the same on every platform (Linux
// defaults to reuseport, which prints different ones). The workers of a
// clustered fixture are threads inside the one child process, so killing
// the child leaves nothing behind.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { hasUWS, EVAL_TIME_ENV, freePort } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;

function bootWorkers(value, port) {
	const env = { ...process.env };
	for (const key of EVAL_TIME_ENV) delete env[key];
	env.HOST = '127.0.0.1';
	env.PORT = String(port);
	env.CLUSTER_WORKERS = value;
	env.CLUSTER_MODE = 'acceptor';
	const proc = spawn(process.execPath, [builtEntry], {
		cwd: fixtureDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env
	});
	child = proc;
	return proc;
}

function refusalOf(value) {
	const proc = bootWorkers(value, 0);
	return new Promise((resolve) => {
		let output = '';
		proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
		proc.stderr.on('data', (chunk) => { output += chunk.toString(); });
		const deadline = setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch {}
			resolve({ code: null, output: output + '\n[test deadline reached]' });
		}, 20000);
		proc.on('exit', (code) => {
			clearTimeout(deadline);
			resolve({ code, output });
		});
	});
}

describeUWS('ADAPTER-ERR-CLUSTER-CONFIG-WORKERS', () => {
	beforeAll(() => {
		expect(buildFixtureOnce()).toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('refuses every value that does not denote a positive whole number, before any worker spawns', async () => {
		// 'abc', '0', and '-1' always refused; '2.5' and '3workers' are the
		// leading-numeric class parseInt used to absorb into a wrong fleet.
		for (const value of ['abc', '0', '-1', '2.5', '3workers']) {
			const { code, output } = await refusalOf(value);
			expect(code, `CLUSTER_WORKERS='${value}' must exit 1: ${output.slice(0, 400)}`).toBe(1);
			expect(output, `CLUSTER_WORKERS='${value}' must print the indexed line`)
				.toContain('[ADAPTER-ERR-CLUSTER-CONFIG-WORKERS]');
			// The refusal is pre-spawn: the primary never announced a fleet.
			expect(output).not.toContain('Primary thread starting');
		}
	}, 120000);

	it('boots the denoted fleet for a padded, signed, decimal spelling of a whole number', async () => {
		// ' +2.0 ' denotes exactly 2 - the same token PORT would accept - so
		// the refusal above cannot be an over-refusal of every unusual
		// spelling. One token carries all three accepted shapes at once.
		const proc = bootWorkers(' +2.0 ', await freePort());
		let output = '';
		const ready = await new Promise((resolve) => {
			const scan = (chunk) => {
				output += chunk.toString();
				if ((output.match(/Worker thread \d+ registered/g) || []).length >= 2
					&& output.includes('Acceptor listening')) resolve(true);
			};
			proc.stdout.on('data', scan);
			proc.stderr.on('data', scan);
			proc.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 30000);
		});
		expect(ready, `CLUSTER_WORKERS=' +2.0 ' must boot two workers to a listening acceptor.\n--- server output ---\n${output}`).toBe(true);
		// For this token parseInt agrees on 2; what the case pins is that the
		// spelling is not over-refused - it boots, and to the fleet it denotes.
		expect(output).toContain('Primary thread starting 2 workers');
		expect(output).not.toContain('[ADAPTER-ERR-CLUSTER-CONFIG-WORKERS]');
	}, 120000);

	it('an exponent spelling starts the fleet it denotes, not the one parseInt absorbs', async () => {
		// ' 1e1 ' denotes 10; parseInt reads 1. The announced fleet size is the
		// parse outcome, so the announcement alone discriminates the two - the
		// case does not wait out a ten-worker boot.
		const proc = bootWorkers(' 1e1 ', await freePort());
		let output = '';
		const announced = await new Promise((resolve) => {
			const scan = (chunk) => {
				output += chunk.toString();
				if (output.includes('Primary thread starting')) resolve(true);
			};
			proc.stdout.on('data', scan);
			proc.stderr.on('data', scan);
			proc.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 30000);
		});
		expect(announced, `CLUSTER_WORKERS=' 1e1 ' must announce a fleet.\n--- server output ---\n${output}`).toBe(true);
		expect(output).toContain('Primary thread starting 10 workers');
	}, 120000);
});
