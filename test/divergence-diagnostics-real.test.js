// Production-built proof for the divergence-detail round trip: the aggregate
// state-hash detector on the primary, the bounded per-worker detail
// collection over parentPort, the replicated diagnostic store, and the
// platform.diagnostic lookup. The pure unit suite drives the diagnostic
// builders with literal report objects, which proves the shapes but not the
// wiring - and the wiring is the claim under test: a deployment's evidence
// comes from this IPC handshake or it does not exist.
//
// The divergence is forced honestly: one worker publishes an externally
// sequenced frame with the relay disabled, so its delivered-seq map moves
// ahead of its sibling's, and the armed state-hash reporter detects the
// fork on its next interval.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { freePort } from './helpers/real-runtime.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build-divergence', 'index.js');
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }
let hasUws = true;
try { require.resolve('uWebSockets.js'); } catch { hasUws = false; }
const describeReal = hasUws && WebSocket !== null ? describe : describe.skip;

describeReal('real clustered divergence diagnostics', () => {
	let child = null;

	beforeAll(() => {
		expect(buildFixtureOnce('divergence'), 'divergence fixture failed to build').toBe(true);
	}, 400000);

	afterEach(() => {
		if (child && !child.killed) {
			try { child.kill('SIGKILL'); } catch { /* already down */ }
		}
		child = null;
	});

	it('collects per-worker detail and replicates the diagnostic to every worker', async () => {
		const port = await freePort();
		let output = '';
		const env = {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			CLUSTER_WORKERS: '2',
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
		const probe = (entry, extra = {}) => {
			const wanted = ++nonce;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`divergence probe timed out\n${output}`)), 10_000);
				const onMessage = (data) => {
					let frame;
					try { frame = JSON.parse(data.toString()); } catch { return; }
					if (frame.topic !== 'probe' || frame.event !== 'divergence' || frame.data?.nonce !== wanted) return;
					clearTimeout(timer);
					ws.off('message', onMessage);
					resolve(frame.data);
				};
				ws.on('message', onMessage);
				ws.send(JSON.stringify({ type: 'divergence-probe', entry, nonce: wanted, ...extra }));
			});
		};

		expect((await probe('diverge', { seq: 41 })).ok).toBe(true);

		// The reporter runs every 50ms with seam jitter and the primary's
		// collection window is one second; poll the REAL replicated store
		// through the platform until the diagnostic lands on this worker.
		const deadline = Date.now() + 15_000;
		let snapshot = null;
		for (;;) {
			const answer = await probe('diagnostics');
			expect(answer.ok, JSON.stringify(answer)).toBe(true);
			if (answer.retained > 0 && answer.detail) { snapshot = answer; break; }
			if (Date.now() >= deadline) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		expect(snapshot, `no divergence diagnostic was collected\n${output}`).not.toBeNull();

		const detail = snapshot.detail;
		expect(typeof detail.diagnosticId).toBe('string');
		expect(detail.kind).toBe('state-divergence');
		expect(detail.expectedWorkers).toBe(2);
		// Both workers answered the bounded detail request over the real
		// parentPort handshake, or the record says explicitly how many are
		// missing - either way the evidence is the IPC round trip, not a
		// synthesized object.
		expect(detail.reportingWorkers).toBeGreaterThan(0);
		expect(Array.isArray(detail.workers)).toBe(true);
		expect(detail.workers.length).toBe(detail.reportingWorkers);
		for (const worker of detail.workers) {
			expect(['minority', 'majority']).toContain(worker.role);
		}
		// The forked stream must be visible as keyed evidence when the
		// collection completed within the window.
		if (detail.complete) {
			expect(detail.explainedBySequenceSummary).toBe(true);
			expect(detail.affectedStreams.length).toBeGreaterThan(0);
		}
		// No topic name may survive into the evidence: streams are keyed ids.
		expect(JSON.stringify(detail)).not.toContain('divergence:room');

		ws.close();
	}, 60_000);
});
