import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const CONTENT = Buffer.from('Representation-specific weak ETag comparison.\n'.repeat(200));
function request(port, method, coding, headers = {}, target = '/weak-etag/doc.txt') {
	return new Promise((resolve, reject) => {
		const req = http.request({ port, host: '127.0.0.1', method, path: target, headers: { 'Accept-Encoding': coding, ...headers } }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.setTimeout(10000, () => req.destroy(new Error('HTTP response timed out')));
		req.on('error', reject);
		req.end();
	});
}

describeUWS('weak static entity tags on the wire', () => {
	let server;
	let dir;
	let immutable;
	const variants = {};
	beforeAll(async () => {
		server = await startRealRuntime();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-weak-etag-'));
		const file = path.join(dir, 'doc.txt');
		fs.writeFileSync(file, CONTENT);
		fs.writeFileSync(file + '.br', zlib.brotliCompressSync(CONTENT));
		fs.writeFileSync(file + '.gz', zlib.gzipSync(CONTENT));
		const mtime = new Date('2026-01-02T03:04:05Z');
		fs.utimesSync(file, mtime, mtime);
		const { manifest } = await import('./fixture/build/manifest-bridge.js');
		immutable = '/weak-etag/' + manifest.appPath + '/immutable/etag.js';
		fs.mkdirSync(path.join(dir, manifest.appPath, 'immutable'), { recursive: true });
		fs.writeFileSync(path.join(dir, manifest.appPath, 'immutable', 'etag.js'), CONTENT);
		const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
		cacheDir(dir, '/weak-etag', true);
		for (const coding of ['identity', 'br', 'gzip']) {
			variants[coding] = await request(server.port, 'GET', coding);
			expect(variants[coding].status).toBe(200);
			expect(variants[coding].headers.etag).toMatch(/^W\/".+"$/);
			const decode = coding === 'br' ? zlib.brotliDecompressSync : coding === 'gzip' ? zlib.gunzipSync : (body) => body;
			expect(decode(variants[coding].body)).toEqual(CONTENT);
		}
		expect(new Set(Object.values(variants).map((value) => value.headers.etag)).size).toBe(3);
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	for (const method of ['GET', 'HEAD']) {
		for (const coding of ['identity', 'br', 'gzip']) {
			it(method + ' weakly compares its selected ' + coding + ' validator, alone and in lists', async () => {
				const tag = variants[coding].headers.etag;
				const opaque = tag.slice(2);
				for (const value of [tag, opaque, '"foreign,tag", ' + opaque, ', W/"other",\t' + opaque + ', ', '*']) {
					const res = await request(server.port, method, coding, { 'If-None-Match': value, Range: 'bytes=0-9' });
					expect(res.status, value).toBe(304);
					expect(res.body.length).toBe(0);
					expect(res.headers.etag).toBe(tag);
					expect(res.headers.vary).toBe('Accept-Encoding');
					expect(res.headers['cache-control']).toBe(variants[coding].headers['cache-control']);
					expect(res.headers['content-range']).toBeUndefined();
				}
			});
			it(method + ' keeps ' + coding + ' revalidation separate from other representations and dates', async () => {
				const own = variants[coding];
				const other = variants[coding === 'identity' ? 'br' : 'identity'].headers.etag;
				for (const value of [other, other.slice(2), '"unrelated"', own.headers.etag.slice(2).toUpperCase()]) {
					const res = await request(server.port, method, coding, { 'If-None-Match': value, 'If-Modified-Since': 'Fri, 01 Jan 2100 00:00:00 GMT' });
					expect(res.status, value).toBe(200);
					expect(res.headers.etag).toBe(own.headers.etag);
					expect(res.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : own.body);
				}
			});
			it(method + ' rejects malformed weak syntax for ' + coding, async () => {
				const opaque = variants[coding].headers.etag.slice(2);
				for (const value of ['w/' + opaque, 'W/ ' + opaque, 'W/W/' + opaque, opaque.slice(1, -1), '"prefix,' + opaque + ',suffix"']) {
					const res = await request(server.port, method, coding, { 'If-None-Match': value });
					expect(res.status, value).toBe(200);
					expect(res.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : variants[coding].body);
				}
			});
			it(method + ' preserves independent If-Match and If-Range policies for ' + coding, async () => {
				const own = variants[coding].headers.etag;
				const other = variants[coding === 'identity' ? 'br' : 'identity'].headers.etag;
				for (const tag of [own, other, '*']) {
					const res = await request(server.port, method, coding, { 'If-Match': tag });
					expect(res.status).toBe(200);
					expect(res.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : variants[coding].body);
				}
				for (const tag of [own.slice(2), other.slice(2), 'W/"unknown"']) {
					const res = await request(server.port, method, coding, { 'If-Match': tag, 'If-None-Match': own });
					expect(res.status).toBe(412);
					expect(res.body.length).toBe(0);
				}
				const range = await request(server.port, method, coding, { 'If-Range': own, Range: 'bytes=0-9' });
				expect(range.status).toBe(200);
				expect(range.headers['content-range']).toBeUndefined();
			});
		}
		it(method + ' retains immutable wildcard and missing-validator behavior', async () => {
			for (const [value, status] of [['*', 304], [variants.identity.headers.etag, 200], [variants.identity.headers.etag.slice(2), 200]]) {
				const res = await request(server.port, method, 'identity', { 'If-None-Match': value }, immutable);
				expect(res.status).toBe(status);
				expect(res.headers.etag).toBeUndefined();
				expect(res.body).toEqual(status === 304 || method === 'HEAD' ? Buffer.alloc(0) : CONTENT);
			}
		});
	}
});
