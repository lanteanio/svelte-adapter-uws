// Allocation gate for the prediction reconciliation path: a steady-state
// command + ack cycle must allocate nothing beyond what the predictor
// produces by contract. Two allocations per cycle ARE the contract: the
// window entry recorded per command, and the `{ divergence, sentMono }`
// result each ack returns to the caller. Everything else - the prefix drop,
// the rebase, the tail replay, the offset bookkeeping - must be free, or a
// busy owner entity would GC-stall its frame loop.
//
// Method: an IDENTITY apply (returns the same state reference) excludes all
// application-state allocation, so the measured heap growth is the
// predictor's own. With the heap settled (forced GC), a window of cycles at
// a fixed window depth is measured BEFORE any collection can hide churn.
// The by-contract cost is calibrated in the same window by allocating the
// same two object shapes directly; the gate covers only the difference,
// with a small margin for the amortized window compaction (the periodic
// splice that trims the consumed prefix).
//
// Run with:  node --expose-gc bench/micro-smooth-replay-alloc.mjs

import { createPredictor } from '../plugins/smooth/predict.js';

if (typeof globalThis.gc !== 'function') {
	console.error('run with --expose-gc');
	process.exit(1);
}

const DEPTH = 8;
const CYCLES = 10000;
const WARMUP = 3000;

const initial = { x: 0, y: 0 };
const identity = (s) => s;
const CMD = { go: 1 };

const p = createPredictor({
	apply: identity,
	initial,
	windowCap: 256,
	windowMaxAgeMs: Number.MAX_SAFE_INTEGER,
	smoothTimeMs: 100
});

let mono = 0;
let ackId = 0;
for (let i = 0; i < DEPTH; i++) p.command(CMD, ++mono);

let sink = 0;
function cycle() {
	p.command(CMD, ++mono);
	const r = p.ack(++ackId, initial, mono);
	return r.divergence;
}
for (let i = 0; i < WARMUP; i++) sink += cycle();

globalThis.gc();
globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < CYCLES; i++) sink += cycle();
const growth = process.memoryUsage().heapUsed - before;
const perCycle = growth / CYCLES;

// Calibrate the by-contract cost per cycle: one window entry per command
// plus one ack result. The shapes mirror the predictor's exactly; keeping
// them briefly live in small rings stops the allocations being elided.
const entryRing = new Array(DEPTH).fill(null);
const resultRing = new Array(2).fill(null);
function calibrate(i) {
	entryRing[i % DEPTH] = { id: i, cmd: CMD, sentMono: i };
	return entryRing[i % DEPTH].id;
}
function calibrateResult(i) {
	resultRing[i % 2] = { divergence: 0, sentMono: i };
	return resultRing[i % 2].sentMono;
}
for (let i = 0; i < WARMUP; i++) sink += calibrate(i) + calibrateResult(i);
globalThis.gc();
globalThis.gc();
const beforeEntry = process.memoryUsage().heapUsed;
for (let i = 0; i < CYCLES; i++) sink += calibrate(i);
const entryCost = (process.memoryUsage().heapUsed - beforeEntry) / CYCLES;
globalThis.gc();
globalThis.gc();
const beforeResult = process.memoryUsage().heapUsed;
for (let i = 0; i < CYCLES; i++) sink += calibrateResult(i);
const resultCost = (process.memoryUsage().heapUsed - beforeResult) / CYCLES;

console.log('steady-state heap growth over ' + CYCLES + ' command+ack cycles at window depth ' + DEPTH + ' (sink ' + (sink >= 0) + ')');
console.log('  total                ' + growth + ' bytes');
console.log('  per cycle            ' + perCycle.toFixed(1) + ' bytes');
console.log('breakdown (by-contract allocations, calibrated):');
console.log('  window entry         ' + entryCost.toFixed(1) + ' bytes/cycle (one per command, by design)');
console.log('  ack result           ' + resultCost.toFixed(1) + ' bytes/cycle (one per ack, returned to the caller)');
console.log('  residual             ' + (perCycle - entryCost - resultCost).toFixed(1) + ' bytes/cycle (compaction amortization + noise; negative when the optimizer elides by-contract objects in context)');

// The gate covers only unexpected garbage: the by-design window entry plus
// a 32-byte margin absorbing the ack result and the amortized compaction.
const GATE = entryCost + 32;
const pass = perCycle < GATE;
console.log('  gate: < entry cost + 32 bytes = ' + GATE.toFixed(1) + ' bytes/cycle -> ' + (pass ? 'PASS' : 'FAIL') + ' (' + perCycle.toFixed(1) + ')');
if (!pass) process.exitCode = 1;
