// ADAPTER-ERR-SHUTDOWN-FAILED, driven from the condition it claims against
// the built runtime as a real child process.
//
// Every application-supplied input to the graceful sequence is contained
// behind its own entry - a throwing ws shutdown hook (WS-SHUTDOWN-HOOK-THREW),
// a rejecting or throwing `sveltekit:shutdown` listener
// (SHUTDOWN-LISTENER-REJECTED / -THREW), a wedged one (-UNSETTLED), an
// overrunning drain (SHUTDOWN-REQUESTS-DROPPED) - so this entry is the last
// resort for the sequence's OWN machinery throwing. The realistic way an
// application reaches it is a broken global: instrumentation layers rewrap
// process and EventEmitter internals routinely, and a patch that throws when
// the cleanup step reads the listener list is exactly "the graceful shutdown
// sequence itself threw". The hookcrash fixture installs that patch behind an
// env-gated drill header and dispatches SIGTERM through the real handler.
//
// The entry's consequence has two halves and both are asserted: the orderly
// steps after the throw were skipped (the shutdown reports itself NOT clean),
// and the process STILL EXITS rather than hanging - which is the half that
// matters at 3am, and the half a case that only greps for the line would
// leave unproved.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, variantOut('hookcrash'), 'index.js');
const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.SHUTDOWN_FAILED);

function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}

/** An unused loopback port, released for the child to take (freePort's shape). */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

const describeMaybe = bindingLoads() ? describe : describe.skip;

describeMaybe('ADAPTER-ERR-SHUTDOWN-FAILED against the built runtime', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	let built = false;
	const token = randomUUID();

	beforeAll(() => {
		built = buildFixtureOnce('hookcrash');
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('a throw inside the sequence prints the indexed line and the process still exits', async () => {
		expect(built, 'fixture build must succeed').toBe(true);

		const port = await freePort();
		let out = '';
		let served = false;
		await new Promise((resolve, reject) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), HOOK_CRASH_DRILL_TOKEN: token }
			});
			const bootTimer = setTimeout(() => reject(new Error('never started serving:\n' + out)), 25000);
			const scan = (buf) => {
				out += buf.toString();
				if (out.includes('Listening on ')) { served = true; clearTimeout(bootTimer); resolve(undefined); }
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => { if (!served) { clearTimeout(bootTimer); reject(new Error('exited before serving:\n' + out)); } });
		});

		// The drill: a 200 first (the route answered before draining began), then
		// the sequence crashes on its own machinery.
		const res = await fetch(`http://127.0.0.1:${port}/__realtime/status`, {
			headers: { 'x-shutdown-sequence-crash': token }
		});
		expect(res.status).toBe(200);

		const exited = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), 20000);
			child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
		});

		// The emission: the console entry's exact documented prefix, with the
		// injected error attached so `nextAction`'s "read the attached error"
		// has something to read.
		expect(out, 'the indexed line must reach the console').toContain(entry.messagePrefix);
		expect(out).toContain('__SHUTDOWN_SEQUENCE_CRASH__');

		// The consequence, both halves: not clean, and an exit rather than a
		// hang. The exit code is 0 - the process exits CLEANLY in the process
		// sense while reporting the shutdown was not - which is the documented
		// "still exits rather than hanging". (The NOT-clean line is the last
		// thing the child writes before process.exit; if this assertion ever
		// flakes with the indexed line present, suspect pipe-write truncation
		// at exit rather than the sequence.)
		expect(out).toContain('was NOT clean');
		expect(exited, 'the process must exit rather than hang').not.toBeNull();
		expect(exited.code).toBe(0);
	}, 60000);
});
