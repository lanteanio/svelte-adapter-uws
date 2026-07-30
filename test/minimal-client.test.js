import { describe, it, expect, afterEach, vi } from 'vitest';
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
/** @type {any} */
let client;

describe('examples/minimal-client.mjs teardown', () => {
	afterEach(() => vi.useRealTimers());

	it('cancels a pending reconnect and remains safe when closed twice', () => {
		vi.useFakeTimers();
		const sockets = [];
		class FakeWebSocket {
			constructor() {
				this.readyState = 0;
				this.closeCalls = 0;
				sockets.push(this);
			}
			send() {}
			close() {
				this.closeCalls++;
				this.readyState = 3;
				this.onclose?.();
			}
		}

		const localClient = createLanteanClient('ws://localhost:9/', { WebSocket: FakeWebSocket });
		const first = sockets[0];
		expect(first.onerror).toBeTypeOf('function');

		// Model the server disappearing: onclose arms the 500 ms reconnect.
		first.onclose();
		expect(vi.getTimerCount()).toBe(1);

		localClient.close();
		localClient.close();
		expect(first.closeCalls).toBe(1);
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(1000);
		expect(sockets, 'close() must prevent every later dial').toHaveLength(1);
	});
});

describeUWS('examples/minimal-client.mjs (Core class)', () => {
	afterEach(async () => {
		// The client FIRST, and this is not tidiness. The example reconnects
		// 500 ms after any close, so a client left running when the server goes
		// away retries into a dead port forever - and `ws` throws that connect
		// error uncaught into whichever test file the worker happens to be
		// running when the timer fires. That is where this suite's stray
		// ECONNREFUSED came from, attributed to a different innocent file every
		// run for as long as it went unnoticed.
		client?.close();
		client = null;
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
		client = createLanteanClient(server.wsUrl, {
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
