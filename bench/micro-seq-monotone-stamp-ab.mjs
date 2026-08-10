// Microbenchmark: A/B the publish path's max-seen record, bare set vs the
// monotone-max guard, on the counter arm.
//
// WHY: the counter arm writes the observed registry through `recordStampedSeen`,
// which sets without comparing. The justification is that a counter is monotone
// in itself, so the compare is known-redundant - true for a topic the counter
// alone numbers, and false the moment the same topic also carries an explicit
// numeric seq. Then the counter's 1 lands on top of a foreign 900000 and the
// observed MAXIMUM moves backward, which the cross-worker convergence hash
// reads as a fabricated divergence and the resume cutover reads as a floor that
// dropped (duplicate delivery rather than a gap).
//
// Mixed authority on one topic is not merely a misconfiguration to be refused:
// the per-entry batch seq is a shipped, tested shape where one entry carries an
// explicit seq and the next takes the counter, on the SAME topic. So the record
// has to tolerate it, which means the compare cannot be skipped - and that puts
// a Map.get on the hottest lane in the runtime, on every publish. Hence this
// bench rather than an argument.
//
// Three arms, measured inside a realistic publish (payload serialize + envelope
// build + stats), because that is the denominator the verdict is a fraction of -
// a delta measured against the recorder alone would flatter or damn it by a
// factor of ten either way.
//
//   A legacy      the pre-change write, inlined here so the comparison survives
//                 the source moving underneath it: bare set plus the size-delta
//                 membership report, ungated.
//   B gated       the shipped recorder, whose compare runs only once a foreign
//                 seq has been recorded on this worker. Measured with the latch
//                 DOWN, which is what a counter-only worker runs.
//   C ungated     the monotone guard on every publish - the straightforward fix,
//                 priced here because it is the one to reach for if the latch is
//                 ever removed.
//
// The guard is not purely additive: it pays a `get` but SKIPS the `set` whenever
// the value does not increase, which on the mixed-authority shape is most
// writes. Its cold-path branch is cheaper too, because `prev === undefined`
// falls out of the read it already made where the legacy arm takes two `size`
// reads across the write. That is why the third shape below runs FASTER guarded.
//
// MEASURED ON THIS MACHINE (5-8M iterations, one arm per process, best of three
// process runs, hot-topic shape):
//
//   A 107.28ns   B 108.45ns (+1.1%, and B came out ahead in one of the three
//                repetitions - the arms cross over, so this is parity)
//   C ~5.5% over A, consistently, which is why the latch exists rather than
//     just calling `recordSeen` from both arms.
//
// A CAUTION FOR WHOEVER RUNS THIS NEXT: the first version of this bench put all
// arms in ONE process and reported +18% for C, which a rerun of the same file
// could not reproduce (129ns against 111ns for the identical function). Inline
// caches and deoptimisation state are shared across call sites in a process, so
// whichever arm runs second inherits the shape the first taught V8. Use --arm=
// and compare across processes; do not trust a single-process comparison here.
//
// Usage:
//   node bench/micro-seq-monotone-stamp-ab.mjs [iterations] [rounds]
// Defaults: 20_000_000 iterations, 12 rounds.

import { stampSeqValue, completeEnvelope } from '../src/runtime/utils/epoch.js';
import { recordSeen, recordStampedSeen, resetForeignSeqLatch } from '../src/runtime/handler/state.js';

const ITERATIONS = parseInt(process.argv[2] || '20000000', 10);
const ROUNDS = parseInt(process.argv[3] || '12', 10);

const ENV_PREFIX = '{"topic":"room","event":"tick","data":';
const ENV_DATA = { x: 12, y: 34, id: 'abc123', n: 42 };

// Under cap, which is the steady state this bench is about: the recorder's only
// cost is deciding whether to report at all.
const idleBound = {
	onSeenInsert() { /* under cap: the real bound returns on its size check */ }
};

/**
 * Variant A: the PRE-CHANGE recorder, inlined so the comparison survives the
 * source moving underneath it - bare set plus the size-delta membership report,
 * with no gate.
 */
function legacyPublish(topic, seqMap, seenMap, stats) {
	const seq = stampSeqValue(undefined, seqMap, topic, undefined);
	if (seq !== null) {
		const before = seenMap.size;
		seenMap.set(topic, seq);
		if (seenMap.size !== before) idleBound.onSeenInsert(topic);
	}
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	stats.b += env.length;
	return env.length;
}

/** Variant B: the shipped recorder, whose compare is gated on the latch. */
function stampedPublish(topic, seqMap, seenMap, stats) {
	const seq = stampSeqValue(undefined, seqMap, topic, undefined);
	if (seq !== null) recordStampedSeen(seenMap, topic, seq, idleBound);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	stats.b += env.length;
	return env.length;
}

