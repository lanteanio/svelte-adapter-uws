// The posture export under `workers`, against the BUILT runtime, over the real
// socket a consumer would connect to.
//
// WHY THIS EXISTS. The export is one filesystem path and the option is a
// build-time constant, so with `workers` configured every worker used to
// evaluate the same install: each unlinked the previous owner's socket and
// bound its own, so only the last to bind stayed reachable while the rest
// listened on orphaned inodes, and the first worker to shut down removed
// whichever socket was live at that moment. A consumer read one bind-order-
// chosen thread's posture and believed it was the server's - which is worse
// than reading none, because the export exists so an edge-defense daemon can
// act on it, and it would have acted on a quiet worker while a sibling was
// under siege.
//
// WHAT MAKES THESE CASES ABLE TO FAIL. `workers` on the line is the field no
// single worker can produce: it counts the threads the primary is summarizing,
// so reading 2 from a two-worker deployment says the socket is owned by the
// primary and both workers are reporting inward. The second case kills a
// worker and reconnects, which is the half that used to remove a live socket
// out from under a reader.
//
// A CHILD PROCESS, not startRealRuntime: this needs a real primary with real
// worker threads, and the harness boots a single-process runtime inside the
// vitest worker (where `parentPort` is vitest's).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { freePort } from './helpers/real-runtime.js';
import { POSTURE_EXPORT_PATH, variantOut } from './fixture/variants.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, variantOut('posture'), 'index.js');
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }
let hasUws = true;
try { require.resolve('uWebSockets.js'); } catch { hasUws = false; }
const describeReal = hasUws && WebSocket !== null ? describe : describe.skip;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Follow the export the way a daemon would: connect, read newline-delimited
 * JSON, keep every line. Retries the connect because the primary binds lazily,
 * on the first worker's first report.
 */
async function followExport(deadlineMs = 8000) {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		const socket = await new Promise((resolve) => {
			const s = connect(POSTURE_EXPORT_PATH);
			s.once('connect', () => resolve(s));
			s.once('error', () => resolve(null));
		});
		if (socket !== null) {
			/** @type {any[]} */
			const lines = [];
			let buffer = '';
			socket.on('data', (chunk) => {
				buffer += chunk.toString();
				let cut;
				while ((cut = buffer.indexOf('\n')) >= 0) {
					const raw = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 1);
					if (raw.length === 0) continue;
					try { lines.push(JSON.parse(raw)); } catch { /* not our line */ }
				}
			});
			return {
				lines,
				close() { try { socket.destroy(); } catch { /* already gone */ } },
				async waitFor(predicate, ms = 6000) {
					const until = Date.now() + ms;
					for (;;) {
						const hit = lines.find(predicate);
						if (hit) return hit;
						if (Date.now() >= until) return null;
						await sleep(50);
					}
				}
			};
		}
		if (Date.now() >= deadline) return null;
		await sleep(100);
	}
}

describeReal('the posture export describes the deployment, not one worker', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	const token = 'posture-drill-token';

	beforeAll(() => {
		expect(buildFixtureOnce('posture'), 'posture fixture failed to build').toBe(true);
	}, 400000);

	afterEach(async () => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
		// The primary unlinks on a graceful stop; a SIGKILL leaves the path, so
		// the next boot's own unlink-before-listen is what clears it. Give the
		// OS a moment to release the name either way.
		await sleep(150);
	});

	async function boot(totalWorkers) {
		const port = await freePort();
		let output = '';
		const env = {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			CLUSTER_WORKERS: String(totalWorkers),
			CLUSTER_MODE: 'acceptor',
			WORKER_CRASH_DRILL_TOKEN: token
		};
		delete env.SSL_CERT;
		delete env.SSL_KEY;
		child = spawn(process.execPath, [builtEntry], {
			cwd: fixtureDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env
		});
		const ready = await new Promise((resolve) => {
			const scan = (chunk) => {
				output += chunk.toString();
				if (output.includes('Acceptor listening')) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 30_000);
		});
		expect(ready, `cluster did not listen\n${output}`).toBe(true);
		return { port, out: () => output };
	}

	/** One ws client, used to reach workers and to fire the crash drill. */
	async function client(port) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		/** @type {any[]} */
		const frames = [];
		ws.on('message', (data) => {
			try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
		});
		await new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		});
		return {
			frames,
			send(msg) { ws.send(JSON.stringify(msg)); },
			close() { try { ws.terminate(); } catch { /* already gone */ } }
		};
	}

	it('one socket carries every worker, and says how many it speaks for', async () => {
		const { out } = await boot(2);
		const follower = await followExport();
		expect(follower, 'nothing was listening on the export path').toBeTruthy();
		try {
			// Both workers report inward on their own 1 Hz sample, so the count
			// reaches 2 within a sample window. No single worker can produce
			// this field: it counts what the primary is summarizing.
			const both = await follower.waitFor((line) => line.workers === 2);
			expect(both, `the export never reported both workers: ${JSON.stringify(follower.lines.slice(0, 4))}`).toBeTruthy();
			expect(both.v).toBe(1);
			expect(both.posture, 'an idle fixture is in the normal posture').toBe('normal');

			// The steady cadence is the contract's liveness signal, so it has
			// to survive the move to the primary: silence must keep meaning
			// "gone" rather than "aggregating".
			const before = follower.lines.length;
			await sleep(2400);
			expect(follower.lines.length - before,
				'the 1 Hz cadence stopped once the primary owned the socket').toBeGreaterThanOrEqual(2);

			// And the deployment really is two threads, so `workers: 2` is a
			// fact about this run rather than a constant. Read off the
			// primary's own registrations rather than by trying to land ws
			// clients on distinct workers, which the kernel decides.
			const registered = new Set(
				[...out().matchAll(/Worker thread (\d+) registered/g)].map((m) => m[1])
			);
			expect(registered.size, `the fleet was not two workers: ${[...registered]}`).toBe(2);
		} finally {
			follower.close();
		}
	}, 120000);

	it('survives a worker exiting, which used to take the live socket with it', async () => {
		const { port, out } = await boot(2);
		const first = await followExport();
		expect(first, 'nothing was listening on the export path').toBeTruthy();
		expect(await first.waitFor((line) => line.workers === 2), 'both workers must report before the kill').toBeTruthy();
		first.close();

		const c = await client(port);
		c.send({ type: 'worker-crash-drill', token });
		c.close();
		// The armed line proves the drill was received; the worker then throws
		// off the request context and exits.
		for (let i = 0; i < 100 && !out().includes('__WORKER_CRASH_DRILL_ARMED__'); i++) await sleep(50);
		expect(out(), 'the crash drill never armed').toContain('__WORKER_CRASH_DRILL_ARMED__');
		await sleep(1200);

		// A FRESH connection, which is what a daemon does after its stream
		// ends. The path must still be there and still be served: it belongs to
		// the primary, and the primary did not exit.
		const second = await followExport();
		expect(second, 'the export path was gone after one worker exited').toBeTruthy();
		try {
			const line = await second.waitFor((l) => typeof l.workers === 'number');
			expect(line, 'the export went silent while the primary was still serving').toBeTruthy();
			expect(line.posture).toBe('normal');
			// The dead worker is retired rather than remembered - its count
			// drops out and comes back when its replacement reports.
			expect(line.workers).toBeGreaterThanOrEqual(1);
			expect(line.workers).toBeLessThanOrEqual(2);
		} finally {
			second.close();
		}
	}, 120000);
});
