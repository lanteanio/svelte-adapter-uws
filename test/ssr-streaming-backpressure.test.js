// Two properties of the SSR write path that only show under load shapes the
// ordinary suite never produces, driven against the built runtime.
//
// 1. A multi-chunk body reaches the client whole through backpressure. The
//    chunk writer parks on a drain promise whenever `res.write` reports
//    backpressure and the socket's writable event wakes it. Backpressure is a
//    socket-buffer event, not a client-speed one: on a real link any body past
//    a few hundred kilobytes produces it at gigabit speeds, and loopback needs
//    a client that pauses between reads only because its buffers hold
//    megabytes. The addon build the 0.5.x line pinned (v20.67.0) lost that
//    wakeup after the first backpressure event: the writer waited out its 30 s
//    deadline and closed the socket on a body cut at the first socket-buffer
//    boundary. The pinned build carries the upstream fix; this holds the pin
//    to it by measuring the outcome.
//
// 2. The request-dedup leader decides whether a body is shareable BEFORE it
//    holds the body. It used to read the whole response and only then compare
//    its size with the cap, so every uncredentialed GET of a large body was
//    materialised in full, per request, and a container serving a big file
//    to two anonymous viewers exceeded its memory. Now a declared length past
//    the cap streams at once, and an undeclared body is read only up to the
//    cap and streams on from there. The observable: the first bytes of a
//    body past the cap arrive BEFORE the route has finished producing it.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, freePort } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * GET `url`, reading the body with a pause after every data event so the
 * server's socket buffer fills, and report what arrived.
 * @param {string} url
 * @param {{ pauseMs?: number, headers?: Record<string, string>, firstByteAt?: (ms: number) => void }} [opts]
 */
function slowGet(url, { pauseMs = 0, headers = {}, firstByteAt } = {}) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { headers, rejectUnauthorized: false }, (res) => {
			let bytes = 0;
			let first = true;
			res.on('data', (chunk) => {
				if (first) { first = false; firstByteAt?.(Date.now() - started); }
				bytes += chunk.length;
				if (pauseMs > 0) {
					res.pause();
					setTimeout(() => res.resume(), pauseMs);
				}
			});
			// 'end' fires only once node's parser has seen the terminating chunk
			// (or the declared length); a socket cut mid-body is 'aborted'.
			res.on('end', () => resolve({ status: res.statusCode, bytes, complete: res.complete, headers: res.headers }));
			res.on('aborted', () => resolve({ status: res.statusCode, bytes, complete: false, headers: res.headers }));
			res.on('error', (err) => resolve({ status: res.statusCode, bytes, complete: false, error: err.code, headers: res.headers }));
		});
		req.on('error', reject);
		req.end();
	});
}

describeUWS('a streamed body reaches the client whole through backpressure', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime(); }, 400000);
	afterAll(async () => { await server?.stop(); });

	it('delivers every byte and the terminating chunk through sustained backpressure', async () => {
		// 16 MiB in 64 KiB chunks, read with a pause after every data event: on
		// loopback the kernel buffers a few megabytes, so a body this size with
		// a client this slow drives the writer through backpressure many times.
		// A cookie takes the credentialed path, which streams rather than
		// buffers, the same lane the field report named.
		const r = await slowGet(`${server.httpUrl}/stream-big?mb=16`, { pauseMs: 5, headers: { cookie: 'a=1' } });
		expect(r.status).toBe(200);
		expect(r.complete, 'the response must end with the terminating chunk, not a cut socket').toBe(true);
		expect(r.bytes).toBe(16 * 1024 * 1024);
	}, 120000);

	it('the same body arrives whole when the client reads at full speed', async () => {
		const r = await slowGet(`${server.httpUrl}/stream-big?mb=8`, { headers: { cookie: 'a=1' } });
		expect(r.complete).toBe(true);
		expect(r.bytes).toBe(8 * 1024 * 1024);
	}, 60000);
});

// TLS is booted the way the TLS suites boot it: the built default fixture in
// its own process with SSL_CERT/SSL_KEY set, since the runtime reads them at
// module eval and an in-process boot would leave them on this worker. Skipped
// without an openssl binary to mint the certificate.
function findOpenssl() {
	const candidates = ['openssl'];
	if (process.platform === 'win32') {
		for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
			if (!root) continue;
			candidates.push(path.join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
			candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'openssl.exe'));
		}
	}
	for (const bin of candidates) {
		try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return bin; } catch { /* next */ }
	}
	return null;
}
const openssl = hasUWS ? findOpenssl() : null;
const describeTls = openssl !== null ? describeUWS : describe.skip;

