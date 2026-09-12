// Two framing rules on the HTTP/1.1 plane, driven over raw sockets against the
// real built runtime (and, in the last block, against createTestServer's admin
// mirror), because both defects are invisible to an HTTP client:
//
// - A HEAD response carries no payload (RFC 9112 6.3). uWS writes whatever
//   `end()` is handed, so a generated error answered with `end(text)`, and a
//   page or endpoint body SvelteKit renders for HEAD exactly as for GET, put
//   bytes on the wire after the header block. A client stops reading a HEAD
//   response at the header terminator, so those bytes sat in the connection
//   buffer and were parsed as the start of the NEXT response on the same
//   keep-alive connection. `curl -I` closes the connection and never sees it.
//
// - A 204 carries no Content-Length (RFC 9110 8.6, a MUST NOT), and a 304 may
//   carry one only when it names the 200's content length. Bodyless responses
//   ended with a zero length, or with `end()`, which writes one.
//
// The oracle for the HEAD cases is pipelining: a second request is written on
// the same connection right behind the probe, and its status line has to begin
// EXACTLY at the probe's header terminator. Any payload byte between the two is
// the desync. The stream is read through EOF (the last request says
// `Connection: close`), so nothing the server writes late can hide. The
// endpoint case sends its HEAD alone instead and asserts that EOF follows the
// terminator directly, which catches the same bytes.
//
// The 204 and 304 cases pipeline too: a client that sees neither Content-Length
// nor Transfer-Encoding must still be handed the next response, which is what
// proves the runtime finished the exchange rather than leaving it open.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { connect } from 'node:net';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * Write every request on one connection, back to back, and return the whole
 * byte stream the server answers with, read through EOF.
 *
 * @param {number} port
 * @param {string[][]} requests each request as its lines (request line first);
 *   `Host` and, on the last one, `Connection: close` are added here
 * @returns {Promise<string>} latin1, so byte positions are string positions
 */
function pipeline(port, requests) {
	const wire = requests.map((lines, i) => {
		const out = [lines[0], `Host: 127.0.0.1:${port}`, ...lines.slice(1)];
		if (i === requests.length - 1) out.push('Connection: close');
		return out.join('\r\n') + '\r\n\r\n';
	}).join('');
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => { socket.write(wire); });
		let buffer = '';
		socket.on('data', (chunk) => { buffer += chunk.toString('latin1'); });
		socket.on('end', () => { clearTimeout(timer); resolve(buffer); });
		socket.on('error', reject);
		const timer = setTimeout(() => { socket.destroy(); resolve(buffer); }, 5000);
		timer.unref?.();
	});
}

/** The first response's header block and everything after its terminator. */
function splitFirst(raw) {
	const at = raw.indexOf('\r\n\r\n');
	expect(at, 'a complete header block; got: ' + JSON.stringify(raw.slice(0, 200))).toBeGreaterThan(0);
	return { head: raw.slice(0, at), rest: raw.slice(at + 4) };
}

const statusLine = (head) => head.split('\r\n')[0];
const header = (head, name) => head
	.split('\r\n')
	.slice(1)
	.filter((line) => line.toLowerCase().startsWith(name.toLowerCase() + ':'))
	.map((line) => line.slice(name.length + 1).trim());

/** Read one full response with a body framed by Content-Length. */
function bodyOf(raw) {
	const { head, rest } = splitFirst(raw);
	const cl = Number(header(head, 'content-length')[0]);
	return { head, body: rest.slice(0, cl), rest: rest.slice(cl) };
}

const HEALTHZ = ['GET /healthz HTTP/1.1'];
const FOLLOWER = 'the next response begins at the header terminator; got: ';

/**
 * The HEAD probe and its pipelined follower: the follower's status line starts
 * at the probe's header terminator. `contentLength` is the entity size the
 * probe must name, or null when the GET declared none and the HEAD therefore
 * carries no framing header at all.
 */
