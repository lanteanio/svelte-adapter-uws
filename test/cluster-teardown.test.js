// A cluster worker thread holds uWS's untracked libuv socket handles, so a bare
// process.exit() (or worker.terminate()) in a worker that still holds a uWS App
// aborts the WHOLE process ("uv_loop_close() while having open handles"). The fix
// (src/runtime/index.js exitWorkerClean) closes the App + lets one real loop turn
// run before exiting. This proves both halves via a real subprocess.
//
// Gated to Linux with a loadable uWS binding: reuseport (the crash's production
// context) is Linux-only, the abort only reproduces on Linux's worker teardown,
// and the binding needs glibc>=2.38. Skips elsewhere (Windows/mac/old-glibc),
// so the default dev + CI matrix stays green; run it on an ubuntu-24.04/trixie
// runner (or the Docker node:trixie-slim image) for real coverage.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const probe = fileURLToPath(new URL('./cluster-teardown-probe.mjs', import.meta.url));

function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}

/** Run the probe subprocess; return { ok, status, signal }. */
function run(mode) {
	try {
		execFileSync(process.execPath, [probe, mode], { stdio: 'pipe', timeout: 20000 });
		return { ok: true, status: 0, signal: null };
	} catch (err) {
		return { ok: false, status: err.status ?? null, signal: err.signal ?? null };
	}
}

const canRun = process.platform === 'linux' && bindingLoads();

describe.skipIf(!canRun)('cluster worker native teardown', () => {
	it('the clean discipline (app.close + one loop turn + exit) exits 0 with a live connection', () => {
		const r = run('clean');
		expect(r).toEqual({ ok: true, status: 0, signal: null });
	});

	it('control: a bare process.exit in a worker holding a uWS App aborts the process', () => {
		// The pre-fix behavior we are guarding against: the whole process dies
		// (non-zero status or a SIGABRT signal), never a clean 0.
		const r = run('bare');
		expect(r.ok).toBe(false);
	});
});
