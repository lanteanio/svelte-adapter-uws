import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { runSmoke, waitForOpen } from '../scripts/smoke.js';

let hasNative = true;
try {
	await import('uWebSockets.js');
} catch {
	hasNative = false;
}

const describeNative = hasNative ? describe : describe.skip;

describeNative('contributor smoke command', () => {
	it('proves a real liveness request and WebSocket subscribe/publish exchange', async () => {
		const lines = [];
		const result = await runSmoke({ log: (line) => lines.push(line) });

		expect(result.adapter).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.native).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.node).toMatch(/^v\d+/);
		expect(result.healthStatus).toBe(200);
		expect(result.event).toBe('smoke/checkpoint');
		expect(lines[0]).toContain('svelte-adapter-uws');
		expect(lines.at(-1)).toBe(
			'smoke OK: HTTP /healthz 200; WebSocket subscribe + publish delivered; teardown complete'
		);
	}, 15000);
});

// The happy path proves the product answers. This proves the checkpoint FAILS
// when it should. The original wait was `once(client, 'open')`, which never
// settles against a server that accepts the socket and then neither completes
// nor rejects the upgrade - so `npm run smoke` hung forever, never reached its
// teardown, and reported nothing. A suite timeout does not rescue that: it
// abandons the promise rather than cancelling it, so the pending work and its
// handles outlive the failed test.
describe('smoke handshake bound', () => {
	it('fails within its bound against a server that accepts and never upgrades, and leaves no socket open', async () => {
		const accepted = [];
		const stalled = createServer((socket) => {
			// Accept, hold, answer nothing. This is the exact shape of a broken
			// upgrade path: TCP is healthy, the handshake never resolves.
			accepted.push(socket);
		});
		await new Promise((ready) => stalled.listen(0, '127.0.0.1', ready));
		const { port } = stalled.address();

		try {
			const client = new WebSocket('ws://127.0.0.1:' + port, { handshakeTimeout: 10_000 });
			const startedAt = Date.now();
			// handshakeTimeout is set far higher than the bound under test, so a
			// pass here is attributable to waitForOpen and not to ws giving up.
			await expect(waitForOpen(client, 250)).rejects.toThrow(/waiting for the WebSocket handshake/);
			expect(Date.now() - startedAt).toBeLessThan(5000);

			// Bounded failure is only half of it - the socket must actually be gone,
			// or a failing checkpoint still holds the process open.
			expect(client.readyState).not.toBe(client.OPEN);
			expect(client.readyState).not.toBe(client.CONNECTING);
		} finally {
			for (const socket of accepted) socket.destroy();
			await new Promise((done) => stalled.close(done));
		}
	}, 20000);
});
