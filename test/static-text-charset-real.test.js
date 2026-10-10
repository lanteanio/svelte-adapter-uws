import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const TEXT = 'Gr\u00fc\u00dfe aus K\u00f6ln. \u65e5\u672c\u8a9e.\n'.repeat(120);
const MEDIA = { txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', css: 'text/css', html: 'text/html', js: 'text/javascript', ics: 'text/calendar', vtt: 'text/vtt', yaml: 'text/yaml' };
function request(port, method, target, coding) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { 'Accept-Encoding': coding } }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.end();
	});
}
describeUWS('UTF-8 content types for static text', () => {
	let server;
	let dir;
	beforeAll(async () => {
		server = await startRealRuntime();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-text-charset-'));
		for (const ext of [...Object.keys(MEDIA), 'bin', 'xml', 'rtf']) {
			const file = path.join(dir, 'text.' + ext);
			fs.writeFileSync(file, TEXT);
			fs.writeFileSync(file + '.br', zlib.brotliCompressSync(Buffer.from(TEXT)));
			fs.writeFileSync(file + '.gz', zlib.gzipSync(Buffer.from(TEXT)));
		}
		const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
		cacheDir(dir, '/charset-static', true);
		cacheDir(dir, '/charset-prerender', false);
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	for (const method of ['GET', 'HEAD']) {
		for (const coding of ['identity', 'br', 'gzip']) {
			it.each(Object.entries(MEDIA))(method + ' ' + coding + ' labels .%s as UTF-8', async (ext, media) => {
				const res = await request(server.port, method, '/charset-static/text.' + ext, coding);
				expect(res.status).toBe(200);
				expect(res.headers['content-type']).toBe(media + '; charset=utf-8');
				const decode = coding === 'br' ? zlib.brotliDecompressSync : coding === 'gzip' ? zlib.gunzipSync : (b) => b;
				expect(method === 'HEAD' ? res.body.length : decode(res.body).toString('utf8')).toBe(method === 'HEAD' ? 0 : TEXT);
			});
		}
	}
	it('prerendered HTML aliases carry the same UTF-8 type', async () => {
		const res = await request(server.port, 'GET', '/charset-prerender/text', 'identity');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
		expect(res.body.toString('utf8')).toBe(TEXT);
	});
	it.each([['bin', 'application/octet-stream'], ['xml', 'text/xml'], ['rtf', 'text/rtf']])('preserves the .%s type without overriding its encoding', async (ext, media) => {
		const res = await request(server.port, 'GET', '/charset-static/text.' + ext, 'identity');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe(media);
		expect(res.body).toEqual(Buffer.from(TEXT));
	});
});
