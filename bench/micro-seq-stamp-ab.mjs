// Microbenchmark: A/B the publish-path seq resolution before vs after the
// `stampSeq` helper + the numeric-seq record branch.
//
// Widening the `seq` publish option from boolean to `boolean | number` moved the
// three inline publish-site resolutions (publish / publishWire / publishBatched)
// behind a shared `stampSeq(options, seqMap, topic)` helper, and split the
// max-seen record into a numeric-guarded branch (an explicit authoritative seq
// takes the monotone-max guard; the in-memory counter keeps its bare set). The
// common publish carries NO seq option, so the hot path must stay byte-identical:
// an absent-option publish must resolve + record exactly as fast as the old
// inline ternary + bare set. Credo #4 requires the bench, not an estimate - a
// single-digit-% regression on the publish resolution is a blocker.
//
// Variant A replays the pre-change inline shape; Variant B calls the real shipped
// stampSeq + recordSeen. Three operand shapes are timed: the absent case (the hot
// path), { seq: false }, and { seq: <number> } (the new authoritative track).
//
// Usage:
//   node bench/micro-seq-stamp-ab.mjs [iterations] [rounds]
// Defaults: 20_000_000 iterations, 12 rounds.

import { stampSeq, nextTopicSeq, completeEnvelope } from '../src/runtime/utils/epoch.js';
import { recordSeen } from '../src/runtime/handler/state.js';

const ITERATIONS = parseInt(process.argv[2] || '20000000', 10);
const ROUNDS = parseInt(process.argv[3] || '12', 10);
const topic = 'room';

// A realistic publish payload + prefix so the publish-proxy case below pays the
// JSON.stringify + envelope-build cost a real publish pays around the resolution.
const ENV_PREFIX = '{"topic":"room","event":"tick","data":';
const ENV_DATA = { x: 12, y: 34, id: 'abc123', n: 42 };

// Variant A: the pre-change inline resolution + bare max-seen set.
function baseline(options, seqMap, seenMap) {
	const seq = (options && options.seq === false) ? null : nextTopicSeq(seqMap, topic);
	if (seq !== null) seenMap.set(topic, seq);
	return seq;
}

// Variant B: the shipped shared helper + numeric-guarded record branch.
function current(options, seqMap, seenMap) {
	const seq = stampSeq(options, seqMap, topic);
	if (seq !== null) {
		if (options && typeof options.seq === 'number') recordSeen(seenMap, topic, seq);
		else seenMap.set(topic, seq);
	}
	return seq;
}

