import { test, expect } from '@playwright/test';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { startBrowserCoverage, stopBrowserCoverage } from './browser-coverage.js';
import { PROD_PORT } from './ports.js';

const PORT = PROD_PORT;
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

// - Helpers ------------------------------------------------------------------

function connectWs(url = WS_URL) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

function subscribe(ws, topic) {
	ws.send(JSON.stringify({ type: 'subscribe', topic }));
}

function waitFor(ws, predicate, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.removeListener('message', handler);
			reject(new Error('Timed out waiting for message'));
		}, timeoutMs);

		function handler(raw) {
			const msg = JSON.parse(raw.toString());
			if (predicate(msg)) {
				clearTimeout(timeout);
				ws.removeListener('message', handler);
				resolve(msg);
			}
		}

		ws.on('message', handler);
	});
}

function collect(ws, durationMs = 1000) {
	return new Promise((resolve) => {
		const messages = [];

		function handler(raw) {
			messages.push(JSON.parse(raw.toString()));
		}

		ws.on('message', handler);
		setTimeout(() => {
			ws.removeListener('message', handler);
			resolve(messages);
		}, durationMs);
	});
}

// - SSR & HTTP ---------------------------------------------------------------

test.describe('SSR and static files (production)', () => {
	test('renders the page with SSR data', async ({ request }) => {
		const res = await request.get('/');
		expect(res.status()).toBe(200);
		const html = await res.text();
		expect(html).toContain('hello from ssr');
	});

	test('serves static files with cache headers', async ({ request }) => {
		const res = await request.get('/test.txt');
		expect(res.status()).toBe(200);
		expect(await res.text()).toContain('static file content');
	});

	test('returns 404 for missing routes', async ({ request }) => {
		const res = await request.get('/does-not-exist-at-all');
		expect(res.status()).toBe(404);
	});

	test('health check endpoint', async ({ request }) => {
		const res = await request.get('/healthz');
		expect(res.status()).toBe(200);
	});

	// Backpressure is a socket-buffer event, not a client-speed one, and the
	// uWebSockets.js build 0.5.8 pinned lost the writable wakeup after the first
	// one: the writer waited out its drain deadline and closed the socket on a
	// body cut at a buffer boundary. A cookie takes the credentialed lane, which
	// streams rather than buffers. 16 MiB read with a pause per data event
	// drives the writer through backpressure many times on loopback.
	test('delivers a streamed body whole through backpressure', async () => {
		test.setTimeout(60000);
		const result = await new Promise((resolve, reject) => {
			const req = http.request(`${BASE_URL}/stream-big?mb=16`, { headers: { cookie: 'a=1' } }, (res) => {
				let bytes = 0;
				res.on('data', (chunk) => {
					bytes += chunk.length;
					res.pause();
					setTimeout(() => res.resume(), 5);
				});
				res.on('end', () => resolve({ status: res.statusCode, bytes, complete: res.complete }));
				res.on('aborted', () => resolve({ status: res.statusCode, bytes, complete: false }));
				res.on('error', () => resolve({ status: res.statusCode, bytes, complete: false }));
			});
			req.on('error', reject);
			req.end();
		});
		expect(result.status).toBe(200);
		expect(result.complete).toBe(true);
		expect(result.bytes).toBe(16 * 1024 * 1024);
	});

	// `new Request()` throws for these three, which answered 500 with an SSR
	// error in the log. Raw socket, because HTTP clients refuse to send them.
	// uWS answers a target that is not a path itself, so CONNECT goes to `/`.
	test('refuses TRACE, TRACK and CONNECT with 405 and Allow', async () => {
		for (const method of ['TRACE', 'TRACK', 'CONNECT']) {
			const head = await new Promise((resolve) => {
				let buf = '';
				const sock = net.connect(PORT, '127.0.0.1', () => {
					sock.write(`${method} / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
				});
				sock.setTimeout(5000, () => sock.destroy());
				sock.on('data', (d) => { buf += d.toString('latin1'); });
				sock.on('close', () => resolve(buf.slice(0, buf.indexOf('\r\n\r\n') + 1)));
				sock.on('error', () => {});
			});
			expect(head.split('\r\n')[0], method).toMatch(/^HTTP\/1\.1 405/);
			expect(head.toLowerCase(), method).toContain('allow: get, head, post, put, patch, delete, options');
		}
	});

	// A header returned from the upgrade hook must ride a 101. uWS writes an
	// implicit 200 on the first header unless the status was written first,
	// and browsers refuse that handshake. Raw socket, so the status line is
	// read as the server wrote it.
	test('an upgrade hook header rides a 101 Switching Protocols status line', async () => {
		const raw = await new Promise((resolve) => {
			let buf = '';
			let settle;
			const key = Buffer.from('0123456789abcdef').toString('base64');
			const sock = net.connect(PORT, '127.0.0.1', () => {
				sock.write(
					`GET /ws?header=1 HTTP/1.1\r\nHost: localhost:${PORT}\r\n` +
					'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
					`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
				);
			});
			const finish = () => { clearTimeout(settle); sock.destroy(); resolve(buf); };
			sock.setTimeout(5000, finish);
			sock.on('data', (d) => { buf += d.toString('latin1'); clearTimeout(settle); settle = setTimeout(finish, 200); });
			sock.on('close', () => resolve(buf));
			sock.on('error', () => {});
		});
		expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
		expect(raw.toLowerCase()).toContain('x-fixture: upgrade');
		expect(raw).not.toContain('200 OK');
	});
});

// - SSR response and abort paths ---------------------------------------------

// The routes behind these tests hold at a gate the test releases through
// /probe once it has observed what it needs, so no assertion waits on a timer
// to be right. A cookie takes the credentialed lane, which streams; no cookie
// takes the anonymous lane, which may share a body between identical requests.
test.describe('SSR response and abort paths (production)', () => {
	// Several tests wait on more than one 10 s deadline in turn; a failure
	// should report the wait that missed, not the test timeout.
	test.describe.configure({ timeout: 90000 });

	let seq = 0;
	const nextId = (name) => `${name}-${Date.now()}-${++seq}`;

	/** GET `path` on the credentialed lane: status and body. */
	function get(path) {
		return new Promise((resolve, reject) => {
			http.get(`${BASE_URL}${path}`, { headers: { cookie: 'probe=1' }, agent: false }, (res) => {
				let body = '';
				res.on('data', (chunk) => { body += chunk; });
				res.on('error', reject);
				res.on('end', () => resolve({ status: res.statusCode, body }));
			}).on('error', reject);
		});
	}

	/** The lifecycle records of `id`; `release` opens its gate first. */
	async function probe(id, release = false) {
		const res = await get(`/probe?id=${encodeURIComponent(id)}${release ? '&release=1' : ''}`);
		return JSON.parse(res.body);
	}

	async function waitForRecord(id, event) {
		const deadline = Date.now() + 10000;
		for (;;) {
			const list = await probe(id);
			if (list.includes(event)) return;
			if (Date.now() > deadline) throw new Error(`${id}: no '${event}' record, saw ${JSON.stringify(list)}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	function within(promise, what, ms = 10000) {
		let timer;
		return Promise.race([
			promise,
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); })
		]).finally(() => clearTimeout(timer));
	}

	async function expectServing() {
		expect((await get('/')).status).toBe(200);
	}

	/**
	 * GET `path`. `seen(text)` resolves once the body read so far contains
	 * `text`; `outcome` resolves when the exchange closes, `complete` telling
	 * a body that ended cleanly from one cut short.
	 */
	function open(path, cookie) {
		let body = '';
		const watchers = [];
		const req = http.request(`${BASE_URL}${path}`, { headers: cookie ? { cookie: 'a=1' } : {}, agent: false });
		let responded = false;
		const outcome = new Promise((resolve) => {
			req.on('response', (res) => {
				responded = true;
				res.on('data', (chunk) => {
					body += chunk.toString('latin1');
					for (const w of watchers) if (body.includes(w.text)) w.resolve();
				});
				res.on('error', () => {});
				res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body, complete: res.complete }));
			});
			// After a response, its own close event reports the outcome.
			req.on('error', () => { if (!responded) resolve({ status: 0, headers: {}, body, complete: false }); });
		});
		req.end();
		const seen = (text) => new Promise((resolve) => {
			if (body.includes(text)) resolve();
			else watchers.push({ text, resolve });
		});
		return { req, outcome, seen, body: () => body };
	}

	/**
	 * Write `request` on a raw socket and collect what comes back until the
	 * server closes, nothing has arrived for `settleMs`, or `maxMs` passes.
	 */
	function rawExchange(request, settleMs = 300, maxMs = 5000) {
		return new Promise((resolve) => {
			let buf = '';
			let settle;
			const sock = net.connect(PORT, '127.0.0.1', () => sock.write(request));
			const finish = () => { clearTimeout(settle); clearTimeout(max); sock.destroy(); resolve(buf); };
			const max = setTimeout(finish, maxMs);
			sock.on('data', (d) => {
				buf += d.toString('latin1');
				clearTimeout(settle);
				settle = setTimeout(finish, settleMs);
			});
			sock.on('close', finish);
			sock.on('error', () => {});
		});
	}

	// A source that fails after the response started must not end the body
	// cleanly - the client would take the cut body for a complete one - and
	// must not answer a 500 into the started response, which uWS refuses with
	// a throw that would take the process down.
	test('a body that fails after it started closes the connection, and the server keeps serving', async () => {
		for (const cookie of [true, false]) {
			const id = nextId('fail');
			const exchange = open(`/response/fail?id=${id}`, cookie);
			try {
				await within(exchange.seen('ff'), 'the first chunks');
			} finally {
				await probe(id, true);
			}
			const result = await exchange.outcome;
			expect(result.status, `cookie=${cookie}`).toBe(200);
			expect(result.complete, `cookie=${cookie}`).toBe(false);
			await expectServing();
		}
	});

	// The anonymous lane shares only a body that is ready: a body that waits on
	// I/O streams, so its first chunk is not held until the last one exists.
	test('a streamed body sends its first chunk before its next one exists', async () => {
		for (const cookie of [true, false]) {
			const id = nextId('gated');
			const exchange = open(`/response/gated?id=${id}`, cookie);
			try {
				await within(exchange.seen('first;'), 'the first chunk');
				expect(exchange.body()).toBe('first;');
			} finally {
				await probe(id, true);
			}
			const result = await exchange.outcome;
			expect(result.complete).toBe(true);
			expect(result.body).toBe('first;second');
		}
	});

	test('a page that streams a load promise sends its shell before the promise settles', async () => {
		for (const cookie of [true, false]) {
			const id = nextId('deferred');
			const exchange = open(`/deferred?id=${id}`, cookie);
			try {
				await within(exchange.seen('deferred shell'), 'the page shell');
				expect(exchange.body()).not.toContain('released value');
			} finally {
				await probe(id, true);
			}
			const result = await exchange.outcome;
			expect(result.complete).toBe(true);
			expect(result.body).toContain('released value');
		}
	});

	test('an anonymous event stream delivers its first event at once', async () => {
		const exchange = open('/response/sse', false);
		await within(exchange.seen('data: open'), 'the first event');
		exchange.req.destroy();
		await expectServing();
	});

	// The share cap bounds what the anonymous lane holds: a body that passes it
	// streams on from where the read stopped. A small ready body is still
	// shared, and goes out framed by its length.
	test('the anonymous lane streams a body past the share cap and shares a small one', async () => {
		const big = await open('/response/ready?kb=1024', false).outcome;
		expect(big.complete).toBe(true);
		expect(big.body.length).toBe(1024 * 1024);
		expect(big.headers['transfer-encoding']).toBe('chunked');
		const small = await open('/response/ready?kb=48', false).outcome;
		expect(small.complete).toBe(true);
		expect(small.headers['content-length']).toBe(String(48 * 1024));
	});

	// The client leaves while the endpoint is still working: the body the
	// endpoint then returns is cancelled, so whatever its source holds is
	// released. The body never produces a chunk, so it is cancelled only if
	// the abort itself cancels it, whichever of the two the server sees first.
	test('a body returned after the client left is cancelled', async () => {
		for (const cookie of [true, false]) {
			const id = nextId('respond');
			const exchange = open(`/response/cancel?mode=respond&id=${id}`, cookie);
			await waitForRecord(id, 'entered');
			exchange.req.destroy();
			await probe(id, true);
			await waitForRecord(id, 'cancelled');
		}
	});

	// The abort itself cancels a body whose next read is pending, whether the
	// writer is waiting for its first chunk, a chunk after the ones it sent,
	// or (anonymous lane) the read that decides whether the body is shared.
	test('a body is cancelled when the client leaves while it waits for a chunk', async () => {
		for (const cookie of [true, false]) {
			const id = nextId('never');
			const exchange = open(`/response/cancel?mode=never&id=${id}`, cookie);
			await waitForRecord(id, 'entered');
			exchange.req.destroy();
			await waitForRecord(id, 'cancelled');
		}
		for (const cookie of [true, false]) {
			const id = nextId('idle');
			const exchange = open(`/response/cancel?mode=idle&id=${id}`, cookie);
			await within(exchange.seen('idle;idle;'), 'the first chunks');
			exchange.req.destroy();
			await waitForRecord(id, 'cancelled');
		}
	});

	// A client that stops sending its body never sends the last chunk; the
	// abort has to end the read with an error, or the request waits forever -
	// and a read that resolved would hand the app a cut body as a whole one.
	// Both readers (a small declared body is read into one preallocated
	// buffer) and both lanes that read a body.
	test('a body read in progress ends when the client leaves mid-upload', async () => {
		const targets = [
			['/upload/settle', 10000, ''],
			['/upload/settle', 100000, ''],
			['/__ws/auth', 10000, 'X-Requested-With: XMLHttpRequest\r\n']
		];
		for (const [path, declared, extra] of targets) {
			const id = nextId('upload');
			const sock = net.connect(PORT, '127.0.0.1');
			sock.on('error', () => {});
			sock.write(
				`POST ${path}?id=${id} HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\nX-Probe-Id: ${id}\r\n${extra}` +
				`Content-Type: application/octet-stream\r\nContent-Length: ${declared}\r\n\r\n`
			);
			sock.write(Buffer.alloc(1000));
			await waitForRecord(id, 'entered');
			sock.destroy();
			await waitForRecord(id, 'rejected');
			expect((await probe(id)).filter((e) => e.startsWith('resolved')), `${path} ${declared}`).toEqual([]);
		}
	});

	// Request-body chunks keep arriving after the endpoint cancelled its body
	// stream. They must be dropped: enqueueing them into the closed stream
	// throws inside the native data callback. The request pipelined behind the
	// body is answered only once every chunk before it has been handled. Both
	// readers: the chunked one after one chunk was read, the preallocated one
	// (it enqueues only at the last chunk) cancelled before any was read.
	test('a request body cancelled mid-upload drops the rest and the connection goes on', async () => {
		for (const [path, total, first] of [['/upload/cancel', 4 * 65536, 65536], ['/upload/cancel?read=0', 32768, 1000]]) {
			const sock = net.connect(PORT, '127.0.0.1');
			let reply = '';
			const answered = (n) => new Promise((resolve) => {
				const check = () => { if (reply.split('HTTP/1.1 200').length - 1 >= n) resolve(); };
				sock.on('data', check);
				check();
			});
			sock.on('data', (d) => { reply += d.toString('latin1'); });
			sock.on('error', () => {});
			sock.write(
				`POST ${path} HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\n` +
				`Content-Type: application/octet-stream\r\nContent-Length: ${total}\r\n\r\n`
			);
			sock.write(Buffer.alloc(first));
			await within(answered(1), `the early answer from ${path}`);
			expect(reply).toContain('stopped');
			sock.write(Buffer.alloc(total - first));
			sock.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n');
			await within(answered(2), `the pipelined answer after ${path}`);
			sock.destroy();
			await expectServing();
		}
	});

	// The body size limit can trip after the response started, through a route
	// that streams its request body back. The exchange is then cut, not
	// answered a second time with a 413 into the closed response.
	test('a body limit tripped mid-response cuts the exchange, and the server keeps serving', async () => {
		const sock = net.connect(PORT, '127.0.0.1');
		let reply = '';
		let closed = false;
		const replied = new Promise((resolve) => sock.on('data', (d) => { reply += d.toString('latin1'); if (reply.includes('\r\n\r\n')) resolve(); }));
		const gone = new Promise((resolve) => sock.on('close', () => { closed = true; resolve(); }));
		sock.on('error', () => {});
		const chunk = (n) => `${n.toString(16)}\r\n${'e'.repeat(n)}\r\n`;
		sock.write('POST /upload/echo HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
		sock.write(chunk(65536));
		await within(replied, 'the echo to start');
		expect(reply.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 200/);
		for (let i = 0; i < 10 && !closed; i++) sock.write(chunk(65536));
		await within(gone, 'the cut');
		expect(reply).not.toContain('413');
		expect(reply.endsWith('0\r\n\r\n'), 'no clean end of the chunked body').toBe(false);
		await expectServing();
	});

	// An event stream is never shared: concurrent anonymous requests each
	// render at once instead of waiting for the first one's first event.
	test('concurrent anonymous event streams each render without waiting on the first event', async () => {
		const id = nextId('sse');
		const exchanges = [open(`/response/sse-gated?id=${id}`, false), open(`/response/sse-gated?id=${id}`, false)];
		try {
			const deadline = Date.now() + 10000;
			while ((await probe(id)).filter((e) => e === 'rendered').length < 2) {
				if (Date.now() > deadline) throw new Error('the second event stream never rendered');
				await new Promise((r) => setTimeout(r, 25));
			}
		} finally {
			await probe(id, true);
		}
		for (const exchange of exchanges) {
			await within(exchange.seen('data: open'), 'the first event');
			exchange.req.destroy();
		}
	});

	/** The status line, the lowercased header lines and the byte count after them. */
	function parse(raw) {
		const end = raw.indexOf('\r\n\r\n');
		const [status, ...headers] = raw.slice(0, end).split('\r\n');
		return { status, headers: headers.map((l) => l.toLowerCase()), bodyBytes: end < 0 ? -1 : raw.length - end - 4 };
	}

	const framingOf = (headers) => headers.filter((l) => l.startsWith('content-length:') || l.startsWith('transfer-encoding:'));

	// A client stops reading a HEAD response at the end of its headers, so a
	// body written after them would be read as the next response. The length
	// reported is the one the response declares, or none.
	test('HEAD answers with headers only', async () => {
		const cases = [['/', false], ['/', true], ['/response/ready?kb=1024', false], ['/response/ready?kb=1024', true], ['/response/sse', true]];
		for (const [path, cookie] of cases) {
			const res = parse(await rawExchange(`HEAD ${path} HTTP/1.1\r\nHost: localhost\r\n${cookie ? 'Cookie: a=1\r\n' : ''}Connection: close\r\n\r\n`));
			expect(res.status, `${path} cookie=${cookie}`).toMatch(/^HTTP\/1\.1 200/);
			expect(res.bodyBytes, `${path} cookie=${cookie}`).toBe(0);
			if (path === '/') expect(framingOf(res.headers)[0], 'a page declares its length').toMatch(/^content-length: [1-9]\d*$/);
			else expect(framingOf(res.headers), `${path} declares no length`).toEqual([]);
		}
		// The server's own answers to a HEAD carry their length and no body.
		const own = [
			['HEAD /response/locked HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\n', 500],
			['HEAD /__ws/auth HTTP/1.1\r\nHost: localhost\r\n', 405],
			['HEAD /%E0%A4%A HTTP/1.1\r\nHost: localhost\r\n', 400],
			['HEAD / HTTP/1.1\r\nHost: localhost/response\r\n', 400]
		];
		if (process.platform === 'win32') own.push(['HEAD /a:b HTTP/1.1\r\nHost: localhost\r\n', 400]);
		for (const [request, status] of own) {
			const res = parse(await rawExchange(request + 'Connection: close\r\n\r\n'));
			expect(res.status).toMatch(new RegExp(`^HTTP/1\\.1 ${status}`));
			expect(res.bodyBytes, res.status).toBe(0);
			expect(framingOf(res.headers)[0], res.status).toMatch(/^content-length: [1-9]\d*$/);
		}
		const locked = await open('/response/locked', true).outcome;
		expect(locked.status).toBe(500);
		expect(locked.body).toContain('Response body is locked');
		// The body a HEAD never sends is cancelled, so its source is released.
		const id = nextId('head');
		const head = parse(await rawExchange(`HEAD /response/cancel?mode=never&id=${id} HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\nConnection: close\r\n\r\n`));
		expect(head.status).toMatch(/^HTTP\/1\.1 200/);
		await waitForRecord(id, 'cancelled');
	});

	// A network-error Response has status 0, which no HTTP status line can
	// carry; it is answered as a server error instead.
	test('a network-error Response is answered 500', async () => {
		const res = parse(await rawExchange('GET /response/network-error HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\nConnection: close\r\n\r\n'));
		expect(res.status).toMatch(/^HTTP\/1\.1 500/);
		await expectServing();
	});

	// RFC 9110 8.6: a 204 carries no Content-Length. A 304 reports one only
	// when the app declared it; any other bodyless response reports zero,
	// whatever it declared, or the client would wait for bytes that never come.
	test('a bodyless response reports the length its status allows', async () => {
		const cases = [
			['/response/bodyless?status=204', []],
			['/response/bodyless?status=204&cl=10', []],
			['/response/bodyless?status=304', []],
			['/response/bodyless?status=304&cl=123', ['content-length: 123']],
			['/response/bodyless?status=200&cl=50', ['content-length: 0']]
		];
		for (const [path, framing] of cases) {
			const res = parse(await rawExchange(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\nConnection: close\r\n\r\n`));
			expect(framingOf(res.headers), path).toEqual(framing);
			expect(res.bodyBytes, path).toBe(0);
		}
		const auth = (shape) => rawExchange(
			`POST /__ws/auth HTTP/1.1\r\nHost: localhost\r\nX-Requested-With: XMLHttpRequest\r\n${shape ? `X-Auth-Response: ${shape}\r\n` : ''}Content-Length: 0\r\nConnection: close\r\n\r\n`
		);
		for (const shape of ['', 'empty']) {
			const res = parse(await auth(shape));
			expect(res.status, `authenticate ${shape || 'default'}`).toMatch(/^HTTP\/1\.1 204/);
			expect(framingOf(res.headers), `authenticate ${shape || 'default'}`).toEqual([]);
		}
		const framed = parse(await auth('framing'));
		expect(framingOf(framed.headers), 'authenticate Response').toEqual(['content-length: 13']);
		expect(framed.headers.filter((l) => l.startsWith('date:'))).toHaveLength(1);
		expect(framed.headers.join('\n')).not.toContain('2024');
	});

	// Concurrent anonymous GETs for one URL share one render; HEADs and
	// credentialed GETs each render. A lane that renders each request is
	// observed directly: both renders are held at the gate at once. Sharing
	// needs the second request to reach the server while the first render is
	// held, which nothing reports, so a round in which it arrived late is
	// retried; a lane that does not share never shows a single render.
	test('concurrent anonymous GETs share one render; HEADs and credentialed GETs each render', async () => {
		const send = (method, path, cookie) => rawExchange(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\n${cookie ? 'Cookie: a=1\r\n' : ''}Connection: close\r\n\r\n`);
		const renders = async (id) => (await probe(id)).filter((e) => e === 'rendered').length;

		for (const [method, cookie] of [['HEAD', false], ['GET', true]]) {
			const id = nextId('render');
			const path = `/response/render?id=${id}`;
			const both = Promise.all([send(method, path, cookie), send(method, path, cookie)]);
			try {
				const deadline = Date.now() + 10000;
				while (await renders(id) < 2) {
					if (Date.now() > deadline) throw new Error(`${method} cookie=${cookie}: the second request never rendered`);
					await new Promise((r) => setTimeout(r, 25));
				}
			} finally {
				await probe(id, true);
			}
			for (const raw of await both) expect(parse(raw).status, `${method} cookie=${cookie}`).toMatch(/^HTTP\/1\.1 200/);
		}

		let shared = false;
		for (let round = 0; round < 3 && !shared; round++) {
			const id = nextId('shared');
			const path = `/response/render?id=${id}`;
			const first = send('GET', path, false);
			await waitForRecord(id, 'rendered');
			const second = send('GET', path, false);
			await new Promise((r) => setTimeout(r, 300));
			await probe(id, true);
			const [a, b] = (await Promise.all([first, second])).map((raw) => raw.slice(raw.indexOf('\r\n\r\n') + 4));
			expect(a).toMatch(/^render \d+$/);
			shared = (await renders(id)) === 1 && a === b;
		}
		expect(shared, 'two concurrent anonymous GETs shared one render').toBe(true);
	});

	// A proxied fetch() Response carries its upstream's framing and Date. Sent
	// beside the ones uWS writes, the body would be framed two ways at once.
	test("a Response's own framing and Date headers are not sent beside the server's", async () => {
		for (const cookie of [false, true]) {
			const raw = await rawExchange(`GET /response/framing HTTP/1.1\r\nHost: localhost\r\n${cookie ? 'Cookie: a=1\r\n' : ''}Connection: close\r\n\r\n`);
			const head = raw.slice(0, raw.indexOf('\r\n\r\n')).toLowerCase().split('\r\n');
			const framing = head.filter((l) => l.startsWith('transfer-encoding:') || l.startsWith('content-length:'));
			expect(framing, `cookie=${cookie}`).toEqual(['content-length: 2000']);
			expect(head.filter((l) => l.startsWith('date:')), `cookie=${cookie}`).toHaveLength(1);
			expect(raw).not.toContain('Mon, 01 Jan 2024');
		}
	});

	// Without ORIGIN the base URL comes from the Host header. A Host that is
	// not a URL authority is the client's fault: a 400, not a throw escaping
	// the native route callback.
	// Two refusals stand between a Host and the throw: the origin check, and
	// the URL parser for a host that passes it but names no valid port.
	test('the authenticate endpoint answers a Host it cannot build a URL from with 400', async () => {
		for (const host of ['exa mple', 'localhost:99999']) {
			const raw = await rawExchange(
				`POST /__ws/auth HTTP/1.1\r\nHost: ${host}\r\nX-Requested-With: XMLHttpRequest\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
			);
			expect(raw.split('\r\n')[0], host).toMatch(/^HTTP\/1\.1 400/);
			expect(raw.endsWith('\r\n\r\nBad Request'), host).toBe(true);
			await expectServing();
		}
	});

	// Without ORIGIN the request URL is the Host header's authority followed
	// by the target. A Host carrying a path would put that path in front of
	// the routed one, so a rule in front of the server that judges the target
	// would be judging a route that is not the one served. It is refused.
	test('a Host that is not an authority is answered 400 instead of routed', async () => {
		const control = await rawExchange('GET /framing HTTP/1.1\r\nHost: localhost\r\nCookie: a=1\r\nConnection: close\r\n\r\n');
		expect(control.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 404/);
		for (const host of ['localhost/response', 'user@localhost', 'localhost:99999']) {
			for (const cookie of [false, true]) {
				const raw = await rawExchange(`GET /framing HTTP/1.1\r\nHost: ${host}\r\n${cookie ? 'Cookie: a=1\r\n' : ''}Connection: close\r\n\r\n`);
				expect(raw.split('\r\n')[0], `${host} cookie=${cookie}`).toMatch(/^HTTP\/1\.1 400/);
				expect(raw.endsWith('\r\n\r\nBad Request'), `${host} cookie=${cookie}`).toBe(true);
			}
		}
		const head = await rawExchange('HEAD /framing HTTP/1.1\r\nHost: localhost/response\r\nConnection: close\r\n\r\n');
		expect(head.split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/);
		expect(head.length - head.indexOf('\r\n\r\n') - 4).toBe(0);
	});
});

