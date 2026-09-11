import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { freePort } from './helpers/real-runtime.js';
import {
	BATCH_ENTRY_SEQUENCE_ERROR,
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
/** The topic the fixture's sequence-policy probe publishes on when none is named. */
const PROBE_TOPIC = 'sequence-policy:room';

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
		// Every envelope on the watched topic, in arrival order. An envelope
		// carries an event; the subscribe ack names the topic too and carries
		// none, so it is not counted. This listener is registered before any
		// probe's, so for a given frame it has run by the time a probe reads
		// its reply. What is NOT assumed is the order between a topic publish
		// and the reply's direct send on the same socket: the native layer may
		// drain the one after the other, so a case never reads the topic at
		// reply time - it plants a sentinel afterwards and reads up to that.
		let watched = null;
		const seen = [];
		ws.on('message', (data) => {
			let frame;
			try { frame = JSON.parse(data.toString()); } catch { return; }
			if (watched !== null && frame.topic === watched && typeof frame.event === 'string') seen.push(frame);
		});
		/** Wait until `count` envelopes have arrived since `from`, then answer with all of them. */
		const arrived = async (from, count) => {
			const deadline = Date.now() + 5_000;
			while (seen.length - from < count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return seen.slice(from);
		};
		return {
			output: () => output,
			/**
			 * Subscribe this same connection to `topic` and watch it, so a probe
			 * can say what went out on the topic since its send, read against
			 * a later sentinel: the reply says whether the call was refused,
			 * the envelopes up to the sentinel's say whether anything fanned
			 * out.
			 */
			async subscribe(topic) {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`subscribe ack timed out\n${output}`)), 10_000);
					const onMessage = (data) => {
						let frame;
						try { frame = JSON.parse(data.toString()); } catch { return; }
						if (frame.type !== 'subscribed' || frame.topic !== topic) return;
						clearTimeout(timer);
						ws.off('message', onMessage);
						resolve(undefined);
					};
					ws.on('message', onMessage);
					// The ack is sent only for a subscribe that carries a ref.
					ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
				});
				watched = topic;
			},
			async probe(entry, options, extra) {
				const wanted = ++nonce;
				const from = seen.length;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`sequence policy response timed out\n${output}`)), 10_000);
					const onMessage = (data) => {
						let frame;
						try { frame = JSON.parse(data.toString()); } catch { return; }
						if (frame.topic !== 'probe' || frame.event !== 'sequence-policy' || frame.data?.nonce !== wanted) return;
						clearTimeout(timer);
						ws.off('message', onMessage);
						// `settled(n)`: everything on the watched topic since this
						// probe's send, once at least n envelopes have arrived. An
						// accepted batch awaits its own pair; a refused one awaits
						// nothing and reads what a later sentinel brought, so what it
						// leaked - if anything - sits ahead of the sentinel's pair.
						resolve({ ...frame.data, settled: (count) => arrived(from, count) });
					};
					ws.on('message', onMessage);
					ws.send(JSON.stringify({ type: 'sequence-policy-probe', entry, options, nonce: wanted, ...extra }));
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
		for (const seq of [0, -1, 1.5]) {
			expect((await server.probe('publish', { seq, relay: false })).error, String(seq))
				.toBe(CLUSTER_SEQUENCE_ERROR);
		}
		server.close();
	}, 60_000);

	it('allows unsequenced or externally ordered fan-out, and rejects repeated numeric batch seqs', async () => {
		const server = await boot(2);
		expect((await server.probe('publish', { seq: false })).ok).toBe(true);
		// null is the second no-seq spelling - a nullable column's answer - and
		// makes no monotonic promise, so a cluster accepts it like false.
		expect((await server.probe('publish', { seq: null })).ok).toBe(true);
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

	it('refuses a per-entry seq on both batch lanes unless the batch renounces the counter and the relay', async () => {
		// The per-entry authority check is the one guard in this family that no
		// in-process case can reach: it returns early off-cluster, so a single
		// worker never runs it. Asked here of a real two-worker runtime, on both
		// lanes - the stateless reroute and the stateful snapshot pass, selected
		// by whether the codec carries `state`.
		//
		// The connection is subscribed to the probe topic, so each refusal is
		// asked two things: the reply says the batch was refused, and the
		// topic says nothing fanned out ahead of it. The second is what makes
		// a pre-pass a pre-pass - a check moved into the fan-out loop answers
		// the same error with the first entry already delivered - and it is
		// the only question the stateless lane can fail, because that lane
		// reroutes each entry through publishWire, which asks the authority
		// question again on its own. The absence is read against a SENTINEL:
		// the accepted spelling of the same probe, published after the
		// refusals, whose pair is the only thing the topic may carry since
		// them. That holds whichever order the native layer drains a publish
		// and the reply, and the sentinel is the control that the
		// subscription sees anything at all.
		const server = await boot(2);
		await server.subscribe(PROBE_TOPIC);
		for (const entry of ['wire-batch-entry-seq', 'wire-batch-entry-seq-stateless']) {
			// With the relay left on, the adapter's own multi-origin fan-out
			// would carry an externally ordered number it cannot keep ordered.
			const refusals = [];
			for (const options of [{ seq: false }, { seq: false, relay: true }]) {
				const refused = await server.probe(entry, options);
				expect(refused.error, entry).toBe(BATCH_ENTRY_SEQUENCE_ERROR);
				refusals.push(refused);
			}
			// The clustered spelling: options renounce the counter AND the
			// relay, entries carry the authority.
			const sentinel = await server.probe(entry, { seq: false, relay: false });
			expect(sentinel.ok, `${entry}: ${sentinel.error}`).toBe(true);
			expect((await sentinel.settled(2)).map((frame) => frame.data.n), entry).toEqual([1, 2]);
			for (const refused of refusals) {
				expect((await refused.settled(0)).map((frame) => frame.data.n), `${entry}: a refused batch fans out nothing`)
					.toEqual([1, 2]);
			}
		}
		server.close();
	}, 60_000);

	it('refuses an entry drawing the per-worker counter on both batch lanes, before anything fans out', async () => {
		// The second refusal the same pre-pass carries, and equally invisible
		// off-cluster. `{ seq: true }` on an entry asks for the local counter,
		// which no other worker shares, so a clustered batch refuses it under
		// the spelling that makes an explicit entry seq legal; the relay
		// setting is passed along but does not enter the verdict for the
		// counter form.
		//
		// Same two questions as above, read against a sentinel the same way.
		// The stateful lane's draw is what the error answers for; the
		// stateless lane reroutes each entry through publishWire, which
		// refuses a counter draw on its own, so what its pre-pass adds is that
		// the refusal lands before the first entry goes out - and that is what
		// the sentinel pins. One sentinel per lane: the stateful lane through
		// a batch with `state`, the stateless one through the per-entry seq
		// probe under the spelling that makes it legal.
		const server = await boot(2);
		await server.subscribe(PROBE_TOPIC);
		for (const [entry, sentinelEntry, sentinelOptions] of [
			['wire-batch-entry-counter', 'wire-batch', { seq: false }],
			['wire-batch-entry-counter-stateless', 'wire-batch-entry-seq-stateless', { seq: false, relay: false }]
		]) {
			const refused = await server.probe(entry, { seq: false, relay: false });
			expect(refused.error, entry).toBe(CLUSTER_SEQUENCE_ERROR);
			const sentinel = await server.probe(sentinelEntry, sentinelOptions);
			expect(sentinel.ok, `${sentinelEntry}: ${sentinel.error}`).toBe(true);
			expect((await sentinel.settled(2)).map((frame) => frame.data.n), sentinelEntry).toEqual([1, 2]);
			expect((await refused.settled(0)).map((frame) => frame.data.n), `${entry}: a refused batch fans out nothing`)
				.toEqual([1, 2]);
		}
		server.close();
	}, 60_000);

	it('takes both per-entry forms on one worker, so neither refusal is blanket', async () => {
		// What this proves and no more: both refusals are CLUSTERED decisions, so
		// a guard that fired everywhere would fail here. It says nothing about
		// what the counter stamps - `ok` is "did not throw" - and the value
		// questions are asked in the in-process suite.
		const server = await boot(1);
		for (const entry of [
			'wire-batch-entry-seq', 'wire-batch-entry-seq-stateless',
			'wire-batch-entry-counter', 'wire-batch-entry-counter-stateless'
		]) {
			expect((await server.probe(entry, { seq: false })).ok, entry).toBe(true);
		}
		server.close();
	}, 60_000);

	it('every lane reads the seq option exactly once, so a stateful accessor cannot split judge and stamp', async () => {
		// The fixture builds an options object whose `seq` answers `false` to
		// its first read and an authoritative number to every later one. A lane
		// that reads once judges and stamps the same value (here: `false`, so
		// nothing is stamped and the publish is accepted). A lane that reads
		// again after judging would stamp - and relay - a number the cluster
		// refusal never saw, which is the exact combination it exists to refuse.
		// The read count is the contract: every extra read is a second answer.
		const server = await boot(2);
		for (const entry of ['publish', 'wire', 'batch', 'loop-batch', 'wire-batch']) {
			const result = await server.probe(entry, undefined, { statefulSeq: 4242 });
			expect(result.ok, `${entry}: ${result.error}`).toBe(true);
			expect(result.seqReads, entry).toBe(1);
		}
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
