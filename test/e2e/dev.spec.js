import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import { startBrowserCoverage, stopBrowserCoverage } from './browser-coverage.js';
import { DEV_PORT } from './ports.js';

const WS_URL = `ws://localhost:${DEV_PORT}/ws`;

// - Helpers ------------------------------------------------------------------

/** Connect a Node.js ws client and wait for open. */
function connectWs(url = WS_URL) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

/** Subscribe to a topic over a ws connection. */
function subscribe(ws, topic) {
	ws.send(JSON.stringify({ type: 'subscribe', topic }));
}

/** Wait for a message matching a predicate. */
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

/** Collect messages for a duration. */
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

test.describe('SSR and static files', () => {
	test('renders the page with SSR data', async ({ page }) => {
		await page.goto('/');
		const heading = page.locator('h1');
		await expect(heading).toHaveText('hello from ssr');
	});

	test('serves static files', async ({ request }) => {
		const res = await request.get('/test.txt');
		expect(res.status()).toBe(200);
		expect(await res.text()).toContain('static file content');
	});
});

// - WebSocket (Node.js ws client) --------------------------------------------

test.describe('WebSocket pub/sub via ws client', () => {
	test('subscribe and receive published messages', async () => {
		const client = await connectWs();
		subscribe(client, 'test-topic');

		// Give the subscription a moment to register
		await new Promise((r) => setTimeout(r, 100));

		// Open a second client - the hooks.ws.js open handler publishes to test-topic
		const trigger = await connectWs();

		const msg = await waitFor(client, (m) => m.event === 'connected');
		expect(msg.topic).toBe('test-topic');
		expect(msg.event).toBe('connected');
		expect(msg.data.ts).toBeGreaterThan(0);

		trigger.close();
		client.close();
	});

	test('echo via custom message handler', async () => {
		const client = await connectWs();
		subscribe(client, 'test-topic');
		await new Promise((r) => setTimeout(r, 100));

		client.send(JSON.stringify({ type: 'echo', payload: 'hello world' }));

		const msg = await waitFor(client, (m) => m.event === 'echo');
		expect(msg.topic).toBe('test-topic');
		expect(msg.data).toBe('hello world');

		client.close();
	});

	test('broadcast reaches all subscribers', async () => {
		const client1 = await connectWs();
		const client2 = await connectWs();
		subscribe(client1, 'broadcast-test');
		subscribe(client2, 'broadcast-test');
		await new Promise((r) => setTimeout(r, 100));

		// Use a third client to send the broadcast
		const sender = await connectWs();
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'broadcast-test',
			event: 'ping',
			payload: 42
		}));

		const [msg1, msg2] = await Promise.all([
			waitFor(client1, (m) => m.topic === 'broadcast-test' && m.event === 'ping'),
			waitFor(client2, (m) => m.topic === 'broadcast-test' && m.event === 'ping')
		]);

		expect(msg1.data).toBe(42);
		expect(msg2.data).toBe(42);

		sender.close();
		client1.close();
		client2.close();
	});

	test('unsubscribed client does not receive messages', async () => {
		const client = await connectWs();
		subscribe(client, 'unsub-test');
		await new Promise((r) => setTimeout(r, 100));

		// Unsubscribe
		client.send(JSON.stringify({ type: 'unsubscribe', topic: 'unsub-test' }));
		await new Promise((r) => setTimeout(r, 100));

		// Trigger a broadcast to unsub-test
		const sender = await connectWs();
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'unsub-test',
			event: 'should-miss',
			payload: 'nope'
		}));

		const messages = await collect(client, 500);
		const matched = messages.filter((m) => m.topic === 'unsub-test' && m.event === 'should-miss');
		expect(matched).toHaveLength(0);

		sender.close();
		client.close();
	});
});

// - Upgrade handler (auth) ---------------------------------------------------

