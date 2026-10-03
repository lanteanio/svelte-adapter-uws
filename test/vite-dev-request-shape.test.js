// What the dev plugin's HTTP middlewares read off a request, held to what
// production reads. Vite's connect matches a mount without regard to case and
// with anything after a `/` or `.`, and strips it from `req.url`; with
// `server.https` set, Vite serves HTTP/2, whose compatibility request carries
// the pseudo-headers and `:authority` in place of `host`, over TLS that Vite
// terminates. Production routes the exact path and reads the target as the
// client sent it.
//
// Both surfaces run the fixture's own authenticate hook, whose echo lane
// answers with the event it was handed, and each is held to the same literal
// expectations, so the production arm is what shows those are production's.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as http2Connect, constants as http2Constants, Http2ServerResponse } from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { bootViteDev, APP_STATUS } from './helpers/vite-dev.js';
import { findOpenssl, loopbackCertificate } from './helpers/openssl.js';
import { authenticate } from './fixture/src/hooks.ws.js';

/** Targets production routes to the hook, and the `url` the hook is handed. */
const ROUTED = [
	['/__ws/auth', '/__ws/auth'],
	['/__ws/auth?a=1&b=%20', '/__ws/auth?a=1&b=%20'],
	['/__ws/auth?a', '/__ws/auth?a'],
	// The path ends at the first `?`.
	['/__ws/auth?next=/a?b', '/__ws/auth?next=/a?b'],
	// uWS reports an empty query as none.
	['/__ws/auth?', '/__ws/auth']
];

/** Spellings Vite's connect mounts onto the path and production does not route. */
const NOT_ROUTED = ['/__ws/auth/', '/__ws/auth/x', '/__WS/AUTH', '/__ws/Auth', '/__ws/auth.json', '/__ws/auth.'];

/**
 * The fixture's declared-length lanes: the status each answers, and the length
 * on the wire, which is the body's own unless a 304 declares one.
 */
const DECLARED_LENGTHS = [
	['declared-body', 200, '5'],
	['declared-empty', 200, '0'],
	['declared-204', 204, undefined],
	['304', 304, '42'],
	['304-loose', 304, '42']
];

/**
 * The start of the cookie the fixture's non-ASCII lane sets, and on its
 * Response the header value and the Set-Cookie.
 */
const NON_ASCII_COOKIE = '\u2603=v; Path=/\u2641';
const NON_ASCII_TEXT = '\u00e9';
const NON_ASCII_RESPONSE_COOKIE = 'a=\u00e9';

/**
 * The fixture's non-ASCII lane, checked on an answer's headers.
 *
 * @param {string} lane
 * @param {Record<string, any>} headers
 */
function expectNonAscii(lane, headers) {
	const cookies = [].concat(headers['set-cookie'] ?? []);
	const cookie = cookies.find((c) => c.startsWith(asWire(NON_ASCII_COOKIE.slice(0, 2))));
	expect(cookie?.slice(0, asWire(NON_ASCII_COOKIE).length), lane).toBe(asWire(NON_ASCII_COOKIE));
	if (lane !== 'response') return;
	expect(headers['x-text']).toBe(asWire(NON_ASCII_TEXT));
	expect(cookies).toContain(asWire(NON_ASCII_RESPONSE_COOKIE));
}

/**
 * Text as a client reads its UTF-8 bytes off the wire: node's clients decode
 * header bytes one character each.
 *
 * @param {string} text
 */
const asWire = (text) => Buffer.from(text, 'utf8').toString('latin1');

/** The Date the fixture's broken-body Response carries, and this file's lanes. */
const HOOK_DATE = 'Mon, 01 Jan 2001 00:00:00 GMT';

/** A Response reporting a status its constructor would refuse. */
class StatusResponse extends Response {
	/**
	 * @param {number} status
	 * @param {BodyInit | null} body
	 * @param {ResponseInit} init
	 */
	constructor(status, body, init) {
		super(body, init);
		this.reported = status;
	}

	get status() {
		return this.reported;
	}
}

