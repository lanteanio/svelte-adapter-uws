// HTTP/1.1 pipelining on the built runtime, over a raw socket.
//
// uWS answers pipelined requests only while each response is written before
// the next request is parsed. When a request is still waiting on its answer -
// any route that awaits, such as a SvelteKit endpoint doing I/O - and the next
// request on the same connection is parsed, uWS closes the connection, and
// neither request gets a byte. That is the transport's rule, applied in its
// parser before any JavaScript runs; RFC 9112 9.3.2 has a client retry the
// requests a closed connection left unanswered. Both halves are pinned here so
// a change in either shows up.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** Write every request in one packet; resolve with what came back before the close. */
function pipeline(port, targets) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		let received = '';
		let closed = false;
		const done = () => { if (!closed) { closed = true; resolve({ received, closedByServer: socket.readableEnded }); } };
		socket.on('data', (d) => { received += d.toString('latin1'); });
		socket.on('end', done);
		socket.on('close', done);
		socket.on('error', done);
		socket.on('connect', () => {
			socket.write(targets.map((t) => `GET ${t} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`).join(''));
		});
		setTimeout(() => { socket.destroy(); done(); }, 3000);
	});
}

describeUWS('pipelined requests on the built runtime', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'default' }); }, 400000);
	afterAll(async () => { await server?.stop(); });

	it('answers requests that are each written before the next is parsed', async () => {
		const { received } = await pipeline(server.port, ['/healthz', '/healthz']);
		expect(received.match(/HTTP\/1\.1 200/g)?.length).toBe(2);
	});

	it('closes without an answer when a request behind a waiting one is parsed', async () => {
		const { received, closedByServer } = await pipeline(server.port, ['/slow-hold?ms=100', '/healthz']);
		expect(received, 'neither request is answered').toBe('');
		expect(closedByServer, 'the server closed the connection').toBe(true);
	});
});
