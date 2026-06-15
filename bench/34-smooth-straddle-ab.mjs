// Interpolation hot-path perf gate. Per render frame the smoothing pipeline
// resolves every visible remote entity through its sample ring (straddle
// search + lerp), where the raw pipeline reads the latest merged position.
// This bench measures that delta across entity counts in the steady state
// (a live 60 Hz stream, render time trailing between the two newest samples
// - the straddle scan's one-or-two-step regime).
//
//   A: direct read of the newest position (today's raw render build)
//   B: beginFrame + per-entity sampleInto through the ring
//
// Gate: 200 entities sampled in well under 1 ms per frame; the per-entity
// cost must be invisible against a 16.6 ms frame budget.
//
// Pure JS, no uWS, no real WS - this is a data-structure property, not a
// network property. Deterministic, repeatable, runs in < 1 s.

import { performance } from 'node:perf_hooks';
import { createSmoother } from '../src/plugins/smooth/interpolate.js';

const COUNTS = [50, 200, 500, 1000];
const FRAMES = 2000;
const ROUNDS = 7;

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Seed a smoother with `count` entities streaming at 60 Hz for ~500ms. */
function seedSmoother(count, baseT) {
	const s = createSmoother({ delayMs: 50, extrapolateMs: 250, snapGapMs: 500 });
	const keys = new Array(count);
	for (let i = 0; i < count; i++) keys[i] = 'k' + i;
	for (let f = 0; f < 32; f++) {
		const t = baseT + f * 16;
		for (let i = 0; i < count; i++) {
			s.ingest({ event: 'update', data: { key: keys[i], data: { x: f * 3 + i, y: f * 2 } }, t }, t);
		}
	}
	return { s, keys, newestT: baseT + 31 * 16 };
}

function benchSampled(count) {
	const baseT = 1_000_000;
	const { s, keys, newestT } = seedSmoother(count, baseT);
	const out = { x: 0, y: 0 };
	let sink = 0;

	// Steady state: each frame pushes one fresh sample per entity and the
	// render time trails 50ms behind, so the straddle lands at the newest
	// pair. Warmup, then timed frames.
	let t = newestT;
	const frame = () => {
		t += 16;
		for (let i = 0; i < count; i++) {
			s.ingest({ event: 'update', data: { key: keys[i], data: { x: t - baseT + i, y: i } }, t }, t);
		}
		const rt = s.beginFrame(t);
		for (let i = 0; i < count; i++) {
			s.sampleInto(keys[i], rt, out);
			sink += out.x;
		}
	};
	for (let f = 0; f < 200; f++) frame();

	// Time only the sampling half (the ingest is the wire path, identical in
	// both variants and excluded from the comparison).
	let total = 0;
	for (let f = 0; f < FRAMES; f++) {
		t += 16;
		for (let i = 0; i < count; i++) {
			s.ingest({ event: 'update', data: { key: keys[i], data: { x: t - baseT + i, y: i } }, t }, t);
		}
		const start = performance.now();
		const rt = s.beginFrame(t);
		for (let i = 0; i < count; i++) {
			s.sampleInto(keys[i], rt, out);
			sink += out.x;
		}
		total += performance.now() - start;
	}
	return { msPerFrame: total / FRAMES, sink };
}

function benchRaw(count) {
	const positions = new Map();
	const keys = new Array(count);
	for (let i = 0; i < count; i++) {
		keys[i] = 'k' + i;
		positions.set(keys[i], { x: i, y: i });
	}
	let sink = 0;
	const frame = (t) => {
		for (let i = 0; i < count; i++) {
			const p = positions.get(keys[i]);
			sink += p.x + t * 0;
		}
	};
	for (let f = 0; f < 200; f++) frame(f);
	let total = 0;
	for (let f = 0; f < FRAMES; f++) {
		const start = performance.now();
		frame(f);
		total += performance.now() - start;
	}
	return { msPerFrame: total / FRAMES, sink };
}

console.log('Interpolation sampling cost per render frame (steady-state 60 Hz stream)');
console.log('  frames timed per round: ' + FRAMES + ', rounds: ' + ROUNDS + ' (median)');

for (const count of COUNTS) {
	const raw = [];
	const sampled = [];
	for (let r = 0; r < ROUNDS; r++) {
		raw.push(benchRaw(count).msPerFrame);
		sampled.push(benchSampled(count).msPerFrame);
	}
	const a = median(raw);
	const b = median(sampled);
	const perEntity = (b * 1e6) / count;
	console.log('\n  ' + String(count).padStart(4) + ' entities');
	console.log('    A raw newest-read   ' + (a * 1000).toFixed(1).padStart(8) + ' us/frame');
	console.log('    B ring straddle     ' + (b * 1000).toFixed(1).padStart(8) + ' us/frame  (' + perEntity.toFixed(0) + ' ns/entity)');
	if (count === 200) {
		const pass = b < 1;
		console.log('    gate: 200 entities < 1 ms/frame -> ' + (pass ? 'PASS' : 'FAIL') + ' (' + (b * 1000).toFixed(1) + ' us)');
		if (!pass) process.exitCode = 1;
	}
}
