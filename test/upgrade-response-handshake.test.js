// The upgrade hook may return upgradeResponse(userData, headers) to attach
// headers to the 101 Switching Protocols response. uWebSockets.js writes an
// implicit "200 OK" status on the first writeHeader() and keeps the first
// status it wrote, so the headers have to be preceded by an explicit 101 or
// the client refuses the handshake ("Unexpected server response: 200") while
// the server still runs open(). These cases drive the real uWebSockets.js
// server through createTestServer and read the raw status line off a TCP
// socket, so nothing between client and server can normalize what the server
// wrote.

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';

let uWS;
try {
	uWS = (await import('uWebSockets.js')).default;
} catch {
	uWS = null;
}
const describeUWS = uWS ? describe : describe.skip;

let server;

/**
 * Raw-TCP WebSocket upgrade request. Resolves with the raw response as a
 * latin1 string once the server has answered: a 101 leaves the socket open
 * for frames, so the read ends on a short quiet period after the first bytes,
 * and a reset or timeout resolves with whatever arrived so the status-line
 * assertion is what fails.
 * @param {number} port
 * @param {string} path
 * @returns {Promise<string>}
 */
function rawUpgrade(port, path = '/ws') {
	return new Promise((resolve) => {
		const key = Buffer.from('0123456789abcdef').toString('base64');
		const chunks = [];
		let settle = null;
		const sock = net.connect(port, '127.0.0.1', () => {
			sock.write(
				`GET ${path} HTTP/1.1\r\n` +
				`Host: 127.0.0.1:${port}\r\n` +
				'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
				`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
			);
		});
		const finish = () => {
			clearTimeout(settle);
			sock.destroy();
			resolve(Buffer.concat(chunks).toString('latin1'));
		};
		sock.on('data', (d) => {
			chunks.push(d);
			clearTimeout(settle);
			settle = setTimeout(finish, 150);
		});
		sock.on('end', finish);
		sock.on('error', finish);
		sock.setTimeout(3000, finish);
	});
}

/** @param {string} raw */
function statusLine(raw) {
	return raw.split('\r\n')[0];
}

describeUWS('upgradeResponse() headers on the 101', () => {
	afterEach(() => {
		server?.close();
		server = null;
	});

	it('answers 101 Switching Protocols with the custom header on the wire', async () => {
		const { createTestServer } = await import('../testing.js');
		const { upgradeResponse } = await import('../upgrade-response.js');
		server = await createTestServer({
			handler: {
				upgrade() {
					return upgradeResponse({ id: '1' }, { 'x-test': '1' });
				}
			}
		});

		const raw = await rawUpgrade(Number(new URL(server.url).port));
		expect(statusLine(raw)).toBe('HTTP/1.1 101 Switching Protocols');
		expect(raw.toLowerCase()).toContain('x-test: 1');
		expect(raw.toLowerCase()).toContain('sec-websocket-accept: ');
		expect(raw).not.toContain('200 OK');
	});

	it('completes the handshake for a WebSocket client, delivers the header and the unwrapped userData', async () => {
		const { createTestServer } = await import('../testing.js');
		const { upgradeResponse } = await import('../upgrade-response.js');
		/** @type {unknown[]} */
		const opened = [];
		server = await createTestServer({
			handler: {
				upgrade() {
					return upgradeResponse({ id: '1' }, { 'x-test': '1' });
				},
				open(ws) {
					opened.push(ws.getUserData().id);
				}
			}
		});

		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl);
		let upgradeHeaders = null;
		ws.on('upgrade', (res) => {
			upgradeHeaders = res.headers;
		});
		await new Promise((resolve, reject) => {
			// Without the 101 written first the client rejects here with
			// "Unexpected server response: 200" while the server has already run
			// open() for the socket: no open, no upgrade event.
			const timer = setTimeout(() => reject(new Error('handshake timed out')), 3000);
			ws.on('open', () => { clearTimeout(timer); resolve(undefined); });
			ws.on('error', (err) => { clearTimeout(timer); reject(err); });
		});

		expect(upgradeHeaders).not.toBeNull();
		expect(upgradeHeaders['x-test']).toBe('1');
		expect(opened).toEqual(['1']);
		ws.close();
	});

	it('writes one line per element of an array header and keeps the 101', async () => {
		const { createTestServer } = await import('../testing.js');
		const { upgradeResponse } = await import('../upgrade-response.js');
		server = await createTestServer({
			handler: {
				upgrade() {
					return upgradeResponse({}, { 'x-multi': ['first', 'second'] });
				}
			}
		});

		const raw = await rawUpgrade(Number(new URL(server.url).port));
		expect(statusLine(raw)).toBe('HTTP/1.1 101 Switching Protocols');
		const lower = raw.toLowerCase();
		expect(lower).toContain('x-multi: first');
		expect(lower).toContain('x-multi: second');
		expect(lower.split('x-multi: ').length - 1).toBe(2);
	});

	it('a hook that returns plain userData without headers still answers 101 (control arm)', async () => {
		const { createTestServer } = await import('../testing.js');
		server = await createTestServer({
			handler: {
				upgrade() {
					return { id: '2' };
				}
			}
		});

		const raw = await rawUpgrade(Number(new URL(server.url).port));
		expect(statusLine(raw)).toBe('HTTP/1.1 101 Switching Protocols');
		expect(raw.toLowerCase()).not.toContain('x-test');
	});
});
