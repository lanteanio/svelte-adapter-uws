// ADAPTER-ERR-CLUSTER-WORKER-ERROR, driven from the condition it claims.
//
// The entry's cause is a worker thread emitting an error event to the
// primary - it threw outside a request or failed during startup - and its
// recovery prose has two halves: the supervisor replaces the exiting worker
// per incident, and the replacement loop is bounded by the slot's restart
// budget. A real clustered runtime is the only place a worker thread's
// uncaught exception exists, so the case boots the built worker-crash
// fixture variant, crashes one worker through an authenticated frame on a
// real socket, and reads the primary's own console: the emitted event, the
// charged restart attempt against the budget, and the replacement worker
// registering. The workers are threads inside the one child process, so
// killing the child leaves nothing behind.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { hasUWS, EVAL_TIME_ENV, freePort } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';

const describeUWS = hasUWS ? describe : describe.skip;

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, variantOut('workercrash'), 'index.js');

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;

describeUWS('ADAPTER-ERR-CLUSTER-WORKER-ERROR', () => {
	beforeAll(() => {
		expect(buildFixtureOnce('workercrash')).toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already gone */ }
		}
		child = null;
	});

	it('reports the crashed worker, charges its slot against the restart budget, and replaces it', async () => {
		const port = await freePort();
		const token = randomUUID();
		const env = { ...process.env };
		for (const key of EVAL_TIME_ENV) delete env[key];
		env.HOST = '127.0.0.1';
		env.PORT = String(port);
		env.CLUSTER_WORKERS = '2';
		env.CLUSTER_MODE = 'acceptor';
		env.WORKER_CRASH_DRILL_TOKEN = token;

		const proc = spawn(process.execPath, [builtEntry], {
			cwd: fixtureDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env
		});
		child = proc;

		let output = '';
		/**
		 * Resolve once `predicate(output)` holds; false on exit or deadline.
		 * Listeners detach on settle so a later wait never double-appends a
		 * chunk; between waits the paused pipes buffer, nothing is lost.
		 */
		const outputReaches = (predicate, ms) => new Promise((resolve) => {
			if (predicate(output)) return resolve(true);
			const done = (hit) => {
				clearTimeout(timer);
				proc.stdout.off('data', scan);
				proc.stderr.off('data', scan);
				proc.off('exit', onExit);
				resolve(hit);
			};
			const timer = setTimeout(() => done(false), ms);
			const scan = (chunk) => {
				output += chunk.toString();
				if (predicate(output)) done(true);
			};
			const onExit = () => done(false);
			proc.stdout.on('data', scan);
			proc.stderr.on('data', scan);
			proc.on('exit', onExit);
		});

		const registrations = (text) => (text.match(/Worker thread \d+ registered/g) || []).length;

		const booted = await outputReaches(
			(text) => registrations(text) >= 2 && text.includes('Acceptor listening'),
			30000
		);
		expect(booted, `the two-worker fixture must boot.\n--- server output ---\n${output}`).toBe(true);

		// Crash one worker through the real wire: the hook schedules the throw
		// off the request context, so the worker's uncaught exception surfaces
		// as the primary's worker 'error' event.
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		ws.send(JSON.stringify({ type: 'worker-crash-drill', token }));
		const armed = await outputReaches((text) => text.includes('__WORKER_CRASH_DRILL_ARMED__'), 15000);
		expect(armed, `the drill frame must reach a worker.\n--- server output ---\n${output}`).toBe(true);
		try { ws.close(); } catch {}

		// The entry's event, with the primary still alive to print it.
		const reported = await outputReaches((text) => text.includes('event=cluster.worker-error'), 15000);
		expect(reported, `the worker error must be reported.\n--- server output ---\n${output}`).toBe(true);
		expect(output).toContain('A worker thread reported an error.');

		// Recovery, both halves the entry describes: the exit is charged
		// against the slot's bounded budget, and a replacement registers -
		// a third registration beyond the two boot ones.
		const replaced = await outputReaches(
			(text) => text.includes('/50)') && registrations(text) >= 3,
			30000
		);
		expect(replaced, `the crashed worker must be charged and replaced.\n--- server output ---\n${output}`).toBe(true);
		expect(output).toMatch(/exited with code 1, restarting in \d+ms\.\.\. \(attempt 1\/50\)/);
	}, 120000);
});