// - WebSocket (Node.js ws client) --------------------------------------------

test.describe('WebSocket pub/sub (production)', () => {
	test('subscribe and receive published messages', async () => {
		const client = await connectWs();
		subscribe(client, 'test-topic');
		await new Promise((r) => setTimeout(r, 100));

		const trigger = await connectWs();

		const msg = await waitFor(client, (m) => m.event === 'connected');
		expect(msg.topic).toBe('test-topic');
		expect(msg.data.ts).toBeGreaterThan(0);

		trigger.close();
		client.close();
	});

	test('echo via custom message handler', async () => {
		const client = await connectWs();
		subscribe(client, 'test-topic');
		await new Promise((r) => setTimeout(r, 100));

		client.send(JSON.stringify({ type: 'echo', payload: 'prod echo' }));

		const msg = await waitFor(client, (m) => m.event === 'echo');
		expect(msg.data).toBe('prod echo');

		client.close();
	});

	test('broadcast reaches multiple subscribers', async () => {
		const c1 = await connectWs();
		const c2 = await connectWs();
		subscribe(c1, 'prod-broadcast');
		subscribe(c2, 'prod-broadcast');
		await new Promise((r) => setTimeout(r, 100));

		const sender = await connectWs();
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'prod-broadcast',
			event: 'ping',
			payload: 'pong'
		}));

		const [m1, m2] = await Promise.all([
			waitFor(c1, (m) => m.topic === 'prod-broadcast' && m.event === 'ping'),
			waitFor(c2, (m) => m.topic === 'prod-broadcast' && m.event === 'ping')
		]);

		expect(m1.data).toBe('pong');
		expect(m2.data).toBe('pong');

		sender.close();
		c1.close();
		c2.close();
	});

	test('unsubscribe stops delivery', async () => {
		const client = await connectWs();
		subscribe(client, 'unsub-prod');
		await new Promise((r) => setTimeout(r, 100));

		client.send(JSON.stringify({ type: 'unsubscribe', topic: 'unsub-prod' }));
		await new Promise((r) => setTimeout(r, 100));

		const sender = await connectWs();
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'unsub-prod',
			event: 'missed',
			payload: 'nope'
		}));

		const messages = await collect(client, 500);
		expect(messages.filter((m) => m.topic === 'unsub-prod')).toHaveLength(0);

		sender.close();
		client.close();
	});
});

