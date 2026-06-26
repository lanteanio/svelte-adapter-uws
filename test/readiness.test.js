import { describe, it, expect, afterEach } from 'vitest';

// The liveness (`/healthz`) and readiness (`/readyz`) probes over a real uWS
// server. The point of the split: during a graceful drain, readiness must flip
// to 503 (so a load balancer stops routing) while liveness stays 200 (so a
// liveness probe never restarts the pod mid-shutdown).
let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

describeUWS('liveness / readiness probes', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('serves readiness 200 "ready" and liveness 200 "OK" when healthy', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		const ready = await fetch(`${server.url}/readyz`);
		expect(ready.status).toBe(200);
		expect(await ready.text()).toBe('ready');

		const live = await fetch(`${server.url}/healthz`);
		expect(live.status).toBe(200);
		expect(await live.text()).toBe('OK');
	});

	it('flips readiness to 503 while liveness stays 200 during a drain', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();

		server.platform.__setDraining(true);

		const ready = await fetch(`${server.url}/readyz`);
		expect(ready.status).toBe(503);
		expect(await ready.text()).toBe('draining');

		// Liveness MUST stay 200 during the drain - else a liveness probe would
		// restart the pod mid-shutdown.
		const live = await fetch(`${server.url}/healthz`);
		expect(live.status).toBe(200);

		server.platform.__setDraining(false); // recovers (not a real lifecycle, just the seam)
		expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
	});

	it('mounts the readiness probe at a custom path', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ readinessCheckPath: '/ready' });
		expect((await fetch(`${server.url}/ready`)).status).toBe(200);
		// Not at the default (uWS built-in 404 - route absent there).
		expect((await fetch(`${server.url}/readyz`)).status).toBe(404);
	});

	it('disables the readiness probe with readinessCheckPath: false', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ readinessCheckPath: false });
		expect((await fetch(`${server.url}/readyz`)).status).toBe(404);
	});
});
