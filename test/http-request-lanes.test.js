// Four request-lane behaviours, driven against the REAL built runtime over raw
// sockets so the bytes on the wire are what is asserted:
//
//   - the liveness and readiness probes answer HEAD, which HAProxy's httpchk
//     and most uptime monitors send by default; a HEAD used to fall through to
//     the catch-all and be answered by the app's 404;
//   - a prerendered trailing-slash redirect spells its Location percent-encoded;
//     the lookup matches the DECODED path and used to write it verbatim, so a
//     route with a non-ASCII name redirected with raw UTF-8 bytes in the header;
//   - the single-chunk SSR lane compresses by the weights in Accept-Encoding;
//   - on Windows, the reserved-character refusal reads the decoded spelling as
//     well as the raw one, since every lane behind it decodes before opening.
//
// Raw sockets rather than fetch: fetch normalises the target and would never
// send a raw non-ASCII byte in a request line, and it hides the header bytes.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { connect } from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const WINDOWS = process.platform === 'win32';

/**
 * Send `request` as written and return the response split into its head (as
 * latin1, so every byte is one character) and body.
 *
 * @param {number} port
 * @param {Buffer} request
 * @returns {Promise<{ status: number, head: string, headers: Record<string, string>, body: Buffer }>}
 */
function exchange(port, request) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		const socket = connect(port, '127.0.0.1', () => { socket.write(request); });
		socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('no response within 10s')); });
		socket.on('data', (chunk) => chunks.push(chunk));
		socket.on('error', reject);
		socket.on('close', () => {
			const raw = Buffer.concat(chunks);
			const blank = raw.indexOf('\r\n\r\n');
			const head = raw.subarray(0, blank < 0 ? raw.length : blank).toString('latin1');
			const body = blank < 0 ? Buffer.alloc(0) : raw.subarray(blank + 4);
			/** @type {Record<string, string>} */
			const headers = {};
			const lines = head.split('\r\n');
			for (const line of lines.slice(1)) {
				const colon = line.indexOf(':');
				if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
			}
			resolve({ status: parseInt(lines[0].split(' ')[1], 10), head, headers, body });
		});
	});
}

/**
 * A request whose target is given as bytes, so a non-ASCII byte can be sent
 * raw where a client library would have refused or encoded it.
 *
 * @param {string} method
 * @param {Buffer | string} target
 * @param {Record<string, string>} [headers]
 */
function request(method, target, headers = {}) {
	const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
	return Buffer.concat([
		Buffer.from(method + ' '),
		Buffer.isBuffer(target) ? target : Buffer.from(target),
		Buffer.from(' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' + lines.map((l) => l + '\r\n').join('') + '\r\n')
	]);
}

const E_ACUTE = Buffer.from([0xc3, 0xa9]);

