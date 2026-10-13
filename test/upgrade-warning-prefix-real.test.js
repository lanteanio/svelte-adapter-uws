import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

function upgrade(port) {
	return new Promise((resolve, reject) => {
		let response = '';
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
		});
		socket.setTimeout(5000, () => socket.destroy(new Error('Upgrade response timed out')));
		socket.on('data', chunk => {
			response += chunk.toString();
			if (response.includes('\r\n\r\n')) {
				resolve(Number(response.split(' ')[1]));
				socket.destroy();
			}
		});
		socket.on('error', reject);
	});
}

describeUWS('prefixed upgrade rate-limit warnings on the built runtime', () => {
	let server;
	let warn;
	beforeAll(async () => {
		warn = vi.spyOn(console, 'warn');
		server = await startRealRuntime({ variant: 'hookcrashproxy' });
	}, 400000);
	afterAll(async () => { warn?.mockRestore(); await server?.stop(); });

	it('names the prefixed address and depth settings when loopback clients exhaust the limit', async () => {
		// Each admitted connection is closed immediately after its handshake.
		const statuses = await Promise.all(Array.from({ length: 102 }, () => upgrade(server.port)));
		expect(statuses.filter(status => status === 429)).toHaveLength(2);
		const messages = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes('while TEST_PROXY_ADDRESS_HEADER is unset'));
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('TEST_PROXY_ADDRESS_HEADER=x-forwarded-for');
		expect(messages[0]).toContain('TEST_PROXY_XFF_DEPTH for the trusted-proxy hop count');
	});
});
