// HTTP/1.1 pipelining on the built runtime, over a raw socket.
// The native parser closes when another request follows an unfinished response.
// That means no bytes for an awaiting route, or a truncated large static body
// when bounded-memory tryEnd is waiting for socket capacity.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** Write every request in one packet; resolve with what came back before the close. */
function pipeline(port, targets, close = false, timeout = 3000) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		let received = '';
		let closed = false;
		const done = () => { if (!closed) { closed = true; clearTimeout(deadline); resolve({ received, closedByServer: socket.readableEnded }); } };
		socket.on('data', (d) => { received += d.toString('latin1'); });
		socket.on('end', done);
		socket.on('close', done);
		socket.on('error', done);
		socket.on('connect', () => {
			socket.write(targets.map((t, i) => `GET ${t} HTTP/1.1\r\nHost: 127.0.0.1\r\n${close && i === targets.length - 1 ? 'Connection: close\r\n' : ''}\r\n`).join(''));
		});
		const deadline = setTimeout(() => { socket.destroy(); done(); }, timeout);
	});
}

describeUWS('pipelined requests on the built runtime', () => {
	let server;
	let dir;
	const largeSize = 32 * 1024 * 1024;
	let largeHash;
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'default' });
		if (process.platform === 'linux') {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uws-pipeline-static-'));
			const body = Buffer.alloc(largeSize, 115);
			largeHash = createHash('sha256').update(body).digest('hex');
			fs.writeFileSync(path.join(dir, 'large.bin'), body);
			const { cacheDir } = await import('./fixture/build/handler/static-assets.js');
			cacheDir(dir, '/pipeline-static', false);
		}
	}, 400000);
	afterAll(async () => {
		await server?.stop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('answers requests that are each written before the next is parsed', async () => {
		const { received } = await pipeline(server.port, ['/healthz', '/healthz']);
		expect(received.match(/HTTP\/1\.1 200/g)?.length).toBe(2);
	});

	it('closes without an answer when a request behind a waiting one is parsed', async () => {
		const { received, closedByServer } = await pipeline(server.port, ['/slow-hold?ms=100', '/healthz']);
		expect(received, 'neither request is answered').toBe('');
		expect(closedByServer, 'the server closed the connection').toBe(true);
	});
	it.skipIf(process.platform !== 'linux')('completes a large static response without a pipelined request', async () => {
		const { received, closedByServer } = await pipeline(server.port, ['/pipeline-static/large.bin'], true, 15000);
		const headerEnd = received.indexOf('\r\n\r\n');
		expect(headerEnd).toBeGreaterThan(0);
		const headers = received.slice(0, headerEnd);
		const body = received.slice(headerEnd + 4);
		expect(headers).toMatch(/^HTTP\/1\.1 200/);
		expect(headers).toMatch(new RegExp('content-length: ' + largeSize + '(?:\\r\\n|$)', 'i'));
		expect(body.length).toBe(largeSize);
		expect(createHash('sha256').update(body, 'latin1').digest('hex')).toBe(largeHash);
		expect(closedByServer).toBe(true);
	}, 20000);

	it.skipIf(process.platform !== 'linux')('closes with a partial large static body when the next request is parsed', async () => {
		const { received, closedByServer } = await pipeline(server.port, ['/pipeline-static/large.bin', '/healthz'], true, 15000);
		const headerEnd = received.indexOf('\r\n\r\n');
		expect(headerEnd).toBeGreaterThan(0);
		const headers = received.slice(0, headerEnd);
		const body = received.slice(headerEnd + 4);
		expect(headers).toMatch(/^HTTP\/1\.1 200/);
		expect(headers).toMatch(new RegExp('content-length: ' + largeSize + '(?:\\r\\n|$)', 'i'));
		expect(body.length).toBeGreaterThan(0);
		expect(body.length).toBeLessThan(largeSize);
		expect(body.replaceAll('s', '')).toBe('');
		expect(received.match(/HTTP\/1\.1 /g)?.length).toBe(1);
		expect(closedByServer).toBe(true);
	}, 20000);

});
