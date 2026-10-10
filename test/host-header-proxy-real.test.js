// Behind a proxy, the headers the deployment configured stand in for the Host
// header, and they are held to the same rule: a value that is not an authority,
// a port or a scheme is refused with 400 before the request URL is built from
// it. A client can reach these values too, wherever the proxy passes its own
// line through.
//
// The operator gets one warning naming the header, because a proxy writing it
// wrong makes every request a 400 and nothing else would say why.
//
// ONE VARIANT PER TEST FILE, and a variant of its own: the header names are
// read at module eval (see helpers/real-runtime.js), and the other suites
// booting the same hooks need them absent.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * @param {number} port
 * @param {string[]} headers
 * @returns {Promise<{ status: number, body: string }>}
 */
function get(port, headers) {
	return new Promise((resolve) => {
		let buf = '';
		const sock = net.connect(port, '127.0.0.1', () => {
			sock.write(['GET / HTTP/1.1', ...headers, 'Connection: close'].join('\r\n') + '\r\n\r\n');
		});
		sock.setTimeout(5000, () => { sock.destroy(); });
		sock.on('data', (d) => { buf += d.toString('latin1'); });
		sock.on('close', () => resolve({
			status: Number(buf.split('\r\n')[0].split(' ')[1] || 0),
			body: buf.slice(buf.indexOf('\r\n\r\n') + 4)
		}));
		sock.on('error', () => {});
	});
}

describeUWS('the configured proxy headers on the built runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	/** @type {import('vitest').MockInstance | null} */
	let warn = null;
	const originalPrefixedBodyLimit = process.env.TEST_PROXY_BODY_SIZE_LIMIT;
	const originalBareHostHeader = process.env.HOST_HEADER;

	beforeAll(async () => {
		process.env.TEST_PROXY_BODY_SIZE_LIMIT = '1';
		process.env.HOST_HEADER = 'wrong-bare-header';
		server = await startRealRuntime({
			variant: 'hookcrashproxy',
			env: {
				HOST_HEADER: 'x-forwarded-host',
				PORT_HEADER: 'x-forwarded-port',
				PROTOCOL_HEADER: 'x-forwarded-proto',
				ADDRESS_HEADER: 'x-forwarded-for',
				XFF_DEPTH: '2'
			}
		});
		warn = vi.spyOn(console, 'warn');
	}, 400000);

	afterAll(async () => {
		warn?.mockRestore();
		try {
			if (server) await server.stop();
			expect(process.env.TEST_PROXY_BODY_SIZE_LIMIT).toBe('1');
			expect(process.env.HOST_HEADER).toBe('wrong-bare-header');
		} finally {
			if (originalPrefixedBodyLimit === undefined) delete process.env.TEST_PROXY_BODY_SIZE_LIMIT;
			else process.env.TEST_PROXY_BODY_SIZE_LIMIT = originalPrefixedBodyLimit;
			if (originalBareHostHeader === undefined) delete process.env.HOST_HEADER;
			else process.env.HOST_HEADER = originalBareHostHeader;
		}
	});

	/** @returns {string[]} */
	const warnings = () => warn.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('400 Bad Request'));

	it('judges the forwarded values, and does not read a Host header the URL is not built from', async () => {
		const served = await get(server.port, ['Host: a/__realtime/introspect?', 'X-Forwarded-Host: example.com']);
		expect(served.status).toBe(200);
		expect(served.body).not.toContain('appRouteReached');
		expect((await get(server.port, ['Host: 127.0.0.1', 'X-Forwarded-Port: 8443', 'X-Forwarded-Proto: https'])).status).toBe(200);
	});

	// One case, because the warning is spent once per module and every step
	// below reads what the earlier ones left.
	it('refuses a forwarded value that cannot be part of an origin, and warns once naming its header and setting', async () => {
		// A refused Host header is the client's alone, so it says nothing to the
		// operator.
		const hostOnly = await get(server.port, ['Host: a/__realtime/introspect?']);
		expect(hostOnly.status).toBe(400);
		expect(warnings(), 'a client\'s Host header is not a proxy fault').toEqual([]);

		const forwarded = await get(server.port, ['Host: 127.0.0.1', 'X-Forwarded-Host: a/__realtime/introspect?']);
		expect(forwarded.status).toBe(400);
		expect(forwarded.body).not.toContain('appRouteReached');
		expect(warnings()).toHaveLength(1);
		const [first] = warnings();
		expect(first).toContain('The x-forwarded-host header');
		expect(first).toContain('TEST_PROXY_HOST_HEADER names it');
		expect(first, 'never the value').not.toContain('__realtime');

		// 400, not the 500 a page answered before, and no second warning.
		for (const headers of [
			['X-Forwarded-Port: 80/__realtime/introspect'],
			['X-Forwarded-Port: 0x50'],
			['X-Forwarded-Proto: ftp'],
			['X-Forwarded-Proto: %E0%A4%A']
		]) {
			const answer = await get(server.port, ['Host: 127.0.0.1', ...headers]);
			expect(answer.status, headers[0]).toBe(400);
			expect(answer.body, headers[0]).toBe('Bad Request');
		}
		expect(warnings(), 'still the one warning').toHaveLength(1);
	});
	it('names the prefixed address settings in SSR client-address errors', async () => {
		const missing = await fetch(server.httpUrl + '/client-address');
		expect(missing.status).toBe(500);
		expect((await missing.json()).error).toContain('TEST_PROXY_ADDRESS_HEADER=x-forwarded-for');
		const shallow = await fetch(server.httpUrl + '/client-address', { headers: { 'x-forwarded-for': '192.0.2.1' } });
		expect(shallow.status).toBe(500);
		expect((await shallow.json()).error).toContain('TEST_PROXY_XFF_DEPTH is 2');
		const valid = await fetch(server.httpUrl + '/client-address', { headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.2' } });
		expect(valid.status).toBe(200);
		expect((await valid.json()).address).toBe('192.0.2.1');
	});

	it('scrubs an inherited prefixed body limit while leaving the bare namespace alone', async () => {
		const response = await fetch(server.httpUrl + '/ssr-echo', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'several-bytes' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('several-bytes');
		expect(process.env.TEST_PROXY_BODY_SIZE_LIMIT).toBeUndefined();
		expect(process.env.HOST_HEADER).toBe('wrong-bare-header');
	});

});
