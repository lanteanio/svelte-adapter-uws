import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.topic-stats.js';

let nonce = 0;
async function connect(url) {
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data) => frames.push({ raw: Buffer.from(data), at: performance.now(), parsed: JSON.parse(data.toString()) }));
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	return { ws, frames };
}
async function waitFor(predicate) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const found = predicate();
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('expected topic broadcast evidence was not delivered');
}
async function command(client, type, event, extra = {}) {
	const id = ++nonce;
	client.ws.send(JSON.stringify({ type, nonce: id, ...extra }));
	return waitFor(() => client.frames.find((frame) => frame.parsed.event === event && frame.parsed.data?.nonce === id));
}
async function close(client) {
	if (client.ws.readyState === WebSocket.CLOSED) return;
	await new Promise((resolve) => { client.ws.once('close', resolve); client.ws.close(); });
}
const isBroadcast = (frame) => frame.parsed.event === 'cast' || frame.parsed.type === 'batch';
const events = (client) => client.frames.filter(isBroadcast).flatMap((frame) => frame.parsed.type === 'batch' ? frame.parsed.events : [frame.parsed]);
const cases = [
	['single publish', false, false, false, false],
	['same-topic packed batch', true, true, false, false],
	['same-topic fallback batch', true, false, false, false],
	['cross-topic packed batch', true, true, true, false],
	['cross-topic filtered fallback', true, true, true, true]
];
const scenarios = [
	['native', null],
	['active pass-through', { scenario: 'drop-outbound', dropRate: 0 }],
	['drop-all', { scenario: 'drop-outbound', dropRate: 1 }],
	['delayed', { scenario: 'slow-drain', delayMs: 60 }],
	['jittered', { scenario: 'ipc-reorder', maxJitterMs: 30 }]
];
for (const surface of ['built', 'testing']) {
	(hasUWS ? describe : describe.skip)('ordinary broadcast close counters on ' + surface, () => {
		let server;
		let observer;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'topicstats' });
			else {
				const { createTestServer } = await import('../src/testing.js');
				const test = await createTestServer({ handler });
				server = { wsUrl: test.wsUrl, stop: () => test.close() };
			}
			observer = await connect(server.wsUrl);
		}, 400000);
		afterAll(async () => { if (observer) await close(observer); await server?.stop(); });
		for (const [label, chaos] of surface === 'built' ? scenarios.slice(0, 1) : scenarios) {
			it.each(cases)(label + ' %s', async (_name, batch, capable, crossTopic, partial) => {
				const client = await connect(server.wsUrl);
				const id = surface + ':' + ++nonce;
				const firstTopic = 'topic-stats:' + id;
				const secondTopic = crossTopic ? firstTopic + ':other' : firstTopic;
				const topics = crossTopic && !partial ? [firstTopic, secondTopic] : [firstTopic];
				try {
					client.ws.send(JSON.stringify({ type: 'hello', caps: capable ? ['batch'] : [] }));
					expect((await command(client, 'join', 'joined', { id, topics })).parsed.data.denials).toEqual(topics.map(() => null));
					await command(client, 'direct', 'direct');
					const messages = [{ topic: firstTopic, event: 'cast', data: { marker: 42 } }];
					if (batch) messages.push({ topic: secondTopic, event: 'cast', data: { marker: 43 } });
					const expected = label === 'drop-all' ? [] : messages.filter((entry) => topics.includes(entry.topic)).map((entry) => entry.data.marker);
					const sentAt = performance.now();
					const ack = await command(client, 'cast', 'cast-done', { batch, messages, chaos });
					if (expected.length) await waitFor(() => events(client).length === expected.length);
					await command(client, 'barrier', 'barrier');
					expect(events(client).map((entry) => entry.data.marker).sort()).toEqual(expected);
					const packed = batch && capable && !partial;
					const broadcastFrames = client.frames.filter(isBroadcast);
					expect(broadcastFrames).toHaveLength(expected.length === 0 ? 0 : packed ? 1 : expected.length);
					for (const frame of broadcastFrames) expect(frame.parsed.type === 'batch').toBe(packed);
					if (label === 'delayed') {
						const deliveredAt = client.frames.find(isBroadcast).at;
						expect(deliveredAt - sentAt).toBeGreaterThanOrEqual(40);
						expect(deliveredAt).toBeGreaterThan(ack.at);
					}
					await close(client);
					const directed = client.frames.filter((frame) => !isBroadcast(frame));
					const counters = { messagesOut: directed.length, bytesOut: directed.reduce((sum, frame) => sum + frame.raw.length, 0) };
					expect((await command(observer, 'report', 'reported', { id })).parsed.data.stats).toEqual(counters);
				} finally { await close(client); }
			});
		}
	});
}
