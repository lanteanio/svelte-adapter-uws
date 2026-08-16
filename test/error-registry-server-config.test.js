// Registry entries driven from the conditions they claim, on the server
// surfaces an application configures: the packaged test server (src/testing.js)
// running its hook lanes in-process, and the built cluster entry judging its
// boot configuration in a spawned child.
//
// The reference generator verifies that entries EXIST, are indexed, and render
// into docs/errors.md; it cannot check that the cause an entry names is
// reachable or that the consequence it promises is what the code delivers. A
// case here reaches the named condition through the real code path, then holds
// the entry to its own words: the exact console line composed through the
// registry, the operational event's fields, the exit code, and what the
// connected client does or does not receive.
//
// The cluster guards live in the primary's boot path, which only a real
// process evaluates - the in-process harness imports the built handler and
// never runs the primary entry - so those cases spawn the built fixture entry
// and assert on its exit code and output. Every refusal here is pre-spawn, so
// no fleet ever boots and killing the child leaves nothing behind.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { hasUWS, EVAL_TIME_ENV } from './helpers/real-runtime.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { variantOut } from './fixture/variants.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY, adapterConsoleLine } from '../src/runtime/error-registry.js';
import { setOperationalEventSink } from '../src/runtime/diagnostic.js';

const describeUWS = hasUWS ? describe : describe.skip;
// The reuseport refusal exists only where the platform cannot do reuseport;
// on Linux the guard is structurally unreachable (reuseport is the default
// there and the platform check passes), so the case runs on the platforms
// where the condition is real.
const describeNonLinuxUWS =
	hasUWS && (process.platform === 'win32' || process.platform === 'darwin') ? describe : describe.skip;

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

/** @param {string} id */
function entryFor(id) {
	const entry = ADAPTER_ERROR_REGISTRY.find((candidate) => candidate.id === id);
	expect(entry, `no registry entry for ${id}`).toBeTruthy();
	return entry;
}

/** Connect a ws client and capture every text frame the server sends. */
async function connectAndCapture(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	const waiters = [];
	ws.on('message', (raw) => {
		const text = raw.toString();
		const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
		const frame = { text, parsed };
		frames.push(frame);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].pred(frame)) {
				waiters[i].resolve(frame);
				waiters.splice(i, 1);
			}
		}
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return {
		ws,
		frames,
		waitFor(pred, timeout = 2000) {
			const existing = frames.find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.pred === pred);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error('waitFor timed out'));
				}, timeout);
				waiters.push({ pred, resolve: (f) => { clearTimeout(timer); resolve(f); } });
			});
		}
	};
}

let server = null;
/** @type {(() => void) | null} */
let disposeSink = null;

describeUWS('ADAPTER-ERR-UPGRADE-HOOK', () => {
	afterEach(async () => {
		disposeSink?.();
		disposeSink = null;
		await server?.close();
		server = null;
	});

	it('a throwing upgrade hook refuses the handshake with a correlated 500 and the indexed event; reconnecting runs the hook again', async () => {
		const entry = entryFor('ADAPTER-ERR-UPGRADE-HOOK');
		const { createTestServer } = await import('../src/testing.js');
		const { WebSocket } = await import('ws');
		const events = [];
		disposeSink = setOperationalEventSink((record) => { events.push(record); });

		let hookCalls = 0;
		server = await createTestServer({
			handler: {
				upgrade() {
					hookCalls++;
					throw new Error('handshake refused by hook');
				}
			}
		});

		// One handshake attempt: the socket must never open, and the refusal
		// must be the correlated 500 the runtime writes after the hook throw.
		const attempt = () => new Promise((resolve, reject) => {
			const ws = new WebSocket(server.wsUrl);
			let opened = false;
			ws.on('open', () => { opened = true; ws.close(); });
			ws.on('unexpected-response', (req, res) => {
				const status = res.statusCode;
				const requestId = res.headers['x-request-id'];
				req.destroy();
				resolve({ opened, status, requestId });
			});
			ws.on('close', () => { if (opened) resolve({ opened, status: null, requestId: null }); });
			ws.on('error', (err) => { if (!opened) reject(err); });
		});

		const first = await attempt();
		// The entry's consequence: that upgrade does not complete and the
		// client cannot open its WebSocket.
		expect(first.opened).toBe(false);
		expect(first.status).toBe(500);
		expect(typeof first.requestId).toBe('string');

		// The emission carries the entry's own event/component/severity, its
		// message IS the indexed problem prefix, and the attached error plus
		// the request correlation the next action leans on are both present.
		const record = events.find((r) => r.event === entry.event);
		expect(record, 'the upgrade failure must emit the indexed operational event').toBeTruthy();
		expect(record.component).toBe(entry.component);
		expect(record.severity).toBe(entry.severity);
		expect(record.message).toBe(entry.problemPrefix);
		expect(record.attributes?.requestId).toBe(first.requestId);
		expect(record.attributes?.error).toBeTruthy();

		// Nothing is cached: a reconnect runs the hook again and is refused
		// again, which is the automatic-recovery statement of the entry.
		const second = await attempt();
		expect(second.status).toBe(500);
		expect(hookCalls).toBe(2);

		// The next action says HTTP continues to work while the WS handshake
		// fails; an ordinary HTTP request must still be answered.
		const res = await fetch(server.url + '/healthz');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
	}, 30000);
});

