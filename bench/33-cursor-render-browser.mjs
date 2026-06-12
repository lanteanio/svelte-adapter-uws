// Cursor renderer paint cost in a REAL browser: Canvas2D vs WebGL2 across
// density rungs, driven through the shipped selectRenderer factory (no mocks,
// no node-canvas substitutes). A throwaway static server serves the repo root
// so the render modules load as native ESM; Playwright Chromium executes and
// times them.
//
// Mode printing: headless Chromium typically runs WebGL2 on SwiftShader
// (software GL) - the reported GL renderer string says exactly which path was
// measured. Pass --headed to run on the real GPU for the numbers that matter
// on reference hardware; headless remains valid for the RELATIVE comparison
// and for correctness.
//
// Timing: render() submit cost plus a gl.finish() fence per frame for the GL
// backend, so queued GPU work is included rather than deferred out of the
// measurement. Median of 60 frames per rung after 10 warmup frames.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');

const PAGE = `<!doctype html>
<html><body>
<script type="module">
import { selectRenderer } from '/plugins/cursor/render/index.js';

const RUNGS = [100, 1000, 5000, 10000, 50000];

function cursorsFor(n) {
	const a = [];
	for (let i = 0; i < n; i++) {
		a.push({ x: (i * 37) % 800, y: (i * 53) % 600, colorRGBA: ((0x3cb44b00 + i * 2654435761) | 0xff) >>> 0, hidden: false });
	}
	return a;
}

async function benchBackend(backend) {
	const canvas = document.createElement('canvas');
	canvas.width = 800; canvas.height = 600;
	document.body.appendChild(canvas);
	let renderer;
	try {
		renderer = selectRenderer(canvas, { gpu: backend, devicePixelRatio: 1 });
	} catch (e) {
		return { error: String(e && e.message) };
	}
	renderer.resize(800, 600);
	const out = {};
	for (const n of RUNGS) {
		const cursors = cursorsFor(n);
		for (let i = 0; i < 10; i++) renderer.render(cursors, n);
		if (renderer.gl) renderer.gl.finish();
		const times = [];
		for (let i = 0; i < 60; i++) {
			const t0 = performance.now();
			renderer.render(cursors, n);
			if (renderer.gl) renderer.gl.finish();
			times.push(performance.now() - t0);
		}
		times.sort((a, b) => a - b);
		out[n] = times[30];
		await new Promise((r) => requestAnimationFrame(r));
	}
	let glInfo = null;
	if (renderer.gl) {
		const dbg = renderer.gl.getExtension('WEBGL_debug_renderer_info');
		glInfo = dbg ? renderer.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unavailable';
	}
	renderer.dispose();
	return { out, glInfo };
}

window.__run = async () => ({
	canvas2d: await benchBackend('canvas2d'),
	webgl2: await benchBackend('webgl2')
});
</script>
</body></html>`;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

const server = createServer(async (req, res) => {
	const url = req.url.split('?')[0];
	if (url === '/' || url === '/index.html') {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(PAGE);
		return;
	}
	try {
		const file = join(root, url);
		const body = await readFile(file);
		res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404);
		res.end('not found');
	}
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
const results = await page.evaluate(() => window.__run());
await browser.close();
server.close();

console.log('Cursor renderer paint cost (real Chromium, 800x600, dpr 1, ' + (headed ? 'HEADED / real GPU' : 'HEADLESS') + ')');
if (results.webgl2 && results.webgl2.glInfo) {
	console.log('  WebGL2 renderer: ' + results.webgl2.glInfo);
}
const rungs = [100, 1000, 5000, 10000, 50000];
const fmt = (v) => (v === undefined ? '      n/a' : v.toFixed(2).padStart(9));
console.log('\n  cursors      canvas2d ms/frame    webgl2 ms/frame');
for (const n of rungs) {
	const c = results.canvas2d.out ? results.canvas2d.out[n] : undefined;
	const g = results.webgl2.out ? results.webgl2.out[n] : undefined;
	console.log('  ' + String(n).padStart(7) + '  ' + fmt(c) + '            ' + fmt(g));
}
if (results.canvas2d.error) console.log('  canvas2d error: ' + results.canvas2d.error);
if (results.webgl2.error) console.log('  webgl2 error: ' + results.webgl2.error);

const c1k = results.canvas2d.out && results.canvas2d.out[1000];
const g50k = results.webgl2.out && results.webgl2.out[50000];
console.log('\n  bars: canvas2d @1K < 16.6ms -> ' + (c1k !== undefined ? (c1k < 16.6 ? 'PASS' : 'FAIL') + ' (' + c1k.toFixed(2) + 'ms)' : 'n/a')
	+ ' | webgl2 @50K < 16.6ms -> ' + (g50k !== undefined ? (g50k < 16.6 ? 'PASS' : 'FAIL') + ' (' + g50k.toFixed(2) + 'ms)' : 'n/a'));
console.log();
