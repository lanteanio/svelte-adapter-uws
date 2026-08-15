// ADAPTER-ERR-SSR, driven from the condition it claims.
//
// The entry's consequence has two halves and they part ways at one byte of
// response: a failure BEFORE anything is written is answered with a real
// error response, while a failure once the body is STREAMING can only be
// made visible by aborting the exchange - a clean EOF on a partial body
// reads as a complete response, which is precisely what the send path must
// never fabricate. A prose pass cannot check either half; both are reached
// here through the built runtime with a real HTTP client, and the sink
// captures the documented event for each.
//
// The first two fixture routes fail in the only place that separates the
// halves: one errors its ReadableStream before the first chunk, the other
// after three chunks have gone out under the app's own 200. The third pipes
// the request body back so the payload limit itself trips mid-stream.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { hasUWS, startRealRuntime, freePort, EVAL_TIME_ENV } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';

const describeUWS = hasUWS ? describe : describe.skip;

const entry = ADAPTER_ERROR_REGISTRY.find((e) => e.id === ADAPTER_ERROR_IDS.SSR);

describeUWS('ADAPTER-ERR-SSR', () => {
	let server;
	/** @type {any[]} */
	const events = [];
	/** @type {() => void} */
	let disposeSink;

	beforeAll(async () => {
		server = await startRealRuntime();
		disposeSink = setOperationalEventSink((record) => { events.push(record); });
	}, 400000);

	afterAll(async () => {
		disposeSink?.();
		await server?.stop();
	});

	it('answers a failure before the response starts with an error response carrying the request id', async () => {
		const before = events.length;
		const response = await fetch(`${server.httpUrl}/ssr-first-chunk-fail`);
		expect(response.status).toBe(500);
		const requestId = response.headers.get('x-request-id');
		expect(requestId).toBeTruthy();
		expect(await response.text()).toBe('Internal Server Error');

		const mine = events.slice(before).filter((r) => r.event === 'runtime.ssr.failed');
		expect(mine.length).toBe(1);
		// Direct emission: the record's message IS the registry's search key.
		expect(mine[0].message).toBe(entry.problemPrefix);
		// nextAction says to read the attached error, and the request id must
		// bind the log line to the response the client saw.
		expect(mine[0].attributes?.requestId).toBe(requestId);
		expect(mine[0].attributes?.error?.message).toContain('ssr pre-body probe fault');
	});

	it('aborts a response that fails mid-stream instead of ending it cleanly', async () => {
		const before = events.length;
		const response = await fetch(`${server.httpUrl}/ssr-stream-fail`);
		// Headers and early chunks were flushed before the source failed, so
		// the client holds the app's own status - no 500 can exist here.
		expect(response.status).toBe(200);

		// The load-bearing assertion: the truncated body must NOT read as
		// complete. A clean resolution of the body is the defect shape.
		let cleanBody = null;
		let aborted = false;
		try {
			cleanBody = await response.text();
		} catch {
			aborted = true;
		}
		expect(aborted, `truncated body read as complete: ${JSON.stringify(cleanBody?.slice(0, 64))}`).toBe(true);

		// The abort reaches the client on the wire before the server's catch
		// finishes its bookkeeping, so give the emission a beat to land.
		const mine = await vi.waitFor(() => {
			const found = events.slice(before).filter((r) => r.event === 'runtime.ssr.failed');
			expect(found.length).toBe(1);
			return found;
		}, { timeout: 2000 });
		expect(mine[0].message).toBe(entry.problemPrefix);
		expect(mine[0].attributes?.error?.message).toContain('ssr mid-stream probe fault');
	});

	it('documents both halves in the registry consequence', () => {
		expect(entry.consequence).toMatch(/before the response starts/i);
		expect(entry.consequence).toMatch(/aborted/i);
	});
});

describeUWS('mid-stream payload limit through an echoing route', () => {
	const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
	const builtEntry = path.join(fixtureDir, 'build', 'index.js');
	let child = null;
	let baseUrl = null;

	// BODY_SIZE_LIMIT is read at module eval, so this limit needs its own
	// process: a spawned copy of the same default build, which also makes the
	// survival assertion below absolute - an unhandled rejection exits the
	// child and every later request refuses to connect.
	beforeAll(async () => {
		expect(buildFixtureOnce()).toBe(true);
		const port = await freePort();
		baseUrl = `http://127.0.0.1:${port}`;
		// Scrub every eval-time knob the shell might carry, then set only what
		// this boot needs - the same discipline startRealRuntime applies.
		const env = { ...process.env };
		for (const key of EVAL_TIME_ENV) delete env[key];
		env.HOST = '127.0.0.1';
		env.PORT = String(port);
		env.CLUSTER_WORKERS = '';
		env.BODY_SIZE_LIMIT = '4096';
		await new Promise((resolveReady, rejectReady) => {
			child = spawn(process.execPath, [builtEntry], {
				cwd: fixtureDir,
				stdio: ['ignore', 'pipe', 'pipe'],
				env
			});
			let output = '';
			const deadline = setTimeout(() => rejectReady(new Error(`fixture not ready: ${output}`)), 30000);
			const scan = (chunk) => {
				output += chunk.toString();
				if (output.includes('Ready for traffic')) {
					clearTimeout(deadline);
					resolveReady(undefined);
				}
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', (code) => {
				clearTimeout(deadline);
				rejectReady(new Error(`fixture exited ${code}: ${output}`));
			});
		});
	}, 400000);

	afterAll(() => {
		if (child && !child.killed) {
			try { child.kill(); } catch {}
		}
		child = null;
	});

	it('aborts the echo when the limit trips mid-stream, and keeps serving', async () => {
		// 1 KiB every 25ms: the echo streams the early chunks back under a 200
		// before the fifth chunk crosses the limit, so the payload error
		// reaches the response reader with bytes already on the wire. A 413
		// written there would be a second response into a closed exchange; the
		// exchange must simply die - and only the exchange, not the server.
		const chunk = new Uint8Array(1024).fill(120);
		let sentChunks = 0;
		const body = new ReadableStream({
			async pull(controller) {
				if (sentChunks >= 8) { controller.close(); return; }
				controller.enqueue(chunk);
				sentChunks += 1;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		});

		let status = null;
		let aborted = false;
		try {
			const response = await fetch(`${baseUrl}/ssr-echo`, {
				method: 'POST',
				body,
				// @ts-expect-error - undici requires duplex for stream bodies
				duplex: 'half'
			});
			status = response.status;
			await response.text();
		} catch {
			aborted = true;
		}
		expect(aborted, 'the echo exchange must not complete cleanly').toBe(true);
		if (status !== null) expect(status).toBe(200);

		// The server survived its own abort: the next request still answers.
		const alive = await fetch(`${baseUrl}/ssr-first-chunk-fail`);
		expect(alive.status).toBe(500);
	});
});
