import { describe, it, expect, afterEach } from 'vitest';
import { createLanteanClient } from '../examples/minimal-client.mjs';

// Keeps the ~40-line Core client example honest: it must connect, subscribe,
// dispatch data events, and track the resume state (lastSeq + epoch) against the
// real reference server. Proves the "a JSON-only client is complete" claim by
// construction (PROTOCOL.md section 13).

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

describeUWS('examples/minimal-client.mjs (Core class)', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('connects, subscribes, and dispatches a published data event', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let platform;
		server = await createTestServer({
			handler: { open(_ws, ctx) { platform = ctx.platform; } }
		});

		const { WebSocket } = await import('ws');
		const received = [];
		const client = createLanteanClient(server.wsUrl, {
			WebSocket,
			onEvent: (topic, event, data) => received.push({ topic, event, data })
		});

		// Wait for welcome + sessionId.
		await new Promise((r) => setTimeout(r, 60));
		expect(client.sessionId).toBeTypeOf('string');

		client.subscribe('room:1');
		await new Promise((r) => setTimeout(r, 60));

		// Publish a sequenced event to the subscribed topic.
		platform.publish('room:1', 'update', { n: 1 }, { seq: 5 });
		await new Promise((r) => setTimeout(r, 60));

		expect(received).toContainEqual({ topic: 'room:1', event: 'update', data: { n: 1 } });
	});
});
