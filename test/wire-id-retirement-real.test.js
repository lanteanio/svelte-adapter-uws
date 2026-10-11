import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { parseBinaryFrame } from '../src/runtime/wire.js';
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
for (const surface of ['built', 'testing']) {
	(hasUWS ? describe : describe.skip)('wire-id recovery across capabilities on ' + surface, () => {
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

		it.each(['stateless', 'stateful'])('re-announces after the %s capability loses its first announcement', async firstKind => {
			const client = await connect(server.wsUrl);
			const id = surface + ':' + ++nonce;
			const topic = 'dropped:' + id;
			const secondKind = firstKind === 'stateless' ? 'stateful' : 'stateless';
			try {
				client.ws.send(JSON.stringify({ type: 'hello', caps: ['dropped.stateless:1', 'dropped.stateful:1'] }));
				expect((await command(client, 'join', 'joined', { id })).denial).toBeNull();
				client.ws._socket.pause();
				const refused = await command(observer, 'exercise', 'exercised', { id, lane: 'wire', kind: firstKind, mode: 'dropped' });
				expect(refused.error).toBeNull();
				const announcement = JSON.parse(Buffer.from(refused.sends[0].hex, 'hex').toString());
				expect(announcement).toEqual({ type: 'wire-id', topic, id: 1 });
				expect(refused.sends[0].result).toBe(2);
				client.ws._socket.resume();
				await expect.poll(async () => (await command(observer, 'buffered', 'buffered', { id })).bytes, { timeout: 5000 }).toBe(0);

				const recovered = await command(observer, 'warm', 'warmed', { id, lane: 'wire', kind: secondKind });
				expect(recovered.error).toBeNull();
				await waitFor(() => client.frames.some(frame => frame.binary));
				const delivered = client.frames.filter(frame => frame.binary || frame.parsed?.type === 'wire-id');
				expect(delivered).toHaveLength(2);
				expect(delivered[0].parsed).toEqual({ type: 'wire-id', topic, id: 2 });
				expect(delivered[1].binary).toBe(true);
				const decoded = parseBinaryFrame(delivered[1].raw);
				expect(decoded.topicId).toBe(delivered[0].parsed.id);
				expect([...decoded.payload]).toEqual([0xa5, 42]);

				// The failed capability stays in its JSON recovery tier. A second
				// send by the healthy capability reuses its delivered mapping.
				await command(observer, 'warm', 'warmed', { id, lane: 'wire', kind: firstKind });
				await waitFor(() => client.frames.some(frame => frame.parsed?.topic === topic && frame.parsed?.event === 'probe'));
				await command(observer, 'warm', 'warmed', { id, lane: 'wire', kind: secondKind });
				await waitFor(() => client.frames.filter(frame => frame.binary).length === 2);
				expect(client.frames.filter(frame => frame.parsed?.type === 'wire-id')).toHaveLength(1);
				expect(parseBinaryFrame(client.frames.filter(frame => frame.binary)[1].raw).topicId).toBe(2);
			} finally { await close(client); }
		}, 30000);
	});
}
