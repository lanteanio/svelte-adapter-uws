// Microbenchmark: A/B the publishWire relay-marker read, property versus
// argument.
//
// The relay receive half's marker started as two string option keys
// (`_isRelay`, then `_relaySeq`), became one Symbol key on the same options
// object, and is now an ARGUMENT compared by identity against a module-private
// token - because a marker read as a property is satisfied by any object that
// answers for every key, without naming the key. Every publishWire call pays
// whichever shape is in force, including the 60 Hz cursor lane, so the rule
// this repo holds applies: a per-publish change on the hottest lane needs a
// measured delta, not an estimate.
//
// Three variants over the same operand shapes: the original string keys, the
// Symbol key that replaced them, and the shipped identity compare. Each then
// takes the same branch on the result, so what is timed is the marker
// resolution and nothing else - no envelope is built inside the window.
//
// The shapes are the ones the lane actually meets: no options at all (the hot
// path), an ordinary application options object (the other hot path, and the
// one where a property miss is paid), and a marked relay re-entry.
//
// `absent` doubles as the control arm: no variant reads a property there, so
// whatever it reports is this bench's floor rather than an effect. Read the
// other two shapes against it, not against zero.
//
// Usage:
//   node bench/micro-relay-marker-ab.mjs [iterations] [rounds]
// Defaults: 10_000_000 iterations, 10 rounds.

const ITERATIONS = parseInt(process.argv[2] || '10000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);

const SYMBOL_KEY = Symbol('adapter-uws.relay-origin-seq');
const TOKEN = Symbol('adapter-uws.relay-receive');

// Variant A: the original string-key marker.
function stringKeys(options) {
	const isRelay = !!(options && options._isRelay);
	const relaySeqOption = isRelay ? options._relaySeq : undefined;
	const seq = isRelay ? (typeof relaySeqOption === 'number' ? relaySeqOption : null) : 0;
	return { isRelay, seq };
}

// Variant B: one Symbol key, presence as the test.
function symbolKey(options) {
	const relayOriginSeq = options != null ? options[SYMBOL_KEY] : undefined;
	const isRelay = relayOriginSeq !== undefined;
	const seq = isRelay ? (typeof relayOriginSeq === 'number' ? relayOriginSeq : null) : 0;
	return { isRelay, seq };
}

// Variant C: the shipped shape - no property lookup at all.
function identityToken(options, relayToken, relaySeq) {
	const isRelay = relayToken === TOKEN;
	const seq = isRelay ? (typeof relaySeq === 'number' ? relaySeq : null) : 0;
	return { isRelay, seq };
}

const SHAPES = [
	['absent', [undefined], [undefined], [undefined, undefined, undefined]],
	['app-options', [{ compress: true }], [{ compress: true }], [{ compress: true }, undefined, undefined]],
	['relay', [{ _isRelay: true, _relaySeq: 7 }], [{ [SYMBOL_KEY]: 7 }], [{ compress: true }, TOKEN, 7]]
];

function run(fn, args) {
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let i = 0; i < ITERATIONS; i++) {
		const out = fn(args[0], args[1], args[2]);
		sink += out.isRelay ? out.seq : 1;
	}
	const ns = Number(process.hrtime.bigint() - start);
	return { ns, sink };
}

let totalSink = 0;
const med = (xs) => xs.sort((p, q) => p - q)[xs.length >> 1];

for (const [name, argsA, argsB, argsC] of SHAPES) {
	const a = [];
	const b = [];
	const c = [];
	for (let round = 0; round < ROUNDS; round++) {
		const ra = run(stringKeys, argsA);
		const rb = run(symbolKey, argsB);
		const rc = run(identityToken, argsC);
		a.push(ra.ns);
		b.push(rb.ns);
		c.push(rc.ns);
		totalSink += ra.sink + rb.sink + rc.sink;
	}
	const perA = med(a) / ITERATIONS;
	const perB = med(b) / ITERATIONS;
	const perC = med(c) / ITERATIONS;
	console.log(
		`${name.padEnd(12)} string-keys ${perA.toFixed(3)}   symbol-key ${perB.toFixed(3)}   token ${perC.toFixed(3)} ns/op` +
		`   token vs string ${(((perC - perA) / perA) * 100).toFixed(2)}%   token vs symbol ${(((perC - perB) / perB) * 100).toFixed(2)}%`
	);
}
// Defeats dead-code elimination of the resolution results.
console.log('sink', totalSink);
