// Readiness, draining and the shutdown budget, driven against the REAL runtime.
//
// The three states this file separates are the whole point of it: LIVE (the
// process is up), READY (a load balancer may route here) and ACCEPTING (the
// listen socket takes connections) are independent, and every defect these
// cases lock down came from two of them being answered by one flag - readiness
// green while `init` was still running, readiness green through the whole
// load-balancer drain delay, the shutdown timeout bounding only the phase the
// adapter controls.
//
// HOW EACH BLOCK IS DRIVEN, and why:
//   - the certificate-reload alert is pure, so it is driven directly;
//   - the lifecycle states are read off the BUILT runtime's own lifecycle
//     module while its routes answer over a real socket, so the state and what
//     a probe actually sees are asserted together;
//   - the shutdown sequence lives in the server entry (src/runtime/index.js),
//     which only runs as a process, so those cases spawn the built server and
//     drive it the way an orchestrator does.
//
// The spawned server is started through a small wrapper module: Windows does
// not deliver SIGTERM to a Node child (the runtime maps it onto an immediate
// TerminateProcess), so on that platform the wrapper re-emits the event on the
// child's own process object from a line on stdin. Everything downstream of
// that - the signal handler, the drain, the budget, the exit - is production
// code either way, and on POSIX the real signal is used.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { EVAL_TIME_ENV } from './helpers/real-runtime.js';
import { certExpiryAlert, readCertIdentity } from '../src/runtime/utils/tls-reload.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = join(fixtureDir, 'build', 'index.js');

function bindingLoads() {
	try {
		createRequire(import.meta.url).resolve('uWebSockets.js');
		return true;
	} catch {
		return false;
	}
}
const describeUWS = bindingLoads() ? describe : describe.skip;

function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter(Boolean));
		for (const root of roots) {
			candidates.push(join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
		}
	}
	for (const bin of candidates) {
		try {
			execFileSync(bin, ['version'], { stdio: 'ignore' });
			return bin;
		} catch {}
	}
	return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

/**
 * One fresh HTTP GET - `agent: false`, so every probe is its OWN connection.
 * A keep-alive reuse would be answered by a socket accepted before the state
 * under test changed, which is exactly the false negative these cases exist to
 * catch.
 */
function httpGet(port, pathName) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: '127.0.0.1', port, path: pathName, method: 'GET', agent: false }, (res) => {
			let body = '';
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

describe('certificate reload alert', () => {
	const notAfter = 1800000000000;
	const day = 86400000;

	it('says nothing while the reload path is healthy, however close expiry is', () => {
		// The served certificate expiring is not by itself a problem: renewal
		// picks it up. Only a renewal path that CANNOT pick it up is.
		expect(certExpiryAlert({ degraded: null, notAfter, notAfterText: 'Jan 1 2027 GMT' }, notAfter - day)).toBeNull();
	});

	it('says nothing while degraded but expiry is still far away', () => {
		expect(certExpiryAlert({ degraded: 'watch failed', notAfter, notAfterText: 'x' }, notAfter - 60 * day)).toBeNull();
	});

	it('names the reason, the expiry and the remaining validity once degraded and inside the window', () => {
		const line = certExpiryAlert(
			{ degraded: 'the certificate directory watch failed to start', notAfter, notAfterText: 'Jan  1 00:00:00 2027 GMT' },
			notAfter - (6 * day + 4 * 3600000)
		);
		expect(line).toContain('DEGRADED');
		expect(line).toContain('the certificate directory watch failed to start');
		expect(line).toContain('Jan  1 00:00:00 2027 GMT');
		expect(line).toContain('6d 4h left');
	});

	it('reports an already-expired certificate rather than a negative duration', () => {
		const line = certExpiryAlert({ degraded: 'swap failed mid-apply', notAfter, notAfterText: 'past' }, notAfter + day);
		expect(line).toContain('ALREADY EXPIRED');
	});

	it('stays silent when the expiry could not be parsed, instead of guessing', () => {
		expect(certExpiryAlert({ degraded: 'watch failed', notAfter: null, notAfterText: null }, notAfter)).toBeNull();
	});
});

const openssl = findOpenssl();
(openssl ? describe : describe.skip)('certificate identity carries the leaf expiry', () => {
	it('reads notAfter from a real certificate, in both the epoch and the printed form', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lifecycle-cert-'));
		const key = join(dir, 'leaf.key');
		const crt = join(dir, 'leaf.crt');
		execFileSync(openssl, [
			'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3', '-nodes',
			'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
		], { stdio: 'ignore' });

		const identity = readCertIdentity(crt);
		expect(typeof identity.notAfter).toBe('number');
		expect(identity.notAfterText).toBeTruthy();
		// Three days out, generously bracketed - this asserts the value is the
		// certificate's own expiry rather than any other date on it.
		const remaining = identity.notAfter - Date.now();
		expect(remaining).toBeGreaterThan(2 * 86400000);
		expect(remaining).toBeLessThan(4 * 86400000);
	});
});

