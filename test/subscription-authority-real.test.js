import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.subscription-state.js';

let nonce = 0;
const topic = 'private:subscription-authority';

async function command(client, type, event, extra = {}) {
	const id = ++nonce;
	client.send({ type, topic, nonce: id, ...extra });
	const frame = await client.waitFor((value) => value?.event === event && value.data?.nonce === id);
	expect(frame, event + ' must answer').not.toBeNull();
	return frame.parsed.data;
}

async function parked(client, index, recover = false, batch = false) {
	const frame = batch
		? { type: 'subscribe-batch', topics: [topic], ref: index + 1, ...(recover ? { recover: { [topic]: { offset: 0 } } } : {}) }
		: { type: 'subscribe', topic, ref: index + 1, ...(recover ? { recover: { offset: 0 } } : {}) };
	client.send(frame);
	expect(await client.waitFor((value) => value?.event === 'parked' && value.data?.index === index)).not.toBeNull();
}

async function install(client, index) {
	client.send({ type: 'install', index });
	expect(await client.waitFor((value) => value?.event === 'installed' && value.data?.index === index)).not.toBeNull();
}

async function finish(client, index, denial) {
	client.send({ type: 'finish', index, denial });
	const answer = await client.waitFor((value) => ['subscribed', 'subscribe-denied'].includes(value?.type) && value.ref === index + 1);
	expect(answer, 'the subscribe must settle').not.toBeNull();
	return answer.parsed;
}

async function bootDev() {
	const { default: createPlugin } = await import('../src/vite.js');
	const httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const plugin = createPlugin({ allowedOrigins: '*', handler: '/subscription-handler' });
	await plugin.configureServer({
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
	suite('subscription authority on ' + surface, () => {
		let server;
		const clients = [];
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'subscriptionstate' });
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

		// The strict policy latches worker-wide, so cases that arm it follow the
		// cases whose first wire admission needs an ordinary authorization hook.
		it.each([false, true])('records a server re-grant over an unconfirmed install (revoked=%s)', async (revoked) => {
			const client = await connect();
			await parked(client, 0);
			if (revoked) await command(client, 'revoke', 'revoked');
			await install(client, 0);
			expect((await command(client, 'grant', 'granted')).denial).toBeNull();
			const answer = await finish(client, 0, revoked ? undefined : 'FORBIDDEN');
			expect(answer.type).toBe(revoked ? 'subscribed' : 'subscribe-denied');
			expect((await command(client, 'probe', 'state')).held).toBe(true);
			const published = await command(client, 'publish', 'published');
			expect(await client.waitFor((value) => value?.event === 'delivery' && value.data?.nonce === published.nonce)).not.toBeNull();
			client.close();
		});

		it.each([false, true])('withholds recover history from a revoked hook install (batch=%s)', async (batch) => {
			const client = await connect();
			await parked(client, 0, true, batch);
			await command(client, 'revoke', 'revoked');
			await install(client, 0);
			expect(await finish(client, 0)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
			expect(await command(client, 'probe', 'state')).toMatchObject({ resumed: [], held: false });
			const published = await command(client, 'publish', 'published');
			expect(client.frames.map((frame) => JSON.parse(frame)).some((frame) => frame?.event === 'delivery' && frame.data?.nonce === published.nonce)).toBe(false);
			client.close();
		});

		it.each([false, true])('serves recover history after a confirmed server re-grant (batch=%s)', async (batch) => {
			const client = await connect();
			await parked(client, 0, true, batch);
			await command(client, 'revoke', 'revoked');
			await install(client, 0);
			expect((await command(client, 'grant', 'granted')).denial).toBeNull();
			expect(await finish(client, 0)).toMatchObject({ type: 'subscribed' });
			expect((await command(client, 'probe', 'state')).resumed).toContain(topic);
			expect(await client.waitFor((value) => value?.event === 'history' && value.data?.topics?.includes(topic))).not.toBeNull();
			client.close();
		});

		it('does not let a refused fresh landing preserve a revoked sibling install', async () => {
			const installed = [];
			for (const [recover, batch] of [[false, false], [true, false], [true, true]]) {
				const pending = await connect();
				await parked(pending, 0, recover, batch);
				await install(pending, 0);
				installed.push(pending);
			}
			const client = await connect();
			await parked(client, 0);
			await command(client, 'revoke', 'revoked');
			await parked(client, 1);
			await command(client, 'arm', 'armed');
			for (const pending of installed) {
				expect(await finish(pending, 0)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
				expect(await command(pending, 'probe', 'state')).toMatchObject({ resumed: [], held: false });
				pending.close();
			}
			expect(await finish(client, 1)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
			await install(client, 0);
			client.send({ type: 'subscribe', topic, ref: 3 });
			const single = await client.waitFor((value) => value?.ref === 3);
			expect(single?.parsed).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
			client.send({ type: 'subscribe-batch', topics: [topic], ref: 4 });
			const batch = await client.waitFor((value) => value?.ref === 4);
			expect(batch?.parsed).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
			expect((await command(client, 'observe', 'observed')).denial).toBe('FORBIDDEN');
			client.send({ type: 'resume', sessionId: 'previous-session', lastSeenSeqs: { [topic]: 0 }, lastSeenEpochs: { [topic]: 1 } });
			const history = await client.waitFor((value) => value?.event === 'history');
			expect(history?.parsed.data).toMatchObject({ topics: [], epochTopics: [] });
			expect(await finish(client, 0)).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
			expect((await command(client, 'probe', 'state')).held).toBe(false);
			const published = await command(client, 'publish', 'published');
			expect(client.frames.map((frame) => JSON.parse(frame)).some((frame) => frame?.event === 'delivery' && frame.data?.nonce === published.nonce)).toBe(false);
			client.close();
		});
	});
}
