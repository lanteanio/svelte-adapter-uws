// Micro-bench for the pressure sampler fold. The 1 Hz pressure tick
// gained a per-connection getBufferedAmount() walk to report aggregate
// backpressure. That walk is the ONLY per-connection iteration the sampler
// does, so it must stay bounded: on a worker holding 100k sockets a naive
// O(connections) walk each second would add loop jitter. The fix is a sample
// cap (BACKPRESSURE_SAMPLE_CAP). This bench proves the capped fold's cost is
// constant in the connection count - a 100k-connection worker pays the same
// per-tick cost as a 1k one - by timing the shipped fold against an uncapped
// baseline over the same mock connection set.
//
// Run: node bench/pressure-sampler-micro.mjs

import { foldConnectionBackpressure, BACKPRESSURE_SAMPLE_CAP, BACKPRESSURE_SAMPLE_THRESHOLD_BYTES } from '../src/runtime/utils/backpressure.js';

const T = BACKPRESSURE_SAMPLE_THRESHOLD_BYTES;

// Build a mock connection set. getBufferedAmount is a plain getter here; in
// production it is a single C++ call, but the point of this bench is the WALK
// cost (loop + call overhead + cap check), which the mock reproduces.
function buildConns(n) {
	const set = new Set();
	for (let i = 0; i < n; i++) {
		const buffered = i % 97 === 0 ? 128 * 1024 : (i % 7) * 1024; // a few over threshold
		set.add({ getBufferedAmount: () => buffered });
	}
	return set;
}

function timeFold(conns, cap, iters) {
	// Warm up.
	for (let i = 0; i < 50; i++) foldConnectionBackpressure(conns, cap, T);
	const t0 = performance.now();
	let sink = 0;
	for (let i = 0; i < iters; i++) {
		const r = foldConnectionBackpressure(conns, cap, T);
		sink += r.maxBufferedBytes + r.backpressuredConnections + r.sampled;
	}
	const ms = performance.now() - t0;
	return { usPerTick: (ms * 1000) / iters, sink };
}

const ITERS = 2000;
const SIZES = [1_000, 10_000, 100_000];

console.log('\ng27 pressure-sampler fold micro-bench  (cap=' + BACKPRESSURE_SAMPLE_CAP + ', ' + ITERS + ' ticks/measure)');
console.log('  ' + 'conns'.padStart(8) + '  ' + 'capped us/tick'.padStart(16) + '  ' + 'uncapped us/tick'.padStart(18) + '  ' + 'speedup'.padStart(9));

let capped100k = 0;
let capped1k = 0;
for (const n of SIZES) {
	const conns = buildConns(n);
	const capped = timeFold(conns, BACKPRESSURE_SAMPLE_CAP, ITERS);
	const uncapped = timeFold(conns, n, ITERS); // cap == n means walk everything
	if (n === 100_000) capped100k = capped.usPerTick;
	if (n === 1_000) capped1k = capped.usPerTick;
	const speedup = uncapped.usPerTick / capped.usPerTick;
	console.log('  ' + String(n).padStart(8) + '  ' +
		capped.usPerTick.toFixed(2).padStart(16) + '  ' +
		uncapped.usPerTick.toFixed(2).padStart(18) + '  ' +
		(speedup >= 1.5 ? speedup.toFixed(1) + 'x' : '~1x').padStart(9));
}

// The capped walk should cost about the same at 100k connections as at 1k
// (both stop at the cap), so its per-tick cost is bounded regardless of scale.
const ratio = capped100k / Math.max(capped1k, 0.0001);
console.log('\n  capped cost 100k vs 1k connections: ' + ratio.toFixed(2) + 'x  (bounded: should be ~1x, well under the connection ratio of 100x)');
console.log('  ' + (ratio < 3 ? 'PASS - capped fold cost is bounded in the connection count.' : 'WARN - capped fold cost grew with connections; investigate the cap.'));
console.log();
process.exit(ratio < 3 ? 0 : 1);
