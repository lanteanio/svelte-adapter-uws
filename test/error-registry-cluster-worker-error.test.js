// ADAPTER-ERR-CLUSTER-WORKER-ERROR, driven from the condition it claims.
//
// The entry's cause is a worker thread emitting an error event to the
// primary - it threw outside a request or failed during startup - and its
// recovery prose has two halves: the supervisor replaces the exiting worker
// per incident, and the replacement loop is bounded by the slot's restart
// budget. A real clustered runtime is the only place a worker thread's
// uncaught exception exists, so the case boots the built worker-crash
// fixture variant, crashes one worker through an authenticated frame on a
// real socket, and reads the primary's own console: the emitted event, the
// charged restart attempt against the budget, and the replacement worker
// registering. The workers are threads inside the one child process, so
// killing the child leaves nothing behind.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { hasUWS, EVAL_TIME_ENV, freePort, REAL_BOOT_BUDGET_MS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';

const describeUWS = hasUWS ? describe : describe.skip;

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, variantOut('workercrash'), 'index.js');

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;

describeUWS('ADAPTER-ERR-CLUSTER-WORKER-ERROR', () => {
	beforeAll(() => {
		expect(buildFixtureOnce('workercrash')).toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('reports the crashed worker, charges its slot against the restart budget, and replaces it', async () => {
		const port = await freePort();
		const token = randomUUID();
		const env = { ...process.env };
		for (const key of EVAL_TIME_ENV) delete env[key];
		env.HOST = '127.0.0.1';
		env.PORT = String(port);
		env.CLUSTER_WORKERS = '2';
		env.CLUSTER_MODE = 'acceptor';
		env.WORKER_CRASH_DRILL_TOKEN = token;

		const proc = spawn(process.execPath, [builtEntry], {
			cwd: fixtureDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env
		});
		child = proc;

		let output = '';
		/**
		 * Resolve once `predicate(output)` holds; on the deadline or child exit
		 * it THROWS a named error rather than returning false. The name matters:
		 * when this case failed one full run and passed the next, the loss was
		 * not knowing WHICH of four sequential waits starved, because the case
		 * budget fired before any wait's own deadline and vitest reported its
		 * generic timeout. Each wait carries its own budget below - all equal to
		 * the real-boot budget, since an output scan starves under machine load
		 * the same way a boot does - and the case budget is set above their sum
		 * so a starving wait always trips its OWN named deadline first. A failed
		 * wait names itself at the HEAD of the message, ahead of the output tail,
		 * so runner truncation cannot eat the identity.
		 *
		 * Listeners detach on settle so a later wait never double-appends a
		 * chunk; between waits the paused pipes buffer, nothing is lost.
		 */
		const waitFor = (name, predicate, ms = REAL_BOOT_BUDGET_MS) => new Promise((resolve, reject) => {
			if (predicate(output)) return resolve();
			const settle = (fn) => {
				clearTimeout(timer);
				proc.stdout.off('data', scan);
				proc.stderr.off('data', scan);
				proc.off('exit', onExit);
				fn();
			};
			const fail = (why) => settle(() => reject(new Error(
				`cluster-worker-error wait "${name}" ${why} after ${ms} ms.\n` +
				`--- last 4000 chars of server output ---\n${output.slice(-4000)}`
			)));
			const timer = setTimeout(() => fail('timed out'), ms);
			const scan = (chunk) => {
				output += chunk.toString();
				if (predicate(output)) settle(resolve);
			};
			const onExit = () => fail('saw the child exit');
			proc.stdout.on('data', scan);
			proc.stderr.on('data', scan);
			proc.on('exit', onExit);
		});

		const registrations = (text) => (text.match(/Worker thread \d+ registered/g) || []).length;

		await waitFor('boot',
			(text) => registrations(text) >= 2 && text.includes('Acceptor listening'));

		// Crash one worker through the real wire: the hook schedules the throw
		// off the request context, so the worker's uncaught exception surfaces
		// as the primary's worker 'error' event.
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		ws.send(JSON.stringify({ type: 'worker-crash-drill', token }));
		await waitFor('drill-armed', (text) => text.includes('__WORKER_CRASH_DRILL_ARMED__'));
		try { ws.close(); } catch {}

		// The entry's event, with the primary still alive to print it.
		await waitFor('error-reported', (text) => text.includes('event=cluster.worker-error'));
		expect(output).toContain('A worker thread reported an error.');

		// Recovery, both halves the entry describes: the exit is charged
		// against the slot's bounded budget, and a replacement registers -
		// a third registration beyond the two boot ones.
		await waitFor('replaced', (text) => text.includes('/50)') && registrations(text) >= 3);
		expect(output).toMatch(/exited with code 1, restarting in \d+ms\.\.\. \(attempt 1\/50\)/);
		// Four waits at the real-boot budget sum to that budget times four; the
		// case budget clears it by a wide margin plus spawn and handshake time,
		// so the structural failure (the case timer firing before a wait's own)
		// cannot recur.
	}, REAL_BOOT_BUDGET_MS * 4 + 60000);
});
