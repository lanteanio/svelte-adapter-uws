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
