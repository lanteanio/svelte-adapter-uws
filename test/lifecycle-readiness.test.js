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
import { variantOut } from './fixture/variants.js';
import { EVAL_TIME_ENV } from './helpers/real-runtime.js';
import { certExpiryAlert, readCertIdentity } from '../src/runtime/utils/tls-reload.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../src/runtime/error-registry.js';

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
		const tail = certExpiryAlert(
			{ degraded: 'the certificate directory watch failed to start', notAfter, notAfterText: 'Jan  1 00:00:00 2027 GMT' },
			notAfter - (6 * day + 4 * 3600000)
		);
		expect(tail).toContain('the certificate directory watch failed to start');
		expect(tail).toContain('Jan  1 00:00:00 2027 GMT');
		expect(tail).toContain('6d 4h left');
		// The composer returns the varying tail; the invariant DEGRADED head
		// comes from the registry, so the printed line is searchable by the
		// documented prefix and carries the stable ID tag.
		const line = adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, tail);
		expect(line).toContain('certificate hot-reload is DEGRADED (the certificate directory watch failed to start)');
		expect(line).toContain('[ADAPTER-ERR-TLS-DEGRADED-EXPIRY]');
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

	it('reports a shutdown hook that throws and completes the teardown regardless', async () => {
		const probe = '__wsHookThrew';
		const lifecycle = await runtimeWithWsHook('threw', probe, [
			'export function shutdown(ctx) {',
			'	globalThis[PROBE_KEY] = { ctx };',
			"	throw new Error('flush failed on purpose');",
			'}',
			''
		].join('\n'));

		const errors = [];
		const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
		try {
			// Resolving at all is part of the subject: a rethrow out of shutdown()
			// would reject this await and leave the teardown unfinished.
			await lifecycle.shutdown({ reason: 'SIGTERM' });
		} finally {
			spy.mockRestore();
		}
		// The hook genuinely ran before it threw, and the close path still walked
		// to its end - the throw is contained, not allowed to refuse the shutdown.
		expect(globalThis[probe].ctx.reason).toBe('SIGTERM');
		expect(lifecycle.lifecycleState()).toBe('closed');
		// The loss is silent unless this line is read, so the line is what these
		// assertions bind: the documented prefix, the stable ID tag, and the
		// hook's own error attached so the log says what the flush died of.
		const text = errors.join('\n');
		expect(text).toContain('the WebSocket shutdown hook threw');
		expect(text).toContain('[ADAPTER-ERR-WS-SHUTDOWN-HOOK-THREW]');
		expect(text).toContain('flush failed on purpose');
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
	 * async one records that it finished. The failing variants register a
	 * healthy listener AFTER the failing one, because the containment under
	 * test is that one listener's failure does not cost the others their turn.
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
			"if (process.env.PROBE_CLEANUP === 'reject') {",
			"	process.on('sveltekit:shutdown', async () => { throw new Error('cleanup rejected on purpose'); });",
			"	process.on('sveltekit:shutdown', async (reason) => {",
			"		await new Promise((r) => setTimeout(r, 50));",
			"		appendFileSync(marker, 'survived:' + reason);",
			"	});",
			"}",
			"if (process.env.PROBE_CLEANUP === 'throw') {",
			"	process.on('sveltekit:shutdown', () => { throw new Error('cleanup threw on purpose'); });",
			"	process.on('sveltekit:shutdown', async (reason) => {",
			"		await new Promise((r) => setTimeout(r, 50));",
			"		appendFileSync(marker, 'survived:' + reason);",
			"	});",
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
			// A process killed by a signal reports `code === null` with the signal name,
			// so folding it to `code ?? 0` read a SIGTERM death as a clean exit - the one
			// outcome these assertions exist to reject, and the one that loses every
			// cleanup listener. Surface the signal so it cannot pass as a zero.
			proc.on('exit', (code, signal) => {
				clearTimeout(timer);
				resolve(code === null && signal ? `killed:${signal}` : (code ?? 0));
			});
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

	it('contains a sveltekit:shutdown listener whose promise rejects: the others still run and the exit stays clean', async () => {
		const marker = join(dir, 'reject-marker.txt');
		const entry = writeWrapper('entry-reject.mjs');
		const { proc, output } = await startServer(entry, { PROBE_CLEANUP: 'reject', PROBE_MARKER: marker });

		requestShutdown(proc);
		// Exit 0 is half of what the registry promises here: the rejection is
		// reported, not escalated into a failing exit or an unhandled rejection
		// that takes the process down mid-teardown.
		expect(await whenExited(proc, 20000)).toBe(0);

		// The documented line, findable by its invariant prefix, plus the stable
		// ID tag an operator searches the reference by, plus the listener's own
		// error so the log says WHICH cleanup was lost.
		expect(output.text).toContain('a sveltekit:shutdown listener rejected');
		expect(output.text).toContain('[ADAPTER-ERR-SHUTDOWN-LISTENER-REJECTED]');
		expect(output.text).toContain('cleanup rejected on purpose');
		// Containment is the other half: the listener registered AFTER the failing
		// one still ran through its await and landed its final write.
		expect(existsSync(marker), `the second listener was lost to the first one's rejection.\n--- server output ---\n${output.text}`).toBe(true);
		expect(readFileSync(marker, 'utf8')).toBe('survived:SIGTERM');
		// And the sequence itself finished: one bad listener does not turn the
		// whole shutdown into an unclean one.
		expect(output.text).toContain('Shutdown complete');
	}, 60000);

	it('contains a sveltekit:shutdown listener that throws: the others still run and the exit stays clean', async () => {
		const marker = join(dir, 'throw-marker.txt');
		const entry = writeWrapper('entry-throw.mjs');
		const { proc, output } = await startServer(entry, { PROBE_CLEANUP: 'throw', PROBE_MARKER: marker });

		requestShutdown(proc);
		// Same containment as the rejection above, on the synchronous path: the
		// throw lands while the listeners are still being invoked, so an escape
		// here would cost every listener registered after it, not just one.
		expect(await whenExited(proc, 20000)).toBe(0);

		expect(output.text).toContain('a sveltekit:shutdown listener threw');
		expect(output.text).toContain('[ADAPTER-ERR-SHUTDOWN-LISTENER-THREW]');
		expect(output.text).toContain('cleanup threw on purpose');
		expect(existsSync(marker), `the second listener was lost to the first one's throw.\n--- server output ---\n${output.text}`).toBe(true);
		expect(readFileSync(marker, 'utf8')).toBe('survived:SIGTERM');
		expect(output.text).toContain('Shutdown complete');
	}, 60000);

	it('arms its signal handlers before the socket, so a SIGTERM during a slow init still drains', async () => {
		const marker = join(dir, 'bootsignal-marker.txt');
		const entry = writeWrapper('entry-bootsignal.mjs');
		// `start()` logs "Listening on" at the bind and only THEN awaits the init
		// hook, so this resolves inside the window under test: the server is already
		// reachable and an orchestrator can already be signalling it.
		const { proc, output } = await startServer(entry, {
			PROBE_CLEANUP: 'async', PROBE_MARKER: marker, SLOW_INIT_MS: '1500'
		});

		requestShutdown(proc);

		// The exit must be the adapter's own. Handlers armed after `await start()`
		// left this window on Node's default SIGTERM disposition, which terminates
		// the process outright - no drain, no listeners, nothing in the log - and
		// reported `code === null`, which the exit helper above used to fold into a
		// passing 0.
		expect(await whenExited(proc, 25000)).toBe(0);

		expect(existsSync(marker), `a SIGTERM during init killed the process outright.\n--- server output ---\n${output.text}`).toBe(true);
		expect(readFileSync(marker, 'utf8')).toBe('closed:SIGTERM');
		// Readiness left the rotation on the SIGNAL, not once the warmup finished:
		// a condemned instance answering 200 for the length of someone's init hook
		// keeps a balancer routing live traffic at it.
		expect(output.text).toContain('Readiness now reports NOT ready (draining)');
		// And the init that completes underneath the shutdown never announces the
		// instance ready on its way down.
		expect(output.text).not.toContain('Ready for traffic');
		expect(output.text).toContain('Shutdown complete');
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
		expect(output.text).toContain('did not settle within the shutdown budget (2000ms)');
		// The overrun line is indexed: it must carry its stable ID tag so the
		// operator can search the reference by the text they saw.
		expect(output.text).toContain('[ADAPTER-ERR-SHUTDOWN-LISTENERS-UNSETTLED]');
		expect(output.text).toContain('was NOT clean');
		expect(output.text).not.toContain('Shutdown complete');
	}, 60000);

	it('drops the requests still open at budget expiry, and says so instead of reporting a clean shutdown', async () => {
		const entry = writeWrapper('entry-inflight.mjs');
		const { proc, port, output } = await startServer(entry, { SHUTDOWN_TIMEOUT: '2' });

		// A request that outlives the whole 2000ms budget. The route prints a line
		// the moment its hold begins, so "the request is in flight" is read off
		// the server's own output rather than assumed from a fixed delay.
		const held = httpGet(port, '/slow-hold?ms=30000').then(() => 'answered', () => 'reset');
		const t0 = Date.now();
		while (!output.text.includes('[slow-hold] holding') && Date.now() - t0 < 10000) await sleep(50);
		expect(output.text, 'the slow-hold request never reached the server').toContain('[slow-hold] holding');

		requestShutdown(proc);
		// The documented exit: the drop is bounded and deliberate, so a budget
		// overrun in the drain does not escalate into a failing exit code.
		expect(await whenExited(proc, 25000)).toBe(0);

		// The composed line names the budget that expired, and it carries the
		// stable ID tag the operator searches the reference by.
		expect(output.text).toContain('in-flight requests did not finish within the shutdown budget (2000ms)');
		expect(output.text).toContain('[ADAPTER-ERR-SHUTDOWN-REQUESTS-DROPPED]');
		// The client-visible half of the consequence: the held request is dropped
		// as the sockets close, so its client sees a reset, never a response.
		expect(await held).toBe('reset');
		// And the summary refuses to call this shutdown clean.
		expect(output.text).toContain('was NOT clean');
		expect(output.text).not.toContain('Shutdown complete');
	}, 60000);
});