describeUWS('ADAPTER-ERR-RECOVER-HOOK', () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await server?.close();
		server = null;
	});

	it('a throwing resume hook on recover-on-subscribe still completes the subscription, reports no gap, and prints the indexed line', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const errorLines = [];
		vi.spyOn(console, 'error').mockImplementation((...args) => { errorLines.push(args); });

		server = await createTestServer({
			handler: {
				resume() { throw new Error('backfill source down'); }
			}
		});

		const client = await connectAndCapture(server.wsUrl);
		await client.waitFor((f) => f.parsed?.type === 'welcome');
		client.ws.send(JSON.stringify({ type: 'subscribe', topic: 'room:1', ref: 7, recover: { offset: 3 } }));

		// The entry's consequence: the subscription itself still completes.
		const ack = await client.waitFor((f) => f.parsed?.type === 'subscribed' && f.parsed?.topic === 'room:1');
		expect(ack.parsed.ref).toBe(7);

		// The console line is the registry's own composition, byte for byte,
		// with the hook's original throw attached as the second argument.
		const expected = adapterConsoleLine(ADAPTER_ERROR_IDS.RECOVER_HOOK);
		const line = errorLines.find((args) => args[0] === expected);
		expect(line, `expected console.error line ${JSON.stringify(expected)}`).toBeTruthy();
		expect(line[1]).toBeInstanceOf(Error);
		expect(line[1].message).toBe('backfill source down');

		// Live delivery continues from the moment of subscription.
		server.platform.publish('room:1', 'tick', { n: 1 });
		const live = await client.waitFor((f) => f.parsed?.event === 'tick');
		expect(live.parsed.data).toEqual({ n: 1 });

		// And no gap is reported to the client: the replay channel's
		// truncation signal is the only wire shape a gap report has, and no
		// replay-channel frame arrived at all.
		const replayFrames = client.frames.filter((f) =>
			typeof f.parsed?.topic === 'string' && f.parsed.topic.startsWith('__replay:')
		);
		expect(replayFrames).toEqual([]);
		expect(client.frames.some((f) => f.parsed?.event === 'truncated')).toBe(false);

		client.ws.close();
	}, 30000);
});

// -- Spawned-child cases: the cluster primary judging its boot configuration --

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;

function bootEntry(builtEntry, envOverrides) {
	const env = { ...process.env };
	for (const key of EVAL_TIME_ENV) delete env[key];
	env.HOST = '127.0.0.1';
	env.PORT = '0';
	Object.assign(env, envOverrides);
	const proc = spawn(process.execPath, [builtEntry], {
		cwd: fixtureDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env
	});
	child = proc;
	return proc;
}

