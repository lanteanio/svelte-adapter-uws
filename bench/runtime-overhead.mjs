// Microbenchmark: the overhead of reading the clock and arming/clearing a timer
// through the injectable runtime environment (src/runtime/runtime.js) versus calling
// the native primitives directly.
//
// The named helpers are one-line reads over a frozen, never-swapped environment
// object in production, so V8 should inline them down to the native primitive.
// This bench proves that: the gate is single-digit-percent overhead on now(),
// the hot-path primitive read on every published message / timestamped event.
//
// Usage:
//   node bench/runtime-overhead.mjs [now-iterations] [timer-iterations] [rounds]
//
// Defaults: 50,000,000 now() iters, 5,000,000 timer iters, 15 rounds.

import { performance } from 'node:perf_hooks';
import { now, setTimer, clearTimer } from '../src/runtime/runtime.js';

const NOW_ITERS = parseInt(process.argv[2] || '50000000', 10);
const TIMER_ITERS = parseInt(process.argv[3] || '5000000', 10);
const ROUNDS = parseInt(process.argv[4] || '15', 10);

// The native default clock the module wraps: a 1Hz-cached wall clock read.
// Mirror it here so the A/B compares like for like (a single variable read),
// not module-read-vs-Date.now (which would compare two different algorithms).
let cachedNow = Date.now();
const _refresher = setInterval(() => { cachedNow = Date.now(); }, 1000);
if (_refresher && _refresher.unref) _refresher.unref();
const nativeNow = () => cachedNow;

// Trimmed mean: sort, drop the top and bottom 20%, average the rest. More
// reproducible than a single median at the sub-3ns scale where one scheduler
// blip can swing a whole round.
function trimmedMean(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const drop = Math.floor(s.length * 0.2);
	const kept = s.slice(drop, s.length - drop);
	return kept.reduce((a, b) => a + b, 0) / kept.length;
}

// --- now() -----------------------------------------------------------------

function runNow(fn, iters) {
	let acc = 0;
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) {
		acc += fn();
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

// --- setTimer/clearTimer ---------------------------------------------------
// Arm a timer with a far-future delay and clear it immediately, so the callback
// never fires and we measure only the arm + clear cost. The handle is captured
// into an accumulator so the loop cannot be optimized away.

function runTimerModule(iters) {
	let acc = 0;
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) {
		const h = setTimer(noop, 1e9);
		clearTimer(h);
		acc++;
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

function runTimerNative(iters) {
	let acc = 0;
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) {
		const h = setTimeout(noop, 1e9);
		clearTimeout(h);
		acc++;
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

function noop() {}

// --- driver ----------------------------------------------------------------

function bench(label, runFn, iters, makeNative, makeModule) {
	// Warm up both paths to stable JIT tiering before measuring.
	for (let i = 0; i < 3; i++) {
		runFn(makeNative, iters);
		runFn(makeModule, iters);
	}

	const nativeMs = [];
	const moduleMs = [];
	let nAcc = 0, mAcc = 0;
	for (let r = 0; r < ROUNDS; r++) {
		const n = runFn(makeNative, iters); nativeMs.push(n.ms); nAcc += n.acc;
		const m = runFn(makeModule, iters); moduleMs.push(m.ms); mAcc += m.acc;
	}

	const nMed = trimmedMean(nativeMs);
	const mMed = trimmedMean(moduleMs);
	const nNs = (nMed * 1e6) / iters;
	const mNs = (mMed * 1e6) / iters;
	const overheadPct = ((mMed - nMed) / nMed) * 100;

	console.log(`\n${label}  (${iters.toLocaleString()} iters x ${ROUNDS} rounds)`);
	console.log(`  native  trimmed ${nMed.toFixed(2).padStart(9)}ms   ${nNs.toFixed(3)} ns/op`);
	console.log(`  module  trimmed ${mMed.toFixed(2).padStart(9)}ms   ${mNs.toFixed(3)} ns/op`);
	console.log(`  overhead ${overheadPct >= 0 ? '+' : ''}${overheadPct.toFixed(2)}%`);

	return { nNs, mNs, overheadPct, nAcc, mAcc };
}

console.log(`Node ${process.version}`);
console.log(`runtime environment overhead: module helpers vs native primitives`);

// now(): the hot path. Compare the module read against the same cached read
// done inline.
const nowResult = bench(
	'now()',
	(fn, iters) => runNow(fn, iters),
	NOW_ITERS,
	nativeNow,
	now
);

// setTimer/clearTimer: a control-plane primitive (resume windows, lease TTLs).
const timerResult = bench(
	'setTimer() + clearTimer()',
	(fn, iters) => fn(iters),
	TIMER_ITERS,
	runTimerNative,
	runTimerModule
);

console.log('\n--- gate ---');
const GATE = 10; // single-digit-percent: strictly less than 10%
const nowOk = Math.abs(nowResult.overheadPct) < GATE;
console.log(`now() overhead ${nowResult.overheadPct.toFixed(2)}%  gate < ${GATE}%  -> ${nowOk ? 'PASS' : 'FAIL'}`);
console.log(`setTimer/clearTimer overhead ${timerResult.overheadPct.toFixed(2)}% (informational)`);

process.exit(nowOk ? 0 : 1);
