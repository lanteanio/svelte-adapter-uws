// Upgrade-path overhead A/B: does enabling the admission gate, a metrics
// registry, or the protection posture change how fast the server accepts
// WebSocket upgrades? No mock, no estimate - a live uWS server through the
// createTestServer harness (the same gate, waiting room, and posture wiring
// as the production upgrade path), real `ws` clients, and full
// upgrade -> open -> close cycles measured end to end.
//
// The gate ceiling is set far above the bench's concurrency so every cycle
// takes the accept path - this measures accept-path overhead, never the
// reject path.
//
// Run: node bench/admission-upgrade-overhead.mjs    (~10-30 s)

import { WebSocket } from 'ws';
import { createTestServer } from '../src/testing.js';

const CYCLES = parseInt(process.env.CYCLES || '4000');
const LANES = parseInt(process.env.LANES || '50');
const ROUNDS = 3;

// Map-backed registry stand-in approximating the prometheus registry's
// per-call work (label-key build + Map lookup + write) without a cross-package
// import. Shape-compatible with the `metrics` option: positional
// counter/gauge factories, `inc(labels?)`, number-first `set(n)`.
function miniRegistry() {
	const series = new Map();
	const seriesKey = (name, labels) =>
		labels && typeof labels === 'object' ? name + JSON.stringify(labels) : name;
	const make = (name) => ({
		inc(labels, n) {
			const k = seriesKey(name, labels);
			const add = typeof labels === 'number' ? labels : (n ?? 1);
			series.set(k, (series.get(k) || 0) + add);
		},
		set(labels, n) {
			const k = seriesKey(name, labels);
			series.set(k, typeof labels === 'number' ? labels : n);
		},
		dec() {},
		observe() {}
	});
	return {
		counter: (name) => make(name),
		gauge: (name) => make(name),
		histogram: (name) => make(name),
		_series: series
	};
}

// `metrics` is ignored by a tree that does not support the option yet, so the
// same file benches both sides of a change: on the old tree the two metrics
// configs read as gate-only controls; on the new tree they price the registry.
const CONFIGS = [
	{ name: 'no gate, no metrics (default)', options: () => ({}) },
	{ name: 'gate on, no metrics', options: () => ({ upgradeAdmission: { maxConcurrent: 1024 } }) },
	{ name: 'gate on, metrics on', options: () => ({ upgradeAdmission: { maxConcurrent: 1024 }, metrics: miniRegistry() }) },
	{ name: 'gate + auto posture + metrics', options: () => ({ upgradeAdmission: { maxConcurrent: 1024 }, protection: 'auto', metrics: miniRegistry() }) }
];

let failures = 0; // per-config; reset before each config's rounds

function cycle(url) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url);
		ws.on('open', () => ws.close());
		ws.on('close', () => resolve());
		ws.on('error', () => { failures++; ws.terminate(); resolve(); });
	});
}

async function lane(url, count) {
	for (let i = 0; i < count; i++) await cycle(url);
}

async function round(url) {
	const per = Math.ceil(CYCLES / LANES);
	const t0 = performance.now();
	await Promise.all(Array.from({ length: LANES }, () => lane(url, per)));
	const dt = (performance.now() - t0) / 1000;
	return (per * LANES) / dt;
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pad = (s, n) => String(s).padStart(n);

console.log('Upgrade accept-path A/B - full upgrade -> open -> close cycles against a live uWS server');
console.log(CYCLES + ' cycles/round x ' + ROUNDS + ' rounds, ' + LANES + ' parallel lanes, ceiling 1024 (accept path only)\n');

let anyFailures = false;

for (const cfg of CONFIGS) {
	const server = await createTestServer(cfg.options());
	await round(server.wsUrl); // warmup: JIT, socket pools, route caches
	failures = 0;
	const rates = [];
	for (let r = 0; r < ROUNDS; r++) rates.push(await round(server.wsUrl));
	await server.close();
	console.log(
		pad(cfg.name, 34) + '  ' +
		rates.map((r) => pad(Math.round(r), 8)).join('') +
		'   median ' + pad(Math.round(median(rates)), 8) + ' upgrades/s' +
		(failures > 0 ? '   [' + failures + ' errored cycle(s) - numbers suspect]' : '')
	);
	if (failures > 0) anyFailures = true;
}

process.exit(anyFailures ? 1 : 0);
