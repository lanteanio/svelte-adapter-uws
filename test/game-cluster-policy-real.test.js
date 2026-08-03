import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { freePort } from './helpers/real-runtime.js';
import { GAME_LANE_CLUSTER_ERROR } from '../src/runtime/handler/game-ingress.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');
const builtSingleHomeEntry = path.join(fixtureDir, 'build-gamehome', 'index.js');
const require = createRequire(import.meta.url);

let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }
let hasUws = true;
try { require.resolve('uWebSockets.js'); } catch { hasUws = false; }

const describeReal = hasUws && WebSocket !== null ? describe : describe.skip;

describeReal('real clustered game-lane topology guard', () => {
	let child = null;

	beforeAll(() => {
		expect(buildFixtureOnce('default'), 'default fixture failed to build').toBe(true);
		expect(buildFixtureOnce('gamehome'), 'single-home fixture failed to build').toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch {}
		}
		child = null;
	});

	let lastOutput = () => '';

	async function probe(entry, extraEnv = {}) {
		const port = await freePort();
		let output = '';
		lastOutput = () => output;
		const env = {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			CLUSTER_WORKERS: '2',
			CLUSTER_MODE: 'acceptor',
			...extraEnv
		};
		delete env.SSL_CERT;
		delete env.SSL_KEY;
		child = spawn(process.execPath, [entry], {
			cwd: fixtureDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env
		});
		const ready = await new Promise((resolve) => {
			const scan = (chunk) => {
				output += chunk.toString();
				if (output.includes('Acceptor listening')) resolve(true);
			};
			child.stdout.on('data', scan);
			child.stderr.on('data', scan);
			child.on('exit', () => resolve(false));
			setTimeout(() => resolve(false), 20_000);
		});
		expect(ready, `cluster did not listen\n${output}`).toBe(true);

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
			const timer = setTimeout(() => {
				ws.close();
				reject(new Error(`game policy response timed out\n${output}`));
			}, 10_000);
			ws.on('open', () => ws.send(JSON.stringify({ type: 'game-policy-probe', topic: 'arena:1' })));
			ws.on('message', (data) => {
				let frame;
				try { frame = JSON.parse(data.toString()); } catch { return; }
				if (frame.topic !== 'probe' || frame.event !== 'game-policy') return;
				clearTimeout(timer);
				ws.close();
				resolve(frame.data);
			});
			ws.on('error', reject);
		});
	}

	it('rejects a grant on the built worker when two I/O workers can own sockets', async () => {
		const result = await probe(builtEntry);
		expect(result).toEqual({ ok: false, error: GAME_LANE_CLUSTER_ERROR });
	}, 60_000);

	it('allows the same built grant with one I/O home plus a compute worker', async () => {
		const result = await probe(builtSingleHomeEntry);
		expect(result).toEqual({ ok: true });
	}, 60_000);

	it('denies publishGame on a compute worker even in the supported single-home topology', async () => {
		// The socket-owning I/O worker passing (previous test) is only half the
		// invariant: a compute worker in the SAME topology has no sockets, so a
		// publishGame there would stamp seqs into its own topicSeqs and fan out
		// to nobody - a second, silently-empty room sequencer. The fixture's
		// init hook attempts publishGame on every worker and logs role +
		// outcome, so this asserts the denial on the real compute worker in the
		// real built runtime.
		const result = await probe(builtSingleHomeEntry, { GAME_POLICY_INIT_PROBE: '1' });
		expect(result).toEqual({ ok: true });
		const line = lastOutput().split('\n').find((candidate) =>
			candidate.includes('__GAME_POLICY_INIT__') && candidate.includes('role=compute'));
		expect(line, `no compute-worker probe line in output\n${lastOutput()}`).toBeTruthy();
		expect(line).toContain(GAME_LANE_CLUSTER_ERROR);
	}, 60_000);
});
