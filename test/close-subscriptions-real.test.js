import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.close-subscriptions.js';

const describeUWS = hasUWS ? describe : describe.skip;
let nextId = 0;
for (const surface of ['built', 'testing', 'vite']) {
	describeUWS('close subscription snapshots on ' + surface, () => {
		let server;
		let observer;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'closesubscriptions' });
			else if (surface === 'testing') {
				const { createTestServer } = await import('../src/testing.js');
				const test = await createTestServer({ handler });
				server = { wsUrl: test.wsUrl, stop: () => test.close() };
			} else {
				const { default: createPlugin } = await import('../src/vite.js');
				const httpServer = createServer();
				await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
				await createPlugin({ allowedOrigins: '*', handler: '/close-subscriptions' }).configureServer({
					httpServer, middlewares: { use() {} },
					config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
					async ssrLoadModule() { return handler; }
				});
				server = { wsUrl: 'ws://127.0.0.1:' + httpServer.address().port + '/ws', stop: () => new Promise((resolve) => httpServer.close(resolve)) };
			}
			observer = await connectRealClient(server.wsUrl);
		}, 400000);
		afterAll(async () => { observer?.close(); await server?.stop(); });
		it.each([
			['array', ['untrusted']], ['object', { size: 4 }], ['string', 'untrusted'],
			['number', 7], ['null', null], ['missing', undefined], ['valid', null],
			['revoked', null], ['prototype-trap', null], ['impostor', null]
		])('hands the hook a safe Set for a %s registry', async (mode, value) => {
			const client = await connectRealClient(server.wsUrl);
			const id = surface + ':' + ++nextId;
			const closed = new Promise((resolve) => client.ws.once('close', resolve));
			try {
				client.send({ type: 'arm', id, mode, value });
				expect(await client.waitFor((frame) => frame?.event === 'armed' && frame.data?.id === id)).not.toBeNull();
				await closed;
				observer.send({ type: 'report', id });
				const reply = await observer.waitFor((frame) => frame?.event === 'reported' && frame.data?.id === id);
				expect(reply).not.toBeNull();
				expect(reply.parsed.data.closed).toEqual({ isSet: true, same: mode === 'valid', topics: mode === 'valid' ? ['close:kept'] : [], completed: true });
				expect(reply.parsed.data.connections).toBe(1);
			} finally { client.close(); }
		});
	});
}
