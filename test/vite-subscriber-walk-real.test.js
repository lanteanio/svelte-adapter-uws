import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import createPlugin from '../src/vite.js';
import { connectRealClient } from './helpers/real-runtime.js';

let server;
let wsUrl;
let nonce = 0;
const clients = [];
const joined = new Map();
const handler = {
	async message(ws, { data, platform }) {
		const msg = JSON.parse(Buffer.from(data).toString());
		if (msg.type === 'join') {
			const denial = await platform.subscribe(ws, msg.topic);
			joined.set(msg.name, ws);
			ws.getUserData().walkName = msg.name;
			platform.send(ws, 'walk', 'joined', { nonce: msg.nonce, denial });
		} else if (msg.type === 'leave') {
			platform.unsubscribe(ws, msg.topic);
			platform.send(ws, 'walk', 'left', { nonce: msg.nonce });
		} else if (msg.type === 'walk') {
			const members = [];
			let error = null;
			try {
				platform.forEachSubscriber(msg.topic, (member, userData) => {
					members.push({ name: userData.walkName, sameSocket: member === joined.get(userData.walkName), sameData: userData === member.getUserData(), subscribed: member.isSubscribed(msg.topic) });
					platform.send(member, 'walk', 'walk-delivery', { nonce: msg.nonce });
				});
			} catch (cause) { error = String(cause); }
			platform.send(ws, 'walk', 'walked', { nonce: msg.nonce, members, error });
		} else if (msg.type === 'request-topic') {
			const results = await platform.requestTopic(msg.topic, 'probe', { nonce: msg.nonce }, { timeoutMs: 100 });
			platform.send(ws, 'walk', 'requested', { nonce: msg.nonce, results });
		} else if (msg.type === 'barrier') platform.send(ws, 'walk', 'barrier', { nonce: msg.nonce });
	}
};

beforeAll(async () => {
	server = createServer();
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	await createPlugin({ allowedOrigins: '*', handler: '/subscriber-walk' }).configureServer({
		httpServer: server, middlewares: { stack: [], use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return handler; }
	});
	wsUrl = 'ws://127.0.0.1:' + server.address().port + '/ws';
});

it('requests matching live adapter sockets and collects replies and per-member timeouts', async () => {
	const a = await connectRealClient(wsUrl);
	const silent = await connectRealClient(wsUrl);
	const other = await connectRealClient(wsUrl);
	clients.push(a, silent, other);
	for (const [client, name, topic] of [[a, 'answer', 'request:target'], [silent, 'silent', 'request:target'], [other, 'other', 'request:other']]) {
		expect((await command(client, 'join', 'joined', { name, topic })).denial).toBeNull();
	}
	a.ws.on('message', (raw) => {
		const msg = JSON.parse(raw.toString());
		if (msg.type === 'request') a.send({ type: 'reply', ref: msg.ref, data: { event: msg.event, ...msg.data } });
	});
	const reply = await command(other, 'request-topic', 'requested', { topic: 'request:target' });
	expect(reply.results).toEqual([
		{ ok: true, reply: { event: 'probe', nonce: reply.nonce } },
		{ ok: false, error: expect.stringMatching(/timed out/i) }
	]);
	await command(other, 'barrier', 'barrier');
	expect(other.frames.map(raw => JSON.parse(raw)).filter(frame => frame.type === 'request')).toEqual([]);
	await command(a, 'leave', 'left', { topic: 'request:target' });
	await new Promise(resolve => { silent.ws.once('close', resolve); silent.close(); });
	expect((await command(other, 'request-topic', 'requested', { topic: 'request:target' })).results).toEqual([]);
	expect((await command(other, 'request-topic', 'requested', { topic: 'request:empty' })).results).toEqual([]);
});
afterAll(async () => { for (const client of clients) client.close(); await new Promise((resolve) => server.close(resolve)); });

async function command(client, type, event, extra = {}) {
	const id = ++nonce;
	client.send({ type, nonce: id, ...extra });
	const reply = await client.waitFor((value) => value?.event === event && value.data?.nonce === id);
	expect(reply, event + ' must answer').not.toBeNull();
	return reply.parsed.data;
}
function delivered(client, id) {
	return client.frames.filter((raw) => { try { const value = JSON.parse(raw); return value.event === 'walk-delivery' && value.data?.nonce === id; } catch { return false; } });
}

it('walks matching live members with the same adapter socket and user data given to hooks', async () => {
	const a = await connectRealClient(wsUrl);
	const b = await connectRealClient(wsUrl);
	const other = await connectRealClient(wsUrl);
	clients.push(a, b, other);
	for (const [client, name, topic] of [[a, 'first', 'walk:target'], [b, 'second', 'walk:target'], [other, 'other', 'walk:other']]) {
		expect((await command(client, 'join', 'joined', { name, topic })).denial).toBeNull();
	}
	const walk = await command(a, 'walk', 'walked', { topic: 'walk:target' });
	expect(walk.error).toBeNull();
	expect(walk.members).toEqual([
		{ name: 'first', sameSocket: true, sameData: true, subscribed: true },
		{ name: 'second', sameSocket: true, sameData: true, subscribed: true }
	]);
	for (const client of [a, b, other]) await command(client, 'barrier', 'barrier');
	expect(delivered(a, walk.nonce)).toHaveLength(1);
	expect(delivered(b, walk.nonce)).toHaveLength(1);
	expect(delivered(other, walk.nonce)).toHaveLength(0);
	expect(await command(a, 'walk', 'walked', { topic: 'walk:empty' })).toMatchObject({ members: [], error: null });
	await command(a, 'leave', 'left', { topic: 'walk:target' });
	await new Promise((resolve) => { b.ws.once('close', resolve); b.close(); });
	expect(await command(a, 'walk', 'walked', { topic: 'walk:target' })).toMatchObject({ members: [], error: null });
});
