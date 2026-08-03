#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildFixtureOnce } from '../test/helpers/fixture-build.js';

if (process.platform !== 'linux') {
	console.log('external-respawner drill: skipped (Linux only)');
	process.exit(0);
}

const fixtureDir = fileURLToPath(new URL('../test/fixture/', import.meta.url));
const entry = fileURLToPath(new URL('../test/fixture/build-respawner/index.js', import.meta.url));
const supervisorEntry = fileURLToPath(new URL('../test/fixtures/external-respawner.mjs', import.meta.url));
const token = `respawner-${process.pid}-${Date.now()}`;
const events = [];
const bus = new EventEmitter();
let output = '';
let supervisor = null;

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => resolve(address.port));
		});
	});
}

function record(event) {
	events.push(event);
	bus.emit('event', event);
}

function waitForEvent(predicate, timeoutMs, label) {
	const existing = events.find(predicate);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			bus.off('event', inspect);
			reject(new Error(`timed out waiting for ${label}\n--- supervisor output ---\n${output}`));
		}, timeoutMs);
		function inspect(event) {
			if (!predicate(event)) return;
			clearTimeout(timer);
			bus.off('event', inspect);
			resolve(event);
		}
		bus.on('event', inspect);
	});
}

async function waitForReady(port, timeoutMs, generation) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
				signal: AbortSignal.timeout(1000)
			});
			if (response.status === 200 && await response.text() === 'ready') return;
		} catch { /* the supervised child is still booting */ }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`generation ${generation} never became ready\n--- supervisor output ---\n${output}`);
}

function wedgeWorker(port) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error('worker-wedge WebSocket never opened'));
		}, 10000);
		socket.once('open', () => {
			clearTimeout(timer);
			socket.send(JSON.stringify({ type: 'respawner-drill-wedge', token }));
			resolve(socket);
		});
		socket.once('error', reject);
	});
}

async function stopSupervisor() {
	if (supervisor === null || supervisor.exitCode !== null) return;
	const exited = new Promise((resolve) => supervisor.once('exit', resolve));
	supervisor.send?.({ type: 'stop' });
	const timer = setTimeout(() => supervisor?.kill('SIGKILL'), 20000);
	await exited;
	clearTimeout(timer);
}

try {
	assert.equal(buildFixtureOnce('respawner'), true, 'respawner fixture build must succeed');
	const port = await freePort();
	supervisor = spawn(process.execPath, [supervisorEntry, entry], {
		cwd: fixtureDir,
		env: {
			...process.env,
			RESPAWNER_CWD: fixtureDir,
			RESPAWNER_DRILL_TOKEN: token,
			HOST: '127.0.0.1',
			PORT: String(port),
			CLUSTER_WORKERS: '2',
			CLUSTER_MODE: 'reuseport',
			SHUTDOWN_DELAY_MS: '0',
			SHUTDOWN_TIMEOUT: '10',
			NODE_ENV: 'production'
		},
		stdio: ['ignore', 'pipe', 'pipe', 'ipc']
	});
	supervisor.on('message', record);
	supervisor.once('error', (error) => record({ type: 'supervisor-error', message: error.message }));
	for (const stream of [supervisor.stdout, supervisor.stderr]) {
		stream.on('data', (chunk) => {
			output = (output + chunk.toString()).slice(-65536);
			process.stdout.write(chunk);
		});
	}

	const first = await waitForEvent((event) => event.type === 'spawn' && event.generation === 1, 10000, 'first supervised spawn');
	await waitForReady(port, 30000, 1);
	const socket = await wedgeWorker(port);
	const workerExit = await waitForEvent((event) => event.type === 'exit' && event.generation === 1, 65000, 'wedged-worker hard exit');
	assert.equal(workerExit.signal, 'SIGKILL');
	assert.match(output, /__RESPAWNER_DRILL_WORKER_WEDGED__/);
	const second = await waitForEvent((event) => event.type === 'spawn' && event.generation === 2, 10000, 'worker-failure respawn');
	assert.notEqual(second.pid, first.pid);
	await waitForReady(port, 30000, 2);
	socket.terminate();

	supervisor.send({ type: 'kill-primary' });
	const primaryExit = await waitForEvent((event) => event.type === 'exit' && event.generation === 2, 10000, 'primary SIGKILL');
	assert.equal(primaryExit.signal, 'SIGKILL');
	const third = await waitForEvent((event) => event.type === 'spawn' && event.generation === 3, 10000, 'primary-failure respawn');
	assert.notEqual(third.pid, second.pid);
	await waitForReady(port, 30000, 3);

	console.log(`external-respawner drill: PASS (generations ${first.pid} -> ${second.pid} -> ${third.pid})`);
} finally {
	await stopSupervisor();
}
