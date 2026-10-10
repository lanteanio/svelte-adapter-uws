import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { bootViteDev } from './helpers/vite-dev.js';
import * as handler from './fixture/src/hooks.ws.cookie-safety.js';

function request(port, mode) {
	return new Promise((resolve, reject) => {
		let bytes = Buffer.alloc(0), settled = false;
		const socket = net.connect(port, '127.0.0.1', () => socket.write(
			'POST /__ws/auth HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\nContent-Length: 0\r\nX-Requested-With: XMLHttpRequest\r\nX-Cookie-Case: ' + mode + '\r\n\r\n'
		));
		socket.on('data', chunk => {
			bytes = Buffer.concat([bytes, chunk]);
			const end = bytes.indexOf('\r\n\r\n');
			if (end === -1 || settled) return;
			settled = true;
			socket.destroy();
			const raw = bytes.subarray(0, end).toString('latin1');
			resolve({ status: Number(raw.match(/^HTTP\/1\.1 (\d+)/)?.[1]), raw, bytes: bytes.subarray(0, end) });
		});
		socket.on('error', error => { if (!settled) { settled = true; reject(error); } });
		socket.on('end', () => { if (!settled) { settled = true; reject(new Error('response ended before headers')); } });
		socket.setTimeout(3000, () => { socket.destroy(); if (!settled) { settled = true; reject(new Error('cookie response deadline')); } });
	});
}
const invalid = [
	...['name', 'raw', 'path', 'relative', 'domain'].flatMap(field => ['high', 'low'].map(part => field + '-' + part)),
	'expires-duck', 'expires-control', 'expires-invalid', 'expires-proxy', 'expires-null'
];
for (const surface of ['built', 'vite']) {
	(hasUWS ? describe : describe.skip)('cookie serialization over real ' + surface + ' HTTP', () => {
		let server;
		beforeAll(async () => {
			if (surface === 'built') server = await startRealRuntime({ variant: 'cookiesafety' });
			else {
				const dev = await bootViteDev({ handler, pluginOptions: { allowedOrigins: '*', authPathRateLimit: 0 } });
				server = { port: dev.port, stop: dev.close };
			}
		}, 400000);
		afterAll(async () => { await server?.stop(); });
		it.each(invalid)('refuses %s before it reaches response headers', async mode => {
			const answer = await request(server.port, mode);
			expect(answer.status).toBe(500);
			expect(answer.raw).not.toMatch(/\r\n(?:set-cookie|x-injected):/i);
			const healthy = await request(server.port, 'valid');
			expect(healthy.status).toBe(200);
			expect(healthy.raw).toContain('safe=ok; Path=/');
		});
		it.each([
			['valid', 'safe=ok; Path=/'], ['encoded', 'safe=%F0%9F%99%82'],
			['relative', '; Path=/__ws/sub'], ['date-valid', '; Expires=Tue, 01 Jan 2030 00:00:00 GMT'],
			['date-tampered', '; Expires=Tue, 01 Jan 2030 00:00:00 GMT'],
			['date-subclass', '; Expires=Tue, 01 Jan 2030 00:00:00 GMT']
		])('preserves valid %s cookie bytes', async (mode, expected) => {
			const answer = await request(server.port, mode);
			expect(answer.status).toBe(200);
			expect(answer.raw).toContain(expected);
			expect(answer.raw).not.toMatch(/\r\nx-injected:/i);
		});
		if (surface === 'built') it('preserves valid paired Unicode in an unencoded native cookie', async () => {
			const answer = await request(server.port, 'paired');
			expect(answer.status).toBe(200);
			expect(answer.bytes.includes(Buffer.from('safe=\ud83d\ude42; Path=/'))).toBe(true);
		});
	});
}
