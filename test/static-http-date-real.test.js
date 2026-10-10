import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const CONTENT = 'A static date validator.\n';

function request(port, method, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request({ port, host: '127.0.0.1', method, path: '/date-validation/doc.txt', headers }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}

describeUWS('static date validators on the wire', () => {
	let server;
	let dir;
	beforeAll(async () => {
		server = await startRealRuntime();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-date-validation-'));
		const file = path.join(dir, 'doc.txt');
		fs.writeFileSync(file, CONTENT);
		fs.utimesSync(file, new Date('2026-01-02T03:04:05Z'), new Date('2026-01-02T03:04:05Z'));
		const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
		cacheDir(dir, '/date-validation', false);
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	for (const method of ['GET', 'HEAD']) {
		it.each([
			['If-Modified-Since', '2027-01-01'],
			['If-Modified-Since', '2027-01-01T00:00:00Z'],
			['If-Unmodified-Since', '2020-01-01'],
			['If-Unmodified-Since', 'Sun, 01 Jan 1899 00:00:00 GMT'],
			['If-Unmodified-Since', 'January 1, 2020'],
			['If-Unmodified-Since', 'Sat, 30 Feb 2020 00:00:00 GMT']
		])(method + ' ignores invalid %s: %s', async (header, value) => {
			const res = await request(server.port, method, { [header]: value });
			expect(res.status).toBe(200);
			expect(res.body).toBe(method === 'HEAD' ? '' : CONTENT);
		});
		it.each([
			'Fri, 02 Jan 2026 03:04:05 GMT',
			'Friday, 02-Jan-26 03:04:05 GMT',
			'Fri Jan  2 03:04:05 2026'
		])(method + ' accepts %s', async (value) => {
			const res = await request(server.port, method, { 'If-Modified-Since': value });
			expect(res.status).toBe(304);
			expect(res.headers['last-modified']).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
			expect(res.body).toBe('');
		});
		it(method + ' refuses a valid earlier If-Unmodified-Since', async () => {
			const res = await request(server.port, method, { 'If-Unmodified-Since': 'Wed, 01 Jan 2020 00:00:00 GMT' });
			expect(res.status).toBe(412);
			expect(res.body).toBe('');
		});
	}
});