// Publish proxy: the resolution PLUS the completeEnvelope (JSON.stringify) + stats
// work a real publish does around it. The isolated resolution is a few ns; a real
// publish also serializes the payload and builds the envelope, so this measures
// the resolution delta against a real publish's cost - the number credo #4 cares
// about, since nothing calls the resolution in a hot loop on its own.
function baselinePublish(options, seqMap, seenMap, stats) {
	const seq = (options && options.seq === false) ? null : nextTopicSeq(seqMap, topic);
	if (seq !== null) seenMap.set(topic, seq);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	stats.b += env.length;
	return env.length;
}
function currentPublish(options, seqMap, seenMap, stats) {
	const seq = stampSeq(options, seqMap, topic);
	if (seq !== null) {
		if (options && typeof options.seq === 'number') recordSeen(seenMap, topic, seq);
		else seenMap.set(topic, seq);
	}
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
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

function runCase(fn, options) {
	// A fresh map per run keeps the single-topic counter growth identical across
	// both variants (the number does grow over ITERATIONS, but symmetrically).
	const seqMap = new Map();
	const seenMap = new Map();
	const t0 = performance.now();
	for (let i = 0; i < ITERATIONS; i++) fn(options, seqMap, seenMap);
	const t1 = performance.now();
	return t1 - t0;
}

const CASES = [
	{ name: 'absent (hot path)', options: undefined },
	{ name: '{ seq: false }', options: { seq: false } },
	{ name: '{ seq: <number> }', options: { seq: 123456 } }
];

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds, alternating`);

console.log('\n== isolated resolution (diagnostic; nothing calls this in a hot loop on its own) ==');
for (const c of CASES) {
	for (let i = 0; i < 4; i++) { runCase(baseline, c.options); runCase(current, c.options); }
	const aMs = [];
	const bMs = [];
	for (let r = 0; r < ROUNDS; r++) {
		aMs.push(runCase(baseline, c.options));
		bMs.push(runCase(current, c.options));
	}
	const aMed = median(aMs);
	const bMed = median(bMs);
	const aSd = stddev(aMs);
	const deltaPct = ((bMed - aMed) / aMed) * 100;
	const noiseFloor = (aSd / aMed) * 100;
	const nsPerOpA = (aMed * 1e6) / ITERATIONS;
	const nsPerOpB = (bMed * 1e6) / ITERATIONS;

	console.log(`\ncase ${c.name}`);
	console.log(`  baseline (inline)   median ${aMed.toFixed(2).padStart(8)}ms  ${nsPerOpA.toFixed(3)} ns/op  +/- ${aSd.toFixed(2)}`);
	console.log(`  current  (stampSeq) median ${bMed.toFixed(2).padStart(8)}ms  ${nsPerOpB.toFixed(3)} ns/op`);
	console.log(`  delta ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%  (noise floor ${noiseFloor.toFixed(2)}%)`);
}

// Publish proxy: resolution measured inside a realistic publish (payload
// serialize + envelope build + stats). This is the credo #4 verdict - the
// resolution delta as a fraction of a real publish, not of the bare resolution.
function runCasePublish(fn, options) {
	const seqMap = new Map();
	const seenMap = new Map();
	const stats = { b: 0 };
	const t0 = performance.now();
	for (let i = 0; i < ITERATIONS; i++) fn(options, seqMap, seenMap, stats);
	const t1 = performance.now();
	return t1 - t0;
}

console.log('\n== publish proxy (resolution + completeEnvelope + stats): the credo #4 verdict ==');
let blocker = false;
for (const c of [{ name: 'absent (hot path)', options: undefined }, { name: '{ seq: <number> }', options: { seq: 123456 } }]) {
	for (let i = 0; i < 4; i++) { runCasePublish(baselinePublish, c.options); runCasePublish(currentPublish, c.options); }
	const aMs = [];
	const bMs = [];
	for (let r = 0; r < ROUNDS; r++) {
		aMs.push(runCasePublish(baselinePublish, c.options));
		bMs.push(runCasePublish(currentPublish, c.options));
	}
	const aMed = median(aMs);
	const bMed = median(bMs);
	const aSd = stddev(aMs);
	const deltaPct = ((bMed - aMed) / aMed) * 100;
	const noiseFloor = (aSd / aMed) * 100;
	const nsPerOpA = (aMed * 1e6) / ITERATIONS;
	const nsPerOpB = (bMed * 1e6) / ITERATIONS;

	console.log(`\npublish proxy - ${c.name}`);
	console.log(`  baseline median ${aMed.toFixed(2).padStart(8)}ms  ${nsPerOpA.toFixed(2)} ns/op  +/- ${aSd.toFixed(2)}`);
	console.log(`  current  median ${bMed.toFixed(2).padStart(8)}ms  ${nsPerOpB.toFixed(2)} ns/op`);

	let verdict;
	if (Math.abs(deltaPct) <= noiseFloor) verdict = `noise (within stddev ${noiseFloor.toFixed(2)}%) -> free`;
	else if (deltaPct < 0) verdict = `current FASTER by ${Math.abs(deltaPct).toFixed(2)}%`;
	else if (deltaPct < 1) verdict = `current slower by <1% (${deltaPct.toFixed(2)}%) -> negligible`;
	else { verdict = `current slower by ${deltaPct.toFixed(2)}% -> investigate`; if (c.name.startsWith('absent')) blocker = true; }
	console.log(`  delta ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   ${verdict}`);
}

console.log(blocker
	? '\nRESULT: publish-proxy absent case regressed > 1% -> investigate'
	: '\nRESULT: on a realistic publish the resolution change is within noise / <1% -> ship');
console.log();
