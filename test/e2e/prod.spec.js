import { test, expect } from '@playwright/test';
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
