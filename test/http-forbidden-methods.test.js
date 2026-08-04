// TRACE and TRACK produced a generic 500 instead of 405.
//
// The cause was that the fetch specification forbids CONNECT, TRACE and TRACK,
// so `new Request()` throws a TypeError for them, and that throw reached the
// generic SSR failure path. Two consequences, and the second is the worse one:
// the status was wrong, AND every probe emitted a full error-severity
// diagnostic with a request id, so a scanner sending TRACE in a loop could fill
// an operator's error log with no application involvement at all.
//
// Driven over a raw socket rather than fetch, because fetch itself refuses to
// send these methods - they are forbidden on the client side too, so a test
// written with fetch cannot reach the server path at all.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { connect } from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

function rawRequest(port, requestLine) {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(requestLine + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
		});
		let buffer = '';
		socket.on('data', (chunk) => { buffer += chunk.toString('latin1'); });
		socket.on('end', () => resolve(buffer));
		socket.on('error', reject);
		const timer = setTimeout(() => { socket.destroy(); resolve(buffer); }, 5000);
		timer.unref?.();
	});
}

const head = (raw) => (raw.split('\r\n\r\n')[0] || raw);
const status = (raw) => head(raw).split('\r\n')[0];
const header = (raw, name) => head(raw)
	.split('\r\n')
	.filter((line) => line.toLowerCase().startsWith(name.toLowerCase() + ':'))
	.map((line) => line.slice(name.length + 1).trim());

describeUWS('forbidden HTTP methods, against the real built runtime', () => {
	let server;
	let port;

	beforeAll(async () => {
		server = await startRealRuntime();
		port = Number(new URL(server.httpUrl).port);
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('answers 405 with an Allow header for every method the fetch specification forbids', async () => {
		for (const method of ['TRACE', 'TRACK', 'CONNECT']) {
			const raw = await rawRequest(port, method + ' /');
			expect(status(raw), method + ' status').toContain('405');
			// RFC 9110 requires Allow on a 405. Without it the response is a
			// refusal that never says what would have been accepted.
			expect(header(raw, 'allow'), method + ' Allow header')
				.toEqual(['GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS']);
			expect(raw, method + ' body').not.toContain('Internal Server Error');
		}
	}, 30000);

	it('leaves the supported methods exactly as they were', async () => {
		// The refusal is scoped to the three forbidden methods. If it had been
		// written as an allowlist over the method map instead, an unlisted method
		// like PROPFIND would have started being refused by the adapter rather
		// than routed to the application - a wider behaviour change than the
		// defect warranted.
		expect(status(await rawRequest(port, 'GET /healthz'))).toContain('200');
		expect(status(await rawRequest(port, 'OPTIONS /'))).toContain('204');

		const propfind = await rawRequest(port, 'PROPFIND /');
		expect(status(propfind), 'an unlisted method still reaches the application')
			.not.toContain('405 Method Not Allowed');
	}, 30000);
});
