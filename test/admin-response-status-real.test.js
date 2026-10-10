import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { createTestServer } from '../src/testing.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

function request(port, method, fail) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(`${method} /__realtime/status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nX-Response-Error: ${fail ? '1' : '0'}\r\n\r\n`);
		});
		const chunks = [];
		const timer = setTimeout(() => { socket.destroy(); reject(new Error('Response did not end')); }, 5000);
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', (error) => { clearTimeout(timer); reject(error); });
		socket.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('latin1')); });
	});
}

for (const surface of ['production', 'testing']) {
	describeUWS(`admin final response statuses (${surface})`, () => {
		let server;
		let port;
		beforeAll(async () => {
			if (surface === 'production') {
				server = await startRealRuntime({ variant: 'hookcrash' });
				port = server.port;
			} else {
				server = await createTestServer({ handler: {
					admin: (request) => request.headers.get('x-response-error') === '1'
						? Response.error() : new Response('healthy')
				} });
				port = Number(new URL(server.url).port);
			}
		}, 400000);
		afterAll(async () => {
			if (surface === 'production') await server?.stop();
			else await server?.close();
		});

		it.each(['GET', 'HEAD'])('%s answers an error Response with a valid 500 and serves the next request', async (method) => {
			const raw = await request(port, method, true);
			expect(raw.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 500(?: |$)/);
			const [headers, body] = raw.split('\r\n\r\n');
			expect(headers.toLowerCase()).toContain('content-type: application/json');
			expect(body).toBe(method === 'HEAD' ? '' : '{"error":"internal error"}');
			const healthy = await request(port, 'GET', false);
			expect(healthy.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 200(?: |$)/);
			expect(healthy.split('\r\n\r\n')[1].length).toBeGreaterThan(0);
		});
	});
}
