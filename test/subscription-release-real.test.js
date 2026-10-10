import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';
import * as handler from './fixture/src/hooks.ws.subscription-release.js';

let nonce = 0;
let stoppedAccounting;
async function command(client, type, event, topic, extra = {}) {
	const id = ++nonce;
	client.send({ type, topic, nonce: id, ...extra });
	const frame = await client.waitFor((value) => value?.event === event && value.data?.nonce === id);
	expect(frame, event + ' must answer').not.toBeNull();
	return frame.parsed.data;
}
async function begin(client, topic, index) {
	const id = ++nonce;
	client.send({ type: 'begin', topic, nonce: id });
	expect(await client.waitFor((value) => value?.event === 'parked' && value.data?.index === index)).not.toBeNull();
	return id;
}
async function finish(client, index, id, denial) {
	client.send({ type: 'finish', index, denial });
	const answer = await client.waitFor((value) => value?.event === 'admitted' && value.data?.nonce === id);
	expect(answer, 'the admission must settle').not.toBeNull();
	return answer.parsed.data.denial;
}
function deliveries(client, id) {
	return client.frames.flatMap((raw) => { try { const value = JSON.parse(raw); return value.data?.nonce === id && ['base', 'derived', 'shared'].includes(value.event) ? [value.event] : []; } catch { return []; } });
}

async function bootNonProduction(surface) {
	if (surface === 'testing') {
		const { createTestServer } = await import('../src/testing.js');
		const test = await createTestServer({ handler });
		return { wsUrl: test.wsUrl, stop: () => test.close() };
	}
	const { default: createPlugin } = await import('../src/vite.js');
	const httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	await createPlugin({ allowedOrigins: '*', handler: '/subscription-release' }).configureServer({
		httpServer, middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return handler; }
	});
	return { wsUrl: 'ws://127.0.0.1:' + httpServer.address().port + '/ws', stop: () => new Promise((resolve) => httpServer.close(resolve)) };
}

