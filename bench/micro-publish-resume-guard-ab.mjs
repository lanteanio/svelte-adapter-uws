// Microbenchmark: A/B the publish hot path before vs after the resume-cutover
// capture guard.
//
// The recovery barrier adds one line to platform.publish (and the other fan-out
// sites): `if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, envelope,
// compress)`. In the overwhelming common case no connection is mid-resume, so
// `resumeBuffers` is empty and the guard is a single Map.size read + integer
// compare + untaken branch per publish. This proves that guard is free on the
// hot path - a measured bench, not an estimate.
//
// Variant A is the publish per-call work WITHOUT the guard; variant B adds the
// real shipped guard with an EMPTY resumeBuffers (the hot path). Both pay the
// completeEnvelope (JSON.stringify) + stats cost a real publish pays, so the
// delta is measured as a fraction of a real publish, not of the bare guard.
//
// Usage:
//   node bench/micro-publish-resume-guard-ab.mjs [iterations] [rounds]
// Defaults: 20_000_000 iterations, 12 rounds.

import { stampSeq, completeEnvelope } from '../src/runtime/utils/epoch.js';
import { recordSeen, resumeBuffers, captureResumeFrame } from '../src/runtime/handler/state.js';

const ITERATIONS = parseInt(process.argv[2] || '20000000', 10);
const ROUNDS = parseInt(process.argv[3] || '12', 10);
const topic = 'room';

const ENV_PREFIX = '{"topic":"room","event":"tick","data":';
const ENV_DATA = { x: 12, y: 34, id: 'abc123', n: 42 };

// Variant A: the publish per-call work as it was BEFORE the barrier.
function baselinePublish(seqMap, seenMap, stats) {
	const seq = stampSeq(undefined, seqMap, topic);
	if (seq !== null) seenMap.set(topic, seq);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	// The real guard rides here; baseline omits it.
	stats.b += env.length;
	return env.length;
}

// Variant B: identical, PLUS the shipped guard against the real (empty) map.
function currentPublish(seqMap, seenMap, stats) {
	const seq = stampSeq(undefined, seqMap, topic);
	if (seq !== null) seenMap.set(topic, seq);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, env, false);
	stats.b += env.length;
	return env.length;
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

function runCase(fn) {
	const seqMap = new Map();
	const seenMap = new Map();
	const stats = { b: 0 };
	const t0 = performance.now();
	for (let i = 0; i < ITERATIONS; i++) fn(seqMap, seenMap, stats);
	const t1 = performance.now();
	return t1 - t0;
}

if (resumeBuffers.size !== 0) throw new Error('bench precondition: resumeBuffers must start empty');

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds, alternating`);
console.log('\n== publish proxy (per-call work + completeEnvelope + stats): the verdict ==');

for (let i = 0; i < 4; i++) { runCase(baselinePublish); runCase(currentPublish); }
const aMs = [];
const bMs = [];
for (let r = 0; r < ROUNDS; r++) {
	aMs.push(runCase(baselinePublish));
	bMs.push(runCase(currentPublish));
}
const aMed = median(aMs);
const bMed = median(bMs);
const aSd = stddev(aMs);
const deltaPct = ((bMed - aMed) / aMed) * 100;
const noiseFloor = (aSd / aMed) * 100;
const nsPerOpA = (aMed * 1e6) / ITERATIONS;
const nsPerOpB = (bMed * 1e6) / ITERATIONS;

console.log(`\npublish proxy - hot path (resumeBuffers empty)`);
console.log(`  baseline (no guard) median ${aMed.toFixed(2).padStart(8)}ms  ${nsPerOpA.toFixed(2)} ns/op  +/- ${aSd.toFixed(2)}`);
console.log(`  current  (+ guard)  median ${bMed.toFixed(2).padStart(8)}ms  ${nsPerOpB.toFixed(2)} ns/op`);

let verdict;
let blocker = false;
if (Math.abs(deltaPct) <= noiseFloor) verdict = `noise (within stddev ${noiseFloor.toFixed(2)}%) -> free`;
else if (deltaPct < 0) verdict = `current FASTER by ${Math.abs(deltaPct).toFixed(2)}%`;
else if (deltaPct < 1) verdict = `current slower by <1% (${deltaPct.toFixed(2)}%) -> negligible`;
else { verdict = `current slower by ${deltaPct.toFixed(2)}% -> investigate`; blocker = true; }
console.log(`  delta ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   ${verdict}`);

console.log(blocker
	? '\nRESULT: publish hot path regressed > 1% -> investigate'
	: '\nRESULT: the resume-capture guard is within noise / <1% on a realistic publish -> ship');
console.log();