/** The headers HTTP/2 does not carry, as a hook Response may hold them. */
const CONNECTION_HEADERS = {
	// node's http2 layer throws only on this value; it drops any other.
	connection: 'trailers',
	// Not node's own default, so a value it wrote itself does not pass.
	'keep-alive': 'timeout=7',
	'proxy-connection': 'keep-alive',
	'transfer-encoding': 'chunked',
	upgrade: 'h2c',
	'http2-settings': 'AAMAAABkAAQAAP__',
	te: 'gzip'
};

/** The ones that do not frame the body; `transfer-encoding` does, so it is left out. */
const NONFRAMING_CONNECTION_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'upgrade', 'http2-settings', 'te'];

/**
 * The fixture's hook, with lanes of this file's own: a Response carrying the
 * HTTP/1.1 connection headers an app may pass on from an upstream fetch;
 * answers that carry something node's HTTP/1.1 writer refuses, before
 * writing (a header value, a Set-Cookie value, the status of
 * `Response.error()`, a cookie on the implicit 204) or as it writes (a
 * `trailer` on a 204); a Response reporting a given status; and 304s
 * declaring a given length.
 */
const withOwnLanes = {
	/** @param {any} event */
	authenticate(event) {
		if (event.headers['x-connection-headers'] === '1') {
			return new Response('kept', { headers: { ...CONNECTION_HEADERS, 'x-kept': '1' } });
		}
		switch (event.headers['x-refused']) {
			// The Responses with headers carry the hook's own Date too: a 500
			// that has node's Date shows the refusal came before anything was
			// set.
			case 'value':
				return new Response('written', { headers: { 'a-first': '1', date: HOOK_DATE, 'x-refused': 'a\u0001b' } });
			case 'set-cookie':
				return new Response('written', { headers: { 'a-first': '1', date: HOOK_DATE, 'set-cookie': 'sid=a\u0001b' } });
			case 'status':
				event.cookies.set('hook_session', 'secret', { path: '/' });
				return Response.error();
			// The implicit 204, with a cookie whose Expires is not a Date's.
			case 'implicit-expires':
				event.cookies.set('hook_session', 'secret', { path: '/', expires: { toUTCString: () => 'x\u0001y' } });
				return undefined;
			// Refused only as the response is written: node chunks no 204.
			case 'trailer':
				event.cookies.set('hook_session', 'secret', { path: '/' });
				return new Response(null, { status: 204, headers: { 'a-first': '1', trailer: 'x-sum' } });
		}
		if (event.headers['x-status'] !== undefined) {
			return new StatusResponse(Number(event.headers['x-status']), 'written', { headers: { 'a-first': '1', date: HOOK_DATE } });
		}
		if (event.headers['x-304-length'] !== undefined) {
			return new Response(null, { status: 304, headers: { 'content-length': event.headers['x-304-length'] } });
		}
		return authenticate(event);
	}
};

/**
 * A POST, or another method, over HTTP/1.1.
 *
 * @param {number} port
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string> }} [options]
 */
function send(port, path, { method = 'POST', headers = { 'x-requested-with': 'XMLHttpRequest', 'x-auth-echo': '1' } } = {}) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path,
			method,
			headers: { ...headers, 'content-length': '0' }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => resolve({
				status: res.statusCode,
				headers: res.headers,
				echoed: res.headers['x-auth-echo'] === '1',
				body
			}));
		});
		req.once('error', reject);
		req.end();
	});
}

/**
 * An auth POST over HTTP/1.1 declaring a body of `size` bytes and sending
 * `sent` of them; it ends the body only when it sends all of it.
 *
 * @param {number} port
 * @param {number} size
 * @param {number} [sent]
 * @param {Record<string, string>} [headers]
 */
function postBody(port, size, sent = size, headers = { 'x-requested-with': 'XMLHttpRequest' }) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { ...headers, 'content-length': String(size) }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => {
				if (sent < size) req.destroy();
				resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body });
			});
		});
		req.once('error', (err) => { if (sent === size) reject(err); });
		if (sent === size) req.end('x'.repeat(size));
		else req.write('x'.repeat(sent));
	});
}