describeUWS('lifecycle states of the built runtime', () => {
	/** @type {any} */
	let handler;
	/** @type {any} */
	let lifecycle;
	/** @type {any} */
	let counters;
	let port;
	/** @type {Array<[string, string | undefined]>} */
	let envBefore = [];

	beforeAll(async () => {
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		// The runtime reads these at module eval and process.env is shared across
		// the test files in a worker, so a value left by another suite would
		// silently boot a different server than this one describes.
		envBefore = EVAL_TIME_ENV.map((key) => [key, process.env[key]]);
		for (const key of EVAL_TIME_ENV) delete process.env[key];

		port = await freePort();
		// handler.js registers the routes at module eval; lifecycle.js is the same
		// instance that module loaded, so the states read here are the ones the
		// readiness route consults.
		handler = await import(pathToFileURL(join(fixtureDir, 'build', 'handler.js')).href);
		lifecycle = await import(pathToFileURL(join(fixtureDir, 'build', 'handler', 'lifecycle.js')).href);
		({ counters } = await import(pathToFileURL(join(fixtureDir, 'build', 'handler', 'state.js')).href));
	}, 400000);

	afterAll(async () => {
		try { await handler?.shutdown(); } catch { /* already down */ }
		try { handler?.forceCloseApp(); } catch { /* already closed */ }
		for (const [key, value] of envBefore) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('walks starting -> ready -> draining -> closed, and readiness follows it while liveness and accepting do not', async () => {
		// STARTING. Nothing has been bound yet, and readiness must already be
		// closed: the socket is bound before `init` runs (so the kernel queues
		// connections instead of refusing them), which is precisely the window in
		// which a balancer must not be told this instance is ready.
		expect(lifecycle.lifecycleState()).toBe('starting');
		expect(lifecycle.isDraining()).toBe(true);
		// The readiness flag on the shared counters is a MIRROR of the state, and
		// it is asserted at every transition below: a diagnostics surface reading
		// it and a load balancer reading /readyz must never get different answers
		// about whether this instance is taking traffic - least of all during
		// startup, which is the window where the two used to disagree.
		expect(counters.draining).toBe(true);

		const starting = handler.start('127.0.0.1', port);
		expect(lifecycle.lifecycleState()).toBe('starting');
		await starting;

		// READY only once start() resolved, i.e. once the app's init hook committed.
		expect(lifecycle.lifecycleState()).toBe('ready');
		expect(lifecycle.isDraining()).toBe(false);
		expect(counters.draining).toBe(false);
		const ready = await httpGet(port, '/readyz');
		expect(ready.status).toBe(200);
		expect(ready.body).toBe('ready');

		// DRAINING. Readiness closes, liveness does not (a readiness 503 must never
		// trip a liveness probe into restarting a pod that is shutting down on
		// purpose), and the server keeps ACCEPTING - the drain delay is worthless
		// otherwise, because the requests the balancer has not stopped sending yet
		// would meet a closed socket.
		expect(lifecycle.beginDrain()).toBe(true);
		expect(lifecycle.lifecycleState()).toBe('draining');
		expect(counters.draining).toBe(true);
		const draining = await httpGet(port, '/readyz');
		expect(draining.status).toBe(503);
		expect(draining.body).toBe('draining');
		const live = await httpGet(port, '/healthz');
		expect(live.status).toBe(200);
		expect(live.body).toBe('OK');

		// Idempotent: a second call (the signal handler and shutdown() both do it)
		// reports that draining had already begun rather than logging twice.
		expect(lifecycle.beginDrain()).toBe(false);

		// CLOSED: the listen socket is gone, so the port stops answering.
		await handler.shutdown();
		expect(lifecycle.lifecycleState()).toBe('closed');
		expect(counters.draining).toBe(true);
		await expect(httpGet(port, '/healthz')).rejects.toThrow();
	}, 60000);

	it('reports the certificate-reload path as a readable state rather than only as log lines', () => {
		// This server is plain HTTP, so nothing is watched and nothing is broken -
		// which is exactly the shape an operator has to be able to tell apart from
		// "the watcher died and renewals stopped landing".
		const state = lifecycle.tlsReloadState();
		expect(state).toMatchObject({ watching: false, degraded: null, generation: 0, failures: 0 });
		expect(state.notAfter).toBeNull();
		// A snapshot, not the live record: a caller cannot edit the runtime's state.
		state.degraded = 'tampered';
		expect(lifecycle.tlsReloadState().degraded).toBeNull();
	});
});

describeUWS('the app shutdown hook under the shutdown budget', () => {
	// The hook belongs to the APP, so exercising it needs an app that has one -
	// and the shipped fixture deliberately has none. Rather than assert against a
	// stand-in for shutdown(), each case takes a private COPY of the built runtime
	// and swaps only the one generated module the build writes the app's ws
	// handler into. Everything the assertions then run through - the race, the
	// budget, the ordering, the state transitions - is the production module.
	//
	// The copy needs its own `node_modules` because the runtime imports
	// uWebSockets.js by name and Node resolves that by walking up from the
	// importing file; a link back to the repo's is enough and costs nothing.
	const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
	/** @type {any[]} */
	const copies = [];
	let copyRoot;
	/** @type {Array<[string, string | undefined]>} */
	let envBefore = [];

	beforeAll(() => {
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		envBefore = EVAL_TIME_ENV.map((key) => [key, process.env[key]]);
		for (const key of EVAL_TIME_ENV) delete process.env[key];
		copyRoot = mkdtempSync(join(tmpdir(), 'lifecycle-wshook-'));
	}, 400000);

	afterAll(() => {
		for (const copy of copies) {
			try { copy.forceCloseApp(); } catch { /* never opened */ }
		}
		for (const [key, value] of envBefore) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	/**
	 * A private copy of the built runtime whose app ws-handler is `source`.
	 * `probeKey` is the global the injected hook reports through - one per copy,
	 * because every copy runs in this same process.
	 */
	async function runtimeWithWsHook(name, probeKey, source) {
		const out = join(copyRoot, name);
		cpSync(join(fixtureDir, 'build'), out, { recursive: true });
		symlinkSync(repoNodeModules, join(out, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		writeFileSync(join(out, 'server', 'ws-handler.js'), source.replace(/PROBE_KEY/g, JSON.stringify(probeKey)));
		const lifecycle = await import(pathToFileURL(join(out, 'handler', 'lifecycle.js')).href);
		copies.push(lifecycle);
		return lifecycle;
	}

	it('hands the hook the reason, the abort signal and the deadline, and awaits its async work', async () => {
		const probe = '__wsHookAwaited';
		const lifecycle = await runtimeWithWsHook('await', probe, [
			'export async function shutdown(ctx) {',
			'	globalThis[PROBE_KEY] = { ctx, finished: false };',
			'	await new Promise((r) => setTimeout(r, 150));',
			'	globalThis[PROBE_KEY].finished = true;',
			'}',
			''
		].join('\n'));

		const expiry = new AbortController();
		const deadline = Date.now() + 5000;
		const t0 = Date.now();
		await lifecycle.shutdown({ reason: 'SIGTERM', signal: expiry.signal, deadline });

		const probed = globalThis[probe];
		// The context an app writes its hook against. Without it a hook cannot tell
		// a rolling restart from a crash-loop kill, and cannot decide how much of
		// its flush it still has time for.
		expect(probed.ctx.reason).toBe('SIGTERM');
		expect(probed.ctx.deadline).toBe(deadline);
		expect(probed.ctx.signal.aborted).toBe(false);
		expect(typeof probed.ctx.platform.publish).toBe('function');
		// Awaited THROUGH the await inside it: the work an async hook does after
		// its first suspension point is the work that used to be thrown away.
		expect(probed.finished).toBe(true);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
		// And the close only happened after the hook, not around it.
		expect(lifecycle.lifecycleState()).toBe('closed');
	}, 120000);

	it('stops waiting on a hook that never settles once the budget is spent, and says which flush was cut off', async () => {
		const probe = '__wsHookWedged';
		const lifecycle = await runtimeWithWsHook('wedged', probe, [
			'export function shutdown(ctx) {',
			'	globalThis[PROBE_KEY] = { ctx };',
			'	return new Promise(() => {});',
			'}',
			''
		].join('\n'));

		const errors = [];
		const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
		try {
			const expiry = new AbortController();
			const timer = setTimeout(() => expiry.abort(), 200);
			const t0 = Date.now();
			await lifecycle.shutdown({ reason: 'SIGTERM', signal: expiry.signal, deadline: Date.now() + 200 });
			clearTimeout(timer);
			const elapsed = Date.now() - t0;
			// Bounded by the budget, not by the hook. A bare await here held the
			// listen socket open and the process alive until the supervisor's kill.
			expect(elapsed).toBeGreaterThanOrEqual(180);
			expect(elapsed).toBeLessThan(5000);
			expect(lifecycle.lifecycleState()).toBe('closed');
		} finally {
			spy.mockRestore();
		}
		// The mutation this catches is silent otherwise: the socket closes either
		// way, and only this line tells an operator that the app's flush did not.
		expect(errors.join('\n')).toContain('shutdown hook has not settled');
		expect(errors.join('\n')).toContain('did NOT finish');
	}, 120000);

	it('awaits the hook with no deadline at all when no budget is configured', async () => {
		const probe = '__wsHookUnbounded';
		const lifecycle = await runtimeWithWsHook('unbounded', probe, [
			'export async function shutdown(ctx) {',
			'	globalThis[PROBE_KEY] = { ctx, finished: false };',
			'	await new Promise((r) => setTimeout(r, 250));',
			'	globalThis[PROBE_KEY].finished = true;',
			'}',
			''
		].join('\n'));

		// No signal and no deadline is what SHUTDOWN_TIMEOUT=0 forwards. The hook
		// must then be awaited exactly as an unbounded await did, and must be able
		// to SEE that nothing will cut it off rather than guess from a number.
		const t0 = Date.now();
		await lifecycle.shutdown({ reason: 'SIGTERM' });
		expect(globalThis[probe].ctx.signal).toBeNull();
		expect(globalThis[probe].ctx.deadline).toBeNull();
		expect(globalThis[probe].finished).toBe(true);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
	}, 120000);
});

describeUWS('graceful shutdown of the built server', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	let dir;

	beforeAll(() => {
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		dir = mkdtempSync(join(tmpdir(), 'lifecycle-shutdown-'));
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	/**
	 * The entry the child actually runs: it installs the cleanup listener under
	 * test (the documented `sveltekit:shutdown` hook), then imports the built
	 * server. `PROBE_CLEANUP` picks which listener, `PROBE_MARKER` is where an
	 * async one records that it finished.
	 */
	function writeWrapper(name) {
		const file = join(dir, name);
		writeFileSync(file, [
			"import { appendFileSync } from 'node:fs';",
			"const marker = process.env.PROBE_MARKER;",
			"if (process.env.PROBE_CLEANUP === 'async') {",
			"	process.on('sveltekit:shutdown', async (reason) => {",
			"		await new Promise((r) => setTimeout(r, 300));",
			"		appendFileSync(marker, 'closed:' + reason);",
			"	});",
			"}",
			"if (process.env.PROBE_CLEANUP === 'hang') {",
			"	process.on('sveltekit:shutdown', () => new Promise(() => {}));",
			"}",
			"process.stdin.on('data', (d) => { if (String(d).includes('shutdown')) process.emit('SIGTERM'); });",
			"process.stdin.unref();",
			`await import(${JSON.stringify(pathToFileURL(builtEntry).href)});`,
			''
		].join('\n'));
		return file;
	}

	/** Boot the wrapper and resolve once the server reports it is listening. */
	async function startServer(entry, env) {
		const port = await freePort();
		const output = { text: '' };
		const proc = spawn(process.execPath, [entry], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: (() => {
				const merged = { ...process.env, HOST: '127.0.0.1', PORT: String(port), ...env };
				// Ambient knobs would silently change the topology and the timings
				// under test.
				for (const key of ['CLUSTER_WORKERS', 'CLUSTER_MODE', 'SSL_CERT', 'SSL_KEY', 'SHUTDOWN_DELAY_MS', 'SHUTDOWN_TIMEOUT']) {
					if (!(key in (env || {}))) delete merged[key];
				}
				return merged;
			})()
		});
		child = proc;
		const listening = await new Promise((resolve) => {
			const scan = (buf) => {
				output.text += buf.toString();
				if (output.text.includes('Listening on http://')) resolve(true);
			};
			proc.stdout.on('data', scan);
			proc.stderr.on('data', scan);
			proc.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 20000);
		});
		expect(listening, `server never reached listening.\n--- server output ---\n${output.text}`).toBe(true);
		return { proc, port, output };
	}

	/** Ask the server to shut down the way an orchestrator does. */
	function requestShutdown(proc) {
		if (process.platform === 'win32') proc.stdin.write('shutdown\n');
		else proc.kill('SIGTERM');
	}

	function whenExited(proc, ms) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), ms);
			proc.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
		});
	}

	it('reports NOT ready for the whole load-balancer drain delay while it keeps serving', async () => {
		const entry = writeWrapper('entry-delay.mjs');
		const { proc, port, output } = await startServer(entry, { SHUTDOWN_DELAY_MS: '2500' });

		expect((await httpGet(port, '/readyz')).status).toBe(200);

		requestShutdown(proc);
		// Well inside the 2500ms window: the signal handler has run, and the delay
		// it is waiting out has not.
		await sleep(400);

		// The point of the delay is to give the balancer time to deregister this
		// instance - which it can only do if readiness has ALREADY flipped.
		const readiness = await httpGet(port, '/readyz');
		expect(readiness.status, `readiness during the drain delay.\n--- server output ---\n${output.text}`).toBe(503);
		expect(readiness.body).toBe('draining');
		// Still LIVE and still ACCEPTING: a fresh connection is answered. If the
		// socket closed here, the delay would be dropping the very traffic it
		// exists to protect.
		const live = await httpGet(port, '/healthz');
		expect(live.status).toBe(200);

		expect(await whenExited(proc, 20000)).toBe(0);
	}, 60000);

	it('awaits an async sveltekit:shutdown listener instead of exiting out from under it', async () => {
		const marker = join(dir, 'cleanup-marker.txt');
		const entry = writeWrapper('entry-cleanup.mjs');
		const { proc } = await startServer(entry, { PROBE_CLEANUP: 'async', PROBE_MARKER: marker });

		requestShutdown(proc);
		expect(await whenExited(proc, 20000)).toBe(0);

		// The documented cleanup shape (`async (reason) => { await db.close(); }`).
		// Its work lands after an await, which is exactly what a synchronous emit
		// followed by process.exit() used to throw away - silently, with the final
		// writes gone and nothing in the log.
		expect(existsSync(marker), 'the async cleanup listener never finished before exit').toBe(true);
		expect(readFileSync(marker, 'utf8')).toBe('closed:SIGTERM');
	}, 60000);

	it('treats SHUTDOWN_TIMEOUT=0 as NO budget and still awaits the cleanup listener', async () => {
		const marker = join(dir, 'nobudget-marker.txt');
		const entry = writeWrapper('entry-nobudget.mjs');
		const { proc, output } = await startServer(entry, {
			PROBE_CLEANUP: 'async', PROBE_MARKER: marker, SHUTDOWN_TIMEOUT: '0'
		});

		requestShutdown(proc);
		expect(await whenExited(proc, 20000)).toBe(0);

		// 0 is the only spelling for "never cut my cleanup off". Read as a budget
		// of zero milliseconds instead, it aborts on the first macrotask and every
		// flush an app performs on the way out is lost - the exact data loss the
		// budget was added to prevent, reintroduced at the boundary value.
		expect(existsSync(marker), `the cleanup listener was cut off by SHUTDOWN_TIMEOUT=0.\n--- server output ---\n${output.text}`).toBe(true);
		expect(readFileSync(marker, 'utf8')).toBe('closed:SIGTERM');
		expect(output.text).not.toContain('did not settle');
		expect(output.text).toContain('Shutdown complete');
		// And it is announced, because an unbounded shutdown is a real trade: the
		// operator who typed 0 should see that nothing will stop a wedged hook.
		expect(output.text).toContain('no shutdown budget');
	}, 60000);

	it('cannot be held past the shutdown budget by a cleanup listener that never settles', async () => {
		const entry = writeWrapper('entry-hang.mjs');
		const { proc, output } = await startServer(entry, { PROBE_CLEANUP: 'hang', SHUTDOWN_TIMEOUT: '2' });

		const t0 = Date.now();
		requestShutdown(proc);
		const code = await whenExited(proc, 25000);
		const elapsed = Date.now() - t0;

		// Bounded: application code gets the budget, not the process.
		expect(code, `process did not exit after a wedged cleanup listener.\n--- server output ---\n${output.text}`).toBe(0);
		expect(elapsed).toBeGreaterThanOrEqual(1800);
		expect(elapsed).toBeLessThan(20000);
		// And the operator is told which phase ran out of budget, rather than being
		// left with a clean-looking "Shutdown complete."
		expect(output.text).toContain('did not settle within the 2000ms shutdown budget');
		expect(output.text).toContain('was NOT clean');
		expect(output.text).not.toContain('Shutdown complete');
	}, 60000);
});

