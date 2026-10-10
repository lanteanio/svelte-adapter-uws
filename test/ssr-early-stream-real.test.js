import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

function open(url, options = {}) {
	let firstResolve;
	const first = new Promise(resolve => { firstResolve = resolve; });
	const result = {};
	const done = new Promise((resolve, reject) => {
		result.req = request(url, options, response => {
			result.headers = response.headers; result.status = response.statusCode;
			const chunks = [];
			response.on('data', chunk => { chunks.push(chunk); firstResolve(); });
			response.on('end', () => resolve({ ...result, body: Buffer.concat(chunks) }));
			response.on('error', error => { if (result.destroyed) resolve(null); else reject(error); });
		});
		result.req.on('error', error => { if (result.destroyed) resolve(null); else reject(error); });
		result.req.end(options.method === 'POST' ? 'complete request body' : undefined);
	});
	return { first, done, destroy() { result.destroyed = true; result.req.destroy(); } };
}
function within(promise, ms = 1000) {
	let timer;
	return Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]).finally(() => clearTimeout(timer));
}
(hasUWS ? describe : describe.skip)('SSR first bytes before deferred body work', () => {
	let server, nonce = 0;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'ssrstream' }); }, 400000);
	afterAll(async () => { await server?.stop(); });
	const state = id => fetch(server.httpUrl + '/response-stream?mode=stats&id=' + id).then(r => r.json());
	const release = id => fetch(server.httpUrl + '/response-stream?mode=release&id=' + id);
	for (const lane of ['anonymous', 'credentialed', 'post']) {
		const options = lane === 'post' ? { method: 'POST' } : lane === 'credentialed' ? { headers: { cookie: 'session=test' } } : {};
		it.each(['deferred', 'close', 'sse'])(`${lane} streams %s before its producer is released`, async mode => {
			const id = String(++nonce);
			const active = open(server.httpUrl + '/response-stream?mode=' + mode + '&id=' + id, options);
			let early, before, response;
			try { early = await within(active.first); before = await state(id); }
			finally { await release(id); response = await active.done; }
			expect(early).toBe(true); expect(before.finished).toBe(false);
			expect(response.status).toBe(200);
			expect(response.headers['transfer-encoding']).toBe('chunked');
			expect(response.headers['content-length']).toBeUndefined();
			expect(response.body.toString()).toBe(mode === 'close' ? 'shell\n' : 'shell\nresolved\n');
		});
	}
	it.each(['anonymous', 'credentialed'])('streams a real SvelteKit deferred page shell for %s', async lane => {
		const id = String(++nonce);
		const active = open(server.httpUrl + '/streamed-page?id=' + id, lane === 'credentialed' ? { headers: { cookie: 'session=test' } } : {});
		let early, before, response;
		try { early = await within(active.first); before = await state(id); }
		finally { await release(id); response = await active.done; }
		expect(early).toBe(true); expect(before.finished).toBe(false);
		expect(response.body.toString()).toContain('streamed shell');
		expect(response.body.toString()).toContain('resolved page');
	});
	it.each(['anonymous', 'credentialed'])('does not renew the current-turn allowance for every %s chunk', async lane => {
		const id = String(++nonce);
		const active = open(server.httpUrl + '/response-stream?mode=turns&id=' + id, lane === 'credentialed' ? { headers: { cookie: 'session=test' } } : {});
		const firstState = active.first.then(() => state(id));
		const response = await active.done;
		expect((await firstState).finished).toBe(false);
		expect(response.headers['transfer-encoding']).toBe('chunked');
		expect(response.body.toString()).toBe('shell\n' + 'x'.repeat(10000));
	});
	it.each(['bytes', 'blob', 'transforms'])('retains ready %s body compression and length framing', async mode => {
		const response = await open(server.httpUrl + '/response-stream?mode=' + mode, { method: 'POST', headers: { 'accept-encoding': 'gzip' } }).done;
		expect(response.headers['content-encoding']).toBe('gzip');
		expect(response.headers['transfer-encoding']).toBeUndefined();
		expect(Number(response.headers['content-length'])).toBe(response.body.length);
		expect(gunzipSync(response.body).toString()).toBe('ready finite body '.repeat(400));
	});
	it.each([['GET', 'sse'], ['GET', 'never-first'], ['POST', 'sse'], ['POST', 'never-first'], ['GET', 'cancelhang'], ['POST', 'cancelhang']])('cancels a pending %s %s producer on socket abort', async (method, mode) => {
		const id = String(++nonce), active = open(server.httpUrl + '/response-stream?mode=' + mode + '&id=' + id, { method });
		try {
			await expect.poll(async () => (await state(id)).started).toBe(true);
			active.destroy(); await active.done;
			await expect.poll(async () => (await state(id)).cancelled, { timeout: 1000 }).toBe(true);
			await expect.poll(async () => (await state(id)).locked, { timeout: 1000 }).toBe(false);
		} finally { active.destroy(); await release(id); }
	});
});