/**
 * An auth POST over HTTP/1.1 whose body of `size` bytes goes out chunked, with
 * no declared length, asking the fixture's hook to read it.
 *
 * @param {number} port
 * @param {number} size
 */
function postChunked(port, size) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-read-body': '1' }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body }));
		});
		req.once('error', reject);
		for (let sent = 0; sent < size; sent += 16 * 1024) req.write('x'.repeat(Math.min(16 * 1024, size - sent)));
		req.end();
	});
}

/**
 * One HTTP/2 exchange on a fresh session, over TLS when given the certificate
 * to trust.
 *
 * @param {number} port
 * @param {Record<string, string>} headers
 * @param {string} [ca]
 * @param {string} [body]
 */
function h2Exchange(port, headers, ca, body) {
	return new Promise((resolve, reject) => {
		const session = ca === undefined
			? http2Connect(`http://127.0.0.1:${port}`)
			: http2Connect(`https://127.0.0.1:${port}`, { ca });
		/** @param {Error} err */
		const fail = (err) => { session.destroy(); reject(err); };
		session.once('error', fail);
		const stream = session.request(headers);
		/** @type {Record<string, any>} */
		let responseHeaders = {};
		let received = '';
		stream.setEncoding('utf8');
		stream.once('response', (h) => { responseHeaders = h; });
		stream.on('data', (chunk) => { received += chunk; });
		stream.once('error', fail);
		// On close rather than on the response's end: a stream the server
		// never completes leaves the case waiting.
		stream.once('close', () => {
			session.close();
			resolve({ status: responseHeaders[':status'], headers: responseHeaders, body: received });
		});
		stream.end(body);
	});
}

/**
 * The status a WebSocket handshake gets: 101 when it opens.
 *
 * @param {string} url
 * @param {string} origin
 * @param {string} [ca]
 */
function openWebSocket(url, origin, ca) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, ca === undefined ? { origin } : { origin, ca });
		ws.once('open', () => { ws.terminate(); resolve(101); });
		ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
		ws.once('error', reject);
	});
}

/**
 * Boot the plugin with ORIGIN unset, so the same-origin rule reads the request.
 *
 * @param {Parameters<typeof bootViteDev>[0]} options
 */
async function bootWithoutOrigin(options) {
	const saved = process.env.ORIGIN;
	delete process.env.ORIGIN;
	try {
		return await bootViteDev(options);
	} finally {
		if (saved !== undefined) process.env.ORIGIN = saved;
	}
}

const SURFACES = [
	...(hasUWS ? [{
		label: 'production',
		boot: async () => {
			const server = await startRealRuntime({ variant: 'default' });
			return { port: server.port, close: () => server.stop() };
		}
	}] : []),
	{
		label: 'vite dev',
		boot: () => bootWithoutOrigin({ handler: { authenticate } })
	}
];