describeUWS('request lanes against the real built runtime', () => {
	let server;
	let port;

	beforeAll(async () => {
		server = await startRealRuntime();
		port = Number(new URL(server.httpUrl).port);
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('answers HEAD on the liveness and readiness probes with the GET status and no body', async () => {
		const live = await exchange(port, request('HEAD', '/healthz'));
		expect(live.status).toBe(200);
		expect(live.headers['content-length']).toBe('2');
		expect(live.body.byteLength).toBe(0);

		const ready = await exchange(port, request('HEAD', '/readyz'));
		expect(ready.status).toBe(200);
		expect(ready.headers['content-length']).toBe('5');
		expect(ready.body.byteLength).toBe(0);

		// GET is unchanged.
		const got = await exchange(port, request('GET', '/healthz'));
		expect(got.status).toBe(200);
		expect(got.body.toString()).toBe('OK');
		expect((await exchange(port, request('GET', '/readyz'))).body.toString()).toBe('ready');
	}, 30000);

	it('serves a prerendered page under a non-ASCII name for its encoded spelling', async () => {
		const page = await exchange(port, request('GET', '/prerendered/caf%C3%A9'));
		expect(page.status).toBe(200);
		expect(page.body.toString()).toContain('data-testid="prerendered-non-ascii"');
	}, 30000);

	it('redirects the trailing-slash spelling with a percent-encoded Location', async () => {
		const redirect = await exchange(port, request('GET', '/prerendered/caf%C3%A9/?x=1'));
		expect(redirect.status).toBe(308);
		expect(redirect.headers.location).toBe('/prerendered/caf%C3%A9?x=1');
		// Nothing outside ASCII anywhere in the header block.
		expect(/[^\x00-\x7f]/.test(redirect.head)).toBe(false);
	}, 30000);

	it('encodes a raw-byte target the same way, and the redirect lands where the lookup matched', async () => {
		// A client that sends the name's UTF-8 bytes raw in the request line.
		// uWS hands them to the runtime as the decoded characters, and the header
		// used to carry those characters' bytes back out unencoded.
		const target = Buffer.concat([Buffer.from('/prerendered/caf'), E_ACUTE, Buffer.from('/?x='), E_ACUTE]);
		const redirect = await exchange(port, request('GET', target));
		expect(redirect.status).toBe(308);
		expect(redirect.headers.location).toBe('/prerendered/caf%C3%A9?x=%C3%A9');
		expect(/[^\x00-\x7f]/.test(redirect.head)).toBe(false);

		const landed = await exchange(port, request('GET', redirect.headers.location.split('?')[0]));
		expect(landed.status).toBe(200);
		expect(landed.body.toString()).toContain('data-testid="prerendered-non-ascii"');
	}, 30000);

	it('compresses a single-chunk SSR response by the weights in Accept-Encoding', async () => {
		const identity = await exchange(port, request('GET', '/compressible'));
		expect(identity.status).toBe(200);
		expect(identity.headers['content-encoding']).toBeUndefined();
		expect(identity.body.toString()).toContain('data-testid="compressible"');
		// The lane compresses bodies of a kilobyte and up; below that nothing
		// here would be exercised.
		expect(identity.body.byteLength, 'the fixture page must be large enough to compress').toBeGreaterThanOrEqual(1024);

		const browser = await exchange(port, request('GET', '/compressible', { 'Accept-Encoding': 'gzip, deflate, br, zstd' }));
		expect(browser.headers['content-encoding']).toBe('br');
		expect(browser.body.byteLength).toBeLessThan(identity.body.byteLength);

		const refused = await exchange(port, request('GET', '/compressible', { 'Accept-Encoding': 'br;q=0, gzip' }));
		expect(refused.headers['content-encoding']).toBe('gzip');

		const preferred = await exchange(port, request('GET', '/compressible', { 'Accept-Encoding': 'gzip;q=1.0, br;q=0.5' }));
		expect(preferred.headers['content-encoding']).toBe('gzip');

		const none = await exchange(port, request('GET', '/compressible', { 'Accept-Encoding': 'br;q=0, gzip;q=0' }));
		expect(none.headers['content-encoding']).toBeUndefined();
		expect(none.body.byteLength).toBe(identity.body.byteLength);
	}, 30000);

	it.runIf(WINDOWS)('refuses an encoded alternate-data-stream or short-name path on Windows', async () => {
		for (const target of ['/x:y', '/x%3Ay', '/x%3ay', '/LONGFI~1.TXT', '/LONGFI%7E1.TXT', '/caf%C3%A9%3Ax']) {
			const res = await exchange(port, request('GET', target));
			expect(res.status, target).toBe(400);
		}
		// An ordinary encoded path is untouched by the gate.
		expect((await exchange(port, request('GET', '/prerendered/caf%C3%A9'))).status).toBe(200);
	}, 30000);

	it.runIf(!WINDOWS)('applies no reserved-character gate elsewhere', async () => {
		for (const target of ['/x:y', '/x%3Ay', '/LONGFI%7E1.TXT']) {
			const res = await exchange(port, request('GET', target));
			expect(res.status, target).not.toBe(400);
		}
	}, 30000);
});
