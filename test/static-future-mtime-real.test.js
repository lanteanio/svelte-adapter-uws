import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const CONTENT = 'Future timestamp test.\n'.repeat(200);
function request(port, method, coding, modified, etag, unmodified, target = '/future-mtime/doc.txt') {
	return new Promise((resolve, reject) => {
		const headers = { 'Accept-Encoding': coding };
		if (modified) headers['If-Modified-Since'] = modified;
		if (etag) headers['If-None-Match'] = etag;
		if (unmodified) headers['If-Unmodified-Since'] = unmodified;
		const req = http.request({ port, host: '127.0.0.1', method, path: target, headers }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}
describeUWS('future static modification times', () => {
	let server;
	let dir;
	let stat;

	beforeAll(async () => {
		server = await startRealRuntime();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-future-mtime-'));
		const file = path.join(dir, 'doc.txt');
		fs.writeFileSync(file, CONTENT);
		fs.writeFileSync(file + '.br', zlib.brotliCompressSync(Buffer.from(CONTENT)));
		fs.writeFileSync(file + '.gz', zlib.gzipSync(Buffer.from(CONTENT)));
		const future = new Date(Date.now() + 365 * 86400000);
		fs.utimesSync(file, future, future);
		stat = fs.statSync(file);
		for (const name of ['old', 'past']) {
			const fixture = path.join(dir, name + '.txt');
			fs.writeFileSync(fixture, CONTENT);
			const mtime = new Date(name === 'old' ? '1899-01-01T00:00:00Z' : '2020-01-01T00:00:00Z');
			fs.utimesSync(fixture, mtime, mtime);
		}

		const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
		cacheDir(dir, '/future-mtime', false);
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	for (const method of ['GET', 'HEAD']) {
		it.each(['identity', 'br', 'gzip'])(method + ' omits future %s dates while retaining ETag revalidation', async (coding) => {
			const res = await request(server.port, method, coding);
			expect(res.status).toBe(200);
			expect(res.headers['last-modified']).toBeUndefined();
			const suffix = coding === 'identity' ? '' : coding === 'br' ? '-br' : '-gzip';
			expect(res.headers.etag).toBe(`W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}${suffix}"`);
			const decoded = coding === 'br' ? zlib.brotliDecompressSync : coding === 'gzip' ? zlib.gunzipSync : (b) => b;
			expect(method === 'HEAD' ? res.body.length : decoded(res.body).toString()).toBe(method === 'HEAD' ? 0 : CONTENT);
			const conditional = await request(server.port, method, coding, new Date(stat.mtimeMs).toUTCString());
			expect(conditional.status).toBe(200);
			expect(conditional.headers['last-modified']).toBeUndefined();
			const unmodified = await request(server.port, method, coding, null, null, 'Sat, 01 Jan 2000 00:00:00 GMT');
			expect(unmodified.status).toBe(200);
			const etagged = await request(server.port, method, coding, null, res.headers.etag);
			expect(etagged.status).toBe(304);
			expect(etagged.body.length).toBe(0);
		});
	}
	it.each(['GET', 'HEAD'])('%s omits pre-1900 dates but keeps ordinary past validators', async (method) => {
		const old = await request(server.port, method, 'identity', null, null, 'Sun, 01 Jan 1899 00:00:00 GMT', '/future-mtime/old.txt');
		expect(old.status).toBe(200);
		expect(old.headers['last-modified']).toBeUndefined();
		const oldModified = await request(server.port, method, 'identity', 'Sun, 01 Jan 1899 00:00:00 GMT', null, null, '/future-mtime/old.txt');
		expect(oldModified.status).toBe(200);
		const past = await request(server.port, method, 'identity', null, null, null, '/future-mtime/past.txt');
		expect(past.headers['last-modified']).toBe('Wed, 01 Jan 2020 00:00:00 GMT');
		expect((await request(server.port, method, 'identity', past.headers['last-modified'], null, null, '/future-mtime/past.txt')).status).toBe(304);
	});

});