for (const surface of SURFACES) {
	describe(`the auth endpoint's target on ${surface.label}`, () => {
		/** @type {{ port: number, close: () => Promise<void> }} */
		let server;
		beforeAll(async () => { server = await surface.boot(); }, 120_000);
		afterAll(async () => { await server?.close(); });

		it('hands the hook the target as the client sent it', async () => {
			for (const [target, url] of ROUTED) {
				const res = await send(server.port, target);
				expect(res.status, target).toBe(200);
				expect(res.echoed, target).toBe(true);
				const event = JSON.parse(res.body);
				expect(event.url, target).toBe(url);
				expect(event.requestUrl, target).toBe(`http://127.0.0.1:${server.port}${url}`);
			}
		});

		it('routes the exact path only', async () => {
			for (const target of NOT_ROUTED) {
				const res = await send(server.port, target);
				expect(res.echoed, target).toBe(false);
				// The request went on to the application.
				if (surface.label === 'vite dev') expect(res.status, target).toBe(APP_STATUS);
			}
			expect((await send(server.port, '/__ws/auth', { method: 'GET' })).status).toBe(405);
			const otherGet = await send(server.port, '/__WS/AUTH', { method: 'GET' });
			expect(otherGet.status).not.toBe(405);
			if (surface.label === 'vite dev') expect(otherGet.status).toBe(APP_STATUS);
		});

		it('answers a declared body past 64 KiB with 413, and takes one of 64 KiB', async () => {
			const over = await postBody(server.port, 64 * 1024 + 1);
			expect(over.status).toBe(413);
			expect(over.statusMessage).toBe('Content Too Large');
			expect(over.headers['content-type']).toBe('text/plain');
			expect(over.body).toBe('Content Too Large');
			expect((await postBody(server.port, 64 * 1024)).status).toBe(204);
		});

		it('answers a body past 64 KiB sent without a declared length with 413', async () => {
			const res = await postChunked(server.port, 70 * 1024);
			expect(res.status).toBe(413);
			expect(res.body).toBe('Content Too Large');
			const within = await postChunked(server.port, 1024);
			expect(within.status).toBe(204);
			// The hook reads the body it was sent.
			expect(within.headers['x-body-length']).toBe('1024');
		});

		it('answers a declared length past 64 KiB before the body arrives, after the Host check', async () => {
			const res = await postBody(server.port, 64 * 1024 + 1, 10);
			expect(res.status).toBe(413);
			// A Host that is not an authority is refused first, as production
			// refuses it before it looks at the length.
			const badHost = await postBody(server.port, 1024 * 1024, 10, { 'x-requested-with': 'XMLHttpRequest', host: 'a/other?' });
			expect(badHost.status).toBe(400);
		});

		it('answers a hook Response whose body fails with a 500 that carries none of its headers', async () => {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-broken-body': '1' }
			});
			expect(res.status).toBe(500);
			expect(res.headers['set-cookie']).toBeUndefined();
			expect(res.headers['x-from-hook']).toBeUndefined();
			expect(res.headers.date).toBeDefined();
			expect(res.headers.date).not.toBe(HOOK_DATE);
		});

		it('writes cookies and header values past ASCII as their UTF-8 bytes', async () => {
			for (const [lane, status] of [['response', 200], ['implicit', 204]]) {
				const res = await send(server.port, '/__ws/auth', {
					headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-non-ascii': lane }
				});
				expect(res.status, lane).toBe(status);
				expectNonAscii(lane, res.headers);
			}
		});

		it('writes the body\'s own length, and the one a hook 304 declares', async () => {
			for (const [lane, status, length] of DECLARED_LENGTHS) {
				const res = await send(server.port, '/__ws/auth', {
					headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-response': lane }
				});
				expect(res.status, lane).toBe(status);
				expect(res.headers['content-length'], lane).toBe(length);
			}
		});
	});
}

