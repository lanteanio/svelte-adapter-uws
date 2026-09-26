// The Host header names an authority and nothing else, and one that does not is
// refused with 400 wherever the runtime builds a request URL from it.
//
// With no ORIGIN configured, the SSR, admin and auth lanes build the URL as
// `scheme://` + Host + target. A Host carrying a `/`, `?`, `#` or `\` ends the
// authority early and puts its own path in front of the target, so
// `Host: a/__realtime/introspect?` with target `/` handed the app's router the
// path `/__realtime/introspect`: inside the reserved admin prefix, past the
// exact-mount refusals, and past any path rule in a proxy in front, which saw
// the target `/`. Every check on the target was made against the target.
//
// WHAT MAKES THE ASSERTION COUNT. The fixture app has a real route inside the
// reserved prefix that reports the pathname it was handed, and the admin hook
// echoes the path it dispatches on, so a failure here is the app or the admin
// hook reading a path the request line never named.
//
// RAW SOCKETS, because every HTTP client builds the Host header itself.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

const BACKSLASH = String.fromCharCode(92);

/**
 * Send one request verbatim and read the whole answer.
 * @param {number} port
 * @param {string} text
 * @returns {Promise<{ status: number, head: string, body: string, serverClosed: boolean }>}
 */
function exchange(port, text) {
	return new Promise((resolve) => {
		let buf = '';
		let serverClosed = false;
		const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
		sock.setTimeout(5000, () => { sock.destroy(); });
		sock.on('data', (d) => { buf += d.toString('latin1'); });
		sock.on('end', () => { serverClosed = true; });
		sock.on('close', () => {
			const split = buf.indexOf('\r\n\r\n');
			resolve({
				status: Number(buf.split('\r\n')[0].split(' ')[1] || 0),
				head: split === -1 ? buf : buf.slice(0, split),
				body: split === -1 ? '' : buf.slice(split + 4),
				serverClosed
			});
		});
		sock.on('error', () => {});
	});
}

/** @param {number} port @param {string} target @param {string} host */
function get(port, target, host) {
	return exchange(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
}

describeUWS('the Host header on the built runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	it('refuses a Host carrying a path into the reserved admin prefix', async () => {
		// The last two end the authority by a slash or a backslash alone, and
		// resolve with the target's own slash appended.
		for (const host of [
			'a/__realtime/introspect?',
			'a' + BACKSLASH + '__realtime' + BACKSLASH + 'introspect?',
			'a/__realtime/introspect#',
			'a/__realtime/introspect',
			'a' + BACKSLASH + '__realtime' + BACKSLASH + 'introspect'
		]) {
			const answer = await get(server.port, '/', host);
			expect(answer.status, host).toBe(400);
			expect(answer.body, host).toBe('Bad Request');
		}
		const control = await get(server.port, '/', '127.0.0.1');
		expect(control.status, 'the same request with a plain Host renders').toBe(200);
		expect(control.body).not.toContain('appRouteReached');
	});

	it('refuses a Host that would replace the target\'s path', async () => {
		// `http://a#` + `/ssr-echo` is the root page with a fragment, and
		// `http://a?` + `/ssr-echo` is the root page with a query: the target
		// was routed and a different page answered.
		for (const host of ['a#', 'a?', 'a/healthz?']) {
			expect((await get(server.port, '/ssr-echo', host)).status, host).toBe(400);
		}
	});

	it('answers 400, not 500, for a Host that cannot be part of an origin', async () => {
		// Each used to answer 500. The grammar refuses the first four; the last
		// three pass it, and the URL parser refuses them. The client sent every
		// one.
		for (const host of ['', 'a b', 'user@a', 'a:80:80', 'a%2f__realtime', 'a:99999', 'xn--zz']) {
			const answer = await get(server.port, '/', host);
			expect(answer.status, JSON.stringify(host)).toBe(400);
			expect(answer.body, JSON.stringify(host)).toBe('Bad Request');
		}
	});

	it('serves every authority spelling a client sends', async () => {
		for (const host of ['127.0.0.1', `127.0.0.1:${server.port}`, 'EXAMPLE.com.', '[::1]:8080', 'a:', 'sub_domain.example']) {
			expect((await get(server.port, '/', host)).status, host).toBe(200);
		}
	});

	it('reads past a refused request\'s body to the next request', async () => {
		// Past the grammar, the URL parser refuses the host after the body
		// stream exists but before anything reads it. The next request on the
		// connection must be answered as itself, not as the body's bytes.
		const answer = await exchange(server.port,
			'POST /ssr-echo HTTP/1.1\r\nHost: xn--zz\r\nContent-Type: application/octet-stream\r\nContent-Length: 12\r\n\r\nGET / HTTP/1' +
			'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
		// Unanchored: the 400's body carries no line break before the next status.
		const statuses = [...(answer.head + '\r\n\r\n' + answer.body).matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
		expect(statuses).toEqual([400, 200]);
	});

	it('refuses a Host that moves the admin hook to another admin path', async () => {
		const moved = await get(server.port, '/__realtime/introspect', 'a/__realtime/other?');
		expect(moved.status).toBe(400);
		expect(moved.body).not.toContain('/__realtime/other');
		const control = await get(server.port, '/__realtime/introspect', '127.0.0.1');
		expect(control.status).toBe(200);
		expect(JSON.parse(control.body).path).toBe('/__realtime/introspect');
	});

	it('refuses the same Host on the authentication endpoint', async () => {
		/** @param {string} host */
		const post = (host) => exchange(server.port,
			`POST /__ws/auth HTTP/1.1\r\nHost: ${host}\r\nX-Requested-With: XMLHttpRequest\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
		expect((await post('a/other?')).status).toBe(400);
		const control = await post('127.0.0.1');
		expect(control.status, 'the hook runs for a plain Host').toBeGreaterThanOrEqual(200);
		expect(control.status).toBeLessThan(300);
	});
});
