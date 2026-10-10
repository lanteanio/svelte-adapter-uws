import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.dropped-stats.js';

let nonce = 0;
async function connect(url) {
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (data, binary) => {
		const raw = Buffer.from(data);
		if (binary && raw[0] === 0xfe) return; // Uncounted native pressure filler.
		const parsed = binary ? null : JSON.parse(raw.toString());
		frames.push({ raw, binary, parsed });
		if (parsed?.type === 'request') ws.send(JSON.stringify({ type: 'reply', ref: parsed.ref, data: null }));
	});
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
	return { ws, frames };
}
async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = predicate();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('expected native peer evidence was not delivered');
}
async function command(client, type, event, extra = {}) {
	const id = ++nonce;
	client.ws.send(JSON.stringify({ type, nonce: id, ...extra }));
	return (await waitFor(() => client.frames.find((frame) => frame.parsed?.event === event && frame.parsed.data?.nonce === id))).parsed.data;
}
async function close(client) {
	if (client.ws.readyState === WebSocket.CLOSED) return;
	client.ws._socket?.resume();
	await new Promise((resolve) => { client.ws.once('close', resolve); client.ws.close(); });
}
const lanes = [
	['send', 'send', 'stateless', false],
	['wire JSON', 'wire', 'stateless', false],
	['wire binary', 'wire', 'stateless', true],
	['wire declined', 'wire', 'declined', true],
	['batch JSON', 'batch', 'stateless', false],
	['batch binary', 'batch', 'stateless', true],
	['batch declined', 'batch', 'stateful-declined', true],
	['stateful binary', 'wire', 'stateful', true],
	['stateful batch', 'batch', 'stateful', true],
	['sendTo', 'sendTo', 'stateless', false],
	['advisory', 'advice', 'stateless', false],
	['game JSON', 'game', 'stateless', false],
	['game binary', 'game', 'stateless', true],
	['request', 'request', 'stateless', false],
	['unannounced wire', 'wire', 'stateless', true, true],
	['unannounced batch', 'batch', 'stateful', true, true],
	['unannounced game', 'game', 'stateless', true, true],
	['per-entry binary batch', 'batch', 'stateful-split', true]
];
for (const surface of ['built', 'testing']) {
	(hasUWS ? describe : describe.skip)('native directed close counters on ' + surface, () => {
		let server;
		let observer;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'droppedstats' });
			else {
				const { createTestServer } = await import('../src/testing.js');
				const test = await createTestServer({ handler });
				server = { wsUrl: test.wsUrl, stop: () => test.close() };
			}
			observer = await connect(server.wsUrl);
		}, 400000);
		afterAll(async () => { if (observer) await close(observer); await server?.stop(); });
		async function exercise(mode, lane, kind, capable, cold = false, delay = false) {
			const client = await connect(server.wsUrl);
			const id = surface + ':' + ++nonce;
			const params = { id, lane, kind, mode, cold, delay };
			try {
				client.ws.send(JSON.stringify({ type: 'hello', caps: capable ? [lane === 'game' ? 'game.fanout:1' : 'dropped.' + kind + ':1'] : [] }));
				expect((await command(client, 'join', 'joined', { id })).denial).toBeNull();
				const warmStart = client.frames.length;
				const warm = await command(observer, 'warm', 'warmed', params);
				expect(warm.error).toBeNull();
				expect(warm.sends.length).toBeGreaterThan(0);
				await waitFor(() => client.frames.length >= warmStart + warm.sends.length);
				// The warm frame announces wire ids before backpressure is applied.
				const first = client.frames.length;
				if (mode !== 'healthy') client.ws._socket.pause();
				const result = await command(observer, 'exercise', 'exercised', params);
				expect(result.error).toBeNull();
				expect(result.sends.length).toBeGreaterThan(0);
				const status = mode === 'healthy' ? 1 : mode === 'queued' ? 0 : 2;
				expect(result.sends.map((send) => send.result)).toEqual(result.sends.map(() => status));
				client.ws._socket.resume();
				const accepted = result.sends.filter((send) => send.result !== 2);
				if (accepted.length) await waitFor(() => client.frames.length >= first + accepted.length);
				await close(client);
				expect(client.frames.slice(first).map((frame) => frame.raw.toString('hex'))).toEqual(accepted.map((send) => send.hex));
				const expected = {
					messagesOut: result.before.messagesOut + accepted.length,
					bytesOut: result.before.bytesOut + accepted.reduce((sum, send) => sum + send.length, 0)
				};
				expect((await command(observer, 'report', 'reported', { id })).stats).toEqual(expected);
			} finally { await close(client); }
		}
		for (const mode of ['healthy', 'queued', 'dropped']) {
			it.each(lanes)(mode + ' %s', async (_label, lane, kind, capable, cold) => exercise(mode, lane, kind, capable, cold));
		}
		if (surface === 'testing') for (const binary of [false, true]) {
			it('delayed native dropped ' + (binary ? 'binary' : 'JSON'), () => exercise('dropped', 'wire', 'stateless', binary, false, true));
			it('delayed native queued ' + (binary ? 'binary' : 'JSON'), () => exercise('queued', 'wire', 'stateless', binary, false, true));
		}
	});
}