describe('the dev plugin over plain HTTP/1.1', () => {
	/** @type {{ port: number, close: () => Promise<void> }} */
	let server;
	beforeAll(async () => { server = await bootWithoutOrigin({ handler: withOwnLanes }); }, 120_000);
	afterAll(async () => { await server?.close(); });

	it('checks a same-origin Origin against http on the WebSocket and the auth POST', async () => {
		const authority = `127.0.0.1:${server.port}`;
		expect(await openWebSocket(`ws://${authority}/ws`, `http://${authority}`)).toBe(101);
		expect(await openWebSocket(`ws://${authority}/ws`, `https://${authority}`)).toBe(403);
		/** @param {string} origin */
		const post = (origin) => send(server.port, '/__ws/auth', { headers: { origin, 'x-auth-echo': '1' } });
		expect((await post(`http://${authority}`)).status).toBe(200);
		expect((await post(`https://${authority}`)).status).toBe(403);
	});

	it('answers what node cannot write with a 500 that carries nothing of the hook\'s', async () => {
		for (const lane of ['value', 'set-cookie', 'status', 'implicit-expires']) {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-refused': lane }
			});
			expect(res.status, lane).toBe(500);
			expect(res.headers['a-first'], lane).toBeUndefined();
			expect(res.headers['set-cookie'], lane).toBeUndefined();
			expect(res.headers.date, lane).toBeDefined();
			expect(res.headers.date, lane).not.toBe(HOOK_DATE);
		}
	});

	it('answers a status that is no final status node can write with that 500, and writes 999', async () => {
		for (const status of ['199', '1000', '200.5']) {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-status': status }
			});
			expect(res.status, status).toBe(500);
			expect(res.headers['a-first'], status).toBeUndefined();
			expect(res.headers.date, status).not.toBe(HOOK_DATE);
		}
		const highest = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-status': '999' }
		});
		expect(highest.status).toBe(999);
		expect(highest.body).toBe('written');
	});

	it('closes the connection on what node refuses only as it writes, and keeps serving', async () => {
		await expect(send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-refused': 'trailer' }
		})).rejects.toThrow(/socket hang up|ECONNRESET/);
		expect((await send(server.port, '/__ws/auth')).status).toBe(200);
	});

	it('writes no length for a 304 whose declared one does not read as a length', async () => {
		for (const [declared, length] of [['0', '0'], ['0x10', '0'], ['-1', undefined], ['99999999999999999999', undefined], ['abc', undefined]]) {
			const res = await send(server.port, '/__ws/auth', {
				headers: { 'x-requested-with': 'XMLHttpRequest', 'x-304-length': declared }
			});
			expect(res.status, declared).toBe(304);
			expect(res.headers['content-length'], declared).toBe(length);
		}
	});

	it('refuses a cross-origin POST before it looks at the declared length', async () => {
		const res = await postBody(server.port, 1024 * 1024, 10, { origin: 'http://elsewhere.example' });
		expect(res.status).toBe(403);
	});

	it('keeps on the 500 the headers middleware ahead of the plugin set', async () => {
		// Vite's CORS middleware admits a localhost origin before the plugin runs.
		const res = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-auth-broken-body': '1', origin: 'http://localhost:5173' }
		});
		expect(res.status).toBe(500);
		expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
	});

	it('keeps a hook Response\'s connection headers over HTTP/1.1', async () => {
		const res = await send(server.port, '/__ws/auth', {
			headers: { 'x-requested-with': 'XMLHttpRequest', 'x-connection-headers': '1' }
		});
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		expect(res.headers['x-kept']).toBe('1');
		for (const name of NONFRAMING_CONNECTION_HEADERS) {
			expect(res.headers[name], name).toBe(CONNECTION_HEADERS[name]);
		}
	});
});

