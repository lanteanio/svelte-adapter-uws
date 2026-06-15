// Allocation gate for the interpolation RENDER path: beginFrame plus the
// per-entity straddle/extrapolation sampling must allocate NOTHING in the
// steady state - a per-frame allocation here would GC-stall the worker
// render loop, which is a blocker, not a warning. (The ingest path's event
// objects are the wire decoder's, allocated at the wire boundary regardless
// of smoothing, and are deliberately outside this gate.)
//
// Method: with the rings populated and the heap settled (forced GC), run a
// window of sampling-only frames over a fixed entity set and read heapUsed
// growth BEFORE any collection can hide churn. The window stays inside the
// new space, so even one small object per entity per frame shows up as
// megabytes.
//
// Run with:  node --expose-gc bench/micro-smooth-alloc.mjs

import { createSmoother } from '../src/plugins/smooth/interpolate.js';

if (typeof globalThis.gc !== 'function') {
	console.error('run with --expose-gc');
	process.exit(1);
}

const ENTITIES = 200;
const FRAMES = 500;

const s = createSmoother({ delayMs: 50, extrapolateMs: 250, snapGapMs: 500 });
const keys = [];
const baseT = 1_000_000;
for (let i = 0; i < ENTITIES; i++) keys.push('k' + i);

// Populate every ring with ~500ms of 60 Hz history (rings allocate once per
// entity, never per frame) and warm every sampling branch.
let t = baseT;
for (let f = 0; f < 32; f++) {
	t += 16;
	for (let i = 0; i < ENTITIES; i++) {
		s.ingest({ event: 'update', data: { key: keys[i], data: { x: f * 3 + i, y: i } }, t }, t);
	}
}

const out = { x: 0, y: 0 };
let mono = t;
// The render time walks back and forth across the buffered span so the
// straddle search exercises shallow AND deep scans, extrapolation, and the
// buffer-ahead branch - none of which may allocate.
function frame(f) {
	mono += 16;
	const rt = s.beginFrame(mono) - ((f % 40) * 12);
	let sink = 0;
	for (let i = 0; i < ENTITIES; i++) {
		s.sampleInto(keys[i], rt, out);
		sink += out.x;
	}
	return sink;
}
let sink = 0;
for (let f = 0; f < 300; f++) sink += frame(f);

globalThis.gc();
globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let f = 0; f < FRAMES; f++) sink += frame(f);
const growth = process.memoryUsage().heapUsed - before;

const perFrame = growth / FRAMES;
const perEntityFrame = perFrame / ENTITIES;
console.log('steady-state heap growth over ' + FRAMES + ' frames x ' + ENTITIES + ' entities (sink ' + (sink > 0) + ')');
console.log('  total      ' + growth + ' bytes');
console.log('  per frame  ' + perFrame.toFixed(1) + ' bytes');
console.log('  per entity ' + perEntityFrame.toFixed(3) + ' bytes/frame');

// Noise floor: timer/engine internals account for a few KB across the whole
// window. One small object per entity per frame would read ~32 bytes here.
const GATE_BYTES_PER_ENTITY_FRAME = 2;
const pass = perEntityFrame < GATE_BYTES_PER_ENTITY_FRAME;
console.log('  gate: < ' + GATE_BYTES_PER_ENTITY_FRAME + ' bytes/entity/frame -> ' + (pass ? 'PASS' : 'FAIL'));
if (!pass) process.exitCode = 1;