// - WebSocket hook failures ------------------------------------- production
// The fixture's open hook throws for a connection whose URL carries boom=open,
// its close hook for boom=close, and its message hook parses every frame as
// JSON, so a non-JSON frame throws inside it. Each failure must cost only the
// connection it ran for: that client reads a 1011 close, a bystander keeps
// receiving, and a fresh connection is served afterwards. A failure that
// escaped the hook would end the server process instead.

function closeCodeOf(ws) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('no close frame')), 5000);
		ws.on('error', () => {});
		ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
	});
}

async function echoes(ws, payload) {
	const reply = waitFor(ws, (m) => m.event === 'echo' && m.data === payload);
	ws.send(JSON.stringify({ type: 'echo', payload }));
	return reply;
}

async function subscribedWithAck(ws, topic, ref) {
	const ack = waitFor(ws, (m) => m.type === 'subscribed' && m.topic === topic && m.ref === ref);
	ws.send(JSON.stringify({ type: 'subscribe', topic, ref }));
	return ack;
}

async function bystanderStillReceives(bystander, sender, payload) {
	const seen = waitFor(bystander, (m) => m.event === 'broadcast' && m.data === payload);
	sender.send(JSON.stringify({ type: 'broadcast', payload }));
	await seen;
}

test.describe('WebSocket hook failures (production)', () => {
	test('a throwing open hook closes only that connection with 1011', async () => {
		const bystander = await connectWs();
		await subscribedWithAck(bystander, 'test-topic', 1);

		const victim = new WebSocket(`${WS_URL}?boom=open`);
		expect(await closeCodeOf(victim)).toBe(1011);

		const fresh = await connectWs();
		await echoes(fresh, 'after-open-boom');
		await bystanderStillReceives(bystander, fresh, 'open-boom-bystander');
		bystander.close();
		fresh.close();
	});

	test('a message hook that throws on a non-JSON frame closes only that connection', async () => {
		const bystander = await connectWs();
		await subscribedWithAck(bystander, 'test-topic', 1);

		const victim = await connectWs();
		const closed = closeCodeOf(victim);
		victim.send('garbage');
		expect(await closed).toBe(1011);

		const fresh = await connectWs();
		await echoes(fresh, 'after-message-boom');
		await bystanderStillReceives(bystander, fresh, 'message-boom-bystander');
		bystander.close();
		fresh.close();
	});

	test('a message hook that throws on a JSON-prefixed frame that fails to parse closes only that connection', async () => {
		// {"ty matches the control-message prefix the runtime checks before
		// parsing; the parse fails and the raw frame is handed to the hook.
		const victim = await connectWs();
		const closed = closeCodeOf(victim);
		victim.send('{"ty');
		expect(await closed).toBe(1011);

		const fresh = await connectWs();
		await echoes(fresh, 'after-prefix-boom');
		fresh.close();
	});

	test('a throwing close hook leaves the server serving', async () => {
		const ws = await connectWs(`${WS_URL}?boom=close`);
		ws.close();
		await new Promise((r) => setTimeout(r, 100));

		const fresh = await connectWs();
		await echoes(fresh, 'after-close-boom');
		fresh.close();
	});

	test('a throwing unsubscribe hook is contained and the connection keeps working', async () => {
		const ws = await connectWs();
		await subscribedWithAck(ws, 'boom', 1);
		ws.send(JSON.stringify({ type: 'unsubscribe', topic: 'boom' }));
		await subscribedWithAck(ws, 'after-unsubscribe-boom', 2);
		ws.close();
	});
});