describe('the dev plugin over HTTP/2', () => {
	/** @type {{ port: number, h2Port: number, close: () => Promise<void> }} */
	let server;
	// Every reason phrase an HTTP/2 response is given, through the setter or
	// writeHead, across the whole block: HTTP/2 has no room for one.
	/** @type {string[]} */
	const statusMessages = [];
	const statusMessage = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Http2ServerResponse.prototype, 'statusMessage'));
	const writeHead = Http2ServerResponse.prototype.writeHead;
	beforeAll(async () => {
		Object.defineProperty(Http2ServerResponse.prototype, 'statusMessage', {
			...statusMessage,
			/** @param {string} value */
			set(value) {
				statusMessages.push(value);
				statusMessage.set?.call(this, value);
			}
		});
		/** @this {Http2ServerResponse} @param {any[]} args */
		Http2ServerResponse.prototype.writeHead = function (...args) {
			if (typeof args[1] === 'string') statusMessages.push(args[1]);
			return writeHead.apply(this, /** @type {any} */ (args));
		};
		server = /** @type {any} */ (await bootWithoutOrigin({ handler: withOwnLanes, h2: true }));
	}, 120_000);
	afterAll(async () => {
		Object.defineProperty(Http2ServerResponse.prototype, 'statusMessage', statusMessage);
		Http2ServerResponse.prototype.writeHead = writeHead;
		await server?.close();
		expect(statusMessages).toEqual([]);
	});

	it('runs the auth hook with no pseudo-headers and the authority as the host', async () => {
		const authority = `127.0.0.1:${server.h2Port}`;
		// A same-origin Origin, checked against the host the authority supplies.
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth?a=1',
			':authority': authority,
			origin: `http://${authority}`,
			'x-auth-echo': '1'
		});
		expect(res.status).toBe(200);
		expect(res.headers['x-auth-echo']).toBe('1');
		const event = JSON.parse(res.body);
		expect(event.url).toBe('/__ws/auth?a=1');
		expect(event.requestUrl).toBe(`http://${authority}/__ws/auth?a=1`);
		expect(event.headerNames.filter((name) => name.startsWith(':'))).toEqual([]);
		expect(event.headerNames).toContain('host');
	});

	it('takes the authority over a host header that disagrees with it', async () => {
		const authority = `127.0.0.1:${server.h2Port}`;
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': authority,
			host: 'other.example',
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-echo': '1'
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).requestUrl).toBe(`http://${authority}/__ws/auth`);
	});

	it('writes a hook Response without the headers HTTP/2 does not carry', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-connection-headers': '1'
		});
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		expect(res.headers['x-kept']).toBe('1');
		for (const name of Object.keys(CONNECTION_HEADERS)) {
			expect(res.headers[name], name).toBeUndefined();
		}
	});

	it('answers a status that is no final status HTTP/2 can carry with a 500 that carries nothing of the hook\'s', async () => {
		// 700 is refused by node's HTTP/2 writer, 200.5 by the lane.
		for (const status of ['700', '200.5']) {
			const res = await h2Exchange(server.h2Port, {
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-status': status
			});
			expect(res.status, status).toBe(500);
			expect(res.headers['a-first'], status).toBeUndefined();
			expect(res.headers.date, status).not.toBe(HOOK_DATE);
		}
	});

	it('writes cookies and header values past ASCII as their UTF-8 bytes', async () => {
		for (const [lane, status] of [['response', 200], ['implicit', 204]]) {
			const res = await h2Exchange(server.h2Port, {
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-auth-non-ascii': lane
			});
			expect(res.status, lane).toBe(status);
			expectNonAscii(lane, res.headers);
		}
	});

	it('keeps the hook\'s answer when a header value or cookie is one HTTP/1.1 refuses', async () => {
		for (const [lane, status] of [['value', 200], ['set-cookie', 200], ['implicit-expires', 204]]) {
			const res = await h2Exchange(server.h2Port, {
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'x-refused': lane
			});
			expect(res.status, lane).toBe(status);
			if (status === 200) {
				expect(res.body, lane).toBe('written');
				expect(res.headers['a-first'], lane).toBe('1');
			}
		}
	});

	it('answers 413 as the body crosses 64 KiB, before the client has sent it all', async () => {
		const status = await new Promise((resolve, reject) => {
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.once('error', reject);
			const stream = session.request({
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest'
			});
			stream.once('error', () => {});
			stream.once('response', (headers) => {
				resolve(headers[':status']);
				session.destroy();
			});
			// More than the cap, and the stream left open.
			stream.write('x'.repeat(70 * 1024));
		});
		expect(status).toBe(413);
	});

	it('reads the authority from host when a request carries no :authority', async () => {
		const page = await h2Exchange(server.h2Port, { ':method': 'GET', ':path': '/__uws/dashboard', host: `localhost:${server.h2Port}` });
		expect(page.status).toBe(200);
		const auth = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			host: `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-echo': '1'
		});
		expect(auth.status).toBe(200);
		expect(JSON.parse(auth.body).requestUrl).toBe(`http://127.0.0.1:${server.h2Port}/__ws/auth`);
	});

	it('answers a body past 64 KiB with 413', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest'
		}, undefined, 'x'.repeat(4 * 1024 * 1024));
		expect(res.status).toBe(413);
	});

	it('answers a declared length past 64 KiB before the body arrives', async () => {
		const status = await new Promise((resolve, reject) => {
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.once('error', reject);
			const stream = session.request({
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest',
				'content-length': String(64 * 1024 + 1)
			});
			stream.once('error', () => {});
			stream.once('response', (headers) => {
				resolve(headers[':status']);
				session.destroy();
			});
			stream.write('x'.repeat(10));
		});
		expect(status).toBe(413);
	});

	it('answers a hook Response whose body fails with a 500 that carries none of its headers', async () => {
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-auth-broken-body': '1'
		});
		expect(res.status).toBe(500);
		expect(res.headers['set-cookie']).toBeUndefined();
		expect(res.headers['x-from-hook']).toBeUndefined();
		expect(res.headers.date).not.toBe(HOOK_DATE);
	});

	it('serves the dashboard to a loopback authority and refuses any other', async () => {
		const page = await h2Exchange(server.h2Port, {
			':method': 'GET',
			':path': '/__uws/dashboard',
			':authority': `localhost:${server.h2Port}`
		});
		expect(page.status).toBe(200);
		expect(page.headers['content-type']).toContain('text/html');

		const rebound = await h2Exchange(server.h2Port, {
			':method': 'GET',
			':path': '/__uws/dashboard',
			':authority': `attacker.example:${server.h2Port}`
		});
		expect(rebound.status).toBe(403);
		expect(rebound.body).toContain('loopback');

		// The authority is what names the host; a loopback host header beside
		// a foreign authority does not pass the gate.
		const beside = await h2Exchange(server.h2Port, {
			':method': 'GET',
			':path': '/__uws/dashboard',
			':authority': `attacker.example:${server.h2Port}`,
			host: `localhost:${server.h2Port}`
		});
		expect(beside.status).toBe(403);
	});
});

