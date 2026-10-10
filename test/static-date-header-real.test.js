import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

// Read to EOF, not through an HTTP parser: invalid lengths/statuses must remain
// observable and any forbidden HEAD/304 body bytes must not disappear.
function request(port, method, target, extra = {}) {
	const lines = [method + ' ' + target + ' HTTP/1.1', 'Host: 127.0.0.1:' + port,
		'Connection: close', ...Object.entries(extra).map(([k, v]) => k + ': ' + v)];
	if (method === 'POST') lines.push('Content-Length: 0');
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
		const chunks = [];
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('HTTP response did not complete')); }, 10000);
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', (error) => { clearTimeout(timer); reject(error); });
		socket.on('end', () => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks);
			const split = raw.indexOf('\r\n\r\n');
			if (split < 0) { reject(new Error('Incomplete HTTP headers')); return; }
			const lines = raw.subarray(0, split).toString('latin1').split('\r\n');
			const headers = {};
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(':');
				const key = line.slice(0, colon).toLowerCase();
				(headers[key] ||= []).push(line.slice(colon + 1).trim());
			}
			resolve({ status: Number(lines[0].split(' ')[1]), headers, body: raw.subarray(split + 4) });
		});
	});
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CONTENT = Buffer.from('A static representation with exactly one date.\n'.repeat(200));
describeUWS('native static Date fields', () => {
	let server;
	let dir;
	let immutablePath;
	let immutableEntry;
	const coded = { identity: CONTENT, br: zlib.brotliCompressSync(CONTENT), gzip: zlib.gzipSync(CONTENT) };
	beforeAll(async () => {
		server = await startRealRuntime();
		const { staticCache } = await import('./fixture/build/handler/state.js');
		[immutablePath, immutableEntry] = [...staticCache].find(([url, entry]) =>
			url.includes('/_app/immutable/') && entry.etag === '' && entry.brBuffer && entry.gzBuffer);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-single-date-'));
		fs.writeFileSync(path.join(dir, 'doc.txt'), CONTENT);
		fs.writeFileSync(path.join(dir, 'doc.txt.br'), coded.br);
		fs.writeFileSync(path.join(dir, 'doc.txt.gz'), coded.gzip);
		const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
		cacheDir(dir, '/single-date', false);
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
	function date(res) {
		expect(res.headers.date).toHaveLength(1);
		expect(res.headers.date[0]).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/);
		expect(Number.isNaN(Date.parse(res.headers.date[0]))).toBe(false);
	}
	for (const method of ['GET', 'HEAD']) {
		for (const coding of ['identity', 'br', 'gzip']) {
			for (const immutable of [false, true]) {
				it(method + ' ' + coding + ' ' + (immutable ? 'immutable' : 'mutable') + ' has one Date on 200 and 304', async () => {
					const url = immutable ? immutablePath : '/single-date/doc.txt';
					const body = immutable ? (coding === 'br' ? immutableEntry.brBuffer : coding === 'gzip' ? immutableEntry.gzBuffer : immutableEntry.buffer) : coded[coding];
					const full = await request(server.port, method, url, { 'Accept-Encoding': coding });
					expect(full.status).toBe(200);
					date(full);
					expect(full.headers['content-length']).toEqual([String(body.length)]);
					expect(full.headers['content-encoding']).toEqual(coding === 'identity' ? undefined : [coding]);
					expect(full.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : body);
					const conditional = await request(server.port, method, url, { 'Accept-Encoding': coding, 'If-None-Match': immutable ? '*' : full.headers.etag[0] });
					expect(conditional.status).toBe(304);
					date(conditional);
					for (const key of ['etag', 'last-modified', 'cache-control', 'vary', 'x-content-type-options']) {
						expect(conditional.headers[key]).toEqual(full.headers[key]);
					}
					expect(conditional.headers['content-length']).toBeUndefined();
					expect(conditional.body.length).toBe(0);
				});
			}
		}
		it.each([
			[{ Range: 'bytes=0-3' }, 206],
			[{ Range: 'bytes=99999999-' }, 416],
			[{ 'If-Match': '"missing"' }, 412]
		])(method + ' range and refusal responses have one Date (%s)', async (headers, status) => {
			const res = await request(server.port, method, '/single-date/doc.txt', headers);
			expect(res.status).toBe(status);
			date(res);
		});
	}
	it('SSR and auth Responses cannot duplicate the native Date', async () => {
		const oldDate = 'Thu, 01 Jan 1970 00:00:00 GMT';
		for (const method of ['GET', 'HEAD']) {
			for (const status of [200, 304]) {
				const res = await request(server.port, method, '/response-guard?status=' + status + '&date=' + encodeURIComponent(oldDate));
				expect(res.status).toBe(status);
				date(res);
				expect(res.headers.date[0]).not.toBe(oldDate);
			}
		}
		const auth = await request(server.port, 'POST', '/__ws/auth', { 'X-Auth-Response': 'date' });
		expect(auth.status).toBe(200);
		expect(auth.body.toString()).toBe('dated');
		date(auth);
		expect(auth.headers.date[0]).not.toBe(oldDate);
	});

});
