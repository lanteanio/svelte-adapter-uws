// What the runtime carries from `res.upgrade()` to `open` arrives, whatever the
// process has installed on Object.prototype.
//
// uWS copies upgrade userData onto the object `open` receives with plain
// assignments, so an accessor on Object.prototype for a carried key takes the
// value and the far side never sees it. The runtime used to carry the request
// id, the trace context and the admission permit on string keys, and a taken
// permit refused every connection while `maxConnections` was set. They now ride
// keys no other code can name.
//
// This has to run in a process of its own: under vitest the userData object
// comes from the native addon, whose prototype chain does not reach the
// Object.prototype a test module can see, so an accessor installed here would
// never be consulted. The server is booted with a preload that installs the
// accessors in the server's own realm.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasUWS } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

const describeUWS = hasUWS ? describe : describe.skip;
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

/** Every string key an earlier carrier rode on. */
const TAKEN_KEYS = ['__adapter_uws_request_id__', '__uwsTraceContext', '__adapter_uws_connection_permit__'];

function freePort() {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
	});
}

describeUWS('the upgrade carry under accessors on Object.prototype', () => {
	let child = null;
	let dir = null;
	let port = 0;
	let output = '';

	beforeAll(async () => {
		// The variant with a live-connection ceiling, so the admission permit
		// crosses the upgrade too.
		expect(buildFixtureOnce('waitingdefault'), 'fixture build must succeed').toBe(true);
		dir = mkdtempSync(path.join(tmpdir(), 'upgrade-carry-'));
		const preload = path.join(dir, 'accessors.mjs');
		writeFileSync(preload, TAKEN_KEYS.map((key) =>
			`Object.defineProperty(Object.prototype, ${JSON.stringify(key)}, { configurable: true, set() {}, get() { return undefined; } });`
		).join('\n') + '\n');
		port = await freePort();
		const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port) };
		delete env.CLUSTER_WORKERS;
		// A production process: under a test env a fatal() throws where it
		// would stop the worker, and the exit this case watches for never comes.
		delete env.VITEST;
		delete env.VITEST_WORKER_ID;
		delete env.VITEST_POOL_ID;
		if (env.NODE_ENV === 'test') delete env.NODE_ENV;
		child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(fixtureDir, 'build-waiting-default', 'index.js')], {
			cwd: fixtureDir, env, stdio: ['ignore', 'pipe', 'pipe']
		});
		await new Promise((resolve, reject) => {
			const scan = (b) => { output += b; if (output.includes('Ready for traffic')) resolve(undefined); };
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => reject(new Error('server exited before ready:\n' + output)));
			setTimeout(() => reject(new Error('server never ready:\n' + output)), 60000);
		});
	}, 400000);

	afterAll(() => {
		child?.kill('SIGKILL');
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('opens the connection and hands it the request id the upgrade carried', async () => {
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-request-id': 'carry-probe-1' } });
		const answer = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('no answer:\n' + output)), 5000);
			ws.on('error', (err) => { clearTimeout(timer); reject(err); });
			ws.on('close', (code) => { clearTimeout(timer); reject(new Error(`closed ${code} before answering:\n${output}`)); });
			ws.on('open', () => ws.send(JSON.stringify({ type: 'request-id-probe' })));
			ws.on('message', (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.topic === 'probe' && msg.event === 'request-id') { clearTimeout(timer); resolve(msg.data); }
			});
		});
		ws.terminate();
		expect(answer.requestId).toBe('carry-probe-1');
		expect(child.exitCode, 'the server is still running').toBeNull();
		expect(output).not.toContain('connection-permit-carrier');
	});
});
