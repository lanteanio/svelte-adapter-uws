// Cursor mainThreadFeed boundary cost: the worker-side sample/encode loop, a
// REAL worker-thread postMessage with a transfer list, and the main-side Map
// reconstruct - the three costs the feed adds per tick at its capped rate.
//
// Mirrors the shipped code paths: the sample loop is the shape of
// plugins/cursor/cursor-worker.js postFeed (keys array + transferred
// Float32Array positions + Uint32Array colors), the reconstruct is the shape
// of the feed sink in plugins/cursor/client.js (Map of
// { user, data: {x, y}, colorRGBA } joined against a cached roster).
// node:worker_threads postMessage uses the same structured-clone + transfer
// semantics as a browser Worker, so the boundary is measured, not modeled.
//
// The question this answers: is the feed an incidental cost (sub-millisecond
// main-thread work per tick at realistic densities) or a second rendering
// path sneaking back onto the main thread? Deterministic densities, < 5 s.

import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const DENSITIES = [50, 200, 500, 2000];
const TICKS = 200;

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const workerSource = `
const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');

let pool = [];
parentPort.on('message', (msg) => {
	if (msg.type === 'setup') {
		pool = [];
		for (let i = 0; i < msg.n; i++) {
			pool.push({ key: 'instance-7f3a9c:' + i, bx: (i * 37) % 1920, by: (i * 53) % 1080, colorRGBA: (0xe6194bff + i) >>> 0 });
		}
		parentPort.postMessage({ type: 'ready' });
		return;
	}
	if (msg.type === 'tick') {
		// The sample/encode loop the render worker runs per feed tick.
		const t0 = performance.now();
		const n = pool.length;
		const keys = new Array(n);
		const positions = new Float32Array(n * 2);
		const colors = new Uint32Array(n);
		for (let i = 0; i < n; i++) {
			const c = pool[i];
			keys[i] = c.key;
			positions[i * 2] = c.bx;
			positions[i * 2 + 1] = c.by;
			colors[i] = c.colorRGBA;
		}
		const encodeNs = (performance.now() - t0) * 1e6;
		parentPort.postMessage(
			{ type: 'feed', keys, positions, colors, encodeNs, sentAt: performance.now() },
			[positions.buffer, colors.buffer]
		);
	}
});
`;

const worker = new Worker(workerSource, { eval: true });

function once(type) {
	return new Promise((resolve) => {
		const h = (msg) => { if (msg.type === type) { worker.off('message', h); resolve(msg); } };
		worker.on('message', h);
	});
}

console.log('Cursor mainThreadFeed boundary microbench (worker_threads round-trip, transfer list)');
console.log('  per tick at the default 10 Hz cap; reconstruct mirrors the client feed sink');

for (const n of DENSITIES) {
	worker.postMessage({ type: 'setup', n });
	await once('ready');

	// Roster cache the reconstruct joins against, as the client keeps it.
	const roster = new Map();
	for (let i = 0; i < n; i++) roster.set('instance-7f3a9c:' + i, { name: 'user-' + i, team: i % 5 });

	const encode = [], transit = [], reconstruct = [];
	let sink;
	for (let t = 0; t < TICKS; t++) {
		worker.postMessage({ type: 'tick' });
		const msg = await once('feed');
		const arrived = performance.now();
		const t0 = performance.now();
		const map = new Map();
		const { keys, positions, colors } = msg;
		for (let i = 0; i < keys.length; i++) {
			map.set(keys[i], {
				user: roster.get(keys[i]),
				data: { x: positions[i * 2], y: positions[i * 2 + 1] },
				colorRGBA: colors[i]
			});
		}
		reconstruct.push((performance.now() - t0) * 1e6);
		encode.push(msg.encodeNs);
		transit.push((arrived - msg.sentAt) * 1e6);
		sink = map; // keep the result alive
	}
	void sink;

	const us = (ns) => (ns / 1000).toFixed(1).padStart(8);
	console.log('\n' + n + ' in-view cursors');
	console.log('  worker sample+encode   median ' + us(median(encode)) + ' us/tick');
	console.log('  postMessage transit    median ' + us(median(transit)) + ' us/tick  (transfer list, structured-clone keys)');
	console.log('  main reconstruct       median ' + us(median(reconstruct)) + ' us/tick' + (n === 500 ? '  <- the sub-1ms bar' : ''));
}

await worker.terminate();
console.log();
