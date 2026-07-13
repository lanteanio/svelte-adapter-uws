// DBOPS-02 regression: in acceptor cluster mode, an I/O worker must run its
// hooks.ws `init` hook (DB connectivity checks, pool warmup, migration validation)
// BEFORE the primary starts serving. The bug: the acceptor branch only posted
// getDescriptor() and the primary listened immediately, so acceptor I/O workers
// took traffic without ever running init - reuseport/compute workers await start()
// (which fires init) but acceptor I/O workers did not.
//
// This drives the REAL built runtime: it builds the fixture (whose adapter is a
// symlink to this repo, so the build embeds the current src) and spawns it in
// acceptor cluster mode with a fixture init hook that logs a marker only when
// ACCEPTOR_INIT_PROBE=1. Pre-fix the marker never appears (acceptor I/O workers
// skip init entirely); post-fix it appears once per I/O worker. Cross-thread stdout
// ordering is unreliable (worker output is buffered through the primary), so the
// assertion is marker PRESENCE, which is what is genuinely red-without-fix.
//
// Gated on a loadable uWS binding (as the other real-server suites are); skips on a
// runner without the binding so the default matrix stays green.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');

function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}

let built = false;
const canRun = bindingLoads();

const describeMaybe = canRun ? describe : describe.skip;

describeMaybe('DBOPS-02: acceptor workers run init before serving', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;

	beforeAll(() => {
		// Build the fixture once (build/ is gitignored, so CI has no prebuilt copy).
		// The adapter resolves through a symlink to this repo, so the build embeds
		// the current runtime source under test.
		try {
			execSync('npx vite build', { cwd: fixtureDir, stdio: 'pipe', timeout: 180000 });
			built = true;
		} catch {
			built = false;
		}
	}, 200000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('an acceptor-mode I/O worker fires its init hook (it did not before the fix)', async () => {
		expect(built, 'fixture build must succeed for this integration test').toBe(true);

		const marker = '__ACCEPTOR_INIT_RAN__';
		const port = 41800 + Math.floor((process.pid % 200)); // spread across parallel runners
		let out = '';

		const seen = await new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					CLUSTER_WORKERS: '2',
					CLUSTER_MODE: 'acceptor',
					HOST: '127.0.0.1',
					PORT: String(port),
					ACCEPTOR_INIT_PROBE: '1'
				}
			});
			const scan = (buf) => {
				out += buf.toString();
				// Resolve as soon as at least one I/O worker has run its init hook.
				if (out.includes(marker)) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(out.includes(marker)));
			// Overall bound: pre-fix the marker never appears, so time out and fail.
			setTimeout(() => resolve(out.includes(marker)), 15000);
		});

		expect(seen, `acceptor I/O worker never ran init.\n--- server output ---\n${out}`).toBe(true);
		// The primary only listens once a worker has registered, so a healthy boot
		// also reached the serving state - init ran as part of that startup, not after.
		expect(out).toContain('Acceptor listening');
	}, 30000);
});
