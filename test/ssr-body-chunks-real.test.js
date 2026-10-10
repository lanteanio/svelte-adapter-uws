import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

function read(url, options = {}, onFirst) {
	return new Promise((resolve, reject) => {
		const req = request(url, options, res => {
			const chunks = [];
			res.on('data', chunk => { if (!chunks.length) onFirst?.(); chunks.push(chunk); });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.setTimeout(3000, () => req.destroy(new Error('response deadline')));
		req.on('error', reject); req.end();
	});
}

(hasUWS ? describe : describe.skip)('SSR response chunk bytes', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'ssrbody' }); }, 400000);
	afterAll(async () => { await server?.stop(); });
	const bytes = [17, 34, 51, 68, 85, 102, 119, 136];
	for (const lane of ['anonymous', 'credentialed', 'post']) {
		const options = lane === 'post' ? { method: 'POST' } : lane === 'credentialed' ? { headers: { cookie: 'session=test' } } : {};
		it.each([
			['bytes', bytes], ['buffer', bytes], ['views', [34, 51, 68, 85, 102, 119, 136]],
			['string', [...Buffer.from('Grüße '.repeat(400))]]
		])(`${lane} preserves %s chunks`, async (shape, expected) => {
			const response = await read(server.httpUrl + '/body-chunks?shape=' + shape, options);
			expect(response.status).toBe(200);
			expect([...response.body]).toEqual(expected);
		});
		it.each(['number', 'object'])(`${lane} rejects a %s chunk and cancels its producer`, async shape => {
			const before = await (await fetch(server.httpUrl + '/body-chunks?shape=stats')).json();
			const response = await read(server.httpUrl + '/body-chunks?shape=' + shape, options);
			expect(response.status).toBe(500);
			const after = await (await fetch(server.httpUrl + '/body-chunks?shape=stats')).json();
			expect(after.cancelled).toBe(before.cancelled + 1);
		});
	}
	it('shares exact offset-view bytes with concurrent anonymous waiters', async () => {
		const before = await (await fetch(server.httpUrl + '/body-chunks?shape=stats')).json();
		const responses = await Promise.all([read(server.httpUrl + '/body-chunks?shape=views&defer=1'), read(server.httpUrl + '/body-chunks?shape=views&defer=1')]);
		for (const response of responses) expect([...response.body]).toEqual([34, 51, 68, 85, 102, 119, 136]);
		const after = await (await fetch(server.httpUrl + '/body-chunks?shape=stats')).json();
		expect(after.renders).toBe(before.renders + 1);
	});
	it.each(['GET', 'POST'])('compresses a single string chunk on %s like its UTF-8 byte equivalent', async method => {
		const response = await read(server.httpUrl + '/body-chunks?shape=string', { method, headers: { 'accept-encoding': 'gzip' } });
		expect(response.headers['content-encoding']).toBe('gzip');
		expect(gunzipSync(response.body).toString()).toBe('Grüße '.repeat(400));
	});
	it('retains credentialed compression protection for string chunks', async () => {
		const response = await read(server.httpUrl + '/body-chunks?shape=string', { headers: { cookie: 'session=test', 'accept-encoding': 'gzip' } });
		expect(response.headers['content-encoding']).toBeUndefined();
		expect(response.body.toString()).toBe('Grüße '.repeat(400));
	});
	it('counts UTF-8 string bytes toward the sharing cap and streams the full body', async () => {
		let observed;
		const response = await read(server.httpUrl + '/body-chunks?shape=large', {}, () => {
			observed = fetch(server.httpUrl + '/body-chunks?shape=stats').then(response => response.json());
		});
		const firstState = await observed;
		expect(response.status).toBe(200);
		expect(firstState.finished).toBe(false);
		expect(response.body.equals(Buffer.from('ü'.repeat(8192 * 40)))).toBe(true);
		const finalState = await (await fetch(server.httpUrl + '/body-chunks?shape=stats')).json();
		expect(finalState.finished).toBe(true);
	});
});
