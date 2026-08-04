import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { freePort } from './helpers/real-runtime.js';
import {
	BATCH_SEQUENCE_ERROR,
	CLUSTER_SEQUENCE_ERROR
} from '../src/runtime/handler/cluster-sequence-policy.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }
let hasUws = true;
try { require.resolve('uWebSockets.js'); } catch { hasUws = false; }
const describeReal = hasUws && WebSocket !== null ? describe : describe.skip;

describeReal('real clustered sequence-authority policy', () => {
	let child = null;

	beforeAll(() => {
		expect(buildFixtureOnce('default'), 'default fixture failed to build').toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch {}
		}
		child = null;
	});

	async function boot(totalWorkers) {
		const port = await freePort();
		let output = '';
		const env = {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			CLUSTER_WORKERS: String(totalWorkers),
			CLUSTER_MODE: 'acceptor'
		};
		delete env.SSL_CERT;
		delete env.SSL_KEY;
		child = spawn(process.execPath, [builtEntry], {
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

		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		});
		let nonce = 0;
		return {
			output: () => output,
			async probe(entry, options) {
				const wanted = ++nonce;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`sequence policy response timed out\n${output}`)), 10_000);
					const onMessage = (data) => {
						let frame;
						try { frame = JSON.parse(data.toString()); } catch { return; }
						if (frame.topic !== 'probe' || frame.event !== 'sequence-policy' || frame.data?.nonce !== wanted) return;
						clearTimeout(timer);
						ws.off('message', onMessage);
						resolve(frame.data);
					};
					ws.on('message', onMessage);
					ws.send(JSON.stringify({ type: 'sequence-policy-probe', entry, options, nonce: wanted }));
				});
			},
			async pluginProbe(entry) {
				const wanted = ++nonce;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`plugin probe timed out\n${output}`)), 10_000);
					const onMessage = (data) => {
						let frame;
						try { frame = JSON.parse(data.toString()); } catch { return; }
						const isAnswer = frame.topic === 'probe' && frame.event === 'plugin-cluster' && frame.data?.nonce === wanted;
						const isGroupFrame = frame.event === 'group-probe' && frame.data?.nonce === wanted;
						if (!isAnswer && !isGroupFrame) return;
						clearTimeout(timer);
						ws.off('message', onMessage);
						resolve(isGroupFrame
							? { ok: true, delivered: true, topic: frame.topic }
							: frame.data);
					};
					ws.on('message', onMessage);
					ws.send(JSON.stringify({ type: 'plugin-cluster-probe', entry, nonce: wanted }));
				});
			},
			close() { ws.close(); }
		};
	}

	it('rejects every implicit production publisher before delivery in a multi-worker runtime', async () => {
		const server = await boot(2);
		for (const entry of ['publish', 'wire', 'wire-batch', 'batch', 'loop-batch']) {
			const result = await server.probe(entry, undefined);
			expect(result, entry).toMatchObject({ ok: false, error: CLUSTER_SEQUENCE_ERROR });
			expect(Number.isInteger(result.nonce), entry).toBe(true);
		}
		expect((await server.probe('publish', { relay: false })).error).toBe(CLUSTER_SEQUENCE_ERROR);
		expect((await server.probe('publish', { seq: 7 })).error).toBe(CLUSTER_SEQUENCE_ERROR);
		expect((await server.probe('publish', { seq: true, relay: false })).error).toBe(CLUSTER_SEQUENCE_ERROR);
		for (const seq of [0, -1, 1.5, null]) {
			expect((await server.probe('publish', { seq, relay: false })).error, String(seq))
				.toBe(CLUSTER_SEQUENCE_ERROR);
		}
		server.close();
	}, 60_000);

	it('allows unsequenced or externally ordered fan-out, and rejects repeated numeric batch seqs', async () => {
		const server = await boot(2);
		expect((await server.probe('publish', { seq: false })).ok).toBe(true);
		expect((await server.probe('wire', { seq: 11, relay: false })).ok).toBe(true);
		expect((await server.probe('batch', { seq: 12, relay: false })).ok).toBe(true);
		expect((await server.probe('loop-batch', { seq: 13, relay: false })).ok).toBe(true);
		expect((await server.probe('wire-batch', { seq: false })).ok).toBe(true);
		expect((await server.probe('wire-batch', { seq: 14, relay: false })).error)
			.toBe(BATCH_SEQUENCE_ERROR);
		// The refusal is a property of the surface, not of the array it was
		// handed: a single-entry batch and an empty one answer the same, so a
		// caller cannot discover the rule only once a tick produces two updates.
		expect((await server.probe('wire-batch-one', { seq: 14, relay: false })).error)
			.toBe(BATCH_SEQUENCE_ERROR);
		expect((await server.probe('wire-batch-empty', { seq: 14, relay: false })).error)
			.toBe(BATCH_SEQUENCE_ERROR);
		// A valid unsequenced empty batch is still the no-op it always was.
		expect(await server.probe('wire-batch-empty', { seq: false }))
			.toMatchObject({ ok: true, result: false });
		server.close();
	}, 60_000);

	it('bundled plugins declare their own sequence authority and keep working in a cluster', async () => {
		// The regression this pins: the sequence guard landed on
		// platform.publish/publishWire while the bundled plugins passed no
		// options, so cursor, presence, groups and replay threw on every
		// broadcast in any multi-worker runtime - invisible to the direct
		// probe entries above. group-roundtrip drives the REAL groups plugin
		// (join -> internal-topic broadcast -> client-delivered frame).
		const server = await boot(2);
		const group = await server.pluginProbe('group-roundtrip');
		expect(group.ok, JSON.stringify(group)).toBe(true);
		expect(group.delivered).toBe(true);
		// The in-memory replay buffer is per-worker state and must refuse the
		// clustered topology at creation with the fix in the message, rather
		// than throwing mid-flight on every publish.
		const replay = await server.pluginProbe('replay-create');
		expect(replay.ok).toBe(false);
		expect(replay.error).toContain('per-worker');
		server.close();
	}, 60_000);

	it('the in-memory replay buffer stays available with exactly one worker', async () => {
		const server = await boot(1);
		const replay = await server.pluginProbe('replay-create');
		expect(replay).toMatchObject({ ok: true, seq: 0 });
		server.close();
	}, 60_000);

	it('keeps the implicit in-memory counter available with exactly one worker', async () => {
		const server = await boot(1);
		for (const entry of ['publish', 'wire', 'wire-batch', 'batch', 'loop-batch']) {
			expect((await server.probe(entry, undefined)).ok, entry).toBe(true);
		}
		server.close();
	}, 60_000);
});
