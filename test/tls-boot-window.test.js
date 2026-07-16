// Boot-window TLS regression, driven against the REAL built runtime imported
// in-process. The uWS SSLApp loads the certificate from disk at MODULE EVAL
// (handler/config.js), but the hot-reload arms inside start() - and on a real
// app the module-eval tail (static cache indexing, SSR init) runs for seconds.
// The bug this pins down: a renewal completing in that window used to be read
// at arm time and recorded as the served baseline, so every future reload
// fingerprint-gated to a no-op and the server sat on the stale boot cert until
// it expired (certbot rewrites next ~60 days later - after the served cert's
// expiry). The fix: the baseline fingerprint is captured in the same tick as
// the SSLApp creation, and initTlsReload runs one fingerprint-gated catch-up
// reload after arming.
//
// In-process import is what makes the race DETERMINISTIC: the test owns the
// gap between module eval and start(), and swaps the cert on disk exactly
// there. The reload debounce is set huge (10 minutes) so the directory watcher
// cannot be the mechanism that swaps - within the test's lifetime only the
// arm-time catch-up can serve cert B. Red without the catch-up: a fresh
// SNI-matched handshake keeps serving cert A forever.
//
// Gated on a loadable uWS binding + openssl, like the sibling TLS suites.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { join } from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtHandler = path.join(fixtureDir, 'build', 'handler.js');

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

function gen(dir, name) {
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
			res.resume();
			res.on('end', () => resolve(res.statusCode));
		});
		req.on('error', reject);
		req.end();
	});
}

describeMaybe('TLS boot window: a renewal landing between SSLApp creation and arm is caught up at arm time', () => {
	let built = false;
	/** @type {any} */
	let handler = null;

	beforeAll(() => {
		built = buildFixtureOnce();
	}, 400000);

	afterAll(async () => {
		if (handler) {
			try { await handler.shutdown(); } catch {}
			try { handler.forceCloseApp(); } catch {}
		}
	});

	it('serves the renewed cert on the first fresh SNI handshake, with the watcher out of the picture', async () => {
		expect(built, 'fixture build must succeed for this integration test').toBe(true);

		const dir = mkdtempSync(join(tmpdir(), 'tls-boot-window-'));
		const certA = gen(dir, 'boot');
		const certB = gen(dir, 'renewed');
		expect(certA.fingerprint).not.toBe(certB.fingerprint);

		const liveCrt = join(dir, 'live.crt');
		const liveKey = join(dir, 'live.key');
		copyFileSync(certA.crt, liveCrt);
		copyFileSync(certA.key, liveKey);

		// Env must be in place BEFORE the import: the built runtime reads it at
		// module eval (config.js), where the SSLApp loads cert A and the baseline
		// fingerprint is captured. The huge debounce parks the directory watcher:
		// any event it sees schedules a reload 10 minutes out, far beyond this
		// test - so a cert B observation below can only come from the arm-time
		// catch-up.
		process.env.SSL_CERT = liveCrt;
		process.env.SSL_KEY = liveKey;
		process.env.SSL_RELOAD_DEBOUNCE_MS = '600000';
		delete process.env.SSL_WATCH;      // the DEFAULT must be safe
		delete process.env.SSL_SNI_HOSTS;
		delete process.env.CLUSTER_WORKERS;

		// Module eval: SSLApp(certA) + boot fingerprint capture. This is the real
		// production module graph the built server runs - not a harness copy.
		handler = await import(pathToFileURL(builtHandler).href);

		// THE WINDOW: the renewal lands after the app loaded cert A, before
		// start() arms the hot-reload.
		copyFileSync(certB.crt, liveCrt);
		copyFileSync(certB.key, liveKey);

		const port = await freePort();
		await handler.start('127.0.0.1', port);

		// The arm-time catch-up must have swapped: a FRESH SNI-matched handshake
		// serves cert B (red without the catch-up: cert A forever, because the
		// old arm-time baseline read recorded B as already served). And the
		// mirrored domain router must carry the routes - the request completes.
		expect(await servedFingerprint(port, true)).toBe(certB.fingerprint);
		expect(await httpsGet(port, '/healthz', true)).toBe(200);

		// Non-SNI clients stay on the static default context with the boot cert -
		// the documented caveat, and the proof that cert A really was what the
		// boot context loaded (i.e. the window was genuinely recreated).
		expect(await servedFingerprint(port, false)).toBe(certA.fingerprint);
		expect(await httpsGet(port, '/healthz', false)).toBe(200);
	}, 60000);
});
