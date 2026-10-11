import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.system-topics.js';

for (const surface of ['built', 'testing']) {
	(hasUWS ? describe : describe.skip)('trusted system-topic authorization on ' + surface, () => {
		let server;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'systemtopics' });
			else {
				const { createTestServer } = await import('../src/testing.js');
				const test = await createTestServer({ handler });
				server = { wsUrl: test.wsUrl, stop: () => test.close() };
			}
		}, 400000);
		afterAll(async () => { await server?.stop(); });

		it.each([
			['check', 'allow'], ['check', 'deny'],
			['subscribe', 'allow'], ['subscribe', 'deny']
		])('%s consults the hook for a system topic it can %s', async (operation, outcome) => {
			const topic = '__contract:' + outcome;
			const client = new WebSocket(server.wsUrl);
			const frames = [];
			try {
				const result = new Promise((resolve, reject) => {
					client.once('error', reject);
					client.on('message', raw => {
						const frame = JSON.parse(raw.toString());
						frames.push(frame);
						if (frame.event === 'result') resolve(frame.data);
					});
					client.once('open', () => client.send(JSON.stringify({ type: 'probe', operation, topic })));
				});
				const admitted = operation === 'subscribe' && outcome === 'allow';
				expect(await result).toEqual({
					denial: outcome === 'allow' ? null : 'FORBIDDEN',
					calls: [topic], subscribers: admitted ? 1 : 0
				});
				expect(frames.filter(frame => frame.event === 'delivery')).toEqual(
					admitted ? [expect.objectContaining({ topic, data: { topic } })] : []
				);
			} finally {
				if (client.readyState !== WebSocket.CLOSED) {
					await new Promise(resolve => { client.once('close', resolve); client.terminate(); });
				}
			}
		});
	});
}
