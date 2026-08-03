#!/usr/bin/env node
/**
 * Short, visible proof that this checkout can run the adapter's real native
 * transport. This deliberately uses the public testing entry point: it binds a
 * real uWebSockets.js server, exercises the liveness route, opens a real ws
 * client, subscribes, and observes a publish before tearing everything down.
 *
 * @module scripts/smoke
 */
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createTestServer } from '../src/testing.js';

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
		server = await createTestServer();

		const health = await fetch(server.url + '/healthz', {
			signal: AbortSignal.timeout(5000)
		});
		const healthBody = await health.text();
		if (health.status !== 200 || healthBody !== 'OK') {
			throw new Error('health check returned ' + health.status + ' ' + JSON.stringify(healthBody));
		}

		const client = server.track(new WebSocket(server.wsUrl));
		await once(client, 'open');

		const subscribed = waitForFrame(
			client,
			(frame) => frame?.type === 'subscribed' && frame.topic === 'smoke',
			'subscribe acknowledgement'
		);
		client.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
		client.send(JSON.stringify({ type: 'subscribe', topic: 'smoke', ref: 'smoke-subscribe' }));
		await subscribed;

		const delivered = waitForFrame(
			client,
			(frame) => frame?.topic === 'smoke' && frame.event === 'checkpoint' && frame.data?.ok === true,
			'published checkpoint'
		);
		server.platform.publish('smoke', 'checkpoint', { ok: true });
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