function expectHeadFraming(raw, { status, contentLength }) {
	const { head, rest } = splitFirst(raw);
	expect(statusLine(head)).toContain(status);
	expect(header(head, 'content-length')).toEqual(contentLength === null ? [] : [String(contentLength)]);
	expect(header(head, 'transfer-encoding')).toEqual([]);
	expect(rest.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(rest.slice(0, 40))).toBe(true);
	return head;
}

/** A bodyless status with neither framing header, and the exchange completes. */
function expectUnframed(raw, status) {
	const { head, rest } = splitFirst(raw);
	expect(statusLine(head)).toContain(status);
	expect(header(head, 'content-length')).toEqual([]);
	expect(header(head, 'transfer-encoding')).toEqual([]);
	expect(rest.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(rest.slice(0, 40))).toBe(true);
	return head;
}

describeUWS('HEAD, 204 and 304 framing on the real built runtime', () => {
	let server;
	let port;

	beforeAll(async () => {
		server = await startRealRuntime();
		port = Number(new URL(server.httpUrl).port);
	}, 400000);

	afterAll(async () => { await server?.stop(); });

	describe('a HEAD request takes the headers without the payload', () => {
		it('on the authenticate path 405', async () => {
			// The GET is the control: it still carries the text.
			const get = bodyOf(await pipeline(port, [['GET /__ws/auth HTTP/1.1'], HEALTHZ]));
			expect(statusLine(get.head)).toContain('405');
			expect(get.body).toBe('Method Not Allowed');
			expect(get.rest.startsWith('HTTP/1.1 200')).toBe(true);

			const head = expectHeadFraming(
				await pipeline(port, [['HEAD /__ws/auth HTTP/1.1'], HEALTHZ]),
				{ status: '405', contentLength: 'Method Not Allowed'.length }
			);
			expect(header(head, 'allow')).toEqual(['POST']);
		}, 30000);

		it('on the request edge 400 for an ambiguous header', async () => {
			// Two Authorization lines are refused before the request is built;
			// the same refusal on a GET carries 'Bad Request'.
			const get = bodyOf(await pipeline(port, [
				['GET / HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two'],
				HEALTHZ
			]));
			expect(statusLine(get.head)).toContain('400');
			expect(get.body).toBe('Bad Request');

			expectHeadFraming(
				await pipeline(port, [
					['HEAD / HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two'],
					HEALTHZ
				]),
				{ status: '400', contentLength: 'Bad Request'.length }
			);
		}, 30000);

		it('on a rendered page', async () => {
			// SvelteKit renders the page for HEAD exactly as for GET and declares
			// the page's length on the Response; the GET's body is real, the
			// HEAD names the same size and never writes it.
			const get = bodyOf(await pipeline(port, [['GET / HTTP/1.1'], HEALTHZ]));
			expect(statusLine(get.head)).toContain('200');
			expect(get.body).toContain('<html');

			const head = expectHeadFraming(
				await pipeline(port, [['HEAD / HTTP/1.1'], HEALTHZ]),
				{ status: '200', contentLength: Buffer.byteLength(get.body, 'latin1') }
			);
			expect(header(head, 'content-type')[0]).toContain('text/html');
		}, 30000);

		it('on an endpoint answered through its GET handler', async () => {
			// SvelteKit routes HEAD to the GET handler and hands its Response
			// back unchanged, body and all. This endpoint declares no length, so
			// the HEAD carries no framing header. Each request goes alone and is
			// read through EOF: the oracle here is that nothing at all follows
			// the HEAD's header terminator.
			const get = bodyOf(await pipeline(port, [['GET /__leak HTTP/1.1']]));
			expect(statusLine(get.head)).toContain('404');
			expect(get.body).toBe('Not Found');

			const { head, rest } = splitFirst(await pipeline(port, [['HEAD /__leak HTTP/1.1']]));
			expect(statusLine(head)).toContain('404');
			expect(header(head, 'content-length')).toEqual([]);
			expect(header(head, 'transfer-encoding')).toEqual([]);
			expect(rest, 'bytes after the header terminator').toBe('');
		}, 30000);

		it('on an endpoint that answers HEAD itself', async () => {
			// A null-body Response from the app's own HEAD handler: the length it
			// declares is the GET's and is reported; without one nothing is,
			// since only the app could know the GET's size.
			// Lone requests through EOF, as for the endpoint above.
			const get = bodyOf(await pipeline(port, [['GET /head-declared HTTP/1.1']]));
			expect(get.body).toBe('twelve bytes');

			const declared = splitFirst(await pipeline(port, [['HEAD /head-declared HTTP/1.1']]));
			expect(statusLine(declared.head)).toContain('200');
			expect(header(declared.head, 'content-length')).toEqual([String('twelve bytes'.length)]);
			expect(declared.rest, 'bytes after the header terminator').toBe('');

			const undeclared = splitFirst(await pipeline(port, [['HEAD /head-declared?declare=0 HTTP/1.1']]));
			expect(statusLine(undeclared.head)).toContain('200');
			expect(header(undeclared.head, 'content-length')).toEqual([]);
			expect(header(undeclared.head, 'transfer-encoding')).toEqual([]);
			expect(undeclared.rest, 'bytes after the header terminator').toBe('');
		}, 30000);
	});

	describe('a 204 carries neither Content-Length nor Transfer-Encoding', () => {
		it('on the implicit authenticate success, Set-Cookie and all', async () => {
			const head = expectUnframed(await pipeline(port, [
				['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest',
					'x-set-cookie-probe: 1', 'Content-Length: 0'],
				HEALTHZ
			]), '204');
			expect(header(head, 'set-cookie')).toHaveLength(1);
		}, 30000);

		it('on a 204 Response the authenticate hook returns itself', async () => {
			expectUnframed(await pipeline(port, [
				['POST /__ws/auth HTTP/1.1', 'x-requested-with: XMLHttpRequest',
					'x-auth-response: 204', 'Content-Length: 0'],
				HEALTHZ
			]), '204');
		}, 30000);

		it('on a 204 the application returns through the SSR writer', async () => {
			// SvelteKit answers OPTIONS on a page route with 204.
			expectUnframed(await pipeline(port, [['OPTIONS / HTTP/1.1'], HEALTHZ]), '204');
		}, 30000);
	});

	describe('a 304 for a rendered representation declares no length', () => {
		it('from the page ETag', async () => {
			const get = bodyOf(await pipeline(port, [['GET / HTTP/1.1'], HEALTHZ]));
			const [etag] = header(get.head, 'etag');
			expect(etag, 'the page carries an ETag').toBeTruthy();

			expectUnframed(await pipeline(port, [
				['GET / HTTP/1.1', 'If-None-Match: ' + etag],
				HEALTHZ
			]), '304');
		}, 30000);

		it('from the static lane', async () => {
			const get = bodyOf(await pipeline(port, [['GET /test.txt HTTP/1.1'], HEALTHZ]));
			expect(statusLine(get.head)).toContain('200');
			const [etag] = header(get.head, 'etag');
			expect(etag, 'a mutable asset carries an ETag').toBeTruthy();

			expectUnframed(await pipeline(port, [
				['GET /test.txt HTTP/1.1', 'If-None-Match: ' + etag],
				HEALTHZ
			]), '304');
		}, 30000);
	});
});

