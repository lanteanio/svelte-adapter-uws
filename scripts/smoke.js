#!/usr/bin/env node
/**
 * Short, visible proof that this checkout can run the adapter's real native
 * transport. It boots the REAL BUILT runtime - not the public testing harness,
 * which is a second implementation of the same plumbing - binds a real
 * uWebSockets.js server, exercises the liveness route, opens a real ws client,
 * subscribes, and observes a publish before tearing everything down. See
 * `startServer` below for why the harness is deliberately not used.
 *
 * Every wait here is bounded. A checkpoint that hangs is worse than one that
 * fails: it produces no diagnosis, never reaches teardown, and on a CI runner
 * it burns the job timeout instead of naming what broke.
 *
 * @module scripts/smoke
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function versions() {
	const adapter = readJson(join(root, 'package.json')).version;
	const nativeEntry = require.resolve('uWebSockets.js');
	const native = readJson(join(dirname(nativeEntry), 'package.json')).version;
	return { adapter, native, node: process.version };
}

/**
 * Wait for the handshake to complete, bounded.
 *
 * `once(ws, 'open')` never settles when a server accepts the socket and then
 * neither completes nor rejects the upgrade: the script hangs forever, never
 * reaches its teardown, and reports nothing. A test-level timeout does not help,
 * because it abandons the promise rather than cancelling it, so the pending
 * work and its open handles survive the failed test.
 *
 * On expiry the socket is TERMINATED rather than closed. A close handshake on a
 * connection that never finished opening has nothing to negotiate with, so it
 * can leave the handle open - which is the hang this exists to prevent.
 *
 * @param {import('ws').WebSocket} ws
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function waitForOpen(ws, timeoutMs = 5000) {
	return new Promise((resolveOpen, rejectOpen) => {
		const timer = setTimeout(() => {
			cleanup();
			// terminate() on a still-connecting socket makes ws emit 'error'
			// ("closed before the connection was established"). Our listeners are
			// detached by now, and an unhandled 'error' event is fatal to the
			// process - so this would crash the run that the bound exists to keep
			// diagnosable. Swallow that one deliberately.
			ws.on('error', () => {});
			try { ws.terminate(); } catch { /* already gone */ }
			rejectOpen(new Error('timed out after ' + timeoutMs + 'ms waiting for the WebSocket handshake'));
		}, timeoutMs);
		timer.unref?.();

		function cleanup() {
			clearTimeout(timer);
			ws.off('open', onOpen);
			ws.off('error', onError);
			ws.off('close', onClose);
		}
		function onOpen() {
			cleanup();
			resolveOpen();
		}
		function onError(error) {
			cleanup();
			rejectOpen(error);
		}
		function onClose(code) {
			cleanup();
			rejectOpen(new Error('WebSocket closed with code ' + code + ' before the handshake completed'));
		}

		ws.on('open', onOpen);
		ws.on('error', onError);
		ws.on('close', onClose);
	});
}

function waitForFrame(ws, predicate, label, timeoutMs = 5000) {
	return new Promise((resolveFrame, rejectFrame) => {
		const timer = setTimeout(() => {
			cleanup();
			rejectFrame(new Error('timed out waiting for ' + label));
		}, timeoutMs);
		timer.unref?.();

		function cleanup() {
			clearTimeout(timer);
			ws.off('message', onMessage);
			ws.off('error', onError);
			ws.off('close', onClose);
		}
		function onError(error) {
			cleanup();
			rejectFrame(error);
		}
		function onClose(code) {
			cleanup();
			rejectFrame(new Error('WebSocket closed with code ' + code + ' while waiting for ' + label));
		}
		function onMessage(data) {
			let frame;
			try {
				frame = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (!predicate(frame)) return;
			cleanup();
			resolveFrame(frame);
		}

		ws.on('message', onMessage);
		ws.on('error', onError);
		ws.on('close', onClose);
	});
}

/**
 * Boot the REAL built adapter runtime, the way a deployed app boots it.
 *
 * This deliberately does NOT use `createTestServer`: that harness is a second
 * implementation of the server's plumbing, and this checkpoint exists to prove
 * the shipped runtime answers - a checkpoint built on the reimplementation
 * proves the reimplementation. The fixture is built once and reused (the
 * builder is source-digest keyed), then its generated handler is imported and
 * listened exactly as production does.
 *
 * @returns {Promise<{ url: string, wsUrl: string, platform: any, track: (ws: any) => any, close: () => Promise<void> }>}
 */
async function startServer() {
	const { startRealRuntime } = await import('../test/helpers/real-runtime.js');
	const runtime = await startRealRuntime();
	const sockets = [];
	return {
		url: runtime.httpUrl,
		wsUrl: runtime.wsUrl,
		platform: runtime.handler.platform,
		track(ws) { sockets.push(ws); return ws; },
		async close() {
			for (const ws of sockets) {
				try {
					// A socket still CONNECTING has no open connection to negotiate a
					// close on, so close() can leave the handle alive and teardown
					// never finishes. Terminate those outright.
					if (ws.readyState === ws.CONNECTING) {
						ws.on('error', () => {});
						ws.terminate();
					} else ws.close();
				} catch { /* already closed */ }
			}
			await runtime.stop();
		}
	};
}

/**
 * Run the contributor smoke checkpoint.
 *
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<{ adapter: string, native: string, node: string, healthStatus: number, event: string }>}
 */
export async function runSmoke({ log = console.log } = {}) {
	const found = versions();
	log(
		'smoke: svelte-adapter-uws ' + found.adapter +
		' | uWebSockets.js ' + found.native +
		' | Node ' + found.node
	);

	let server;
	let result;
	try {
		server = await startServer();

		const health = await fetch(server.url + '/healthz', {
			signal: AbortSignal.timeout(5000)
		});
		const healthBody = await health.text();
		if (health.status !== 200 || healthBody !== 'OK') {
			throw new Error('health check returned ' + health.status + ' ' + JSON.stringify(healthBody));
		}

		// handshakeTimeout bounds the upgrade inside ws itself; waitForOpen bounds
		// the wait here. Both, because they cover different stalls: ws only arms
		// its timer for the HTTP response, so a server that answers 101 and then
		// goes silent is caught by the second, not the first.
		const client = server.track(new WebSocket(server.wsUrl, { handshakeTimeout: 5000 }));
		await waitForOpen(client);

		const subscribed = waitForFrame(
			client,
			(frame) => frame?.type === 'subscribed' && frame.topic === 'smoke',
			'subscribe acknowledgement'
		);
		client.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
		client.send(JSON.stringify({ type: 'subscribe', topic: 'smoke', ref: 'smoke-subscribe' }));
		await subscribed;

		// The publish is triggered BY THE CLIENT and delivered back to it, so
		// this is a full client -> real server -> client round trip through
		// the deployed runtime rather than a server-side call the client
		// merely observes.
		const delivered = waitForFrame(
			client,
			(frame) => frame?.topic === 'smoke' && frame.event === 'checkpoint' && frame.data?.ok === true,
			'published checkpoint'
		);
		client.send(JSON.stringify({
			type: 'broadcast',
			topic: 'smoke',
			event: 'checkpoint',
			payload: { ok: true },
			options: { seq: false }
		}));
		await delivered;

		result = {
			...found,
			healthStatus: health.status,
			event: 'smoke/checkpoint'
		};
	} finally {
		await server?.close();
	}
	log('smoke OK: HTTP /healthz 200; WebSocket subscribe + publish delivered; teardown complete');
	return result;
}

async function main() {
	try {
		await runSmoke();
	} catch (error) {
		console.error('smoke FAILED: ' + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
