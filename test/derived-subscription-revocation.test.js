// Revoking a topic releases the observer taps derived from it.
//
// WHY THIS EXISTS. The presence roster channel (`__presence:<topic>`) and the
// cursor position channel (`__cursor:<topic>`) are separate subscriptions
// established on the connection's behalf. Both plugins keep them alive across a
// participant leave ON PURPOSE - a co-resident observer's roster would
// otherwise freeze - and release them only on socket close. So
// `platform.unsubscribe(ws, topic)`, the revocation a kick, ban or lease expiry
// runs, removed the grant and left the tap in place.
//
// The consequence is the access the revocation was supposed to withdraw: the
// revoked client keeps receiving the roster and every peer's cursor position.
// For cursor it also keeps PUBLISHING, because the publish gate authorizes an
// outgoing frame by asking whether the socket still holds the tap.
//
// These drive the real platform.unsubscribe and the real plugins, and assert on
// server-visible membership rather than on a helper's return value.

import { describe, it, expect, afterEach } from 'vitest';
import { createCursor } from '../src/plugins/cursor/server.js';
import { createPresence } from '../src/plugins/presence/server.js';

/** @type {any} */
let server = null;

afterEach(async () => {
	await server?.close();
	server = null;
});

/** Connect a real ws client and collect frames. */
async function connect(wsUrl) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl);
	const frames = [];
	ws.on('message', (d) => frames.push(d.toString()));
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, frames, send: (m) => ws.send(JSON.stringify(m)) };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('a plugin side-effect hook does not disarm the grant gate', () => {
	// The gate steps aside when the APP exports a subscribe hook, on the
	// reasoning that an app which took over the topic decision owns it.
	// Presence's subscribe hook is not that: it joins a roster and returns
	// undefined on every path, so it never denies. But the documented wiring
	// re-exports it, so arming the gate and following the presence README used to
	// produce zero enforcement - any client could name any topic, get subscribed,
	// and receive its roster and live diffs.

	it('denies an ungranted wire subscribe even with presence hooks exported', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const presence = createPresence();
		server = await createTestServer({
			authorizeWireSubscribe: true,
			// Exactly the documented wiring.
			handler: {
				subscribe: presence.hooks.subscribe,
				unsubscribe: presence.hooks.unsubscribe,
				message: presence.hooks.message,
				close: presence.hooks.close
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'tenant-b:secret', ref: 1 });
		await settle();

		const answer = client.frames.map((f) => JSON.parse(f)).find((f) => f.topic === 'tenant-b:secret');
		expect(answer, 'the client must be answered').toBeTruthy();
		expect(answer).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		expect(
			server.platform.subscribers('tenant-b:secret'),
			'no membership may be installed for an ungranted topic'
		).toBe(0);

		client.ws.terminate();
	});

	it('still steps aside for an app hook that wraps the plugin one', async () => {
		// The documented escape hatch has to keep working: a wrapper is app code
		// that may decide, so the app owns authorization and the gate defers to it.
		// Without this, marking the plugin hook would silently take over apps that
		// deliberately took control.
		const { createTestServer } = await import('../src/testing.js');
		const presence = createPresence();
		server = await createTestServer({
			authorizeWireSubscribe: true,
			handler: {
				subscribe(ws, topic, ctx) {
					presence.hooks.subscribe(ws, topic, ctx);
				}
			}
		});
		const client = await connect(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'app-decides', ref: 2 });
		await settle();

		const answer = client.frames.map((f) => JSON.parse(f)).find((f) => f.topic === 'app-decides');
		expect(answer, 'the client must be answered').toBeTruthy();
		expect(answer, 'an app that took over the decision keeps it').toMatchObject({ type: 'subscribed' });

		client.ws.terminate();
	});
});

describe('revocation releases a derived observer tap', () => {
	it('drops the cursor position tap when the underlying topic is revoked', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const cursors = createCursor({ throttle: 0 });
		let captured = null;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				message(ws, ctx) { cursors.hooks.message(ws, ctx); }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		client.send({ type: 'cursor-snapshot', topic: 'room' });
		await settle();
		expect(
			server.platform.subscribers('__cursor:room'),
			'the snapshot must establish the tap, or this test proves nothing'
		).toBe(1);

		// The revocation a kick or ban runs.
		server.platform.unsubscribe(captured, 'room');
		await settle();

		expect(
			server.platform.subscribers('__cursor:room'),
			'a revoked client must not keep receiving peer positions on the tap channel'
		).toBe(0);

		client.ws.terminate();
	});

	it('drops the cursor position tap when the client itself unsubscribes the base topic', async () => {
		// Same release, other revocation surface: the client-wire `unsubscribe`
		// frame. It must release the derived tap exactly like platform.unsubscribe
		// does - a client leaving `room` cannot keep the `__cursor:room` tap
		// receiving peer positions, nor the cursor write authority that rides it.
		const { createTestServer } = await import('../src/testing.js');
		const cursors = createCursor({ throttle: 0 });
		server = await createTestServer({
			handler: {
				message(ws, ctx) { cursors.hooks.message(ws, ctx); }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		client.send({ type: 'cursor-snapshot', topic: 'room' });
		await settle();
		expect(
			server.platform.subscribers('__cursor:room'),
			'the snapshot must establish the tap, or this test proves nothing'
		).toBe(1);

		client.send({ type: 'unsubscribe', topic: 'room' });
		await settle();

		expect(
			server.platform.subscribers('__cursor:room'),
			'a client that left the base topic must not keep the observer tap'
		).toBe(0);

		client.ws.terminate();
	});

	it('drops the presence roster tap when the underlying topic is revoked', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const presence = createPresence();
		let captured = null;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				message(ws, ctx) { presence.hooks.message?.(ws, ctx); }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		// Establish the observer tap through the plugin's own server-side entry
		// point, which is what an app calls to hand a client a roster.
		await presence.sync(captured, 'room', server.platform);
		await settle();
		expect(
			server.platform.subscribers('__presence:room'),
			'sync must establish the roster tap, or this test proves nothing'
		).toBe(1);

		server.platform.unsubscribe(captured, 'room');
		await settle();

		expect(
			server.platform.subscribers('__presence:room'),
			'a revoked client must not keep receiving the roster and its live diffs'
		).toBe(0);

		client.ws.terminate();
	});

	it('revoking one topic leaves another topic\'s tap alone', async () => {
		// The release is per topic. A revocation for one room must not silently
		// tear down an observer's tap on a different room, which would be a
		// self-inflicted outage rather than a fix.
		const { createTestServer } = await import('../src/testing.js');
		const cursors = createCursor({ throttle: 0 });
		let captured = null;
		server = await createTestServer({
			handler: {
				open(ws) { captured = ws; },
				message(ws, ctx) { cursors.hooks.message(ws, ctx); }
			}
		});
		const client = await connect(server.wsUrl);
		await settle();

		client.send({ type: 'cursor-snapshot', topic: 'room-a' });
		client.send({ type: 'cursor-snapshot', topic: 'room-b' });
		await settle();
		expect(server.platform.subscribers('__cursor:room-a')).toBe(1);
		expect(server.platform.subscribers('__cursor:room-b')).toBe(1);

		server.platform.unsubscribe(captured, 'room-a');
		await settle();

		expect(server.platform.subscribers('__cursor:room-a'), 'the revoked topic loses its tap').toBe(0);
		expect(server.platform.subscribers('__cursor:room-b'), 'an unrelated topic keeps its tap').toBe(1);

		client.ws.terminate();
	});
});
