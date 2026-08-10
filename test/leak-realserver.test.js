import { describe, it, expect, afterEach } from 'vitest';
import { createResourceTracker, processResourceProbes, detectGrowth } from '../src/sim.js';

// Real-server leak harness: boots an actual uWS server, churns real ws clients,
// and asserts the process heap and active-handle count trend flat across many
// connect/close cycles. Unlike the DST structural harness (test/sim-leak.test.js)
// this covers the NON-DETERMINISTIC memory dimension, so it needs a settled heap:
// `global.gc` has to exist. vitest.config.js passes `--expose-gc` to every worker,
// so the default `npm test` runs this suite. The guard below stays as a guard: it
// reports an honest skip if the flag is ever dropped, rather than failing on a
// missing global. Skipping it is not the resting state - a permanent skip here
// leaves real heap behaviour under real client churn untested, which the
// deterministic simulator in test/sim-leak.test.js does not cover.

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}

const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
const enabled = uWS && gc;
const describeMaybe = enabled ? describe : describe.skip;

/** Connect a real ws client and wait until it is fully open. */
async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return ws;
}

/** Wait until the server reports `target` live connections (or time out). */
async function waitForConnections(server, target, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (server.platform.connections !== target) {
		if (Date.now() > deadline) throw new Error(`connections stuck at ${server.platform.connections}, wanted ${target}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

describeMaybe('real-server resource-leak harness (needs --expose-gc)', () => {
	let server;

	afterEach(async () => {
		try { await server?.close(); } catch { /* best effort */ }
		server = null;
	});

	it('heapUsed and activeHandles trend flat across connection churn', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				open(ws) { ws.subscribe?.('room'); },
				message() { /* echo nothing; the churn is the workload */ }
			}
		});

		const CLIENTS_PER_CYCLE = 8;
		const WARMUP_CYCLES = 3;
		const SAMPLE_CYCLES = 12;

		async function churnOnce() {
			const clients = [];
			for (let i = 0; i < CLIENTS_PER_CYCLE; i++) clients.push(await connectClient(server.wsUrl));
			await waitForConnections(server, CLIENTS_PER_CYCLE);
			for (const ws of clients) ws.close();
			await waitForConnections(server, 0);
		}

		// Warm up so first-touch allocations (JIT, buffers, TLS-free path) settle
		// before we start trending.
		for (let i = 0; i < WARMUP_CYCLES; i++) await churnOnce();

		const tracker = createResourceTracker(processResourceProbes({ forceGc: true }));
		for (let i = 0; i < SAMPLE_CYCLES; i++) {
			await churnOnce();
			gc();
			// Let libuv release closed socket handles before the reading.
			await new Promise((r) => setTimeout(r, 20));
			tracker.sample();
		}

		// activeHandles must be strictly flat: a socket handle that outlives its
		// closed connection is a hard leak, so a zero tolerance is right here.
		const handles = detectGrowth(tracker.series('activeHandles'), { tolerance: 0 });
		expect(handles.leaking).toBe(false);

		// heapUsed is noisy even post-gc, so require only that it not exhibit a
		// sustained monotonic climb. The tolerance absorbs normal allocator jitter.
		const heap = detectGrowth(tracker.series('heapUsed'), { tolerance: 2 * 1024 * 1024, minMonotonicFraction: 0.95 });
		expect(heap.leaking).toBe(false);
	}, 60000);
});