// - Browser client -----------------------------------------------------------

test.describe('browser client.js (production)', () => {
	/** @type {any} */
	let cdpClient;

	test.beforeEach(async ({ page }) => {
		cdpClient = await startBrowserCoverage(page);
	});

	test.afterEach(async () => {
		if (cdpClient) {
			await stopBrowserCoverage(cdpClient);
			cdpClient = null;
		}
	});

	test('page loads and client connects', async ({ page }) => {
		await page.goto('/');
		const heading = page.locator('h1');
		await expect(heading).toHaveText('hello from ssr');

		const status = page.locator('#status');
		await expect(status).toHaveText('open', { timeout: 5000 });
	});

	test('client receives published messages', async ({ page }) => {
		await page.goto('/');
		await page.locator('#status').filter({ hasText: 'open' }).waitFor({ timeout: 5000 });

		const sender = await connectWs();
		await new Promise((r) => setTimeout(r, 200));
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'test-topic',
			event: 'prod-hello',
			payload: { from: 'node' }
		}));

		const eventEl = page.locator('#event');
		await expect(eventEl).not.toHaveText('none', { timeout: 5000 });

		const text = await eventEl.textContent();
		const parsed = JSON.parse(text);
		expect(parsed.topic).toBe('test-topic');
		expect(parsed.event).toBe('prod-hello');
		expect(parsed.data.from).toBe('node');

		sender.close();
	});
});
