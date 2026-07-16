// Acceptor-init regression: in acceptor cluster mode, an I/O worker must run its
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';

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

describeMaybe('acceptor cluster mode: io workers run init before serving', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;

	beforeAll(() => {
		// Build the fixture (build/ is gitignored, so CI has no prebuilt copy).
		// The adapter resolves through a symlink to this repo, so the build embeds
		// the current runtime source under test. Serialized + reused across the
		// suites that boot the built fixture (the TLS hot-reload suite builds the
		// same directory).
		built = buildFixtureOnce();
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('an acceptor-mode I/O worker fires its init hook (it did not before the fix)', async () => {
		expect(built, 'fixture build must succeed for this integration test').toBe(true);

		const marker = '__ACCEPTOR_INIT_RAN__';
		let out = '';
		// Both signals must appear: the init marker (an I/O worker ran init) AND the
		// primary reaching the serving state. Cross-thread stdout ordering is
		// unreliable (worker output buffers through the primary), so wait for both
		// rather than race them on the first-seen line.
		const ready = (s) => s.includes(marker) && s.includes('Acceptor listening');

		const ok = await new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					CLUSTER_WORKERS: '2',
					CLUSTER_MODE: 'acceptor',
					HOST: '127.0.0.1',
					// PORT=0 binds an ephemeral port - the test never connects a client
					// (it only watches stdout), so this avoids any parallel-runner
					// port collision.
					PORT: '0',
					ACCEPTOR_INIT_PROBE: '1'
				}
			});
			const scan = (buf) => {
				out += buf.toString();
				if (ready(out)) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(ready(out)));
			// Pre-fix the marker never appears, so time out and fail with the output.
			setTimeout(() => resolve(ready(out)), 15000);
		});

		expect(ok, `acceptor I/O worker did not run init before the server began serving.\n--- server output ---\n${out}`).toBe(true);
	}, 30000);
});
