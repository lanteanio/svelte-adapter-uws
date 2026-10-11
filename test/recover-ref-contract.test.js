// A subscribe that asks for HISTORY must carry a ref, on every surface.
//
// The family ack policy is deliberate silence for a ref-less subscribe - the
// client said it would not listen. The recover lane is the exception the
// policy needs: history is the one request whose reply the client must
// correlate, and before this contract a ref-less recover subscribe that hit
// the saturated gate (or any silent denial) installed nothing and said
// nothing - the client believed itself subscribed and resumed into a silent
// gap. It is now refused up front by an uncorrelatable error frame,
// {"type":"error","code":"RECOVER_REQUIRES_REF","topic":...}, the established
// shape for frames that answer for no correlatable request. A plain ref-less
// subscribe keeps its documented silence: the refusal engages only where a
// resume hook exists and the recover object would engage it.
//
// ONE VARIANT PER TEST FILE (grant, the resume-armed fixture) for the real
// half, per helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const isRefusal = (p, topic) => p && p.type === 'error' && p.code === 'RECOVER_REQUIRES_REF' && p.topic === topic;

describeUWS('production refuses a ref-less recover subscribe with the uncorrelatable error', () => {
	/** @type {any} */ let rt;
	/** @type {any} */ let client;

	beforeAll(async () => {
		rt = await startRealRuntime({ variant: 'grant' });
		client = await connectRealClient(rt.wsUrl);
	}, 90000);

	afterAll(async () => {
		try { client?.close(); } catch { /* gone */ }
		await rt?.stop();
	});

	it('answers the error frame instead of silence, and only for the recover lane', async () => {
		client.send({ type: 'subscribe', topic: 'recover-ref-single', recover: { offset: 0 } });
		const refusal = await client.waitFor((p) => isRefusal(p, 'recover-ref-single'), 5000);
		expect(refusal, 'the ref-less recover subscribe died silently').not.toBeNull();

		// The same request WITH a ref takes the ordinary lanes and gets a
		// correlatable answer (here the armed grant gate's denial - the
		// point is that an answer arrives on the ref, not which one).
		client.send({ type: 'subscribe', topic: 'recover-ref-single', recover: { offset: 0 }, ref: 71 });
		const answered = await client.waitFor((p) => p && p.ref === 71 && (p.type === 'subscribed' || p.type === 'subscribe-denied'), 5000);
		expect(answered, 'the ref-carrying recover subscribe got no answer').not.toBeNull();

		// A plain ref-less subscribe keeps its documented silence: no error
		// frame may appear for it. The follow-up ref-carrying probe bounds
		// the wait - its answer proves the server processed both frames.
		const before = client.frames.length;
		client.send({ type: 'subscribe', topic: 'recover-ref-plain' });
		client.send({ type: 'subscribe', topic: 'recover-ref-probe', ref: 72 });
		const probe = await client.waitFor((p) => p && p.ref === 72, 5000);
		expect(probe, 'the bounding probe was never answered').not.toBeNull();
		const between = client.frames.slice(before).map((r) => { try { return JSON.parse(r); } catch { return null; } });
		expect(between.some((p) => p && p.type === 'error' && p.code === 'RECOVER_REQUIRES_REF'),
			'a plain ref-less subscribe must keep its documented silence').toBe(false);
	}, 20000);

	it('refuses a ref-less recover subscribe before the topic checks can swallow it', async () => {
		// The INVALID_TOPIC denial is silent without a ref too, so a refusal
		// ordered after it would leave exactly the silent death the contract
		// removes - for the invalid-topic spelling of the same request.
		client.send({ type: 'subscribe', topic: 'invalid topic\n', recover: { offset: 0 } });
		const refusal = await client.waitFor((p) => isRefusal(p, 'invalid topic\n'), 5000);
		expect(refusal, 'an invalid-topic recover subscribe died silently').not.toBeNull();
	}, 20000);

	it('refuses a ref-less batch whole when its recover map names any history', async () => {
		client.send({ type: 'subscribe-batch', topics: ['recover-ref-a', 'recover-ref-b'], recover: { 'recover-ref-a': { offset: 3 } } });
		const refusal = await client.waitFor((p) => isRefusal(p, null), 5000);
		expect(refusal, 'the ref-less recover batch died silently').not.toBeNull();

		// The non-refusal boundary: a recover map that names NO well-formed
		// history - empty, or malformed entries only - keeps the batch's
		// documented ref-less silence. Bounded by a ref-carrying probe.
		const before = client.frames.length;
		client.send({ type: 'subscribe-batch', topics: ['recover-ref-c'], recover: {} });
		client.send({ type: 'subscribe-batch', topics: ['recover-ref-d'], recover: { 'recover-ref-d': { offset: 'not-a-number' } } });
		client.send({ type: 'subscribe', topic: 'recover-ref-bound', ref: 74 });
		expect(await client.waitFor((p) => p && p.ref === 74, 5000), 'the bounding probe was never answered').not.toBeNull();
		const between = client.frames.slice(before).map((r) => { try { return JSON.parse(r); } catch { return null; } });
		expect(between.some((p) => p && p.type === 'error' && p.code === 'RECOVER_REQUIRES_REF'),
			'a recover map naming no well-formed history must keep the batch silence').toBe(false);

		// With a ref the same frame takes the ordinary lanes: every topic
		// answers on the ref.
		client.send({ type: 'subscribe-batch', topics: ['recover-ref-a', 'recover-ref-b'], recover: { 'recover-ref-a': { offset: 3 } }, ref: 73 });
		const answered = await client.waitFor((p) => p && p.ref === 73 && (p.type === 'subscribed' || p.type === 'subscribe-denied'), 5000);
		expect(answered, 'the ref-carrying recover batch got no answer').not.toBeNull();
	}, 20000);
});

