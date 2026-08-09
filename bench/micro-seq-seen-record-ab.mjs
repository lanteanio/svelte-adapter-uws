// Microbenchmark: A/B the publish path's max-seen record, bare set vs the
// membership-reporting recorder.
//
// The counter arm of every publish lane used to write the observed registry
// with a bare `maxSeenSeq.set(topic, seq)`, which left the registry bound
// blind to the topics that lane admitted - the configured ceiling bounded one
// registry and not the other. The fix routes those writes through
// `recordStampedSeen`, which keeps the bare set (the value is freshly stamped
// and monotonic, so the compare `recordSeen` performs is known-redundant here)
// and adds a membership report: two reads of the map's own `size` across the
// write, and a call to the bound only when the write actually admitted a new
// topic.
//
// That runs on the hottest lane in the runtime, on every publish, so it needs
// the bench rather than an argument: a single-digit-% regression on the publish
// path is a blocker.
//
// Variant A replays the pre-fix bare set. Variant B calls the shipped recorder.
// Both are measured inside a realistic publish (payload serialize + envelope
// build + stats), because that is the denominator the verdict is a fraction of.
//
// Three shapes, and the third is the one that costs something. Read its
// caveats before quoting its number.
//
// A counter publish reaches an eviction sweep the counter lane never used to
// trigger, and that sweep is NOT a bounded transient - an earlier version of
// this header argued it was, and the argument was wrong. Under mixed
// authority the seen-lane sweep evicts whichever entry is oldest-evictable,
// which is routinely a COUNTER topic, and evicting one deletes it from the
// counter registry too. So the counter registry never reaches its own ceiling
// (it settles at capacity * counterRate / (counterRate + externalRate)), its
// own insert path never sweeps, and every new counter topic keeps paying a
// seen-lane sweep indefinitely. Measured directly: at capacity 64 with
// alternating arrivals, the sweep was still judging one candidate per arrival
// 4,000 arrivals in.
//
// Two things this case still cannot tell you, both of which understate the
// production cost:
//
// - the baseline arm is the PRE-FIX behaviour, whose observed registry grows
//   without limit in this shape. Its per-op cost therefore includes Map growth
//   that the current arm does not pay, and its memory is unbounded, which is
//   the defect being fixed. A delta here prices bounding against leaking, not
//   two equivalent implementations.
// - the sweep's per-candidate judgment is a stub here. The wired bound calls
//   `app.numSubscribers` - a native call - per candidate, and on a clustered
//   worker the reporter's quiet probe rejects unjudged topics, so most sweeps
//   come back empty and pay both passes. Neither is modelled below.
//
// With those caveats stated, the measured answer on this machine is that the
// bounded arm is FASTER on that shape - about 640 ns per arrival against about
// 710 - because the Map growth it prevents costs more than the sweep it adds.
// That is a reason to bound the registry, not a reason to stop watching the
// sweep: the two caveats above both point the same way, and a deployment whose
// candidates are mostly subscribed or mostly unjudged pays more than this.
//
// Usage:
//   node bench/micro-seq-seen-record-ab.mjs [iterations] [rounds]
// Defaults: 20_000_000 iterations, 12 rounds.

import { stampSeqValue, completeEnvelope } from '../src/runtime/utils/epoch.js';
import { recordSeen, recordStampedSeen } from '../src/runtime/handler/state.js';
import { createSeqBound } from '../src/runtime/utils/seq-bound.js';

const ITERATIONS = parseInt(process.argv[2] || '20000000', 10);
const ROUNDS = parseInt(process.argv[3] || '12', 10);

const ENV_PREFIX = '{"topic":"room","event":"tick","data":';
const ENV_DATA = { x: 12, y: 34, id: 'abc123', n: 42 };

// A bound that answers every insert as under-cap, which is the steady state
// this bench is about: the registry is not full, so the recorder's only cost
// is deciding whether to report at all.
const idleBound = {
	onSeenInsert() { /* under cap: the real bound returns on its size check */ }
};

// Variant A: the pre-fix write - correct value, invisible membership.
function baselinePublish(topic, seqMap, seenMap, stats, bed) {
	const seq = stampSeqValue(undefined, seqMap, topic, bed ? bed.bound : undefined);
	if (seq !== null) seenMap.set(topic, seq);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	stats.b += env.length;
	return env.length;
}

