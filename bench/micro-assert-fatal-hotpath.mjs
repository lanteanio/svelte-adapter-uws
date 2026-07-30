// Microbenchmark: A/B the hot-path cost of the soft `assert(cond, ...)` guard
// against the hard `fatal(cond, ...)` guard on the SUCCESS branch - the only
// branch a healthy publish / message-dispatch / subscribe ever takes.
//
// The structural-invariant promotions replace `assert(cond, cat, ctx)` with
// `fatal(cond, cat, ctx)` at the publish envelope guard, the message platform
// guard, and the subscribe subscription-shape guard. Both functions short-circuit
// on a truthy condition with a single comparison (`if (cond) return;`), so the
// expectation is byte-unchanged hot-path cost. This needs the bench, not
// an estimate: a single-digit-percent regression on any hot path is a blocker.
//
// The production handler/platform modules are built against rollup-injected
// globals and cannot be imported here, so this drives the REAL `assert`/`fatal`
// from the runtime utils through the exact guard shapes the dispatch uses. That
// is the only thing the promotion changed on the hot path.
//
// Usage:
//   node bench/micro-assert-fatal-hotpath.mjs [iterations] [rounds]
// Defaults: 20_000_000 iterations, 12 rounds.

import { assert, fatal } from '../src/runtime/utils.js';

const ITERATIONS = parseInt(process.argv[2] || '20000000', 10);
const ROUNDS = parseInt(process.argv[3] || '12', 10);

// Hot-path operand shapes, all on the HEALTHY (truthy) branch.
const subs = new Set(['room']);
const platformSlot = {};            // a live per-connection platform clone
const envelope = '{"topic":"room","event":"tick","data":{"n":1}}';
const topic = 'room';
const event = 'tick';

// Variant A: the soft assert guards (pre-promotion shape).
function dispatchAssert() {
	// message platform guard
	assert(platformSlot, 'ws.platform-missing-in-message', null);
	// subscribe subscription-shape guard
	assert(subs instanceof Set, 'subs.shape', null);
	// publish envelope guard
	assert(envelope.length > 0, 'envelope.empty', { topic, event });
}

// Variant B: the hard fatal guards (post-promotion shape).
function dispatchFatal() {
	fatal(platformSlot, 'ws.platform-missing-in-message', null);
	fatal(subs instanceof Set, 'subs.shape', null);
	fatal(envelope.length > 0, 'envelope.empty', { topic, event });
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs) {
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function run(fn) {
	const t0 = performance.now();
	for (let i = 0; i < ITERATIONS; i++) fn();
	const t1 = performance.now();
	return t1 - t0;
}

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds, alternating`);
console.log('\nhot-path guard success branch: assert vs fatal (3 guards per iteration)');

for (let i = 0; i < 4; i++) { run(dispatchAssert); run(dispatchFatal); }

const assertMs = [];
const fatalMs = [];
for (let r = 0; r < ROUNDS; r++) {
	const a = run(dispatchAssert); assertMs.push(a);
	const b = run(dispatchFatal); fatalMs.push(b);
	process.stdout.write(`  Round ${r + 1}/${ROUNDS}: assert ${a.toFixed(1)}ms  fatal ${b.toFixed(1)}ms\n`);
}

const aMed = median(assertMs);
const bMed = median(fatalMs);
const aSd = stddev(assertMs);
const bSd = stddev(fatalMs);
const deltaPct = ((bMed - aMed) / aMed) * 100;

console.log(`\n  ${'assert'.padEnd(20)} median ${aMed.toFixed(2).padStart(8)}ms  +/- ${aSd.toFixed(2)}`);
console.log(`  ${'fatal'.padEnd(20)} median ${bMed.toFixed(2).padStart(8)}ms  +/- ${bSd.toFixed(2)}`);
console.log(`  ${'delta (slowdown)'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (positive = fatal slower)`);

const noiseFloor = (aSd / aMed) * 100;
if (Math.abs(deltaPct) <= noiseFloor) {
	console.log(`  VERDICT: noise (within baseline stddev ${noiseFloor.toFixed(2)}%) -> promotion is free on the hot path`);
} else if (deltaPct < 0) {
	console.log(`  VERDICT: fatal FASTER (V8 quirk, but free) by ${Math.abs(deltaPct).toFixed(2)}%`);
} else if (deltaPct < 1) {
	console.log(`  VERDICT: fatal slower by <1% (${deltaPct.toFixed(2)}%) -> negligible`);
} else {
	console.log(`  VERDICT: fatal slower by ${deltaPct.toFixed(2)}% -> BLOCKER (single-digit-% hot-path regression)`);
}
console.log();
