import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { hasUWS } from './helpers/real-runtime.js';

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


describeUWS('native Date on testing admin Responses', () => {
	let server;
	beforeAll(async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: {
			admin(request) {
				const headers = new Headers({ 'cache-control': 'private', 'x-probe': 'retained' });
				headers.append('set-cookie', 'a=1; Path=/');
				headers.append('set-cookie', 'b=2; Path=/');
				if (request.headers.has('x-response-date')) headers.set('Date', 'Thu, 01 Jan 1970 00:00:00 GMT');
				return new Response('dated', { headers });
			}
		} });
	});
	afterAll(async () => { await server?.close(); });
	for (const customDate of [false, true]) {
		it.each(['GET', 'HEAD'])('%s keeps one native Date, custom date=' + customDate, async (method) => {
			const extra = customDate ? { 'X-Response-Date': '1' } : {};
			const res = await request(server.port, method, '/__realtime/date', extra);
			expect(res.status).toBe(200);
			expect(res.headers.date).toHaveLength(1);
			expect(Number.isNaN(Date.parse(res.headers.date[0]))).toBe(false);
			expect(res.headers.date[0]).not.toBe('Thu, 01 Jan 1970 00:00:00 GMT');
			expect(res.headers['cache-control']).toEqual(['private']);
			expect(res.headers['x-probe']).toEqual(['retained']);
			expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
			expect(res.headers['content-length']).toEqual(['5']);
			expect(res.body.toString()).toBe(method === 'HEAD' ? '' : 'dated');
		});
	}
});