/** Variant C: the ungated monotone guard, the version rejected on cost. */
function monotonePublish(topic, seqMap, seenMap, stats) {
	const seq = stampSeqValue(undefined, seqMap, topic, undefined);
	if (seq !== null) recordSeen(seenMap, topic, seq, idleBound);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	stats.b += env.length;
	return env.length;
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
/**
 * The verdict statistic, for the reason the sibling bench states: a median
 * carries every scheduler interruption, and on this shape the run-to-run spread
 * is several percent while the effect under test is a fraction of one. The
 * fastest round is the one that came closest to running uninterrupted.
 */
function fastest(xs) { return Math.min(...xs); }

// The shapes, because the recorder's branch resolves differently in each:
//
// - one hot topic: every write after the first hits an existing key. A busy
//   room, a game lane or a cursor stream. THIS is the shape the verdict rests
//   on, and the shape where B pays its `get` and still performs its `set`.
// - fresh topic per publish: every write admits a new key, so A reports through
//   the size delta and B through `prev === undefined`.
// - a foreign seq already recorded high: the mixed-authority shape this change
//   exists for. B reads, compares, and writes NOTHING; A writes every time.
const CASES = [
	{ name: 'one hot topic (the publish lane)', topics: 1 },
	{ name: 'fresh topic per publish (arrival-bound)', topics: 0 },
	{ name: 'foreign seq held high (the shape the fix is for)', topics: -1 }
];

function runCase(shape, fn) {
	const rounds = [];
	for (let r = 0; r < ROUNDS; r++) {
		const seqMap = new Map();
		const seenMap = new Map();
		const stats = { b: 0 };
		if (shape.topics === -1) seenMap.set('room', 900000);
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < ITERATIONS; i++) {
			const topic = shape.topics === 0 ? 'room:' + i : 'room';
			fn(topic, seqMap, seenMap, stats);
		}
		const t1 = process.hrtime.bigint();
		rounds.push(Number(t1 - t0) / ITERATIONS);
		if (stats.b === 0) throw new Error('the publish was optimised away');
	}
	return rounds;
}

// ONE ARM PER PROCESS. Running the arms in a single process let the first
// measurement of this file report a +18% cost for the monotone guard that a
// second run of the same file could not reproduce (129ns against 111ns for the
// identical function). Three call sites reaching the same recorders in one
// process share inline caches and deoptimisation state, so whichever arm runs
// second inherits the shape the first one taught V8. Comparing across processes
// costs a few seconds and removes the whole class of error.
const ARM = (process.argv.find((a) => a.startsWith('--arm=')) || '--arm=all').slice(6);
const ARMS = {
	legacy: ['A legacy bare set', legacyPublish],
	gated: ['B gated, latch down', stampedPublish],
	ungated: ['C ungated monotone', monotonePublish]
};

if (ARM !== 'all') {
	const [label, fn] = ARMS[ARM] || [];
	if (!fn) throw new Error(`unknown arm ${JSON.stringify(ARM)}; expected legacy | gated | ungated | all`);
	console.log(`arm=${ARM} iterations=${ITERATIONS} rounds=${ROUNDS}`);
	for (const shape of CASES) {
		// `recordSeen` arms the latch, so the gated arm resets before each shape to
		// measure the latch-DOWN path a counter-only worker actually runs.
		resetForeignSeqLatch();
		const xs = runCase(shape, fn);
		console.log(`${shape.name}\t${label}\tfastest=${fastest(xs).toFixed(2)}ns\tmean=${mean(xs).toFixed(2)}ns`);
	}
	process.exit(0);
}

console.log(`iterations=${ITERATIONS} rounds=${ROUNDS}\n`);
for (const shape of CASES) {
	// The gated arm is measured with the latch DOWN, which is what a worker that
	// never meets a foreign seq runs - a single-process deployment publishing
	// through its own counter. `recordSeen` arms the latch, so it is reset before
	// the gated arm and left armed only for the ungated comparison.
	resetForeignSeqLatch();
	const a = runCase(shape, legacyPublish);
	resetForeignSeqLatch();
	const b = runCase(shape, stampedPublish);
	const c = runCase(shape, monotonePublish);
	const fa = fastest(a);
	const fb = fastest(b);
	const fc = fastest(c);
	console.log(shape.name);
	console.log(`  A legacy bare set        fastest=${fa.toFixed(2)}ns mean=${mean(a).toFixed(2)}ns`);
	console.log(`  B gated, latch down      fastest=${fb.toFixed(2)}ns mean=${mean(b).toFixed(2)}ns  delta vs A ${((fb - fa) / fa * 100).toFixed(2)}%`);
	console.log(`  C ungated monotone       fastest=${fc.toFixed(2)}ns mean=${mean(c).toFixed(2)}ns  delta vs A ${((fc - fa) / fa * 100).toFixed(2)}%`);
	console.log('');
}