describe('the dev auth lane\'s body read', () => {
	/** @type {{ port: number, h2Port: number, close: () => Promise<void> }} */
	let server;
	/** @type {(value?: unknown) => void} */
	let release;
	let calls = 0;
	beforeAll(async () => {
		// The handler loads only once released, so a request waits before its
		// body is read and a client can leave at that point on purpose.
		const ready = new Promise((resolve) => { release = resolve; });
		server = /** @type {any} */ (await bootWithoutOrigin({
			handler: { authenticate() { calls++; } },
			ready,
			h2: true
		}));
	}, 120_000);
	afterAll(async () => { await server?.close(); });

	it('runs no hook for a client that left before its body was read, and keeps serving', async () => {
		const overHttp1 = httpRequest({
			host: '127.0.0.1',
			port: server.port,
			path: '/__ws/auth',
			method: 'POST',
			headers: { 'x-requested-with': 'XMLHttpRequest', 'content-length': '100' }
		});
		overHttp1.once('error', () => {});
		overHttp1.write('x'.repeat(10));

		/** @param {(session: import('node:http2').ClientHttp2Session, stream: import('node:http2').ClientHttp2Stream) => void} leave */
		const leaveOverHttp2 = (leave) => {
			const session = http2Connect(`http://127.0.0.1:${server.h2Port}`);
			session.once('error', () => {});
			const stream = session.request({
				':method': 'POST',
				':path': '/__ws/auth',
				':authority': `127.0.0.1:${server.h2Port}`,
				'x-requested-with': 'XMLHttpRequest'
			});
			stream.once('error', () => {});
			stream.write('x'.repeat(10));
			return () => leave(session, stream);
		};
		const resetStream = leaveOverHttp2((_session, stream) => stream.close(http2Constants.NGHTTP2_CANCEL));
		const dropSession = leaveOverHttp2((session) => session.destroy());

		await new Promise((resolve) => setTimeout(resolve, 100));
		overHttp1.destroy();
		resetStream();
		dropSession();
		await new Promise((resolve) => setTimeout(resolve, 100));
		release();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(calls).toBe(0);

		const after = await send(server.port, '/__ws/auth', { headers: { 'x-requested-with': 'XMLHttpRequest' } });
		expect(after.status).toBe(204);
		expect(calls).toBe(1);
	});

	it('runs no hook for a body past 64 KiB over HTTP/1.1, declared or not', async () => {
		release();
		const before = calls;
		expect((await postBody(server.port, 64 * 1024 + 1)).status).toBe(413);
		expect((await postChunked(server.port, 70 * 1024)).status).toBe(413);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls).toBe(before);
	});

	it('runs no hook for a body past 64 KiB over HTTP/2', async () => {
		release();
		const before = calls;
		const res = await h2Exchange(server.h2Port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.h2Port}`,
			'x-requested-with': 'XMLHttpRequest'
		}, undefined, 'x'.repeat(4 * 1024 * 1024));
		expect(res.status).toBe(413);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls).toBe(before);
	});
});

const openssl = findOpenssl();

/**
 * The auth POST over HTTP/1.1 on TLS.
 *
 * @param {number} port
 * @param {Record<string, string>} headers
 * @param {string} ca
 */
function sendTls(port, headers, ca) {
	return new Promise((resolve, reject) => {
		const req = httpsRequest({
			host: '127.0.0.1',
			port,
			path: '/__ws/auth',
			method: 'POST',
			ca,
			headers: { ...headers, 'content-length': '0' }
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.once('error', reject);
		req.end();
	});
}

// Vite's own listener under `server.https`: `http2.createSecureServer` with
// HTTP/1.1 allowed, which a browser reaches over HTTP/2 for requests and over
// HTTP/1.1 for the WebSocket. Vite terminates TLS here, so a same-origin
// Origin is the `https://` one, as under production's SSL_CERT. These are the
// only cases that give the origin checks a TLS listener, so on CI a missing
// openssl fails them rather than skipping them.
(openssl === null && process.env.CI !== 'true' ? describe.skip : describe)('the dev plugin under server.https', () => {
	/** @type {{ port: number, close: () => Promise<void> }} */
	let server;
	/** @type {string} */
	let ca;
	/** @type {string | undefined} */
	let dir;
	beforeAll(async () => {
		if (openssl === null) throw new Error('the server.https cases need openssl, which CI must provide');
		dir = mkdtempSync(join(tmpdir(), 'uws-vite-tls-'));
		const tls = loopbackCertificate(openssl, dir);
		ca = tls.cert;
		server = await bootWithoutOrigin({ handler: withOwnLanes, tls });
	}, 120_000);
	afterAll(async () => {
		await server?.close();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it('holds the auth POST to an https same-origin Origin, over HTTP/2 and HTTP/1.1', async () => {
		const authority = `127.0.0.1:${server.port}`;
		/** @param {string} origin */
		const post = (origin) => h2Exchange(server.port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': authority,
			origin,
			'x-auth-echo': '1'
		}, ca);
		const accepted = await post(`https://${authority}`);
		expect(accepted.status).toBe(200);
		expect(JSON.parse(accepted.body).requestUrl).toBe(`https://${authority}/__ws/auth`);
		// The same host on the other scheme is another origin.
		expect((await post(`http://${authority}`)).status).toBe(403);

		const overHttp1 = await sendTls(server.port, { origin: `https://${authority}`, 'x-auth-echo': '1' }, ca);
		expect(overHttp1.status).toBe(200);
		expect(JSON.parse(overHttp1.body).requestUrl).toBe(`https://${authority}/__ws/auth`);
		expect((await sendTls(server.port, { origin: `http://${authority}`, 'x-auth-echo': '1' }, ca)).status).toBe(403);
	});

	it('keeps a hook Response\'s connection headers over HTTP/1.1 on TLS', async () => {
		const res = await sendTls(server.port, { 'x-requested-with': 'XMLHttpRequest', 'x-connection-headers': '1' }, ca);
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		for (const name of NONFRAMING_CONNECTION_HEADERS) {
			expect(res.headers[name], name).toBe(CONNECTION_HEADERS[name]);
		}
	});

	it('writes a hook Response without the headers HTTP/2 does not carry, over HTTP/2 on TLS', async () => {
		const res = await h2Exchange(server.port, {
			':method': 'POST',
			':path': '/__ws/auth',
			':authority': `127.0.0.1:${server.port}`,
			'x-requested-with': 'XMLHttpRequest',
			'x-connection-headers': '1'
		}, ca);
		expect(res.status).toBe(200);
		expect(res.body).toBe('kept');
		for (const name of Object.keys(CONNECTION_HEADERS)) {
			expect(res.headers[name], name).toBeUndefined();
		}
	});

	it('opens a WebSocket for an https same-origin Origin and refuses the http one', async () => {
		const authority = `127.0.0.1:${server.port}`;
		expect(await openWebSocket(`wss://${authority}/ws`, `https://${authority}`, ca)).toBe(101);
		expect(await openWebSocket(`wss://${authority}/ws`, `http://${authority}`, ca)).toBe(403);
	});
});
