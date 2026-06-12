// Real-browser proof of cursor smoothing: a remote mover sends two distant
// wire frames, and the canvas paints intermediate positions the wire never
// carried (render-in-the-past interpolation inside the worker), then settles.
// Runs against both the vite dev server and the production build, like the
// base cursor spec.

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

test('a smoothed canvas animates between wire frames and settles', async ({ page, baseURL }) => {
	const workerPromise = page.waitForEvent('worker', { timeout: 15000 });
	await page.goto('/smooth');
	await expect(page.locator('#mounted')).toHaveText('true');
	const worker = await workerPromise;
	expect(worker.url()).toContain('cursor-worker');

	// The worker negotiated the smoothing pipeline.
	await expect.poll(async () => worker.evaluate(() => {
		const d = globalThis.__cursorWorkerDebug;
		return d ? d.smoothing : false;
	}), { timeout: 5000 }).toBe(true);

	const m = await mover(baseURL, 'e2e-smooth');

	// Park the cursor and wait until it surfaces (the pipeline is live).
	m.move(40, 40);
	await expect(page.locator('#feed-size')).toHaveText('1', { timeout: 5000 });

	// A spread of wire frames, then silence. The fixture renders 700ms in
	// the past, so by the time the wire goes quiet a raw canvas would be at
	// rest - everything painted after that is the interpolator's.
	m.move(120, 90);
	await page.waitForTimeout(300);
	m.move(240, 170);
	await page.waitForTimeout(300);
	m.move(360, 260);
	await page.waitForTimeout(60);
	m.move(360, 260);

	// Let the wire-quiet point pass, then capture the render-in-the-past
	// window: the delayed playback is still in flight here.
	await page.waitForTimeout(300);
	const canvas = page.locator('#cursor-canvas');
	const shots = [];
	for (let i = 0; i < 6; i++) {
		shots.push(await canvas.screenshot());
		await page.waitForTimeout(120);
	}
	const distinct = new Set(shots.map((s) => s.toString('base64')));
	expect(distinct.size).toBeGreaterThanOrEqual(2);
	expect(shots[0].equals(shots[shots.length - 1])).toBe(false);

	// And it settles: once the buffered motion is played out, the paint (and
	// the widened dirty gate) come to rest.
	await page.waitForTimeout(1200);
	const restA = await canvas.screenshot();
	await page.waitForTimeout(250);
	const restB = await canvas.screenshot();
	expect(restA.equals(restB)).toBe(true);

	const dbg = await worker.evaluate(() => {
		const d = globalThis.__cursorWorkerDebug;
		return {
			smoothing: d.smoothing,
			smoothRings: d.smoothRings,
			smoothDelayMs: d.smoothDelayMs,
			smoothMotionPending: d.smoothMotionPending,
			clockOffsetMs: d.clockOffsetMs
		};
	});
	expect(dbg.smoothing).toBe(true);
	expect(dbg.smoothRings).toBeGreaterThanOrEqual(1);
	expect(dbg.smoothDelayMs).toBeGreaterThan(0);
	expect(dbg.smoothMotionPending).toBe(false);
	expect(typeof dbg.clockOffsetMs).toBe('number');

	m.ws.close();
});