describeTls('a streamed body reaches the client whole through backpressure over TLS', () => {
	const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
	/** @type {import('node:child_process').ChildProcess | null} */
	let child = null;
	let port = 0;

	beforeAll(async () => {
		expect(buildFixtureOnce('default')).toBe(true);
		const dir = mkdtempSync(path.join(tmpdir(), 'stream-tls-'));
		const key = path.join(dir, 'live.key');
		const crt = path.join(dir, 'live.crt');
		execFileSync(openssl, [
			'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
			'-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
		], { stdio: 'ignore' });
		port = await freePort();
		const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), SSL_CERT: crt, SSL_KEY: key };
		for (const k of ['CLUSTER_WORKERS', 'CLUSTER_MODE', 'SSL_WATCH', 'SSL_SNI_HOSTS', 'SSL_RELOAD_DEBOUNCE_MS']) delete env[k];
		let out = '';
		const listening = await new Promise((resolve) => {
			child = spawn(process.execPath, [path.join(fixtureDir, 'build', 'index.js')], { cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'], env });
			const scan = (buf) => { out += buf.toString(); if (out.includes('Listening on https://')) resolve(true); };
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 20000);
		});
		expect(listening, `the TLS server never reached listening.\n--- server output ---\n${out}`).toBe(true);
	}, 400000);

	afterAll(async () => {
		if (child && child.exitCode === null) {
			child.kill();
			await new Promise((resolve) => child.once('exit', resolve));
		}
	});

	it('delivers every byte and the terminating chunk through sustained backpressure over TLS', async () => {
		const r = await slowGet(`https://127.0.0.1:${port}/stream-big?mb=16`, { pauseMs: 5, headers: { cookie: 'a=1' } });
		expect(r.status).toBe(200);
		expect(r.complete, 'the response must end with the terminating chunk, not a cut socket').toBe(true);
		expect(r.bytes).toBe(16 * 1024 * 1024);
	}, 120000);
});

describeUWS('the request-dedup leader decides sharing before it holds the body', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime(); }, 400000);
	afterAll(async () => { await server?.stop(); });

	const renders = async () => Number(await (await fetch(`${server.httpUrl}/big-shared?renders=1`)).text());

	it('streams an undeclared body once it passes the cap: bytes arrive before the route has produced the rest', async () => {
		// The route emits ten 64 KiB chunks at once (640 KiB, past the 512 KiB
		// cap) and the rest after a pause. The leader reads until the cap is
		// passed, which happens inside those ten, and streams from there; a
		// leader that held the whole body would write nothing until the pause
		// was over. The write path corks the first two chunks together, so
		// "before the pause" is the earliest any byte can leave.
		let firstByte = Infinity;
		const r = await slowGet(`${server.httpUrl}/big-shared?kb=1024&after=10&delay=1500`, { firstByteAt: (ms) => { firstByte = ms; } });
		expect(r.status).toBe(200);
		expect(r.complete).toBe(true);
		expect(r.bytes).toBe(1024 * 1024);
		expect(firstByte, 'bytes must leave before the route pauses, so the body was not held whole').toBeLessThan(1500);
	}, 60000);

	it('streams a body whose declared length is past the cap from its first chunks, without reading ahead', async () => {
		// With a Content-Length past the cap nothing is read to decide: the
		// pause sits right after the two chunks the write path corks together,
		// and the client still sees them before it ends.
		let firstByte = Infinity;
		const r = await slowGet(`${server.httpUrl}/big-shared?kb=1024&after=2&delay=1500&declare=1`, { firstByteAt: (ms) => { firstByte = ms; } });
		expect(r.status).toBe(200);
		expect(r.complete).toBe(true);
		expect(r.bytes).toBe(1024 * 1024);
		expect(firstByte, 'a declared length past the cap must stream at once').toBeLessThan(1500);
	}, 60000);

	it('does not share a body past the cap: a concurrent anonymous request renders for itself and both complete', async () => {
		const before = await renders();
		const [a, b] = await Promise.all([
			slowGet(`${server.httpUrl}/big-shared?kb=1024&delay=300`),
			slowGet(`${server.httpUrl}/big-shared?kb=1024&delay=300`)
		]);
		expect(a.complete && b.complete).toBe(true);
		expect(a.bytes).toBe(1024 * 1024);
		expect(b.bytes).toBe(1024 * 1024);
		expect(await renders() - before, 'past the cap nothing is shared, so each request rendered').toBe(2);
	}, 60000);

	it('still shares a body within the cap, so the herd protection is intact', async () => {
		// The pause after the first chunk keeps the leader in flight while the
		// second request arrives, which is what makes the two concurrent.
		const before = await renders();
		const [a, b] = await Promise.all([
			slowGet(`${server.httpUrl}/big-shared?kb=256&after=1&delay=300`),
			slowGet(`${server.httpUrl}/big-shared?kb=256&after=1&delay=300`)
		]);
		expect(a.complete && b.complete).toBe(true);
		expect(a.bytes).toBe(256 * 1024);
		expect(b.bytes).toBe(256 * 1024);
		expect(await renders() - before, 'within the cap the second request is served from the leader').toBe(1);
	}, 60000);
});
