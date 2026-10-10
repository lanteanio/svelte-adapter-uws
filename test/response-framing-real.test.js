import { createServer, request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { createTestServer } from '../src/testing.js';

function read(url, options = {}) {
	return new Promise((resolve, reject) => {
		const req = request(url, options, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
			response.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}
function within(promise, ms = 1000) {
	let timer;
	return Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]).finally(() => clearTimeout(timer));
}
(hasUWS ? describe : describe.skip)('Response framing and HEAD body ownership', () => {
	let server, mirror, upstream, upstreamUrl, nonce = 0;
	beforeAll(async () => {
		upstream = createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.write('relay '); res.end('response'); });
		await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
		upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
		server = await startRealRuntime({ variant: 'responseframing' });
		mirror = await createTestServer({ handler: { admin(request) {
			return request.headers.get('x-framing-upstream') ? fetch(upstreamUrl) : new Response('relay response', { headers: { 'transfer-encoding': 'chunked' } });
		} } });
	}, 400000);
	afterAll(async () => { await mirror?.close(); await server?.stop(); if (upstream) await new Promise(resolve => upstream.close(resolve)); });
	for (const lane of ['anonymous SSR', 'credentialed SSR', 'POST SSR', 'authenticate', 'admin', 'testing admin']) {
		it.each(['explicit header', 'fetch response'])(`${lane} owns framing for a %s`, async shape => {
			const headers = {}, options = { headers };
			let url = server.httpUrl + '/response-framing';
			if (lane === 'credentialed SSR') headers.cookie = 'session=test';
			if (lane === 'POST SSR') options.method = 'POST';
			if (lane === 'authenticate') { url = server.httpUrl + '/__ws/auth'; options.method = 'POST'; headers.origin = server.httpUrl; }
			if (lane === 'admin') url = server.httpUrl + '/__realtime/framing';
			if (lane === 'testing admin') url = mirror.url + '/__realtime/framing';
			if (shape === 'fetch response') { url += '?upstream=' + encodeURIComponent(upstreamUrl); headers['x-framing-upstream'] = upstreamUrl; }
			const response = await read(url, options);
			expect(response.status).toBe(200);
			expect(response.headers['transfer-encoding']).toBeUndefined();
			expect(Number(response.headers['content-length'])).toBe(14);
			expect(response.body.toString()).toBe('relay response');
		});
	}
	const state = id => fetch(server.httpUrl + '/response-framing?mode=stats&id=' + id).then(r => r.json());
	const release = id => fetch(server.httpUrl + '/response-framing?mode=release&id=' + id);
	it.each(['anonymous', 'credentialed'])('%s HEAD cancels without pulling the response body', async lane => {
		const id = String(++nonce);
		const pending = read(server.httpUrl + '/response-framing?mode=head&id=' + id, { method: 'HEAD', headers: lane === 'credentialed' ? { cookie: 'session=test' } : {} });
		let early, before, response;
		try { early = await within(pending); before = await state(id); }
		finally { await release(id); response = await pending; }
		expect(early).toBe(true);
		expect(before).toEqual({ pulls: 0, cancelled: true });
		expect(response.status).toBe(200); expect(response.body.length).toBe(0);
		expect(response.headers['content-length']).toBe('123');
		expect(response.headers['transfer-encoding']).toBeUndefined();
	});
	it('GET still consumes the same gated body after release', async () => {
		const id = String(++nonce);
		const pending = read(server.httpUrl + '/response-framing?mode=head&id=' + id);
		await expect.poll(async () => (await state(id))?.pulls).toBe(1);
		await release(id);
		const response = await pending;
		expect(response.status).toBe(200); expect(response.body.equals(Buffer.alloc(123, 120))).toBe(true);
		expect(response.headers['content-length']).toBe('123');
	});
});
