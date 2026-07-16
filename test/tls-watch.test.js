// TLS hot-reload regression, driven against the REAL built runtime with real
// TLS handshakes. The bug: uWS `addServerName` creates an empty per-domain HTTP
// router, and every request on a connection whose handshake SNI matched that
// name routes through the domain router instead of the app's main router - a
// route miss force-closes the socket. The old code registered the cert's SNI
// hosts at boot, so with SSL_WATCH=1 (the default) every real-world client
// (browsers and curl send SNI matching the cert host) had its first request
// force-closed: a 100% TLS outage that local smokes missed because they hit
// localhost by IP with non-matching SNI.
//
// The fix is a lazy fingerprint-gated overlay: boot registers nothing (serving
// is byte-identical to SSL_WATCH=0), and only a genuine cert change activates
// the SNI server names - each swap followed by a full route mirror onto the
// fresh domain routers (route-registry.js). This test proves the whole ladder:
//   1. SNI-matched HTTPS at boot is served (RED without the fix: ECONNRESET),
//   2. a cert swapped on disk is picked up by the directory watch and served to
//      NEW SNI-matched handshakes without a restart (fingerprint flips),
//   3. HTTP and the WebSocket upgrade still work through the mirrored domain
//      router after the swap,
//   4. a non-SNI client keeps the boot cert (the uWS default context is
//      static - the documented caveat).
//
// Every HTTP request uses `agent: false`: the default agent's keep-alive would
// reuse a connection whose handshake predates the reload and false-negative
// the assertions (the trap that hid the original outage from the node repro).
//
// Gated on a loadable uWS binding + an openssl binary (self-signed certs for
// SAN localhost are generated at setup); skips where either is missing.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { join } from 'node:path';
import { WebSocket } from 'ws';

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

const openssl = findOpenssl();
const canRun = bindingLoads() && openssl !== null;
const describeMaybe = canRun ? describe : describe.skip;

let built = false;
let dir;
const certs = {};

function gen(name) {
	const key = join(dir, name + '.key');
	const crt = join(dir, name + '.crt');
	execFileSync(openssl, [
		'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
		'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
	], { stdio: 'ignore' });
	const fingerprint = new X509Certificate(readFileSync(crt, 'utf8')).fingerprint256;
	return { key, crt, fingerprint };
}

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
 * One fresh HTTPS GET (no keep-alive, no reuse). `sni: true` sends
 * servername=localhost - the SNI the cert serves, i.e. what every real-world
 * client sends; `sni: false` connects by bare IP (no SNI at all).
 */
function httpsGet(port, pathName, sni) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest({
			host: '127.0.0.1',
			port,
			path: pathName,
			method: 'GET',
			agent: false,
			rejectUnauthorized: false,
			...(sni ? { servername: 'localhost' } : {})
		}, (res) => {
			let body = '';
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** The fingerprint256 a FRESH handshake is served (sni as in httpsGet). */
function servedFingerprint(port, sni) {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({
			host: '127.0.0.1',
			port,
			rejectUnauthorized: false,
			...(sni ? { servername: 'localhost' } : {})
		}, () => {
			const fp = socket.getPeerCertificate().fingerprint256;
			socket.destroy();
			resolve(fp);
		});
		socket.on('error', reject);
	});
}

function wssUpgrades(port) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
			servername: 'localhost',
			rejectUnauthorized: false
		});
		const done = (ok) => { try { ws.terminate(); } catch {} resolve(ok); };
		ws.on('open', () => done(true));
		ws.on('error', () => done(false));
		setTimeout(() => done(false), 5000);
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Child env for the spawned fixture: ambient adapter knobs are stripped so the
 * mode under test is pinned by the overrides alone (an inherited
 * CLUSTER_WORKERS would silently flip the topology; an inherited SSL_WATCH=0
 * would defeat the whole "the default must be safe" point).
 */
function childEnv(overrides) {
	const env = { ...process.env, ...overrides };
	for (const key of ['CLUSTER_WORKERS', 'CLUSTER_MODE', 'SSL_WATCH', 'SSL_SNI_HOSTS', 'SSL_RELOAD_DEBOUNCE_MS']) {
		if (!(key in overrides)) delete env[key];
	}
	return env;
}

