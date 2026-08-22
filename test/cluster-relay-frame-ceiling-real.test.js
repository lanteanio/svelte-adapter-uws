import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildFixtureOnce } from './helpers/fixture-build.js';
import { freePort } from './helpers/real-runtime.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const builtEntry = path.join(fixtureDir, 'build', 'index.js');
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }
let hasUws = true;
try { require.resolve('uWebSockets.js'); } catch { hasUws = false; }
const describeReal = hasUws && WebSocket !== null ? describe : describe.skip;

// The whole point of the sender-side frame ceiling is that ONE oversized
// publish costs exactly its own cross-worker copy: local subscribers still get
// it, no sibling is quarantined, the cluster keeps relaying. These tests drive
// a real multi-worker runtime through that contract from the outside - two
// clients proven to sit on different worker threads - because every prior
// defect here (cluster-wide quarantine, stranded ring prefix, lane asymmetry)
// was invisible to unit tests of the modules involved.
describeReal('real clustered relay frame ceiling', () => {
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

	async function boot(extraEnv) {
		const port = await freePort();
		let output = '';
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
		return { port, output: () => output };
	}

	let nonce = 0;

	async function connect(port) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		const frames = [];
		ws.on('message', (data) => {
			try { frames.push(JSON.parse(data.toString())); } catch {}
		});
		await new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		});
		const until = (predicate, label) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000);
			const scan = () => {
				const hit = frames.find(predicate);
				if (hit === undefined) return false;
				clearTimeout(timer);
				ws.off('message', scan);
				resolve(hit);
				return true;
			};
			if (!scan()) ws.on('message', scan);
		});
		return {
			ws,
			frames,
			until,
			send(message) { ws.send(JSON.stringify(message)); },
			async threadId() {
				const wanted = ++nonce;
				this.send({ type: 'whoami', nonce: wanted });
				const frame = await until(
					(f) => f.topic === 'probe' && f.event === 'whoami' && f.data?.nonce === wanted,
					'whoami'
				);
				return frame.data.threadId;
			},
			close() { try { ws.close(); } catch {} }
		};
	}

	// Two clients proven (via the fixture's whoami probe) to sit on different
	// worker threads.
	//
	// The retry HOLDS every same-worker connection open until a different worker
	// answers, and only then lets them go. Closing each one before trying again
	// is the intuitive spelling and it fights the acceptor: a worker that just
	// lost a connection is the emptiest one, so the next connect goes straight
	// back to it, and the loop can spend all twelve attempts on a single worker.
	// That is not hypothetical - it is how this failed one full run, under a
	// load that made the distribution lopsided enough for the effect to show.
	// Parking the connections instead pushes the acceptor along.
	async function connectOnDistinctWorkers(port) {
		const a = await connect(port);
		const aThread = await a.threadId();
		/** Same-worker landings, kept open so the acceptor stops choosing that worker. */
		const parked = [];
		try {
			for (let attempt = 0; attempt < 12; attempt++) {
				const b = await connect(port);
				if (await b.threadId() !== aThread) return { a, b };
				parked.push(b);
			}
		} finally {
			for (const client of parked) client.close();
		}
		throw new Error(
			`could not place two clients on distinct workers - 12 connections all landed on thread ${aThread}`
		);
	}

	// One deterministic scenario for any lane configuration. The negative
	// assertion rides the relay's own ordering guarantee: frames from one
	// worker arrive in send order, so once the small fence publish (sent AFTER
	// the oversized one) has arrived at the remote client, the oversized frame
	// either already arrived - a failure - or never will.
	async function refusalScenario(port, output) {
		const topic = 'ceiling:room';
		const { a, b } = await connectOnDistinctWorkers(port);
		try {
			for (const client of [a, b]) {
				const ref = ++nonce;
				client.send({ type: 'subscribe', topic, ref });
				await client.until((f) => f.type === 'subscribed' && f.topic === topic, 'subscribed');
			}
			// The subscription is acked by B's OWN worker; prove the cross-worker
			// path end to end before relying on it for the negative case.
			a.send({ type: 'broadcast', topic, payload: { warmup: true } });
			await b.until((f) => f.topic === topic && f.data?.warmup === true, 'cross-worker warmup');

			const big = 'x'.repeat(6000); // envelope > the 4 KiB ceiling booted below
			a.send({ type: 'broadcast', topic, payload: { big } });
			a.send({ type: 'broadcast', topic, payload: { fence: true } });

			// Local delivery survives the refusal on the publishing worker...
			await a.until((f) => f.topic === topic && f.data?.big === big, 'local oversized delivery');
			// ...the cluster stays alive and ordered past it on the remote one...
			await b.until((f) => f.topic === topic && f.data?.fence === true, 'post-refusal fence');
			// ...which proves the oversized frame was refused, not delayed.
			expect(b.frames.some((f) => f.topic === topic && f.data?.big !== undefined)).toBe(false);

			// No worker was blamed for the oversized publish: nothing was
			// quarantined, asked to exit, or escalated to a process kill.
			expect(output()).not.toContain('relay spill quarantining');
			expect(output()).not.toContain('did not exit within');

			// ADAPTER-ERR-RELAY-FRAME-REFUSED, driven from the condition it
			// names. The entry's whole value is that the split above is
			// INVISIBLE to clients - a described consequence nobody on the wire
			// can observe - so the operator line is the only place it surfaces,
			// and an entry whose emission never fires documents a silence.
			// Asserted on the cluster child's own output, because the worker
			// that refused is the one that reports.
			expect(output(), 'the refusal must reach the operator; nothing on the wire says it happened')
				.toContain('event=cluster-relay.frame-refused');
			expect(output(), 'and it is a warning, not an error - local delivery succeeded')
				.toContain('severity=warn');
		} finally {
			a.close();
			b.close();
		}
	}

	it('refuses only the cross-worker copy on the ring lane, and the cluster keeps relaying', async () => {
		const server = await boot({ CLUSTER_RELAY_MAX_FRAME_KB: '4' });
		await refusalScenario(server.port, server.output);
	}, 60_000);

	it('the postMessage lane (rings disabled) enforces the same ceiling', async () => {
		const server = await boot({ CLUSTER_RELAY_MAX_FRAME_KB: '4', CLUSTER_RELAY_RING_KB: '0' });
		await refusalScenario(server.port, server.output);
	}, 60_000);

	it('the batched lane refuses wholesale at the same ceiling, and the publish itself survives', async () => {
		// platform.publishBatched relays its whole event list as ONE frame, so
		// it is a separate decision point from the single-publish lane - and it
		// hands the relay a different entry shape. The acks are the load-bearing
		// assertion: the ceiling once read a field this lane does not carry, so
		// every clustered publishBatched THREW under the default ceiling while
		// the single-publish scenarios above stayed green.
		const server = await boot({ CLUSTER_RELAY_MAX_FRAME_KB: '4' });
		const topic = 'ceiling:batched';
		const { a, b } = await connectOnDistinctWorkers(server.port);
		try {
			const ref = ++nonce;
			b.send({ type: 'subscribe', topic, ref });
			await b.until((f) => f.type === 'subscribed' && f.topic === topic, 'subscribed');

			const warm = ++nonce;
			a.send({ type: 'broadcast-batched', topic, nonce: warm, payload: { warmup: true } });
			await a.until((f) => f.event === 'batched-ack' && f.data?.nonce === warm && f.data.ok === true, 'warmup ack');
			await b.until((f) => f.topic === topic && f.data?.warmup === true, 'cross-worker batched warmup');

			const bigNonce = ++nonce;
			a.send({ type: 'broadcast-batched', topic, nonce: bigNonce, inflate: 6000 });
			const fenceNonce = ++nonce;
			a.send({ type: 'broadcast-batched', topic, nonce: fenceNonce, payload: { fence: true } });

			// Both publishes succeed on the publishing worker - a refusal drops
			// only the cross-worker copy, it never throws into the app.
			await a.until((f) => f.event === 'batched-ack' && f.data?.nonce === bigNonce && f.data.ok === true, 'oversized batched ack');
			await a.until((f) => f.event === 'batched-ack' && f.data?.nonce === fenceNonce && f.data.ok === true, 'fence batched ack');

			await b.until((f) => f.topic === topic && f.data?.fence === true, 'post-refusal batched fence');
			expect(b.frames.some((f) => f.topic === topic && f.data?.big !== undefined)).toBe(false);
			expect(server.output()).not.toContain('relay spill quarantining');
		} finally {
			a.close();
			b.close();
		}
	}, 60_000);

	it('the shipped default refuses a multi-megabyte publish instead of bouncing the cluster', async () => {
		// The headline defect the sender ceiling fixed: one publish above the
		// spill budget used to quarantine EVERY healthy sibling in a single
		// fan-out pass, each asked to exit, with a process kill behind the grace. Under
		// the shipped defaults the same publish now costs exactly its own
		// cross-worker copy. The payload is synthesized server-side because the
		// inbound frame cap is far below the default frame ceiling.
		const server = await boot({});
		const topic = 'ceiling:room';
		const { a, b } = await connectOnDistinctWorkers(server.port);
		try {
			const ref = ++nonce;
			b.send({ type: 'subscribe', topic, ref });
			await b.until((f) => f.type === 'subscribed' && f.topic === topic, 'subscribed');
			a.send({ type: 'broadcast', topic, payload: { warmup: true } });
			await b.until((f) => f.topic === topic && f.data?.warmup === true, 'cross-worker warmup');

			a.send({ type: 'broadcast', topic, inflate: 5 * 1024 * 1024 });
			a.send({ type: 'broadcast', topic, payload: { fence: true } });

			await b.until((f) => f.topic === topic && f.data?.fence === true, 'post-refusal fence');
			expect(b.frames.some((f) => f.topic === topic && f.data?.big !== undefined)).toBe(false);
			expect(server.output()).not.toContain('relay spill quarantining');
			expect(server.output()).not.toContain('did not exit within');
		} finally {
			a.close();
			b.close();
		}
	}, 60_000);

	it('under pure defaults, a frame larger than the ring streams through in pieces and arrives whole', async () => {
		// The other side of the default boundary: 600 KB is far larger than the
		// 256 KB ring (so it must straddle several drains and be reassembled)
		// but under the 4 MiB frame ceiling (so it is admitted). The ring is a
		// byte stream; carrying such a frame in pieces is what makes a large
		// frame not-a-peer-fault, and this asserts the CLIENT-delivered value
		// on the remote worker, not any internal counter.
		const server = await boot({});
		const topic = 'ceiling:room';
		const { a, b } = await connectOnDistinctWorkers(server.port);
		try {
			const ref = ++nonce;
			b.send({ type: 'subscribe', topic, ref });
			await b.until((f) => f.type === 'subscribed' && f.topic === topic, 'subscribed');
			const size = 600 * 1024;
			a.send({ type: 'broadcast', topic, inflate: size });
			a.send({ type: 'broadcast', topic, payload: { fence: true } });
			const delivered = await b.until(
				(f) => f.topic === topic && typeof f.data?.big === 'string',
				'cross-worker multi-chunk delivery'
			);
			expect(delivered.data.big.length).toBe(size);
			await b.until((f) => f.topic === topic && f.data?.fence === true, 'post-big-frame fence');
			expect(server.output()).not.toContain('relay spill quarantining');
			expect(server.output()).not.toContain('did not exit within');
		} finally {
			a.close();
			b.close();
		}
	}, 60_000);

	it('the same publish crosses workers when the ceiling is disabled, so the scenario proves refusal rather than loss', async () => {
		// The control that keeps the suite honest: with the ceiling off, the
		// identical oversized publish IS delivered across workers. Without this,
		// the negative assertion above could pass because large publishes never
		// relayed in the first place.
		const server = await boot({ CLUSTER_RELAY_MAX_FRAME_KB: '0' });
		const topic = 'ceiling:room';
		const { a, b } = await connectOnDistinctWorkers(server.port);
		try {
			const ref = ++nonce;
			b.send({ type: 'subscribe', topic, ref });
			await b.until((f) => f.type === 'subscribed' && f.topic === topic, 'subscribed');
			const big = 'x'.repeat(6000);
			a.send({ type: 'broadcast', topic, payload: { big } });
			await b.until((f) => f.topic === topic && f.data?.big === big, 'cross-worker oversized delivery');
		} finally {
			a.close();
			b.close();
		}
	}, 60_000);
});
