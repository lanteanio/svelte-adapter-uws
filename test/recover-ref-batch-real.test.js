import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.recover-ref.js';

let nonce = 0;
async function probe(client, topics) {
	const id = ++nonce;
	client.send({ type: 'probe', topics, nonce: id });
	const answer = await client.waitFor((frame) => frame?.event === 'state' && frame.data?.nonce === id);
	expect(answer, 'the state probe must answer').not.toBeNull();
	return answer.parsed.data;
}

async function bootDev() {
	const { default: createPlugin } = await import('../src/vite.js');
	const httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	await createPlugin({ allowedOrigins: '*', handler: '/recover-ref-handler' }).configureServer({
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return handler; }
	});
	return {
		wsUrl: 'ws://127.0.0.1:' + httpServer.address().port + '/ws',
		async stop() { await new Promise((resolve) => httpServer.close(resolve)); }
	};
}

for (const surface of ['built', 'testing', 'vite']) {
	const suite = surface === 'vite' || hasUWS ? describe : describe.skip;
	suite('recover batch ref contract on ' + surface, () => {
		let server;
		const clients = [];
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'recoverref' });
			else if (surface === 'testing') {
				const { createTestServer } = await import('../src/testing.js');
				const testServer = await createTestServer({ handler });
				server = { wsUrl: testServer.wsUrl, stop: () => testServer.close() };
			} else server = await bootDev();
		}, 400000);
		afterAll(async () => {
			for (const client of clients) client.close();
			await server?.stop();
		});
		async function connect() {
			const client = await connectRealClient(server.wsUrl);
			clients.push(client);
			return client;
		}

		it.each(['included', 'outside', 'invalid'])('refuses the whole ref-less batch before membership or history (%s)', async (lane) => {
			const client = await connect();
			const topics = lane === 'invalid' ? ['invalid topic\n', 'recover-ref-b'] : ['recover-ref-a', 'recover-ref-b'];
			const recoverTopic = lane === 'outside' ? 'not-in-topics' : topics[0];
			client.send({ type: 'subscribe-batch', topics, recover: { [recoverTopic]: { offset: 0 } } });
			const state = await probe(client, topics);
			const frames = client.frames.map((raw) => JSON.parse(raw));
			expect(frames.filter((frame) => frame.type === 'error')).toEqual([{ type: 'error', code: 'RECOVER_REQUIRES_REF', topic: null }]);
			expect(state).toMatchObject({ held: [false, false], resumed: [] });
			expect(frames.some((frame) => frame.event === 'history' || frame.type === 'subscribed')).toBe(false);
			client.close();
		});

		it.each([{}, { 'recover-ref-a': { offset: 'invalid' } }])('keeps plain ref-less admission for ignored recover %j', async (recover) => {
			const client = await connect();
			client.send({ type: 'subscribe-batch', topics: ['recover-ref-a'], recover });
			expect(await probe(client, ['recover-ref-a'])).toMatchObject({ held: [true], resumed: [] });
			const frames = client.frames.map((raw) => JSON.parse(raw));
			expect(frames.some((frame) => frame.type === 'error' || frame.type === 'subscribed' || frame.event === 'history')).toBe(false);
			client.close();
		});

		it('accepts ref zero, serves history and installs every requested topic', async () => {
			const client = await connect();
			const topics = ['recover-ref-a', 'recover-ref-b'];
			client.send({ type: 'subscribe-batch', topics, recover: { 'recover-ref-a': { offset: 0 } }, ref: 0 });
			expect(await probe(client, topics)).toMatchObject({ held: [true, true], resumed: ['recover-ref-a'] });
			const frames = client.frames.map((raw) => JSON.parse(raw));
			expect(frames.filter((frame) => frame.type === 'subscribed').map((frame) => [frame.topic, frame.ref])).toEqual(topics.map((topic) => [topic, 0]));
			expect(frames.some((frame) => frame.event === 'history' && frame.data.value === 'private-history')).toBe(true);
			expect(frames.some((frame) => frame.type === 'error')).toBe(false);
			client.close();
		});
	});
}