// Variant B: the shipped recorder.
function currentPublish(topic, seqMap, seenMap, stats, bed) {
	const seq = stampSeqValue(undefined, seqMap, topic, bed ? bed.bound : undefined);
	if (seq !== null) recordStampedSeen(seenMap, topic, seq, bed ? bed.bound : idleBound);
	const env = completeEnvelope(ENV_PREFIX, ENV_DATA, seq, null);
	stats.b += env.length;
	return env.length;
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/**
 * The verdict statistic. A median carries every scheduler interruption in the
 * run, and on this shape the run-to-run spread is several percent while the
 * effect under test is a fraction of one - so a median comparison answers
 * "within noise" without being able to see the effect at all, which is not the
 * same as measuring it. The fastest round is the one that came closest to
 * running uninterrupted, and it is stable across invocations.
 */
function fastest(xs) {
	return Math.min(...xs);
}
function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs) {
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

// The shapes, because the recorder's branch resolves differently in each:
//
// - one hot topic: every write after the first hits an existing key, so the
//   size never moves and the bound is never called. This is what a busy room,
//   a game lane or a cursor stream actually does, and it is the shape the
//   verdict rests on.
// - fresh topic per iteration, against a bound at its ceiling: every write
//   admits a new key, so every iteration reports. Nothing sustains this shape
//   in production (it is the arrival rate, not the publish rate), but it
//   prices the reporting arm at a stable registry size.
const CASES = [
	{ name: 'one hot topic (the publish lane)', topics: 1, verdict: true },
	{ name: 'fresh topic per publish (arrival-bound)', topics: 0, verdict: true },
	{ name: 'sustained mixed authority, where the sweep runs on every arrival', topics: -1, verdict: true }
];

/**
 * A real bound at a small capacity, which is what both arrival shapes run
 * against. Bounding the registries is also what keeps the measurement honest:
 * without it the maps grow by one entry per iteration and ns/op tracks how
 * large they got (~242 at 50k iterations, ~350 at 200k, ~700 at 400k) rather
 * than the record under test.
 *
 * With `external` set, the seen map starts full of topics the counter registry
 * does not hold - the only state in which the counter lane reaches an eviction
 * sweep, and the state the demonstration case needs.
 */
const BED_CAPACITY = 256;
function makeBed({ external = false } = {}) {
	const seqMap = new Map();
	const seenMap = new Map();
	const bound = createSeqBound({
		seqMap,
		seenMap,
		capacity: BED_CAPACITY,
		floorCap: 1024,
		isProtected: () => false,
		onOverCap: () => {}
	});
	if (external) {
		for (let i = 0; i < BED_CAPACITY; i++) recordSeen(seenMap, 'external:' + i, 1_000_000 + i, bound);
	}
	return { seqMap, seenMap, bound };
}

function runCase(fn, topics, iterations) {
	const bed = topics === 1 ? null : makeBed({ external: topics === -1 });
	const seqMap = bed ? bed.seqMap : new Map();
	const seenMap = bed ? bed.seenMap : new Map();
	const stats = { b: 0 };
	const t0 = performance.now();
	if (topics === 1) {
		for (let i = 0; i < iterations; i++) fn('room', seqMap, seenMap, stats, bed);
	} else if (topics === 0) {
		for (let i = 0; i < iterations; i++) fn('room:' + i, seqMap, seenMap, stats, bed);
	} else {
		// Alternate the two authorities, so the observed registry stays fuller
		// than the counter registry and the sweep keeps running. Both arms take
		// the same external arrivals; only the counter write differs.
		for (let i = 0; i < iterations; i++) {
			recordSeen(seenMap, 'external:' + i, 1_000_000 + i, bed.bound);
			fn('room:' + i, seqMap, seenMap, stats, bed);
		}
	}
	const t1 = performance.now();
	return t1 - t0;
}

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds, alternating`);

let blocker = false;
for (const c of CASES) {
	// Both arrival shapes run against a real bound (see makeBed), so their maps
	// hold at the ceiling instead of growing, and every round can be as long as
	// the hot-topic one. A short round is what made the fastest-round statistic
	// unstable here: at 50k iterations a round is a few milliseconds, and a
	// single scheduler slice moves it several percent.
	const iterations = ITERATIONS;
	const run = (fn) => runCase(fn, c.topics, iterations);

	for (let i = 0; i < 4; i++) { run(baselinePublish); run(currentPublish); }
	const aMs = [];
	const bMs = [];
	for (let r = 0; r < ROUNDS; r++) {
		aMs.push(run(baselinePublish));
		bMs.push(run(currentPublish));
	}
	const aMed = median(aMs);
	const bMed = median(bMs);
	const aFast = fastest(aMs);
	const bFast = fastest(bMs);
	const deltaPct = ((bFast - aFast) / aFast) * 100;
	const medDeltaPct = ((bMed - aMed) / aMed) * 100;
	const spreadA = (stddev(aMs) / aMed) * 100;
	const spreadB = (stddev(bMs) / bMed) * 100;

	console.log(`\npublish proxy - ${c.name} (${iterations.toLocaleString()} iterations)`);
	console.log(`  baseline (bare set) fastest ${((aFast * 1e6) / iterations).toFixed(2)} ns/op   median ${((aMed * 1e6) / iterations).toFixed(2)} ns/op`);
	console.log(`  current  (recorder) fastest ${((bFast * 1e6) / iterations).toFixed(2)} ns/op   median ${((bMed * 1e6) / iterations).toFixed(2)} ns/op`);
	console.log(`  delta ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}% on the fastest round` +
		`  (median ${medDeltaPct >= 0 ? '+' : ''}${medDeltaPct.toFixed(2)}%, round spread ${spreadA.toFixed(2)}% / ${spreadB.toFixed(2)}%)`);
	if (c.topics === -1) {
		console.log(`  ^ the current arm's absolute cost is the number to carry: ` +
			`${((bFast * 1e6) / iterations).toFixed(0)} ns per arrival, sweep included`);
	}
	if (deltaPct > 1) {
		blocker = true;
		console.log('  ^ the fastest round is slower too, so this is a cost rather than scheduler noise');
	}
}

console.log(blocker ? '\nVERDICT: a shape carries a real cost.' : '\nVERDICT: no shape is measurably slower on its fastest round.');
