import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.wire-stats.js';

let nonce = 0;
async function connect(url) {
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data, binary) => frames.push({ raw: Buffer.from(data), binary, at: performance.now(), parsed: binary ? null : JSON.parse(data.toString()) }));
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	return { ws, frames };
}
async function waitFor(client, predicate) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const found = client.frames.find(predicate);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('expected peer frame was not delivered');
}
async function command(client, type, event, extra = {}) {
	const id = ++nonce;
	client.ws.send(JSON.stringify({ type, nonce: id, ...extra }));
	return waitFor(client, (frame) => frame.parsed?.event === event && frame.parsed.data?.nonce === id);
}
async function close(client) {
	if (client.ws.readyState === WebSocket.CLOSED) return;
	await new Promise((resolve) => { client.ws.once('close', resolve); client.ws.close(); });
}
function isBroadcast(frame) { return frame.binary ? frame.raw.at(-1) !== 17 : frame.parsed.event === 'cast'; }
const cases = [
	['stateless binary', 'stateless', true, false, false],
	['stateless JSON walk', 'stateless', false, false, true],
	['declined JSON walk', 'declined', true, false, true],
	['stateful binary', 'stateful', true, false, false],
	['stateful JSON walk', 'stateful', false, false, true],
	['stateful declined', 'stateful-declined', true, false, false],
	['stateless binary batch', 'stateless', true, true, false],
	['stateless JSON batch', 'stateless', false, true, true],
	['stateful binary batch', 'stateful', true, true, false],
	['stateful JSON batch', 'stateful', false, true, true],
	['stateful declined batch', 'stateful-declined', true, true, false],
	['shared binary', 'shared', true, false, false]
];
for (const surface of ['built', 'testing']) {
	(hasUWS ? describe : describe.skip)('broadcast close counters on ' + surface, () => {
		let server;
		let observer;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'wirestats' });
			else {
				const { createTestServer } = await import('../src/testing.js');
				const test = await createTestServer({ handler });
				server = { wsUrl: test.wsUrl, stop: () => test.close() };
			}
			observer = await connect(server.wsUrl);
		}, 400000);
		afterAll(async () => { if (observer) await close(observer); await server?.stop(); });
		async function exercise(kind, capable, batch, exclude, chaos) {
			const client = await connect(server.wsUrl);
			const id = surface + ':' + ++nonce;
			const topic = 'stats:' + id;
			try {
				client.ws.send(JSON.stringify({ type: 'hello', caps: capable ? ['stats.' + kind + ':1'] : [] }));
				expect((await command(client, 'join', 'joined', { id, topic })).parsed.data.denial).toBeNull();
				// Directed wire traffic must remain counted; it also announces binary ids.
				client.ws.send(JSON.stringify({ type: 'direct', topic, kind }));
				await waitFor(client, (frame) => frame.binary ? frame.raw.at(-1) === 17 : frame.parsed.event === 'direct');
				const before = client.frames.filter(isBroadcast).length;
				const sentAt = performance.now();
				const ack = await command(client, 'cast', 'cast-done', { topic, kind, batch, exclude, chaos });
				const dropped = chaos?.scenario === 'drop-outbound';
				const binary = capable && !kind.includes('declined');
				const count = dropped ? 0 : batch && !(binary && kind.startsWith('stateful')) ? 2 : 1;
				if (count) await waitFor(client, () => client.frames.filter(isBroadcast).length === before + count);
				await command(client, 'barrier', 'barrier');
				const broadcasts = client.frames.filter(isBroadcast).slice(before);
				expect(broadcasts).toHaveLength(count);
				for (const frame of broadcasts) expect(frame.binary).toBe(binary);
				if (chaos?.scenario === 'slow-drain') {
					expect(broadcasts[0].at - sentAt).toBeGreaterThanOrEqual(40);
					expect(broadcasts[0].at).toBeGreaterThan(ack.at);
				}
				await close(client);
				const directed = client.frames.filter((frame) => !isBroadcast(frame));
				const expected = { messagesOut: directed.length, bytesOut: directed.reduce((sum, frame) => sum + frame.raw.length, 0) };
				expect((await command(observer, 'report', 'reported', { id })).parsed.data.stats).toEqual(expected);
			} finally { await close(client); }
		}
		it.each(cases)('excludes %s but keeps actual directed bytes', async (_label, kind, capable, batch, exclude) => exercise(kind, capable, batch, exclude));
		if (surface === 'testing') for (const binary of [false, true]) {
			it('preserves chaos drop without charging ' + (binary ? 'binary' : 'JSON'), () => exercise('stateless', binary, false, !binary, { scenario: 'drop-outbound', dropRate: 1 }));
			it('preserves chaos delay without charging ' + (binary ? 'binary' : 'JSON'), () => exercise('stateless', binary, false, !binary, { scenario: 'slow-drain', delayMs: 60 }));
		}
	});
}