describeMaybe('TLS hot-reload (SSL_WATCH default): real server, real handshakes', () => {
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'tls-watch-'));
		certs.A = gen('boot');
		certs.B = gen('renewed');
		expect(certs.A.fingerprint).not.toBe(certs.B.fingerprint);
		// Serialized + reused across the suites that boot the built fixture (the
		// acceptor-init suite builds the same directory).
		built = buildFixtureOnce();
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('serves SNI-matched clients at boot, hot-swaps a renewed cert, and keeps routes + WS through the swap', async () => {
		expect(built, 'fixture build must succeed for this integration test').toBe(true);

		// The live cert files the server watches; boot with cert A.
		const liveCrt = join(dir, 'live.crt');
		const liveKey = join(dir, 'live.key');
		copyFileSync(certs.A.crt, liveCrt);
		copyFileSync(certs.A.key, liveKey);

		const port = await freePort();
		let out = '';
		const listening = await new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				// SSL_WATCH deliberately unset - the DEFAULT must be safe.
				env: childEnv({
					HOST: '127.0.0.1',
					PORT: String(port),
					SSL_CERT: liveCrt,
					SSL_KEY: liveKey,
					SSL_RELOAD_DEBOUNCE_MS: '100'
				})
			});
			const scan = (buf) => {
				out += buf.toString();
				if (out.includes('Listening on https://')) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 15000);
		});
		expect(listening, `server never reached listening.\n--- server output ---\n${out}`).toBe(true);

		// 1. Boot: an SNI-matched request is served. RED without the fix - the
		// boot-time addServerName left an empty domain router that force-closed
		// this exact request (ECONNRESET, zero response bytes).
		const bootSni = await httpsGet(port, '/healthz', true);
		expect(bootSni.status).toBe(200);
		// A non-SNI (bare-IP) client is served by the default context.
		const bootPlain = await httpsGet(port, '/healthz', false);
		expect(bootPlain.status).toBe(200);
		// Both handshake flavors serve the boot cert.
		expect(await servedFingerprint(port, true)).toBe(certs.A.fingerprint);
		expect(await servedFingerprint(port, false)).toBe(certs.A.fingerprint);

		// 2. Renew: swap the cert on disk (certbot-style overwrite; two writes
		// coalesced by the debounce) and poll FRESH handshakes until the served
		// fingerprint flips. No restart, no re-bind.
		copyFileSync(certs.B.crt, liveCrt);
		copyFileSync(certs.B.key, liveKey);
		let flipped = false;
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			if (await servedFingerprint(port, true).catch(() => null) === certs.B.fingerprint) {
				flipped = true;
				break;
			}
			await sleep(200);
		}
		expect(flipped, `renewed cert was never served to new SNI handshakes.\n--- server output ---\n${out}`).toBe(true);

		// 3. The overlay's domain router must carry the full route set: HTTP and
		// the WebSocket upgrade both work for SNI-matched connections post-swap.
		const postSwap = await httpsGet(port, '/healthz', true);
		expect(postSwap.status).toBe(200);
		expect(await wssUpgrades(port)).toBe(true);

		// 4. The documented caveat: a non-SNI client stays on the uWS default
		// context, which is static - it keeps the boot cert until a restart (and
		// keeps being served).
		expect(await servedFingerprint(port, false)).toBe(certs.A.fingerprint);
		const plainPostSwap = await httpsGet(port, '/healthz', false);
		expect(plainPostSwap.status).toBe(200);
	}, 90000);

	it('acceptor cluster mode: the broadcast reload swaps the cert on the worker contexts that terminate TLS', async () => {
		// The primary registers NO server names and never touches its acceptor
		// app's TLS context - the design rests on the handshakes terminating on
		// the CHILD worker app contexts. This proves that empirically: if the
		// acceptor app terminated TLS, the fingerprint below could never flip
		// (nothing reloads the acceptor context anymore).
		expect(built, 'fixture build must succeed for this integration test').toBe(true);

		const liveCrt = join(dir, 'live-acceptor.crt');
		const liveKey = join(dir, 'live-acceptor.key');
		copyFileSync(certs.A.crt, liveCrt);
		copyFileSync(certs.A.key, liveKey);

		const port = await freePort();
		let out = '';
		const listening = await new Promise((resolve) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				// SSL_WATCH again unset: the cluster default must be safe too.
				env: childEnv({
					HOST: '127.0.0.1',
					PORT: String(port),
					SSL_CERT: liveCrt,
					SSL_KEY: liveKey,
					SSL_RELOAD_DEBOUNCE_MS: '100',
					CLUSTER_WORKERS: '2',
					CLUSTER_MODE: 'acceptor'
				})
			});
			// 'Acceptor listening' prints when the FIRST worker registers; wait for
			// BOTH workers' registration lines too, so the cert swap below cannot
			// land while worker 2 is still pre-arm - the pass/fail boundary must be
			// the design, not scheduler luck.
			const ready = (s) => s.includes('Acceptor listening on https://')
				&& (s.match(/Worker thread \d+ registered/g) || []).length >= 2;
			const scan = (buf) => {
				out += buf.toString();
				if (ready(out)) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(ready(out)));
			setTimeout(() => resolve(ready(out)), 20000);
		});
		expect(listening, `cluster never reached listening with both workers registered.\n--- server output ---\n${out}`).toBe(true);

		// Boot: SNI-matched requests are served (nothing registered - lazy), and
		// the boot cert is what the child contexts serve.
		const bootSni = await httpsGet(port, '/healthz', true);
		expect(bootSni.status).toBe(200);
		expect(await servedFingerprint(port, true)).toBe(certs.A.fingerprint);

		// Renew on disk: the primary's directory watch fires the cluster
		// broadcast; every worker fingerprint-gates and swaps its own context.
		copyFileSync(certs.B.crt, liveCrt);
		copyFileSync(certs.B.key, liveKey);
		// The acceptor distributes connections across both workers and each swaps
		// independently on the broadcast, so require a RUN of consecutive fresh
		// handshakes on the renewed cert - every worker swapped, not just the one
		// a single probe happened to land on.
		let consecutive = 0;
		const deadline = Date.now() + 20000;
		while (consecutive < 6 && Date.now() < deadline) {
			if (await servedFingerprint(port, true).catch(() => null) === certs.B.fingerprint) {
				consecutive++;
			} else {
				consecutive = 0;
				await sleep(200);
			}
		}
		expect(consecutive, `renewed cert was never served by every worker.\n--- server output ---\n${out}`).toBe(6);

		const postSwap = await httpsGet(port, '/healthz', true);
		expect(postSwap.status).toBe(200);
		expect(await wssUpgrades(port)).toBe(true);
	}, 120000);
});
