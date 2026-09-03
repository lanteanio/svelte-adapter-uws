// Microbenchmark: A/B the publishWire relay-marker read, string keys vs Symbol.
//
// The relay receive half's marker moved from two string option keys
// (`_isRelay`, then `_relaySeq` when the first was set) to one module-private
// Symbol whose value IS the origin seq. Every publishWire call reads it,
// including the 60 Hz cursor lane, so the rule this repo holds applies: a
// per-publish change on the hottest lane needs a measured delta, not an
// estimate.
//
// Variant A replays the pre-change shape: a string-key miss on the origin path,
// two reads on the relay path. Variant B is the shipped shape: one Symbol read
// either way. Both then take the same branch the lane takes on the result, so
// what is timed is the marker resolution and nothing else - no envelope is
// built inside the window, so the percentages are of the resolution alone
// rather than of a whole publish.
//
// The shapes are the ones the lane actually meets: no options at all (the hot
// path), an ordinary application options object (the other hot path, and the
// one where a miss lookup is paid), and a marked relay re-entry.
//
// `absent` doubles as the control arm: both variants short-circuit on a null
// options object and read no property at all, so whatever it reports is this
// bench's floor rather than an effect. Read the other two shapes against it,
// not against zero.
//
// Usage:
//   node bench/micro-relay-marker-ab.mjs [iterations] [rounds]
// Defaults: 10_000_000 iterations, 10 rounds.

import { RELAY_ORIGIN_SEQ } from '../src/runtime/handler/cluster-sequence-policy.js';

const ITERATIONS = parseInt(process.argv[2] || '10000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);

// Variant A: the pre-change string-key marker.
function stringKeys(options) {
	const isRelay = !!(options && options._isRelay);
	const relaySeqOption = isRelay ? options._relaySeq : undefined;
	const seq = isRelay ? (typeof relaySeqOption === 'number' ? relaySeqOption : null) : 0;
	return { isRelay, seq };
}

// Variant B: the shipped Symbol marker, one read, presence is the test.
function symbolKey(options) {
	const relayOriginSeq = options != null ? options[RELAY_ORIGIN_SEQ] : undefined;
	const isRelay = relayOriginSeq !== undefined;
	const seq = isRelay ? (typeof relayOriginSeq === 'number' ? relayOriginSeq : null) : 0;
	return { isRelay, seq };
}

const SHAPES = [
	['absent', undefined, undefined],
	['app-options', { compress: true }, { compress: true }],
	['relay', { _isRelay: true, _relaySeq: 7 }, { [RELAY_ORIGIN_SEQ]: 7 }]
];

function run(fn, options) {
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < ITERATIONS; i++) {
		const out = fn(options);
		sink += out.isRelay ? out.seq : 1;
	}
	const ns = Number(process.hrtime.bigint() - start);
	return { ns, sink };
}

let totalSink = 0;

for (const [name, optionsA, optionsB] of SHAPES) {
	const a = [];
	const b = [];
	for (let round = 0; round < ROUNDS; round++) {
		const ra = run(stringKeys, optionsA);
		const rb = run(symbolKey, optionsB);
		a.push(ra.ns);
		b.push(rb.ns);
		totalSink += ra.sink + rb.sink;
	}
	const med = (xs) => xs.sort((p, q) => p - q)[xs.length >> 1];
	const perA = med(a) / ITERATIONS;
	const perB = med(b) / ITERATIONS;
	console.log(
		`${name.padEnd(12)} string-keys ${perA.toFixed(3)} ns/op   symbol ${perB.toFixed(3)} ns/op   delta ${(((perB - perA) / perA) * 100).toFixed(2)}%`
	);
}
// Defeats dead-code elimination of the resolution results.
console.log('sink', totalSink);