describeUWS('the admin lane, on a build that mounts a handler', () => {
	let server;
	let port;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
		port = Number(new URL(server.httpUrl).port);
	}, 400000);

	afterAll(async () => { await server?.stop(); });

	it('answers HEAD with the handler headers and the body length, and no bytes', async () => {
		const get = bodyOf(await pipeline(port, [['GET /__realtime/introspect HTTP/1.1'], HEALTHZ]));
		expect(statusLine(get.head)).toContain('200');
		expect(JSON.parse(get.body)).toEqual({ ok: true, path: '/__realtime/introspect' });

		const head = expectHeadFraming(
			await pipeline(port, [['HEAD /__realtime/introspect HTTP/1.1'], HEALTHZ]),
			{ status: '200', contentLength: Buffer.byteLength(get.body) }
		);
		expect(header(head, 'content-type')).toEqual(['application/json']);
	}, 30000);

	it('answers HEAD on its own generated 400 without the JSON payload', async () => {
		const get = bodyOf(await pipeline(port, [
			['GET /__realtime/introspect HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two'],
			HEALTHZ
		]));
		expect(statusLine(get.head)).toContain('400');
		expect(get.body).toBe('{"error":"bad request"}');

		expectHeadFraming(
			await pipeline(port, [
				['HEAD /__realtime/introspect HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two'],
				HEALTHZ
			]),
			{ status: '400', contentLength: get.body.length }
		);
	}, 30000);

	it('writes a 204 from the handler without Content-Length', async () => {
		expectUnframed(await pipeline(port, [['GET /__realtime/empty HTTP/1.1'], HEALTHZ]), '204');
	}, 30000);

	it('honours a declared length on a bodyless answer only for HEAD', async () => {
		// The handler declares 12 bytes and sends none. A GET must not carry
		// that length - the client would wait for bytes that never come - while
		// a HEAD names it, since that is how a handler states the GET's size.
		const get = splitFirst(await pipeline(port, [['GET /__realtime/declared HTTP/1.1'], HEALTHZ]));
		expect(statusLine(get.head)).toContain('200');
		expect(header(get.head, 'content-length')).toEqual(['0']);
		expect(get.rest.startsWith('HTTP/1.1 200'), FOLLOWER + JSON.stringify(get.rest.slice(0, 40))).toBe(true);

		expectHeadFraming(
			await pipeline(port, [['HEAD /__realtime/declared HTTP/1.1'], HEALTHZ]),
			{ status: '200', contentLength: 12 }
		);
	}, 30000);
});