function refusalOf(builtEntry, envOverrides) {
	const proc = bootEntry(builtEntry, envOverrides);
	return new Promise((resolve) => {
		let output = '';
		proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
		proc.stderr.on('data', (chunk) => { output += chunk.toString(); });
		const deadline = setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* already gone */ }
			resolve({ code: null, output: output + '\n[test deadline reached]' });
		}, 20000);
		proc.on('exit', (code) => {
			clearTimeout(deadline);
			resolve({ code, output });
		});
	});
}

const killChild = () => {
	if (child && !child.killed) {
		try { child.kill('SIGKILL'); } catch { /* already gone */ }
	}
	child = null;
};

describeUWS('ADAPTER-ERR-CLUSTER-CONFIG-MODE', () => {
	const builtEntry = path.join(fixtureDir, variantOut('default'), 'index.js');

	beforeAll(() => {
		expect(buildFixtureOnce()).toBe(true);
	}, 400000);

	afterEach(killChild);

	it('an unknown CLUSTER_MODE exits 1 with the indexed line before any worker spawns', async () => {
		const { code, output } = await refusalOf(builtEntry, {
			CLUSTER_WORKERS: '1',
			CLUSTER_MODE: 'bogus'
		});
		expect(code, `CLUSTER_MODE=bogus must exit 1: ${output.slice(0, 400)}`).toBe(1);
		expect(output).toContain('[ADAPTER-ERR-CLUSTER-CONFIG-MODE]');
		// The printed line is the registry's composition for this value - the
		// prefix, the offending token, and the two accepted modes.
		expect(output).toContain(
			adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_MODE, "bogus'. Use 'reuseport' or 'acceptor'.")
		);
		// Pre-spawn: the primary never announced a fleet.
		expect(output).not.toContain('Primary thread starting');
	}, 120000);
});

describeUWS('ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE', () => {
	// This variant is built with websocket.workers.compute = 1, so a total
	// worker count of 1 leaves no I/O worker to listen - exactly the cause the
	// entry names. The compute split is a build-time option, which is why the
	// condition needs its own built variant rather than an env knob.
	const builtEntry = path.join(fixtureDir, variantOut('gamehome'), 'index.js');

	beforeAll(() => {
		expect(buildFixtureOnce('gamehome')).toBe(true);
	}, 400000);

	afterEach(killChild);

	it('a compute count equal to the total worker count exits 1 with the indexed line before any worker spawns', async () => {
		const { code, output } = await refusalOf(builtEntry, {
			CLUSTER_WORKERS: '1',
			CLUSTER_MODE: 'acceptor'
		});
		expect(code, `compute=1 of 1 workers must exit 1: ${output.slice(0, 400)}`).toBe(1);
		expect(output).toContain('[ADAPTER-ERR-CLUSTER-CONFIG-COMPUTE]');
		expect(output).toContain(
			adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_COMPUTE, '1) must be less than the total worker count (1).')
		);
		expect(output).not.toContain('Primary thread starting');
	}, 120000);
});

describeNonLinuxUWS('ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT', () => {
	const builtEntry = path.join(fixtureDir, variantOut('default'), 'index.js');

	beforeAll(() => {
		expect(buildFixtureOnce()).toBe(true);
	}, 400000);

	afterEach(killChild);

	it('requesting reuseport on a platform that cannot do it exits 1 with the indexed line and its shortlink', async () => {
		const entry = entryFor('ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT');
		const { code, output } = await refusalOf(builtEntry, {
			CLUSTER_WORKERS: '1',
			CLUSTER_MODE: 'reuseport'
		});
		expect(code, `CLUSTER_MODE=reuseport on ${process.platform} must exit 1: ${output.slice(0, 400)}`).toBe(1);
		expect(output).toContain('[ADAPTER-ERR-CLUSTER-CONFIG-REUSEPORT]');
		// The composed line names the platform that cannot do it, tells the
		// operator the way back to the default, and carries the entry's link.
		expect(output).toContain(
			adapterConsoleLine(
				ADAPTER_ERROR_IDS.CLUSTER_CONFIG_REUSEPORT,
				`${process.platform}). Remove CLUSTER_MODE to use the default acceptor mode.`
			)
		);
		expect(output).toContain(' See: ' + entry.link);
		expect(output).not.toContain('Primary thread starting');
	}, 120000);
});
