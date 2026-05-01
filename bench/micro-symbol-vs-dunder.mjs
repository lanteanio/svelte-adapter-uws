// Microbenchmark: A/B test the cost of stashing per-connection scratch
// state under a Symbol-keyed property (current) vs a dunder string
// property (the previous handler.js form). Same alternating-round
// methodology as bench/micro-utils.mjs.
//
// Models the WS subscribe hot path's critical inner sequence:
//   const subs = ws.getUserData()[KEY];
//   const isNew = !subs.has(topic);
//   subs.add(topic);
//
// Each variant uses a different key (Symbol vs string) but the same
// underlying Set + access pattern. V8's hidden-class machinery should
// treat these identically; this confirms it on the actual Node version.
//
// Usage:
//   node bench/micro-symbol-vs-dunder.mjs [iterations] [rounds]
// Defaults: 5_000_000 iterations, 10 rounds.

const ITERATIONS = parseInt(process.argv[2] || '5000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);

const SUBS_SYMBOL = Symbol('adapter-uws.ws.subscriptions');

// Realistic-ish per-connection userData shape: a couple of user-supplied
// fields (the upgrade hook return) plus the adapter's tracking slot.
function makeUserData(useSymbol) {
	const obj = { remoteAddress: '127.0.0.1', userId: 'user-123' };
	const subs = new Set();
	if (useSymbol) obj[SUBS_SYMBOL] = subs;
	else obj.__subscriptions = subs;
	return obj;
}

// Minimal ws.getUserData() simulator: each "ws" holds a userData and
// returns it on call. Keeps the call site shape close to real handler.js.
function makeWs(useSymbol) {
	const ud = makeUserData(useSymbol);
	return { getUserData: () => ud };
}

// Pre-built input pool: 32 distinct topic names, varied lengths.
const TOPICS = Array.from({ length: 32 }, (_, i) => `topic-${i}-${'x'.repeat(i % 4)}`);

// Pool of "ws" objects so we exercise more than one hidden class.
const WS_POOL_SIZE = 64;

function buildPool(useSymbol) {
	const pool = [];
	for (let i = 0; i < WS_POOL_SIZE; i++) pool.push(makeWs(useSymbol));
	return pool;
}

// Hot-path simulator: read userData[KEY], call has() + add(), repeat.
// Mirrors the subscribe handler's Set-mutation sequence.
function runSymbol(pool) {
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const ws = pool[i & (WS_POOL_SIZE - 1)];
		const topic = TOPICS[i & 31];
		const subs = ws.getUserData()[SUBS_SYMBOL];
		if (!subs.has(topic)) acc++;
		subs.add(topic);
		// Periodically clear to avoid unbounded growth (Set.add is O(1) but
		// we don't want a single Set with 32 unique topics x N-iter dominating).
		if ((i & 1023) === 0) subs.clear();
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

function runDunder(pool) {
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const ws = pool[i & (WS_POOL_SIZE - 1)];
		const topic = TOPICS[i & 31];
		const subs = ws.getUserData().__subscriptions;
		if (!subs.has(topic)) acc++;
		subs.add(topic);
		if ((i & 1023) === 0) subs.clear();
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
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

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds`);
console.log(`Symbol-keyed vs dunder-string-keyed userData slot access (subscribe hot path)`);

// Build separate pools (different hidden classes) and warm both up.
const symbolPool = buildPool(true);
const dunderPool = buildPool(false);
for (let i = 0; i < 3; i++) { runDunder(dunderPool); runSymbol(symbolPool); }

const dunderMs = [];
const symbolMs = [];
let aSum = 0, bSum = 0;
for (let r = 0; r < ROUNDS; r++) {
	const a = runDunder(dunderPool); aSum += a.acc; dunderMs.push(a.ms);
	const b = runSymbol(symbolPool); bSum += b.acc; symbolMs.push(b.ms);
	process.stdout.write(`  Round ${r + 1}/${ROUNDS}: dunder ${a.ms.toFixed(1)}ms  symbol ${b.ms.toFixed(1)}ms\n`);
}

if (Math.abs(aSum - bSum) > ITERATIONS / 1024) {
	console.log(`  WARNING: accumulator mismatch dunder=${aSum} symbol=${bSum} (functional drift)`);
}

const aMed = median(dunderMs);
const bMed = median(symbolMs);
const aSd = stddev(dunderMs);
const bSd = stddev(symbolMs);
const deltaPct = ((bMed - aMed) / aMed) * 100;
const noiseFloor = (aSd / aMed) * 100;

console.log(`  ${'dunder string'.padEnd(20)} median ${aMed.toFixed(2).padStart(8)}ms  +/- ${aSd.toFixed(2)}`);
console.log(`  ${'symbol'.padEnd(20)} median ${bMed.toFixed(2).padStart(8)}ms  +/- ${bSd.toFixed(2)}`);
console.log(`  ${'delta (slowdown)'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (positive = symbol slower)`);
if (Math.abs(deltaPct) <= noiseFloor) {
	console.log(`  VERDICT: noise (within baseline stddev ${noiseFloor.toFixed(2)}%) -> safe to swap`);
} else if (deltaPct < 0) {
	console.log(`  VERDICT: symbol FASTER by ${Math.abs(deltaPct).toFixed(2)}%`);
} else if (deltaPct < 1) {
	console.log(`  VERDICT: symbol slower by <1% (${deltaPct.toFixed(2)}%) -> borderline`);
} else {
	console.log(`  VERDICT: symbol slower by ${deltaPct.toFixed(2)}% -> KEEP DUNDER`);
}
console.log();
