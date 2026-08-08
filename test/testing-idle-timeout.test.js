// createTestServer must APPLY the caller's idleTimeout, not swallow it. The
// harness once passed a bare literal 120 to the socket while accepting the
// option without complaint, so idle behaviour was untestable: observing an
// idle close meant waiting out two minutes. The assertion here is bound to an
// independent source - the real uWS reaper closing a real socket - never to a
// value the harness reports about itself, so a report-versus-enforce split
// cannot satisfy it.
import { describe, it, expect, afterEach } from 'vitest';
import { hasUWS } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

let server;

describeUWS('createTestServer honours idleTimeout', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('refuses a misshaped value instead of silently ignoring it', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// `idleTimeout: process.env.X` is the natural mistake and is a string.
		await expect(createTestServer({ idleTimeout: '30' })).rejects.toThrow(/must be a number/);
	});

	it('reaps a silent client at the configured timeout, not at the 120s default', async () => {
		const { createTestServer } = await import('../src/testing.js');
		// 8 seconds is the smallest value uWS considers sane. The client refuses
		// to answer protocol pings (autoPong: false), so the only thing that can
		// close it is the server's idle reaper - at 8s if the option was applied,
		// at 120s (far past this test's budget) if it was swallowed.
		server = await createTestServer({ idleTimeout: 8 });
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl, { autoPong: false });
		const started = Date.now();
		const closed = await new Promise((resolve, reject) => {
			ws.on('close', () => resolve(Date.now() - started));
			ws.on('error', reject);
			// Give the reaper headroom (uWS ticks on a coarse grid) while staying
			// far below the 120s that would mean the option was ignored.
			setTimeout(() => resolve(null), 25_000);
		});
		expect(closed, 'the socket was never reaped: idleTimeout was not applied').not.toBeNull();
		expect(closed).toBeGreaterThanOrEqual(4_000);
		expect(closed).toBeLessThan(25_000);
	}, 40_000);
});
