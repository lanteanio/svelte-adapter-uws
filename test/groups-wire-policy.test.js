import { describe, it, expect, afterEach } from 'vitest';
import { createGroup } from '../src/plugins/groups/server.js';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;
const clients = [];

async function connectClient(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	clients.push(ws);
	return { ws, frames };
}

async function waitFor(frames, predicate, label) {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		const found = frames.find(predicate);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`);
}

describeUWS('groups wire authorization policy', () => {
	afterEach(async () => {
		for (const ws of clients.splice(0)) {
			try { ws.terminate(); } catch {}
		}
		await server?.close();
		server = null;
	});

	it('documented destructured hooks join their own system topic without opening the prefix', async () => {
		const lobby = createGroup('wire-lobby', { maxMembers: 2 });
		server = await (await import('../src/testing.js')).createTestServer({
			authorizeWireSubscribe: true,
			handler: lobby.hooks
		});
		const { ws, frames } = await connectClient(server.wsUrl);

		// No allowSystemTopicSubscribe opt-out is needed. The registered plugin
		// namespace reaches its hook, and join() establishes tracked membership.
		ws.send(JSON.stringify({ type: 'subscribe', topic: '__group:wire-lobby', ref: 'own' }));
		await waitFor(frames, (f) => f.type === 'subscribed' && f.ref === 'own', 'group subscribe ack');
		expect(lobby.count()).toBe(1);
		expect(server.platform.subscribers('__group:wire-lobby')).toBe(1);

		// The same marked hook returns undefined for both of these topics. The
		// ordinary one is stopped by the armed server-grant gate; the unhandled
		// plugin topic reaches the hook but is stopped at landing because no
		// plugin established membership. Neither can ride the group's exemption.
		ws.send(JSON.stringify({ type: 'subscribe', topic: 'private-room', ref: 'app' }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: '__group:not-created', ref: 'other' }));
		ws.send(JSON.stringify({ type: 'subscribe', topic: '__signal:victim', ref: 'system' }));

		const appDenied = await waitFor(frames, (f) => f.type === 'subscribe-denied' && f.ref === 'app', 'ordinary-topic denial');
		const otherDenied = await waitFor(frames, (f) => f.type === 'subscribe-denied' && f.ref === 'other', 'unhandled group denial');
		const systemDenied = await waitFor(frames, (f) => f.type === 'subscribe-denied' && f.ref === 'system', 'foreign system-topic denial');
		expect(appDenied.reason).toBe('FORBIDDEN');
		expect(otherDenied.reason).toBe('FORBIDDEN');
		expect(systemDenied.reason).toBe('INVALID_TOPIC');
		expect(server.platform.subscribers('private-room')).toBe(0);
		expect(server.platform.subscribers('__group:not-created')).toBe(0);
		expect(server.platform.subscribers('__signal:victim')).toBe(0);
	});

	it('batch joins only the real group and does not serve recovery for an unjoined plugin topic', async () => {
		const lobby = createGroup('wire-batch');
		let resumeCalls = 0;
		server = await (await import('../src/testing.js')).createTestServer({
			authorizeWireSubscribe: true,
			handler: {
				...lobby.hooks,
				resume() { resumeCalls++; }
			}
		});
		const { ws, frames } = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({
			type: 'subscribe-batch',
			topics: ['__group:wire-batch', 'private-room', '__group:not-created'],
			recover: { '__group:not-created': { offset: 0 } },
			ref: 'batch'
		}));

		await waitFor(frames, (f) => f.type === 'subscribed' && f.topic === '__group:wire-batch', 'batch group ack');
		await waitFor(frames, (f) => f.type === 'subscribe-denied' && f.topic === 'private-room', 'batch app denial');
		await waitFor(frames, (f) => f.type === 'subscribe-denied' && f.topic === '__group:not-created', 'batch plugin denial');
		expect(lobby.count()).toBe(1);
		expect(resumeCalls).toBe(0);
		expect(server.platform.subscribers('__group:not-created')).toBe(0);
	});

	it('onJoin rejection happens before the wire can receive membership or roster data', async () => {
		const denied = createGroup('wire-denied', { onJoin: () => false });
		server = await (await import('../src/testing.js')).createTestServer({
			handler: denied.hooks
		});
		const { ws, frames } = await connectClient(server.wsUrl);

		ws.send(JSON.stringify({ type: 'subscribe', topic: '__group:wire-denied', ref: 'denied' }));
		const refusal = await waitFor(frames, (f) => f.type === 'subscribe-denied' && f.ref === 'denied', 'onJoin denial');
		expect(refusal.reason).toBe('FORBIDDEN');
		expect(denied.count()).toBe(0);
		expect(server.platform.subscribers('__group:wire-denied')).toBe(0);
		expect(frames.some((f) => f.topic === '__group:wire-denied' && f.event === 'members')).toBe(false);
		expect(frames.some((f) => f.topic === '__group:wire-denied' && f.event === 'join')).toBe(false);
	});
});