const describeUWS = hasUWS ? describe : describe.skip;
// The built runtime owns the process-wide accounting sink after it boots.
for (const surface of ['testing', 'vite', 'built']) {
	describeUWS('framework subscription release on ' + surface, () => {
		let server;
		let accounting;
		const clients = [];
		beforeAll(async () => {
			if (surface === 'built') {
				server = await startRealRuntime({ variant: 'subscriptionrelease' });
				accounting = await import('./fixture/build-subscription-release/handler/state.js');
			}
			else server = await bootNonProduction(surface);
		}, 400000);
		afterAll(async () => { for (const client of clients) client.close(); await server?.stop(); if (accounting) stoppedAccounting = accounting; });
		function assertAccounted() {
			if (!accounting) return;
			let total = 0;
			for (const ws of accounting.wsConnections) total += ws.getUserData()[Symbol.for('adapter-uws.ws.subscriptions')].size;
			expect(accounting.counters.totalSubscriptions).toBe(total);
		}
		async function connect() {
			const client = await connectRealClient(server.wsUrl);
			client.binary = [];
			client.ws.on('message', (data, binary) => { if (binary) client.binary.push(data[data.length - 1]); });
			client.send({ type: 'hello', caps: ['release.shared:1'] });
			clients.push(client);
			return client;
		}
		it.each(['allow', 'deny', 'revoke'])('removes admitted access immediately while a sibling later receives %s', async (outcome) => {
			const client = await connect();
			const topic = 'release:' + surface + ':' + outcome;
			const a = await begin(client, topic, 0);
			const b = await begin(client, topic, 1);
			expect(await finish(client, 0, a)).toBeNull();
			await command(client, 'decorate', 'decorated', topic);
			const warm = await command(client, 'publish', 'published', topic);
			expect(deliveries(client, warm.nonce)).toEqual(surface === 'vite' ? ['base', 'derived', 'shared'] : ['base', 'derived']);
			expect(client.binary.includes(warm.nonce)).toBe(surface !== 'vite');
			assertAccounted();
			expect(await command(client, 'probe', 'state', topic)).toMatchObject({ logical: 1, native: 1, derived: 1, grant: topic, cohorts: surface === 'vite' ? 0 : 1, unsubscribes: 0 });
			expect((await command(client, 'release', 'released', topic)).removed).toBe(true);
			expect((await command(client, 'release', 'released', topic)).removed).toBe(false);
			expect(await command(client, 'probe', 'state', topic)).toMatchObject({ logical: 0, native: 0, derived: 0, grant: null, cohorts: 0, unsubscribes: 0 });
			const absent = await command(client, 'publish', 'published', topic);
			expect(deliveries(client, absent.nonce)).toEqual([]);
			expect(client.binary).not.toContain(absent.nonce);
			assertAccounted();
			if (outcome === 'revoke') expect((await command(client, 'revoke', 'revoked', topic)).removed).toBe(true);
			expect(await finish(client, 1, b, outcome === 'deny' ? 'FORBIDDEN' : undefined)).toBe(outcome === 'allow' ? null : 'FORBIDDEN');
			const live = outcome === 'allow' ? 1 : 0;
			expect(await command(client, 'probe', 'state', topic)).toMatchObject({ logical: live, native: live, derived: 0, grant: null, cohorts: surface === 'vite' ? 0 : live });
			const after = await command(client, 'publish', 'published', topic);
			expect(deliveries(client, after.nonce)).toEqual(outcome === 'allow' ? (surface === 'vite' ? ['base', 'shared'] : ['base']) : []);
			expect(client.binary.includes(after.nonce)).toBe(outcome === 'allow' && surface !== 'vite');
			assertAccounted();
			client.close();
		});
		it('preserves independent derived admissions and leaves prior revocation effective', async () => {
			const client = await connect();
			const topic = 'release:' + surface + ':derived';
			const a = await begin(client, topic, 0);
			const derived = await begin(client, '__cursor:' + topic, 1);
			expect(await finish(client, 0, a)).toBeNull();
			await command(client, 'decorate', 'decorated', topic);
			expect((await command(client, 'release', 'released', topic)).removed).toBe(true);
			expect(await finish(client, 1, derived)).toBeNull();
			const publish = await command(client, 'publish', 'published', topic);
			expect(deliveries(client, publish.nonce)).toEqual(['derived']);
			const pending = await begin(client, topic, 2);
			await command(client, 'revoke', 'revoked', topic);
			await command(client, 'release', 'released', topic);
			expect(await finish(client, 2, pending)).toBe('FORBIDDEN');
			client.close();
		});
		it('withdraws a released grant before a revoked hook install lands', async () => {
			const client = await connect();
			const topic = 'release:' + surface + ':old-install';
			const old = await begin(client, topic, 0);
			await command(client, 'revoke', 'revoked', topic);
			const current = await begin(client, topic, 1);
			expect(await finish(client, 1, current)).toBeNull();
			expect((await command(client, 'release', 'released', topic)).removed).toBe(true);
			expect((await command(client, 'install', 'installed', topic)).installed).toBe(true);
			expect(await finish(client, 0, old)).toBe('FORBIDDEN');
			expect(await command(client, 'probe', 'state', topic)).toMatchObject({ logical: 0, native: 0 });
			const publish = await command(client, 'publish', 'published', topic);
			expect(deliveries(client, publish.nonce)).toEqual([]);
			expect(client.binary).not.toContain(publish.nonce);
			assertAccounted();
			client.close();
		});
		it('is harmless for missing and closed memberships', async () => {
			const retired = await connect();
			const topic = 'release:' + surface + ':closed';
			expect((await command(retired, 'release', 'released', topic)).removed).toBe(false);
			const a = await begin(retired, topic, 0);
			expect(await finish(retired, 0, a)).toBeNull();
			await new Promise((resolve) => { retired.ws.once('close', resolve); retired.close(); });
			const client = await connect();
			expect((await command(client, 'retired', 'retired', topic)).removed).toBe(false);
			expect(await command(client, 'probe', 'state', topic)).toMatchObject({ logical: 0, native: 0, derived: 0 });
			client.close();
		});
	});
}

// A stopped built runtime leaves its global accounting sink installed. Neither
// testing nor Vite may charge that unrelated owner for their plain Set entries.
describeUWS('release uses the live connection accounting owner', () => {
	it.each(['testing', 'vite'])('releases on %s after the built runtime has stopped', async (surface) => {
		expect(stoppedAccounting).toBeDefined();
		const before = stoppedAccounting.counters.totalSubscriptions;
		const server = await bootNonProduction(surface);
		const client = await connectRealClient(server.wsUrl);
		try {
			const topic = 'release:after-stop:' + surface;
			const a = await begin(client, topic, 0);
			const b = await begin(client, topic, 1);
			expect(await finish(client, 0, a)).toBeNull();
			expect((await command(client, 'release', 'released', topic)).removed).toBe(true);
			expect(await command(client, 'probe', 'state', topic)).toMatchObject({ native: 0, logical: 0, grant: null });
			expect(stoppedAccounting.counters.totalSubscriptions).toBe(before);
			expect(await finish(client, 1, b)).toBeNull();
			const publish = await command(client, 'publish', 'published', topic);
			expect(deliveries(client, publish.nonce)).toContain('base');
			expect(stoppedAccounting.counters.totalSubscriptions).toBe(before);
		} finally { client.close(); await server.stop(); }
	});
});
