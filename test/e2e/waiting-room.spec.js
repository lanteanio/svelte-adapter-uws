// Real-browser proof of the waiting-room surfaces, across a viewport
// ladder from narrow mobile to wide desktop. What only a browser can
// verify:
//
//   - the built-in holding page RENDERS its states: rest (the initial
//     status line), update (the live status region rewritten from a poll),
//     failure (a poll that cannot reach the server is a visible, announced
//     state) and recovery from it - all driven by the page's own inline
//     script against the real admit endpoint;
//   - the refused WS-path navigation serves the same page at capacity;
//   - with the room opted out, an HTML navigation at capacity receives the
//     minimal accessible 503 document with its manual recovery form;
//   - at every ladder rung the panel fits the viewport: visible, no
//     horizontal overflow, controls on screen.
//
// The spec owns its two servers (tiny gates it saturates over real
// sockets), built from the waitingdefault and waitingoff fixture variants
// in beforeAll; the shared dev/prod servers never sit at capacity, so
// these states are unreachable there.

import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

// Narrow mobile to wide desktop; every state asserts per rung.
const RUNGS = [
	{ width: 360, height: 640 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 },
	{ width: 1920, height: 1080 }
];

const FAILURE_TEXT = 'The last check did not reach the server. Retrying.';
const HEALTHY_STATUS = /(Waiting for a free slot\.|About .+ waiting for a free slot\.)/;

function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close();
				reject(new Error('no port assigned'));
				return;
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

function startVariantServer(port, buildDir) {
	return new Promise((resolve, reject) => {
		const proc = spawn('node', [path.join(__dirname, 'variant-server.js'), String(port), buildDir], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let output = '';
		let resolved = false;
		const timer = setTimeout(() => {
			if (!resolved) { resolved = true; proc.kill(); reject(new Error('variant server start timeout\n' + output)); }
		}, 30000);
		const check = () => {
			if (!resolved && (output.includes('Listening on') || output.includes('localhost:'))) {
				resolved = true;
				clearTimeout(timer);
				resolve(proc);
			}
		};
		proc.stdout.on('data', (c) => { output += c.toString(); check(); });
		proc.stderr.on('data', (c) => { output += c.toString(); check(); });
		proc.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(timer); reject(err); } });
		proc.on('exit', (code) => {
			if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error('variant server exited ' + code + '\n' + output)); }
		});
	});
}

// Fill the tiny gate with real held connections so the admit endpoint
// answers 202 and the page's states hold still for assertions.
async function saturate(port, count) {
	const holders = [];
	for (let i = 0; i < count; i++) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
		holders.push(ws);
	}
	return holders;
}

// Panel-geometry assertions shared by every rung: the main panel is on
// screen and the document does not scroll horizontally.
async function expectPanelFits(page, viewport) {
	const main = page.locator('main');
	await expect(main).toBeVisible();
	const box = await main.boundingBox();
	expect(box, 'main panel must have a box').not.toBeNull();
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(overflow, 'no horizontal overflow').toBeLessThanOrEqual(0);
}

let roomPort;
let roomServer;
let roomHolders = [];
let offPort;
let offServer;
let offHolders = [];

test.beforeAll(async () => {
	// Two vite builds dominate this hook; give it a real budget.
	test.setTimeout(360000);
	execSync('npx vite build', { cwd: fixtureDir, stdio: 'pipe', env: { ...process.env, FIXTURE_VARIANT: 'waitingdefault' } });
	execSync('npx vite build', { cwd: fixtureDir, stdio: 'pipe', env: { ...process.env, FIXTURE_VARIANT: 'waitingoff' } });
	roomPort = await pickFreePort();
	roomServer = await startVariantServer(roomPort, 'build-waiting-default');
	offPort = await pickFreePort();
	offServer = await startVariantServer(offPort, 'build-waiting-off');
	roomHolders = await saturate(roomPort, 2);
	offHolders = await saturate(offPort, 2);
});

test.afterAll(async () => {
	for (const ws of [...roomHolders, ...offHolders]) {
		try { ws.terminate(); } catch { /* gone */ }
	}
	for (const proc of [roomServer, offServer]) {
		if (!proc) continue;
		try { proc.stdin.end(); } catch { /* gone */ }
		try { proc.kill('SIGTERM'); } catch { /* gone */ }
	}
});

for (const rung of RUNGS) {
	const label = `${rung.width}x${rung.height}`;

	test(`holding page rest, failure, and recovery states render at ${label}`, async ({ page }) => {
		await page.setViewportSize(rung);
		await page.goto(`http://127.0.0.1:${roomPort}/__waiting-room`);

		// REST: the document shell and the persistent status region, before
		// any state transition.
		await expect(page.locator('h1')).toHaveText('Server at capacity');
		const status = page.locator('#s[role="status"]');
		await expect(status).toHaveText(HEALTHY_STATUS);
		await expect(page.locator('#p')).toHaveText('Pause live updates');
		await expectPanelFits(page, rung);

		// FAILURE: a poll that cannot reach the server is a visible state,
		// not a silent retry behind a stale number. Blocking the admit
		// endpoint at the browser boundary is the same fetch failure a dead
		// server produces, without tearing down the page under test.
		await page.route('**/__admit-check*', (route) => route.abort());
		await expect(status).toHaveText(FAILURE_TEXT, { timeout: 10000 });
		await expectPanelFits(page, rung);

		// RECOVERY: the next reachable poll announces its way back.
		await page.unroute('**/__admit-check*');
		await expect(status).toHaveText(HEALTHY_STATUS, { timeout: 10000 });
	});

	test(`holding page status region updates from the live poll at ${label}`, async ({ page }) => {
		await page.setViewportSize(rung);
		// Let the rolling crowd estimate from earlier pages drain (it reads 0
		// after two silent poll windows), so the server-rendered seed is the
		// no-crowd line and the transition below is an OBSERVED rewrite, not
		// a seed that already carried the count. Two 2000ms windows plus the
		// runtime's 1s-cached clock plus margin.
		await page.waitForTimeout(6000);
		await page.goto(`http://127.0.0.1:${roomPort}/__waiting-room`);
		const status = page.locator('#s[role="status"]');
		// The seed before any poll registered.
		await expect(status).toHaveText('Waiting for a free slot.');
		// UPDATE: the page's own first poll registers in the crowd estimate
		// and the inline script rewrites the persistent live region.
		await expect(status).toHaveText('About 1 person is waiting for a free slot.', { timeout: 10000 });
		await expectPanelFits(page, rung);
	});

	test(`opted-out fallback serves the accessible 503 at ${label}`, async ({ page }) => {
		await page.setViewportSize(rung);
		const response = await page.goto(`http://127.0.0.1:${offPort}/ws`);
		expect(response.status()).toBe(503);
		expect(Number(response.headers()['retry-after'])).toBeGreaterThanOrEqual(2);
		await expect(page.locator('h1')).toHaveText('Server at capacity');
		await expect(page.locator('[role="status"]')).toHaveText(
			'New connections cannot be opened right now. Try again later.'
		);
		await expect(page.locator('form button[type="submit"]')).toHaveText('Try again');
		await expectPanelFits(page, rung);
	});
}

test('the refused WS-path navigation serves the holding page at capacity', async ({ page }) => {
	const response = await page.goto(`http://127.0.0.1:${roomPort}/ws`);
	// The gate is full: a browser navigation gets the self-polling page.
	expect(response.status()).toBe(200);
	await expect(page.locator('h1')).toHaveText('Server at capacity');
	await expect(page.locator('#s[role="status"]')).toHaveText(HEALTHY_STATUS);
});
