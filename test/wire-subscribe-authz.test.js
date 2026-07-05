// Tests for wire-subscribe authorization (`authorizeWireSubscribe`).
//
// With the policy on, a CLIENT-initiated subscribe / subscribe-batch wire frame
// is honored only for a topic the server already authorized for that connection
// via platform.subscribe - unless the app exports its own subscribe hook, which
// then decides. This closes the raw-wire bypass where a client subscribes to a
// topic it was never granted (a private room, another tenant's channel) and
// receives its fan-out, because the server-side guard ran only on the
// server-initiated subscribe, not the client's wire frame.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data) => { frames.push(JSON.parse(data.toString())); });
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return { ws, frames };
}

/** Send a subscribe frame with a ref and wait for its subscribed / subscribe-denied ack. */
async function subscribeAndAwait(ws, frames, topic, ref) {
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref }));
	return waitForAck(frames, ref);
}

function waitForAck(frames, ref) {
	return new Promise((resolve) => {
		const started = Date.now();
		const poll = () => {
			const ack = frames.find((f) => (f.type === 'subscribed' || f.type === 'subscribe-denied') && f.ref === ref);
			if (ack) return resolve(ack);
			if (Date.now() - started > 2000) return resolve(null);
			setTimeout(poll, 5);
		};
		poll();
	});
}

describeUWS('wire-subscribe authorization', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('denies a raw client subscribe to a topic the server never authorized (no app hook)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ authorizeWireSubscribe: true, handler: {} });
		const { ws, frames } = await connectClient(server.wsUrl);

		const ack = await subscribeAndAwait(ws, frames, 'private:room-42', 1);
		expect(ack).toMatchObject({ type: 'subscribe-denied', topic: 'private:room-42', reason: 'FORBIDDEN' });
		expect(server.platform.subscribers('private:room-42')).toBe(0);

		ws.close();
	});

	it('allows a raw client subscribe to a topic the server already authorized via platform.subscribe', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let capturedWs = null;
		server = await createTestServer({ authorizeWireSubscribe: true, handler: { open(ws) { capturedWs = ws; } } });
		const { ws, frames } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		// Server authorizes the subscription (the RPC path's platform.subscribe).
		expect(await server.platform.subscribe(capturedWs, 'game:7')).toBeNull();

		// The client's follow-on wire frame for that same topic is honored.
		const ack = await subscribeAndAwait(ws, frames, 'game:7', 2);
		expect(ack).toMatchObject({ type: 'subscribed', topic: 'game:7' });

		ws.close();
	});

	it('defers to an app subscribe hook when one is exported (hook decides, gate does not hard-deny)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			authorizeWireSubscribe: true,
			handler: {
				subscribe(_ws, topic) { return topic.startsWith('ok:') ? undefined : 'FORBIDDEN'; }
			}
		});
		const { ws, frames } = await connectClient(server.wsUrl);

		// Hook allows this one even though the server never platform.subscribe'd it.
		const okAck = await subscribeAndAwait(ws, frames, 'ok:public', 1);
		expect(okAck).toMatchObject({ type: 'subscribed', topic: 'ok:public' });

		// Hook denies this one.
		const noAck = await subscribeAndAwait(ws, frames, 'no:secret', 2);
		expect(noAck).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });

		ws.close();
	});

	it('off by default: a client may subscribe to any valid topic (standalone adapter contract)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: {} });
		const { ws, frames } = await connectClient(server.wsUrl);

		const ack = await subscribeAndAwait(ws, frames, 'anything:goes', 1);
		expect(ack).toMatchObject({ type: 'subscribed', topic: 'anything:goes' });

		ws.close();
	});

	it('platform.authorizeWireSubscribe() arms the policy at runtime', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: {} });
		const { ws, frames } = await connectClient(server.wsUrl);

		// Before arming: allowed.
		expect(await subscribeAndAwait(ws, frames, 'free:1', 1)).toMatchObject({ type: 'subscribed' });

		// Arm it (what svelte-realtime does at init).
		server.platform.authorizeWireSubscribe();

		// After arming: a never-authorized topic is denied.
		expect(await subscribeAndAwait(ws, frames, 'free:2', 2)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });

		ws.close();
	});

	it('subscribe-batch: denies un-authorized topics, honors server-authorized ones, in one frame', async () => {
		const { createTestServer } = await import('../src/testing.js');
		let capturedWs = null;
		server = await createTestServer({ authorizeWireSubscribe: true, handler: { open(ws) { capturedWs = ws; } } });
		const { ws, frames } = await connectClient(server.wsUrl);
		await new Promise(r => setTimeout(r, 30));

		expect(await server.platform.subscribe(capturedWs, 'allowed:a')).toBeNull();

		ws.send(JSON.stringify({ type: 'subscribe-batch', topics: ['allowed:a', 'denied:b'], ref: 9 }));
		const [a, b] = await Promise.all([
			waitForAckTopic(frames, 9, 'allowed:a'),
			waitForAckTopic(frames, 9, 'denied:b')
		]);
		expect(a).toMatchObject({ type: 'subscribed', topic: 'allowed:a' });
		expect(b).toMatchObject({ type: 'subscribe-denied', topic: 'denied:b', reason: 'FORBIDDEN' });

		ws.close();
	});
});

function waitForAckTopic(frames, ref, topic) {
	return new Promise((resolve) => {
		const started = Date.now();
		const poll = () => {
			const ack = frames.find((f) => (f.type === 'subscribed' || f.type === 'subscribe-denied') && f.ref === ref && f.topic === topic);
			if (ack) return resolve(ack);
			if (Date.now() - started > 2000) return resolve(null);
			setTimeout(poll, 5);
		};
		poll();
	});
}
