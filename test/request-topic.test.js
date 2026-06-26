import { describe, it, expect, afterEach } from 'vitest';

// platform.requestTopic: broadcast a request to every subscriber of a topic and
// aggregate per-subscriber replies, with partial success (a non-replying
// subscriber times out into an error entry). Exercised over a real uWS server.
let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

/** Connect a ws client, subscribe it to `topic`, and (optionally) auto-reply to requests. */
async function connectSubscribed(url, topic, autoReply) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.on('message', (raw) => {
		let msg;
		try { msg = JSON.parse(raw.toString()); } catch { return; }
		if (msg.type === 'request' && autoReply) {
			const out = autoReply(msg);
			if (out !== undefined) ws.send(JSON.stringify({ type: 'reply', ref: msg.ref, data: out }));
			// returning undefined = never reply -> the server-side request times out
		}
	});
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref: 1 }));
	await new Promise((resolve) => {
		const h = (raw) => {
			let m;
			try { m = JSON.parse(raw.toString()); } catch { return; }
			if (m.type === 'subscribed' && m.topic === topic) { ws.off('message', h); resolve(); }
		};
		ws.on('message', h);
	});
	return ws;
}

describeUWS('platform.requestTopic', () => {
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it('fans out to every subscriber and aggregates replies (partial success)', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const a = await connectSubscribed(server.wsUrl, 'room', (m) => ({ from: 'a', echo: m.data }));
		const b = await connectSubscribed(server.wsUrl, 'room', () => undefined); // never replies -> timeout

		const results = await server.platform.requestTopic('room', 'ping', { n: 1 }, { timeoutMs: 200 });
		expect(results).toHaveLength(2);
		const ok = results.filter((r) => r.ok);
		const bad = results.filter((r) => !r.ok);
		expect(ok).toHaveLength(1);
		expect(ok[0].reply).toEqual({ from: 'a', echo: { n: 1 } });
		expect(bad).toHaveLength(1);
		expect(bad[0].error).toMatch(/timed out/i);

		a.close();
		b.close();
	});

	it('returns an empty array when no socket subscribes the topic', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		expect(await server.platform.requestTopic('nobody', 'ping', {})).toEqual([]);
	});
});
