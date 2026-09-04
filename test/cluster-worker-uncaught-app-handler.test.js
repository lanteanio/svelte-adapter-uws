// An application that handles its own uncaught exceptions keeps its worker.
//
// WHY THIS EXISTS. The runtime installs a worker-side `uncaughtException`
// handler so a crashing worker closes its uWS App before the thread dies -
// without it the loop is closed with poll handles still open and Node aborts
// the whole process, which costs the deployment rather than one worker.
//
// But installing that handler changes what Node does. Node kills a worker on an
// uncaught exception only when NOTHING is listening; an application that
// listens has taken responsibility and its worker survives. A runtime handler
// that exited unconditionally would take that away silently - the application
// would keep its handler, keep logging its recovery, and lose its worker
// anyway. So the runtime defers whenever it is not the only listener, and this
// is the case that holds it to that.
//
// It cannot pin the abort itself: that is a race between uv's close callbacks
// and the thread teardown, and on an idle machine the drill exits cleanly with
// or without the fix. What it pins is the DEFERENCE, which is deterministic and
// is the half a future simplification would drop.

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

describeUWS('a worker whose application handles uncaught exceptions is not exited', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;

	beforeAll(() => {
		expect(buildFixtureOnce('workercrash'), 'workercrash fixture failed to build').toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('the application handler runs and the worker is neither reported nor replaced', async () => {
		const port = await freePort();
		const token = randomUUID();
		const env = { ...process.env };
		for (const key of EVAL_TIME_ENV) delete env[key];
		env.HOST = '127.0.0.1';
		env.PORT = String(port);
		env.CLUSTER_WORKERS = '2';
		env.CLUSTER_MODE = 'acceptor';
		env.WORKER_CRASH_DRILL_TOKEN = token;
		env.WORKER_CRASH_APP_HANDLER = '1';

		const proc = spawn(process.execPath, [builtEntry], {
			cwd: fixtureDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env
		});
		child = proc;

		// ONE persistent accumulator, deliberately, and this is not a detail:
		// the sibling drill's helper attaches its scan per wait and detaches it
		// on settle, which is right when every assertion is a wait. Here the
		// assertions come AFTER the last wait, and the lines that would prove a
		// failure - a worker-error report, a replacement registering - arrive in
		// that window. Detaching would leave the assertions reading a buffer
		// frozen at the last thing they waited for, and they would pass because
		// they could not see the evidence against them.
		let output = '';
		const collect = (chunk) => { output += chunk.toString(); };
		proc.stdout.on('data', collect);
		proc.stderr.on('data', collect);

		const waitFor = async (name, predicate, ms = REAL_BOOT_BUDGET_MS) => {
			const deadline = Date.now() + ms;
			for (;;) {
				if (predicate(output)) return;
				if (proc.exitCode !== null) {
					throw new Error(`uncaught-app-handler wait "${name}" saw the child exit\n` +
						`--- last 4000 chars of server output ---\n${output.slice(-4000)}`);
				}
				if (Date.now() >= deadline) {
					throw new Error(`uncaught-app-handler wait "${name}" timed out after ${ms} ms.\n` +
						`--- last 4000 chars of server output ---\n${output.slice(-4000)}`);
				}
				await new Promise((r) => setTimeout(r, 25));
			}
		};

		const registrations = (text) => (text.match(/Worker thread \d+ registered/g) || []).length;

		await waitFor('boot', (text) => registrations(text) >= 2 && text.includes('Acceptor listening'));
		const registeredAtBoot = registrations(output);

		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		ws.send(JSON.stringify({ type: 'worker-crash-drill', token }));
		await waitFor('drill-armed', (text) => text.includes('__WORKER_CRASH_DRILL_ARMED__'));
		await waitFor('app-handled', (text) => text.includes('__APP_HANDLED_UNCAUGHT__'));
		try { ws.close(); } catch { /* already closing */ }

		// Long enough that a worker exit would have been noticed and replaced -
		// the drill's own case sees the replacement register well inside this.
		await new Promise((r) => setTimeout(r, 3000));

		expect(proc.exitCode, 'the process died').toBe(null);
		expect(output, 'the runtime exited a worker its application had recovered')
			.not.toContain('cluster.worker-error');
		expect(registrations(output), 'a replacement worker registered, so the worker was exited after all')
			.toBe(registeredAtBoot);
	}, 120000);
});