describeUWS('createTestServer mirrors the admin lane', () => {
	let server;
	let port;

	afterAll(async () => { await server?.close(); });

	it('HEAD takes no payload and a 204 takes no Content-Length', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({
			handler: {
				admin: async (request) => {
					const path = new URL(request.url).pathname;
					if (path.endsWith('/empty')) return new Response(null, { status: 204 });
					if (path.endsWith('/declared')) {
						return new Response(null, { status: 200, headers: { 'content-length': '12' } });
					}
					return new Response(JSON.stringify({ ok: true, path }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}
			}
		});
		port = Number(new URL(server.url).port);

		const get = bodyOf(await pipeline(port, [['GET /__realtime/introspect HTTP/1.1'], HEALTHZ]));
		expect(statusLine(get.head)).toContain('200');
		expectHeadFraming(
			await pipeline(port, [['HEAD /__realtime/introspect HTTP/1.1'], HEALTHZ]),
			{ status: '200', contentLength: Buffer.byteLength(get.body) }
		);
		expectHeadFraming(
			await pipeline(port, [
				['HEAD /__realtime/introspect HTTP/1.1', 'Authorization: Bearer one', 'Authorization: Bearer two'],
				HEALTHZ
			]),
			{ status: '400', contentLength: '{"error":"bad request"}'.length }
		);
		expectUnframed(await pipeline(port, [['GET /__realtime/empty HTTP/1.1'], HEALTHZ]), '204');
		const declared = splitFirst(await pipeline(port, [['GET /__realtime/declared HTTP/1.1'], HEALTHZ]));
		expect(header(declared.head, 'content-length')).toEqual(['0']);
		expect(declared.rest.startsWith('HTTP/1.1 200')).toBe(true);
		expectHeadFraming(
			await pipeline(port, [['HEAD /__realtime/declared HTTP/1.1'], HEALTHZ]),
			{ status: '200', contentLength: 12 }
		);
	}, 30000);
});
