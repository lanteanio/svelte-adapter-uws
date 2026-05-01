// Microbenchmark: A/B test the cost of moving esc() / isValidWireTopic /
// createScopedTopic from local copies (handler.js, vite.js, testing.js)
// to imported helpers in files/utils.js.
//
// Each benchmark runs N alternating rounds: one round of local, one round
// of imported, repeated. Alternation controls for system-state drift.
// Reports median + stddev + delta; flags "Likely noise" when the delta
// falls inside the baseline stddev.
//
// Usage:
//   node bench/micro-utils.mjs [iterations] [rounds]
//
// Defaults: 5_000_000 iterations, 10 rounds (12s total on a fast box).
//
// Hot paths analyzed:
//   - esc(s)              : called inside envelopePrefix() on cache miss
//                           (per unique topic+event seen). Cold-ish in
//                           steady state, but matters during cache fill.
//   - isValidWireTopic(t) : called per subscribe / unsubscribe /
//                           subscribe-batch entry. Control messages only.
//   - createScopedTopic   : called per platform.topic('name') invocation.
//                           Cold; bench is for completeness.

import {
	esc as escImported,
	isValidWireTopic as isValidWireTopicImported,
	createScopedTopic as createScopedTopicImported
} from '../files/utils.js';

const ITERATIONS = parseInt(process.argv[2] || '5000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);

// Local copies matching the handler.js / vite.js / testing.js inline forms.

function escLocal(s) {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 32 || c === 34 || c === 92) {
			throw new Error(
				`Topic/event name contains invalid character at index ${i}: '${s}'. ` +
				'Names must not contain quotes, backslashes, or control characters.'
			);
		}
	}
	return '"' + s + '"';
}

function isValidWireTopicLocal(topic) {
	if (typeof topic !== 'string' || topic.length === 0 || topic.length > 256) return false;
	for (let i = 0; i < topic.length; i++) {
		if (topic.charCodeAt(i) < 32) return false;
	}
	return true;
}

function createScopedTopicLocal(publish, name) {
	return {
		publish: (event, data) => publish(name, event, data),
		created: (data) => publish(name, 'created', data),
		updated: (data) => publish(name, 'updated', data),
		deleted: (data) => publish(name, 'deleted', data),
		set: (value) => publish(name, 'set', value),
		increment: (amount = 1) => publish(name, 'increment', amount),
		decrement: (amount = 1) => publish(name, 'decrement', amount)
	};
}

// Realistic inputs: a mix of short and longer identifiers. The publish
// hot path sees varied topic / event names, so a single-input bench would
// over-report inline-cache wins.
const ESC_INPUTS = [
	'chat', 'todos', 'cursor', 'presence', 'replay',
	'__presence:room1', '__cursor:doc-12', '__replay:chat',
	'created', 'updated', 'deleted', 'set', 'increment', 'decrement',
	'message', 'typing', 'heartbeat'
];

const TOPIC_INPUTS = [
	'chat', 'todos', 'cursor', 'presence:room1', '__replay:chat',
	'a', 'b', 'long-topic-name-with-some-detail-12345',
	// invalid cases:
	'', null, 123, 'hascontrol'
];

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

function runEsc(fn) {
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const s = ESC_INPUTS[i % ESC_INPUTS.length];
		acc += fn(s).length;
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

function runIsValid(fn) {
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const t = TOPIC_INPUTS[i % TOPIC_INPUTS.length];
		if (fn(t)) acc++;
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

// For createScopedTopic we measure factory + invocation, since real callers
// almost always use the returned object at least once.
function runScoped(fn) {
	const publish = () => 1;
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const s = fn(publish, 'topic-' + (i & 7));
		s.created({ x: i });
		s.set(i);
		acc++;
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

function compare(label, runFn, localImpl, importedImpl) {
	console.log(`\n${label}  (${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds, alternating)`);

	// Warmup each implementation - enough to reach stable JIT tiering.
	for (let i = 0; i < 3; i++) {
		runFn(localImpl);
		runFn(importedImpl);
	}

	const localMs = [];
	const importedMs = [];
	let aSum = 0, bSum = 0;
	for (let r = 0; r < ROUNDS; r++) {
		const a = runFn(localImpl); aSum += a.acc; localMs.push(a.ms);
		const b = runFn(importedImpl); bSum += b.acc; importedMs.push(b.ms);
		process.stdout.write(`  Round ${r + 1}/${ROUNDS}: local ${a.ms.toFixed(1)}ms  imported ${b.ms.toFixed(1)}ms\n`);
	}

	if (aSum !== bSum) {
		console.log(`  WARNING: accumulator mismatch local=${aSum} imported=${bSum} (functional drift)`);
	}

	const aMed = median(localMs);
	const bMed = median(importedMs);
	const aSd = stddev(localMs);
	const bSd = stddev(importedMs);
	// Delta is signed: positive means imported is SLOWER (took longer).
	// We want it small or negative for the extraction to be safe.
	const deltaPct = ((bMed - aMed) / aMed) * 100;

	console.log(`  ${'local'.padEnd(20)} median ${aMed.toFixed(2).padStart(8)}ms  +/- ${aSd.toFixed(2)}`);
	console.log(`  ${'imported'.padEnd(20)} median ${bMed.toFixed(2).padStart(8)}ms  +/- ${bSd.toFixed(2)}`);
	console.log(`  ${'delta (slowdown)'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (positive = imported slower)`);

	const noiseFloor = (aSd / aMed) * 100;
	if (Math.abs(deltaPct) <= noiseFloor) {
		console.log(`  VERDICT: noise (within baseline stddev ${noiseFloor.toFixed(2)}%) -> safe to extract`);
	} else if (deltaPct < 0) {
		console.log(`  VERDICT: imported FASTER by ${Math.abs(deltaPct).toFixed(2)}% -> safe to extract`);
	} else if (deltaPct < 1) {
		console.log(`  VERDICT: imported slower by <1% (${deltaPct.toFixed(2)}%) -> borderline, prefer keep local`);
	} else {
		console.log(`  VERDICT: imported slower by ${deltaPct.toFixed(2)}% -> KEEP LOCAL`);
	}
}

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds`);

compare('esc(s)', runEsc, escLocal, escImported);
compare('isValidWireTopic(t)', runIsValid, isValidWireTopicLocal, isValidWireTopicImported);
compare('createScopedTopic(pub, name) + .created() + .set()', runScoped, createScopedTopicLocal, createScopedTopicImported);
console.log();