// The mirrors answer identically - a harness or dev server that stayed silent
// would certify a client the production server then refuses.
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
	for (const c of clients) { try { c.ws.terminate(); } catch { /* gone */ } }
	clients.length = 0;
	await server?.close();
	server = null;
});

async function connectRaw(url) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(url);
	const frames = [];
	ws.on('message', (d, isBinary) => { if (!isBinary) { try { frames.push(JSON.parse(d.toString())); } catch { /* ignore */ } } });
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	const client = {
		ws, frames,
		send: (o) => ws.send(JSON.stringify(o)),
		async waitFor(predicate, ms = 5000) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = frames.find(predicate);
				if (hit) return hit;
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		}
	};
	clients.push(client);
	return client;
}

describe('the harness mirror answers the same refusal', () => {
	itUWS('refuses ref-less recover and keeps plain ref-less silence', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: { resume() { return {}; } } });
		const client = await connectRaw(server.wsUrl);

		client.send({ type: 'subscribe', topic: 'mirror-recover-ref', recover: { offset: 0 } });
		const refusal = await client.waitFor((p) => isRefusal(p, 'mirror-recover-ref'));
		expect(refusal, 'the harness let a ref-less recover subscribe die silently').not.toBeNull();

		client.send({ type: 'subscribe', topic: 'mirror-recover-ref', recover: { offset: 0 }, ref: 81 });
		const answered = await client.waitFor((p) => p && p.ref === 81 && (p.type === 'subscribed' || p.type === 'subscribe-denied'));
		expect(answered, 'the ref-carrying recover subscribe got no answer').not.toBeNull();

		const before = client.frames.length;
		client.send({ type: 'subscribe', topic: 'mirror-recover-plain' });
		client.send({ type: 'subscribe', topic: 'mirror-recover-probe', ref: 82 });
		expect(await client.waitFor((p) => p && p.ref === 82), 'the bounding probe was never answered').not.toBeNull();
		expect(client.frames.slice(before).some((p) => p && p.type === 'error' && p.code === 'RECOVER_REQUIRES_REF'),
			'a plain ref-less subscribe must keep its silence on the harness').toBe(false);
	}, 30000);

	it('refuses on the Vite dev plugin too', async () => {
		const mod = await import('../src/vite.js');
		const { createServer } = await import('node:http');
		const handler = { resume() { return {}; } };
		const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });

		const httpServer = createServer();
		await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
		const port = httpServer.address().port;
		try {
			await plugin.configureServer({
				httpServer,
				middlewares: { stack: [], use() {} },
				config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
				async ssrLoadModule() { return { default: handler, ...handler }; }
			});
			const client = await connectRaw(`ws://127.0.0.1:${port}/ws`);

			client.send({ type: 'subscribe', topic: 'dev-recover-ref', recover: { offset: 0 } });
			const refusal = await client.waitFor((p) => isRefusal(p, 'dev-recover-ref'));
			expect(refusal, 'dev let a ref-less recover subscribe die silently').not.toBeNull();

			client.send({ type: 'subscribe', topic: 'dev-recover-ref', recover: { offset: 0 }, ref: 91 });
			const answered = await client.waitFor((p) => p && p.ref === 91 && (p.type === 'subscribed' || p.type === 'subscribe-denied'));
			expect(answered, 'the ref-carrying recover subscribe got no answer on dev').not.toBeNull();
		} finally {
			// Terminate the client BEFORE closing: http.Server.close waits for
			// every live connection, and the afterEach that terminates clients
			// runs after this finally.
			for (const c of clients) { try { c.ws.terminate(); } catch { /* gone */ } }
			await new Promise((r) => httpServer.close(() => r(undefined)));
		}
	}, 30000);

	itUWS('does not refuse when no resume hook exists - there is no history to miss', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer();
		const client = await connectRaw(server.wsUrl);

		const before = client.frames.length;
		client.send({ type: 'subscribe', topic: 'mirror-no-resume', recover: { offset: 0 } });
		client.send({ type: 'subscribe', topic: 'mirror-no-resume-probe', ref: 83 });
		expect(await client.waitFor((p) => p && p.ref === 83), 'the bounding probe was never answered').not.toBeNull();
		expect(client.frames.slice(before).some((p) => p && p.type === 'error' && p.code === 'RECOVER_REQUIRES_REF'),
			'recover against a server with no resume hook is ignored, exactly as before').toBe(false);
	}, 30000);
});