// A real signal, or nothing. Windows does not deliver SIGTERM to a Node child -
// the cases above re-emit the event from stdin, which calls whatever handler is
// registered and therefore cannot observe the absence of one. The whole subject
// here is what Node's DEFAULT disposition does to a process that has armed
// nothing yet, so a Windows run of these two would pass with the fix reverted.
const describeSignal = bindingLoads() && process.platform === 'linux' ? describe : describe.skip;

describeSignal('a cluster primary signalled inside its own boot window', () => {
	// The primary registered its SIGTERM/SIGINT handlers at the END of its
	// branch, after the app's `primaryInit` hook had been awaited. Everything
	// before that sat on the default disposition, where a signal terminates the
	// process outright - and in cluster mode the workers are THREADS in this
	// process, so once any of them is serving that disposition takes their live
	// connections too.
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	let dir;

	beforeAll(() => {
		expect(buildFixtureOnce('slowprimary'), 'fixture build must succeed').toBe(true);
		dir = mkdtempSync(join(tmpdir(), 'lifecycle-primarysignal-'));
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	/**
	 * Boot the clustered fixture and resolve once `marker` appears in its output.
	 * The marker is what makes this deterministic: the window under test opens
	 * and closes on the app hook's own schedule, so waiting a fixed delay into it
	 * would be a race that silently passes when it lost.
	 */
	async function bootUntil(marker, env, notifyDir) {
		const port = await freePort();
		const output = { text: '' };
		const merged = {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			CLUSTER_WORKERS: '1',
			...env
		};
		if (notifyDir) {
			merged.NOTIFY_SOCKET = '/run/systemd/notify';
			merged.PATH = notifyDir + ':' + merged.PATH;
		}
		for (const key of ['CLUSTER_MODE', 'SSL_CERT', 'SSL_KEY', 'SHUTDOWN_DELAY_MS', 'SHUTDOWN_TIMEOUT']) {
			if (!(key in (env || {}))) delete merged[key];
		}
		const proc = spawn(process.execPath, [join(fixtureDir, variantOut('slowprimary'), 'index.js')], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: merged
		});
		child = proc;
		const reached = await new Promise((resolve) => {
			const scan = (buf) => {
				output.text += buf.toString();
				if (output.text.includes(marker)) resolve(true);
			};
			proc.stdout.on('data', scan);
			proc.stderr.on('data', scan);
			proc.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 30000);
		});
		expect(reached, `never reached ${marker}.\n--- server output ---\n${output.text}`).toBe(true);
		return { proc, output };
	}

	function exited(proc, ms) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), ms);
			proc.on('exit', (code, signal) => {
				clearTimeout(timer);
				resolve(code === null && signal ? `killed:${signal}` : (code ?? 0));
			});
		});
	}

	it('runs its own exit instead of dying on the default disposition', async () => {
		// Inside `await primaryInit(...)`: no listen socket, no worker, nothing in
		// flight - and, before this was fixed, no signal handler either.
		const { proc, output } = await bootUntil('__PRIMARY_INIT_HOLDING__', { SLOW_PRIMARY_INIT_MS: '4000' });
		proc.kill('SIGTERM');

		// With the handlers armed at the end of the branch this reported
		// `killed:SIGTERM`: the kernel ended it, with nothing in the log to say so.
		expect(await exited(proc, 25000), `--- server output ---\n${output.text}`).toBe(0);
		expect(output.text).toContain('before any worker was spawned');
		// It exits on the signal rather than waiting out the app's hook. Deferring
		// would be worse than the death it replaces: the primary's own shutdown
		// leaves the process exit to the last worker's exit handler, and with no
		// worker ever spawned nothing would end the process at all.
		expect(output.text, `the hold ran to completion before the exit.\n--- server output ---\n${output.text}`)
			.not.toContain('__PRIMARY_INIT_DONE__');
	}, 120000);

	it('withholds READY from systemd when a worker reports in after the shutdown began', async () => {
		// sd_notify goes through the `systemd-notify` helper binary, so a stand-in
		// earlier on PATH records exactly what the runtime would have told systemd.
		const notifyDir = mkdtempSync(join(dir, 'notify-'));
		const log = join(notifyDir, 'sent.txt');
		const helper = join(notifyDir, 'systemd-notify');
		writeFileSync(helper, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });

		// The primary boots immediately; the WORKER holds in its own init hook, so
		// the signal lands after the primary is up and well before the worker
		// reports ready.
		const { proc, output } = await bootUntil('Primary thread starting', { SLOW_INIT_MS: '3000' }, notifyDir);
		proc.kill('SIGTERM');
		expect(await exited(proc, 30000), `--- server output ---\n${output.text}`).toBe(0);

		const sent = existsSync(log) ? readFileSync(log, 'utf8') : '';
		expect(sent, `no systemd notification was sent at all.\n--- server output ---\n${output.text}`).toContain('STOPPING=1');
		// The worker finishes its init underneath the shutdown and reports ready.
		// Passing that on told systemd the instance had arrived, one tick before it
		// left - which is how a rolling deploy convinces itself a dying instance is
		// healthy.
		expect(sent, `READY was announced during shutdown.\n--- notifications ---\n${sent}\n--- server output ---\n${output.text}`)
			.not.toContain('--ready');
	}, 120000);
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