describeUWS('a cluster worker drained while it is still booting', () => {
	// A shutdown can always overtake a slow boot, and in cluster mode the worker
	// learns about it from the primary rather than from a signal. Everything the
	// primary sends is buffered until the worker's handler graph is live, which is
	// right for relay and shutdown traffic and wrong for this one message: leaving
	// the rotation touches nothing but the lifecycle state, and replaying it after
	// boot means the worker first announces itself ready for traffic - for an
	// instance the primary put into shutdown seconds earlier. The log is what an
	// operator reconstructs a bad rollout from, so the ORDER is the assertion.
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('leaves the rotation immediately instead of announcing itself ready first', async () => {
		expect(buildFixtureOnce('default'), 'fixture build must succeed').toBe(true);
		const dir = mkdtempSync(join(tmpdir(), 'lifecycle-clusterdrain-'));
		const out = join(dir, 'build');
		// A private copy, because the app's slow `init` hook is the whole scenario
		// and the shipped fixture does not have one.
		cpSync(join(fixtureDir, 'build'), out, { recursive: true });
		symlinkSync(
			fileURLToPath(new URL('../node_modules', import.meta.url)),
			join(out, 'node_modules'),
			process.platform === 'win32' ? 'junction' : 'dir'
		);
		writeFileSync(join(out, 'server', 'ws-handler.js'), [
			'export async function init() {',
			'	await new Promise((r) => setTimeout(r, 3000));',
			"	console.log('APP INIT FINISHED');",
			'}',
			''
		].join('\n'));

		const entry = join(dir, 'entry.mjs');
		writeFileSync(entry, [
			"process.stdin.on('data', (d) => { if (String(d).includes('shutdown')) process.emit('SIGTERM'); });",
			'process.stdin.unref();',
			`await import(${JSON.stringify(pathToFileURL(join(out, 'index.js')).href)});`,
			''
		].join('\n'));

		const port = await freePort();
		const merged = { ...process.env, HOST: '127.0.0.1', PORT: String(port), CLUSTER_WORKERS: '1', SHUTDOWN_DELAY_MS: '5000', SHUTDOWN_TIMEOUT: '10' };
		for (const key of ['CLUSTER_MODE', 'SSL_CERT', 'SSL_KEY']) delete merged[key];
		const proc = spawn(process.execPath, [entry], { cwd: fixtureDir, stdio: ['pipe', 'pipe', 'pipe'], env: merged });
		child = proc;
		let text = '';
		proc.stdout.on('data', (b) => { text += b; });
		proc.stderr.on('data', (b) => { text += b; });

		// Well inside the app's 3000ms init: the primary broadcasts the drain to a
		// worker whose handler graph is not built yet.
		await sleep(800);
		proc.stdin.write('shutdown\n');

		const code = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), 40000);
			proc.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 0); });
		});
		expect(code, `cluster did not exit cleanly.\n--- server output ---\n${text}`).toBe(0);

		const drainedAt = text.indexOf('Readiness now reports NOT ready (draining)');
		const bootedAt = text.indexOf('APP INIT FINISHED');
		expect(drainedAt, `no worker drain line.\n--- server output ---\n${text}`).toBeGreaterThan(-1);
		expect(bootedAt, `the app init hook never ran.\n--- server output ---\n${text}`).toBeGreaterThan(-1);
		// The ordering IS the finding: buffered, this line lands after the boot it
		// was supposed to overtake, and the worker reports being ready in between.
		expect(drainedAt, `the drain was replayed after boot instead of applied during it.\n--- server output ---\n${text}`).toBeLessThan(bootedAt);
	}, 120000);
});