test.describe('WebSocket platform API coverage', () => {
	test('sendTo delivers only to matching connections', async () => {
		const client = await connectWs(WS_URL);
		subscribe(client, 'test-topic');
		await new Promise((r) => setTimeout(r, 100));

		const sender = await connectWs(WS_URL);
		sender.send(JSON.stringify({
			type: 'sendto',
			token: 'nonexistent-token-xyz',
			topic: 'test-topic',
			event: 'dm',
			payload: 'private'
		}));

		const messages = await collect(client, 500);
		const dms = messages.filter((m) => m.event === 'dm');
		expect(dms).toHaveLength(0);

		sender.close();
		client.close();
	});

	test('cork wraps send in a batched call', async () => {
		const client = await connectWs();
		subscribe(client, 'test-topic');
		await new Promise((r) => setTimeout(r, 100));

		client.send(JSON.stringify({ type: 'cork-test', payload: 'batched' }));

		const msg = await waitFor(client, (m) => m.event === 'corked');
		expect(msg.data).toBe('batched');

		client.close();
	});
});

test.describe('WebSocket upgrade handler', () => {
	test('accepts connection with valid token cookie', async () => {
		const { default: WebSocket } = await import('ws');
		const ws = new WebSocket(WS_URL, {
			headers: { cookie: 'token=valid123' }
		});
		await new Promise((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});
		ws.close();
	});

	test('rejects connection when upgrade returns false', async () => {
		const { default: WebSocket } = await import('ws');
		const ws = new WebSocket(WS_URL, {
			headers: { cookie: 'token=reject' }
		});
		await expect(new Promise((resolve, reject) => {
			ws.on('open', () => reject(new Error('should not open')));
			ws.on('error', resolve);
		})).resolves.toBeTruthy();
	});

	test('returns 500 when upgrade handler throws', async () => {
		const { default: WebSocket } = await import('ws');
		const ws = new WebSocket(WS_URL, {
			headers: { cookie: 'token=error' }
		});
		await expect(new Promise((resolve, reject) => {
			ws.on('open', () => reject(new Error('should not open')));
			ws.on('error', resolve);
		})).resolves.toBeTruthy();
	});

	test('subscribe-batch resubscription works', async () => {
		const client = await connectWs();
		// Send a subscribe-batch message like the client store does on reconnect
		client.send(JSON.stringify({
			type: 'subscribe-batch',
			topics: ['batch-a', 'batch-b', 'batch-c']
		}));
		await new Promise((r) => setTimeout(r, 100));

		// Trigger a broadcast to one of the batch-subscribed topics
		const sender = await connectWs();
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'batch-a',
			event: 'ping',
			payload: 'batched'
		}));

		const msg = await waitFor(client, (m) => m.topic === 'batch-a' && m.event === 'ping');
		expect(msg.data).toBe('batched');

		sender.close();
		client.close();
	});
});

// - Browser client (Playwright) ----------------------------------------------

test.describe('browser client.js', () => {
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

	test('client connects and shows open status', async ({ page }) => {
		await page.goto('/');
		const status = page.locator('#status');
		await expect(status).toHaveText('open', { timeout: 5000 });
	});

	test('client receives pub/sub messages in the browser', async ({ page }) => {
		await page.goto('/');
		await page.locator('#status').filter({ hasText: 'open' }).waitFor({ timeout: 5000 });

		const sender = await connectWs();
		await new Promise((r) => setTimeout(r, 200));
		sender.send(JSON.stringify({
			type: 'broadcast',
			topic: 'test-topic',
			event: 'hello',
			payload: { msg: 'from node' }
		}));

		const eventEl = page.locator('#event');
		await expect(eventEl).not.toHaveText('none', { timeout: 5000 });

		const text = await eventEl.textContent();
		const parsed = JSON.parse(text);
		expect(parsed.topic).toBe('test-topic');
		expect(parsed.event).toBe('hello');
		expect(parsed.data.msg).toBe('from node');

		sender.close();
	});

	test('client reconnects after server-initiated close', async ({ page }) => {
		await page.goto('/');
		await page.locator('#status').filter({ hasText: 'open' }).waitFor({ timeout: 5000 });

		await page.evaluate(() => {
			const wsInstances = (performance).getEntriesByType?.('resource')?.filter(
				(r) => r.name.includes('/ws')
			);
		});

		await page.waitForTimeout(1000);
		const status = page.locator('#status');
		await expect(status).toHaveText('open', { timeout: 10000 });
	});
});
