// Microbenchmark: A/B test the cost of wrapping ws.getUserData() and
// ws.subscribe() in try/catch inside platform.subscribe.
//
// The closed-WS race fix adds two try/catch blocks around uWS calls
// that can throw on freed sockets. Credo #4 requires hot-path A/B
// before/after; this isolates the V8 try/catch cost from everything
// else by mocking ws as a plain object so the only difference between
// variants is the try/catch wrapper.
//
// Usage:
//   node bench/micro-subscribe-trycatch.mjs [iterations] [rounds]
//
// Defaults: 5_000_000 iterations, 10 rounds.

const ITERATIONS = parseInt(process.argv[2] || '5000000', 10);
const ROUNDS = parseInt(process.argv[3] || '10', 10);

const WS_SUBSCRIPTIONS = Symbol.for('adapter-uws.ws.subs');
const MAX_SUBS = 1024;

function makeWs() {
	const userData = {};
	userData[WS_SUBSCRIPTIONS] = new Set();
	return {
		getUserData() { return userData; },
		subscribe(topic) { /* mock uWS subscribe */ },
	};
}

const TOPICS = [
	'chat', 'todos', 'cursor', 'presence', 'replay',
	'__presence:room1', '__cursor:doc-12', '__replay:chat',
	'room:a', 'room:b', 'room:c', 'room:d', 'room:e', 'room:f', 'room:g', 'room:h'
];

// Variant A: bare uWS calls (current code shape, pre-fix).
function subscribeBare(ws, topic) {
	const subs = ws.getUserData()[WS_SUBSCRIPTIONS];
	if (subs.has(topic)) return null;
	if (subs.size >= MAX_SUBS) return 'RATE_LIMITED';
	ws.subscribe(topic);
	subs.add(topic);
	return null;
}

// Variant B: try/catch around both uWS calls (post-fix shape).
function subscribeGuarded(ws, topic) {
	let subs;
	try {
		subs = ws.getUserData()[WS_SUBSCRIPTIONS];
	} catch {
		return null;
	}
	if (subs.has(topic)) return null;
	if (subs.size >= MAX_SUBS) return 'RATE_LIMITED';
	try {
		ws.subscribe(topic);
	} catch {
		return null;
	}
	subs.add(topic);
	return null;
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

function run(fn) {
	const ws = makeWs();
	const t0 = performance.now();
	let acc = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const topic = TOPICS[i & 15];
		const r = fn(ws, topic);
		if (r === null) acc++;
		// Periodically clear subs so the hash set stays small and we keep
		// hitting the steady-state path (subs.has -> false, subscribe, add).
		if ((i & 0xfff) === 0xfff) ws.getUserData()[WS_SUBSCRIPTIONS].clear();
	}
	const t1 = performance.now();
	return { ms: t1 - t0, acc };
}

console.log(`Node ${process.version}, ${ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds, alternating`);
console.log('\nplatform.subscribe inner hot path: bare vs try/catch-wrapped');

for (let i = 0; i < 3; i++) { run(subscribeBare); run(subscribeGuarded); }

const bareMs = [];
const guardMs = [];
let aSum = 0, bSum = 0;
for (let r = 0; r < ROUNDS; r++) {
	const a = run(subscribeBare); aSum += a.acc; bareMs.push(a.ms);
	const b = run(subscribeGuarded); bSum += b.acc; guardMs.push(b.ms);
	process.stdout.write(`  Round ${r + 1}/${ROUNDS}: bare ${a.ms.toFixed(1)}ms  guarded ${b.ms.toFixed(1)}ms\n`);
}

if (aSum !== bSum) {
	console.log(`  WARNING: accumulator mismatch bare=${aSum} guarded=${bSum}`);
}

const aMed = median(bareMs);
const bMed = median(guardMs);
const aSd = stddev(bareMs);
const bSd = stddev(guardMs);
const deltaPct = ((bMed - aMed) / aMed) * 100;

console.log(`\n  ${'bare'.padEnd(20)} median ${aMed.toFixed(2).padStart(8)}ms  +/- ${aSd.toFixed(2)}`);
console.log(`  ${'guarded'.padEnd(20)} median ${bMed.toFixed(2).padStart(8)}ms  +/- ${bSd.toFixed(2)}`);
console.log(`  ${'delta (slowdown)'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (positive = guarded slower)`);

const noiseFloor = (aSd / aMed) * 100;
if (Math.abs(deltaPct) <= noiseFloor) {
	console.log(`  VERDICT: noise (within baseline stddev ${noiseFloor.toFixed(2)}%) -> try/catch is free`);
} else if (deltaPct < 0) {
	console.log(`  VERDICT: guarded FASTER (V8 quirk, but free) by ${Math.abs(deltaPct).toFixed(2)}%`);
} else if (deltaPct < 1) {
	console.log(`  VERDICT: guarded slower by <1% (${deltaPct.toFixed(2)}%) -> negligible`);
} else {
	console.log(`  VERDICT: guarded slower by ${deltaPct.toFixed(2)}% -> investigate`);
}
console.log();
