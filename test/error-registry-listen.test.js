// ADAPTER-ERR-LISTEN, driven from the condition it claims.
//
// The entry used to promise one outcome - "exits with status 1" with no retry -
// and that is only what the single-process path does. The bind failure lives in
// three different failure loops: single-process exits 1; the acceptor primary
// hard-exits by SIGKILL because live workers preclude a clean exit; and a
// reuseport worker's bind failure exits only that worker, whose supervisor
// respawns it against the same address - a retry loop the old prose flatly
// denied, ending in the restart-limit outcome when the conflict persists.
//
// Real processes, real occupied port: the emission is followed by an exit, so
// the single-process and reuseport paths can only be driven in children.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { formatOperationalDiagnostic, listenFailureDiagnostic } from '../src/runtime/utils/operational-diagnostic.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');
const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.LISTEN);

function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}

/** Hold a port open so every bind against it fails. */
function occupyPort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, release: () => srv.close() }));
		srv.on('error', reject);
	});
}

const describeMaybe = bindingLoads() ? describe : describe.skip;
// The reuseport respawn loop can only exist on Linux: the runtime itself
// refuses CLUSTER_MODE=reuseport elsewhere (ADAPTER-ERR-CLUSTER-CONFIG-
// REUSEPORT), so on Windows the branch under test is unreachable by the
// runtime's own gate and a run here would skip-pass while proving nothing.
const describeLinux = bindingLoads() && process.platform === 'linux' ? describe : describe.skip;

describe('ADAPTER-ERR-LISTEN emission fidelity', () => {
	it('composes the exact line the registry indexes, searchable prefix first', () => {
		// `composed` emission: an operator pastes the line they saw; it must
		// resolve to this entry. The registry's messagePrefix is the invariant
		// beginning; host and port follow at runtime.
		const line = formatOperationalDiagnostic(listenFailureDiagnostic('127.0.0.1', 4321));
		expect(line.startsWith(entry.messagePrefix)).toBe(true);
		expect(line).toContain('127.0.0.1:4321');
		// The emitted record carries the registry's own recovery and action
		// sentences, so the prose corrected here is also what operators see.
		expect(line).toContain('[ADAPTER-ERR-LISTEN]');
	});

	it('keeps the prose bound to the three outcomes the code delivers', () => {
		// The failure loop differs per mode, and the old sentences promised the
		// single-process outcome for all three - "exits with status 1", "does
		// not retry" - which under the usual cause (a port conflict) is wrong
		// twice: the acceptor primary SIGKILLs itself, and reuseport RETRIES.
		expect(entry.consequence).not.toMatch(/^The process never becomes ready and exits with status 1\.$/);
		expect(entry.consequence).toMatch(/status 1/);
		expect(entry.consequence).toMatch(/SIGKILL/);
		expect(entry.automaticRecovery).not.toMatch(/does not retry/);
		expect(entry.automaticRecovery).toMatch(/respawns the failed worker/);
		expect(entry.automaticRecovery).toContain('ADAPTER-ERR-WORKER-RESTART-LIMIT');
		// The cross-referenced entry must own the outcome being handed off to.
		const limit = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.WORKER_RESTART_LIMIT);
		expect(limit.consequence).toMatch(/primary exits/i);
	});
});

describeMaybe('ADAPTER-ERR-LISTEN against a genuinely occupied port', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	/** @type {{ port: number, release: () => void } | null} */
	let held = null;
	let built = false;

	beforeAll(() => {
		built = buildFixtureOnce();
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
		held?.release();
		held = null;
	});

	/** Boot the built runtime against the held port and collect output. */
	function boot(env, until, timeoutMs) {
		let out = '';
		return new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, HOST: '127.0.0.1', PORT: String(held.port), ...env }
			});
			const scan = (buf) => {
				out += buf.toString();
				if (until(out)) resolve({ out, code: null, signal: null, exited: false });
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', (code, signal) => resolve({ out, code, signal, exited: true }));
			setTimeout(() => resolve({ out, code: null, signal: null, exited: false }), timeoutMs);
		});
	}

	it('single-process: emits the indexed line and exits with status 1', async () => {
		expect(built, 'fixture build must succeed').toBe(true);
		held = await occupyPort();
		const { out, code } = await boot({}, () => false, 20000);
		expect(out, 'the composed diagnostic line must reach the console').toContain(entry.messagePrefix);
		expect(out).toContain(`${held.port}`);
		// The one mode where "exits with status 1" is the whole truth.
		expect(code).toBe(1);
	}, 30000);

	it('acceptor: the primary emits the indexed line and dies without ever serving', async () => {
		expect(built, 'fixture build must succeed').toBe(true);
		held = await occupyPort();
		// The acceptor binds only after a worker has registered, so at the
		// moment of failure live workers preclude a clean exit and the primary
		// takes itself down hard. What is assertable across platforms: the
		// indexed diagnostic reaches the console, the serving line never
		// appears, and the process dies unsuccessfully rather than exiting 0.
		const sawLine = (s) => s.includes(entry.messagePrefix);
		const { out, code, signal, exited } = await boot(
			{ CLUSTER_WORKERS: '2', CLUSTER_MODE: 'acceptor' },
			() => false,
			25000
		);
		expect(sawLine(out), `expected the indexed diagnostic.\n--- output ---\n${out}`).toBe(true);
		expect(out).not.toContain('Acceptor listening');
		expect(exited, 'the primary must die rather than idle').toBe(true);
		if (process.platform === 'win32') {
			// Windows emulates signal death as a non-zero exit code.
			expect(code).not.toBe(0);
			expect(code).not.toBe(null);
		} else {
			// The entry's own claim, verbatim: with live workers the primary is
			// delivered as a self-SIGKILL rather than an exit status.
			expect(signal).toBe('SIGKILL');
		}
	}, 40000);
});

describeLinux('ADAPTER-ERR-LISTEN reuseport respawn loop', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	/** @type {{ port: number, release: () => void } | null} */
	let held = null;
	let built = false;

	beforeAll(() => {
		built = buildFixtureOnce();
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
		held?.release();
		held = null;
	});

	it('retries the same bind through the supervisor, which is the recovery the entry now describes', async () => {
		expect(built, 'fixture build must succeed').toBe(true);
		held = await occupyPort();
		// Two respawn lines prove the LOOP - one exit could still be the old
		// no-retry story. The budget is 50 attempts with exponential backoff,
		// so the case watches the loop begin and leaves exhaustion to the
		// supervisor's own driven cases.
		const sawLoop = (s) => (s.match(/restarting in \d+ms/g) || []).length >= 2;
		let out = '';
		await new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					HOST: '127.0.0.1',
					PORT: String(held.port),
					CLUSTER_WORKERS: '2',
					CLUSTER_MODE: 'reuseport'
				}
			});
			const scan = (buf) => {
				out += buf.toString();
				if (sawLoop(out)) resolve();
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve());
			setTimeout(resolve, 30000);
		});
		expect(out, 'the bind failure must surface through the indexed diagnostic').toContain(entry.messagePrefix);
		expect(sawLoop(out), `expected repeated respawns against the occupied port.\n--- output ---\n${out}`).toBe(true);
	}, 45000);
});
