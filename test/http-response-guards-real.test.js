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

const lengths = [
	{ declared: 'abc', expected: undefined },
	{ declared: '-1', expected: undefined },
	{ declared: '9007199254740992', expected: undefined },
	{ declared: '42abc', expected: '42' },
	{ declared: '0', expected: '0' },
	{ declared: '9007199254740991', expected: '9007199254740991' }
];

describeUWS('built HTTP response guards', () => {
	let server;
	let immutablePath;
	let immutableEntry;
	beforeAll(async () => {
		server = await startRealRuntime();
		const { staticCache } = await import('./fixture/build/handler/state.js');
		const found = [...staticCache].find(([url, entry]) =>
			url.includes('/_app/immutable/') && entry.etag === '' && entry.brBuffer && entry.gzBuffer);
		expect(found, 'an actual indexed immutable asset with both compressed representations').toBeTruthy();
		[immutablePath, immutableEntry] = found;
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	for (const lane of ['auth-304', 'ssr-304', 'head-empty', 'head-body']) {
		it.each(lengths)(lane + ' safely handles declared length $declared', async ({ declared, expected }) => {
			const auth = lane === 'auth-304';
			const head = lane.startsWith('head');
			const target = auth ? '/__ws/auth' : '/response-guard?status=' + (head ? 200 : 304) +
				'&length=' + encodeURIComponent(declared) + (lane === 'head-body' ? '&body=1' : '');
			const result = await request(server.port, auth ? 'POST' : head ? 'HEAD' : 'GET', target,
				auth ? { 'X-Auth-Response': '304-custom', 'X-Auth-Length': declared } : {});
			expect(result.status).toBe(head ? 200 : 304);
			expect(result.headers['content-length']).toEqual(expected === undefined ? undefined : [expected]);
			expect(result.headers['transfer-encoding']).toBeUndefined();
			expect(result.body.byteLength).toBe(0);
		});
	}

	it('an authentication network-error Response yields a clean 500 without hook cookies', async () => {
		const result = await request(server.port, 'POST', '/__ws/auth', { 'X-Auth-Response': 'error' });
		expect(result.status).toBe(500);
		expect(result.headers['set-cookie']).toBeUndefined();
		expect(result.body.toString()).toBe('Internal Server Error');
	});
	it.each(['GET', 'HEAD'])('an endpoint network-error Response yields a valid %s 500', async (method) => {
		const result = await request(server.port, method, '/response-guard?error=1');
		expect(result.status).toBe(500);
		expect(result.headers['set-cookie']).toBeUndefined();
		expect(result.headers['content-length']).toEqual(['21']);
		expect(result.body.toString()).toBe(method === 'HEAD' ? '' : 'Internal Server Error');
	});

	for (const coding of ['identity', 'br', 'gzip']) {
		for (const method of ['GET', 'HEAD']) {
			it(method + ' immutable ' + coding + ' honors existence wildcard without an ETag', async () => {
				const result = await request(server.port, method, immutablePath, {
					'Accept-Encoding': coding, 'If-None-Match': '*', Range: 'bytes=0-3'
				});
				expect(result.status).toBe(304);
				expect(result.headers['cache-control']).toEqual(['public, max-age=31536000, immutable']);
				expect(result.headers.vary).toEqual(['Accept-Encoding']);
				expect(result.headers['x-content-type-options']).toEqual(['nosniff']);
				expect(result.headers.date?.length).toBeGreaterThan(0);
				for (const date of result.headers.date) expect(Number.isNaN(Date.parse(date))).toBe(false);
				for (const key of ['etag', 'last-modified', 'content-length', 'transfer-encoding', 'content-encoding', 'content-range']) {
					expect(result.headers[key], key).toBeUndefined();
				}
				expect(result.body.byteLength).toBe(0);
			});
			it(method + ' immutable ' + coding + ' still serves normally with no condition', async () => {
				const result = await request(server.port, method, immutablePath, { 'Accept-Encoding': coding });
				const body = coding === 'br' ? immutableEntry.brBuffer : coding === 'gzip' ? immutableEntry.gzBuffer : immutableEntry.buffer;
				expect(result.status).toBe(200);
				expect(result.headers.etag).toBeUndefined();
				expect(result.headers['content-length']).toEqual([String(body.byteLength)]);
				expect(result.headers['content-encoding']).toEqual(coding === 'identity' ? undefined : [coding]);
				expect(result.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : body);
			});
		}
	}
	it.each(['GET', 'HEAD'])('immutable %s keeps conditional precedence and empty-tag handling', async (method) => {
		const invoke = (headers) => request(server.port, method, immutablePath, headers);
		expect((await invoke({ 'If-Match': '*', 'If-None-Match': '*' })).status).toBe(304);
		expect((await invoke({ 'If-Match': '"missing"', 'If-None-Match': '*' })).status).toBe(412);
		expect((await invoke({ 'If-Match': '*' })).status).toBe(200);
		expect((await invoke({ 'If-None-Match': ', "missing"' })).status).toBe(200);
		expect((await invoke({ 'If-Modified-Since': 'Fri, 01 Jan 2100 00:00:00 GMT' })).status).toBe(200);
	});
});
