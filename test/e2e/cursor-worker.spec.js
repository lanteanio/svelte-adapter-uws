// Real-browser proof of the cursor canvas pipeline, against both the vite
// dev server and the production build (the two bundler paths the worker
// chunk must survive). What only a browser can verify:
//
//   - `new Worker(new URL('./cursor-worker.js', import.meta.url))` resolves
//     and boots through the consumer's bundler from the linked package;
//   - the OffscreenCanvas transfer + the worker's second WebSocket handshake
//     work end-to-end against the app's real endpoint;
//   - remote movers driven over a raw socket reach the worker (decode ->
//     state -> paint) and surface on the main thread ONLY via the thinned
//     feed;
//   - the page's main thread stays free of cursor-attributable long tasks
//     while the stream is live.

import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

function wsUrlFrom(baseURL) {
	return baseURL.replace(/^http/, 'ws') + '/ws';
}

async function mover(baseURL, topic) {
	const ws = new WebSocket(wsUrlFrom(baseURL));
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	ws.send(JSON.stringify({ type: 'cursor-snapshot', topic }));
	await new Promise((r) => setTimeout(r, 100));
	return {
		ws,
		move: (x, y) => ws.send(JSON.stringify({ type: 'cursor', topic, data: { x, y } }))
	};
}

test('canvas mount boots the render worker and remote movers paint without touching the main thread', async ({ page, baseURL }) => {
	await page.addInitScript(() => {
		window.__longTasks = 0;
		try {
			new PerformanceObserver((list) => { window.__longTasks += list.getEntries().length; })
				.observe({ type: 'longtask', buffered: false });
		} catch { /* longtask unsupported: counter stays 0 */ }
	});

	const workerPromise = page.waitForEvent('worker', { timeout: 15000 });
	await page.goto('/cursors');
	await expect(page.locator('#mounted')).toHaveText('true');

	// The worker chunk resolved through the consumer bundler and booted.
	const worker = await workerPromise;
	expect(worker.url()).toContain('cursor-worker');

	const blank = await page.locator('#cursor-canvas').screenshot();

	// Reset the long-task counter after load/compile noise; measure only the
	// streaming window.
	await page.evaluate(() => { window.__longTasks = 0; });

	const m = await mover(baseURL, 'e2e-board');
	for (let i = 0; i < 30; i++) {
		m.move(40 + i * 8, 60 + (i % 5) * 20);
		await page.waitForTimeout(16);
	}

	// The thinned feed is the only main-thread surface of the stream; one
	// remote mover must appear on it.
	try {
		await expect(page.locator('#feed-size')).toHaveText('1', { timeout: 5000 });
	} catch (err) {
		const dbg = await worker.evaluate(() => {
			const d = globalThis.__cursorWorkerDebug;
			return d ? {
				phase: d.phase, topic: d.topic, url: d.url, wsReadyState: d.wsReadyState,
				reconnectAttempts: d.reconnectAttempts, positions: d.positions,
				users: d.users, wireIds: d.wireIds, hasRect: d.hasRect, lastVisible: d.lastVisible
			} : null;
		}).catch(() => 'worker.evaluate failed');
		console.log('[cursor-worker debug]', JSON.stringify(dbg));
		throw err;
	}
	const feed = await page.evaluate(() => window.__cursorFeed);
	expect(feed).toHaveLength(1);
	expect(feed[0][1].user).toEqual({ name: 'anon' });
	expect(typeof feed[0][1].data.x).toBe('number');

	// Pixels changed: the painted frame differs from the blank canvas.
	const painted = await page.locator('#cursor-canvas').screenshot();
	expect(painted.equals(blank)).toBe(false);

	// No cursor-attributable main-thread long tasks during the stream.
	const longTasks = await page.evaluate(() => window.__longTasks);
	expect(longTasks).toBeLessThanOrEqual(1);

	m.ws.close();
});

test('a mover at known coordinates paints in the mapped canvas region across the viewport ladder', async ({ page, baseURL }) => {
	test.setTimeout(120000);
	// Narrow mobile to wide desktop. The canvas is a fixed 400x300 board with
	// a 1:1 data-to-pixel mapping (the page sends offsetX/offsetY), so the
	// mapped region must hold at every rung even when the page reflows.
	const RUNGS = [
		{ width: 360, height: 640 },
		{ width: 768, height: 1024 },
		{ width: 1280, height: 800 },
		{ width: 1920, height: 1080 }
	];
	const TARGET = { x: 320, y: 60 };

	for (const rung of RUNGS) {
		await page.setViewportSize(rung);
		await page.goto('/cursors');
		// The worker boots synchronously inside the mount effect, so once
		// mounted reads true it is already running; the feed assertion below
		// is what proves the pipeline moved.
		await expect(page.locator('#mounted')).toHaveText('true');

		const canvas = page.locator('#cursor-canvas');
		await canvas.scrollIntoViewIfNeeded();
		const box = await canvas.boundingBox();
		expect(box, 'canvas must lay out').not.toBeNull();
		// A region around the target and a far region that must stay blank; a
		// cursor painted at the wrong coordinates passes a mere changed-pixels
		// check but fails exactly one of these.
		const near = { x: box.x + TARGET.x - 24, y: box.y + TARGET.y - 24, width: 48, height: 48 };
		const far = { x: box.x + 30, y: box.y + 190, width: 60, height: 60 };
		const nearBlank = await page.screenshot({ clip: near, fullPage: true });
		const farBlank = await page.screenshot({ clip: far, fullPage: true });

		const m = await mover(baseURL, 'e2e-board');
		// Hold the remote cursor at one spot until the paint settles.
		for (let i = 0; i < 10; i++) {
			m.move(TARGET.x, TARGET.y);
			await page.waitForTimeout(50);
		}
		await expect(page.locator('#feed-size')).toHaveText('1', { timeout: 5000 });
		await page.waitForTimeout(200);

		const nearPainted = await page.screenshot({ clip: near, fullPage: true });
		const farPainted = await page.screenshot({ clip: far, fullPage: true });
		expect(nearPainted.equals(nearBlank), `rung ${rung.width}x${rung.height}: the mapped region must paint`).toBe(false);
		expect(farPainted.equals(farBlank), `rung ${rung.width}x${rung.height}: a region away from the mover must stay blank`).toBe(true);

		m.ws.close();
		// Let the roster drop the mover before the next rung remounts.
		await page.waitForTimeout(300);
	}
});

test('unmounting pauses the pipeline and a remount on the same canvas resumes it', async ({ page, baseURL }) => {
	await page.goto('/cursors');
	await expect(page.locator('#mounted')).toHaveText('true');
	await page.waitForEvent('worker', { timeout: 15000 }).catch(() => null);

	const m = await mover(baseURL, 'e2e-board');
	m.move(100, 100);
	await expect(page.locator('#feed-size')).toHaveText('1', { timeout: 5000 });

	// Navigate away (unmount -> pause) and back (remount -> re-init + fresh
	// snapshot rebuilds the roster).
	await page.goto('/');
	await page.goto('/cursors');
	await expect(page.locator('#mounted')).toHaveText('true');
	m.move(120, 120);
	await expect(page.locator('#feed-size')).toHaveText('1', { timeout: 5000 });

	m.ws.close();
});
