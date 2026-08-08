// Microbenchmark: A/B the publish-lane option handling before vs after the
// one-read capture.
//
// The capture replaces repeated `options.<field>` property reads (the authority
// check, the stamp, the max-seen branch, the compress/relay/jitter decisions)
// with four locals read up front, plus the values-form check and `stampSeqValue`.
// The rule this repo holds: a per-publish change on the hottest lane needs a
// measured delta, not an estimate - a single-digit-% regression is a blocker.
//
// Variant A replays the pre-change live-read shape with the OLD monolithic
// bodies inlined below (not today's delegating exports, which would pad the
// baseline with a call frame the old code never paid); Variant B replays the
// shipped captured shape through the real primitives the lane now calls. Both
// run the same three operand shapes: absent options (the hot path),
// { seq: false }, and { seq: N, relay: false } (the authoritative track).
// What is timed is the ISOLATED option-resolution primitive - no envelope is
// built inside the timing window, so the percentages compare the resolution
// alone, not a publish-proportional figure.
//
// Usage:
//   node bench/micro-publish-capture-ab.mjs [iterations] [rounds]
// Defaults: 10_000_000 iterations, 10 rounds.

import { stampSeqValue } from '../src/runtime/utils/epoch.js';
import { clusterSequenceValuesAccepted } from '../src/runtime/handler/cluster-sequence-policy.js';
import { recordSeen } from '../src/runtime/handler/state.js';

const ITERATIONS = parseInt(process.argv[2] || '10000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);
const topic = 'room';

// The pre-change monolithic check and stamp, reproduced verbatim so Variant A
// pays exactly what the old lane paid - object reads inside the check, a
// single non-delegating stamp call, no values-form frames.
const MULTI = false; // single-process bench, same branch the old hoisted boolean took
function oldClusterSequenceAccepted(options) {
	if (!MULTI) return true;
	if (options?.seq === false) return true;
	return Number.isInteger(options?.seq) && options.seq >= 1 && options?.relay === false;
}
function oldStampSeq(options, seqMap) {
	if (options != null) {
		const opt = options.seq;
		if (opt === false) return null;
		if (typeof opt === 'number') {
			if (Number.isInteger(opt) && opt >= 1) return opt;
			throw new TypeError('invalid seq');
		}
	}
	const next = (seqMap.get(topic) ?? 0) + 1;
	seqMap.set(topic, next);
	return next;
}

// Variant A: the pre-change live-read shape (assert reads the object, the
// stamp reads it again, every decision reads it again).
function liveReads(options, seqMap, seenMap) {
	if (!oldClusterSequenceAccepted(options)) throw new Error('refused');
	const seq = oldStampSeq(options, seqMap);
	if (seq !== null) {
		if (options && typeof options.seq === 'number') recordSeen(seenMap, topic, seq);
		else seenMap.set(topic, seq);
	}
	const jitterMs = (options && typeof options.jitterMs === 'number' && options.jitterMs > 0) ? options.jitterMs : null;
	const compress = false && (!options || options.compress !== false);
	const relayed = !!(null && (!options || options.relay !== false));
	return { seq, jitterMs, compress, relayed };
}

// Variant B: the shipped captured shape (one read per field, values forms).
function captured(options, seqMap, seenMap) {
	const seqOption = options != null ? options.seq : undefined;
	const relayOption = options != null ? options.relay : undefined;
	const compressOption = options != null ? options.compress : undefined;
	const jitterOption = options != null ? options.jitterMs : undefined;
	if (!clusterSequenceValuesAccepted(seqOption, relayOption)) throw new Error('refused');
	const seq = stampSeqValue(seqOption, seqMap, topic);
	if (seq !== null) {
		if (typeof seqOption === 'number') recordSeen(seenMap, topic, seq);
		else seenMap.set(topic, seq);
	}
	const jitterMs = (typeof jitterOption === 'number' && jitterOption > 0) ? jitterOption : null;
	const compress = false && compressOption !== false;
	const relayed = !!(null && relayOption !== false);
	return { seq, jitterMs, compress, relayed };
}

const SHAPES = [
	['absent', undefined],
	['seq-false', { seq: false }],
	['numeric', { seq: 1, relay: false }]
];

function run(fn, options) {
	const seqMap = new Map();
	const seenMap = new Map();
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < ITERATIONS; i++) {
		// The numeric shape must vary or the monotone guard throws on repeats.
		const opts = options && typeof options.seq === 'number' ? { seq: i + 1, relay: false } : options;
		const out = fn(opts, seqMap, seenMap);
		sink += out.seq === null ? 0 : 1;
	}
	const ns = Number(process.hrtime.bigint() - start);
	return { ns, sink };
}

let totalSink = 0;

for (const [name, options] of SHAPES) {
	const a = [];
	const b = [];
	for (let round = 0; round < ROUNDS; round++) {
		const ra = run(liveReads, options);
		const rb = run(captured, options);
		a.push(ra.ns);
		b.push(rb.ns);
		totalSink += ra.sink + rb.sink;
	}
	const med = (xs) => xs.sort((p, q) => p - q)[xs.length >> 1];
	const medA = med(a);
	const medB = med(b);
	const perA = medA / ITERATIONS;
	const perB = medB / ITERATIONS;
	console.log(
		`${name.padEnd(10)} live-reads ${perA.toFixed(2)} ns/op   captured ${perB.toFixed(2)} ns/op   delta ${(((perB - perA) / perA) * 100).toFixed(2)}%`
	);
}
// Defeats dead-code elimination of the resolution results.
console.log('sink', totalSink);
