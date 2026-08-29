// The batch exclusion contract on the MIRROR applications certify against:
// the same call-level-default / per-entry-override / null-inherits table the
// production wire answers, read off frames real clients of the harness
// receive on both of its lanes. A mirror that echoed the author back would
// certify an application the production server then embarrasses - the drift
// class the batch parity suite names.

import { describe, it, expect, afterEach } from 'vitest';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const itUWS = uWS ? it : it.skip;

let server = null;
const clients = [];

afterEach(async () => {
	for (const c of clients) { try { c.ws.close(); } catch { /* gone */ } }
	clients.length = 0;
	await server?.close();
	server = null;
});

async function boot() {
	const { createTestServer } = await import('../src/testing.js');
	/** @type {Record<string, any>} */
	const captured = {};
	server = await createTestServer({
		handler: {
			message(ws, ctx) {
				const m = ctx.msg;
				// The server-side socket identity `excludeWs` compares against,
				// captured through the same hook an application would use.
				if (m && m.type === 'iam' && typeof m.name === 'string') captured[m.name] = ws;
			}
		}
	});
	return captured;
}

async function join(name, topic, ref) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(server.wsUrl);
	const frames = [];
	ws.on('message', (d, isBinary) => { if (!isBinary) { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } } });
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'iam', name }));
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref }));
	const deadline = Date.now() + 5000;
	while (!frames.some((p) => p && p.type === 'subscribed' && p.topic === topic && p.ref === ref) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(frames.some((p) => p && p.type === 'subscribed' && p.topic === topic && p.ref === ref),
		`${name} subscribe was never acknowledged`).toBe(true);
	const client = { ws, frames, name };
	clients.push(client);
	return client;
}

const received = (client, topic) => client.frames
	.filter((p) => p && p.topic === topic && p.event === 'update')
	.map((p) => p.data.n);

async function assertContract(topic, wire) {
	const captured = await boot();
	const author = await join('author', topic, 1);
	const audience = await join('audience', topic, 2);
	const authorWs = captured.author;
	const audienceWs = captured.audience;
	expect(authorWs, 'the handler never captured the author socket').toBeTruthy();
	expect(audienceWs, 'the handler never captured the audience socket').toBeTruthy();

	server.platform.publishWireBatch(topic, 'update', [
		{ data: { n: 0 } },
		{ data: { n: 1 }, excludeWs: audienceWs },
		{ data: { n: 2 } },
		// null is ABSENT, not an override to nothing: it inherits the
		// call-level default like an entry that says nothing.
		{ data: { n: 3 }, excludeWs: null }
	], wire, { seq: false, excludeWs: authorWs });

	const deadline = Date.now() + 5000;
	while (!audience.frames.some((p) => p && p.topic === topic && p.data && p.data.n === 3) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(received(audience, topic), 'the audience receives all but its own override entry').toEqual([0, 2, 3]);
	expect(received(author, topic), 'the author hears only the entry that overrode the default').toEqual([1]);
}

describe('batch exclusions on the harness mirror', () => {
	itUWS('the stateful lane honours the call-level default, override, and null-inherit', async () => {
		await assertContract('exclude-mirror-stateful', {
			capability: 'fixture.exclude-mirror-stateful:1',
			schemaVersion: 1,
			state: { onAttach: () => ({}) },
			encode: () => null
		});
	}, 30000);

	itUWS('the stateless lane answers the same contract', async () => {
		await assertContract('exclude-mirror-stateless', {
			capability: 'fixture.exclude-mirror-stateless:1',
			schemaVersion: 1,
			encode: () => null
		});
	}, 30000);
});
