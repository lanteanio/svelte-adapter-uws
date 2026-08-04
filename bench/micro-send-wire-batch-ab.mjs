// Microbenchmark: A/B sendWireBatch's payload pinning, eager vs decided at the
// capability test.
//
// sendWireBatch is the per-viewer counterpart to publishWireBatch - the culled
// delivery walk calls it once per viewer, so a 200-viewer room at 60 Hz runs it
// 12,000 times a second. When the batch one-read rule landed it pinned the
// caller's payloads into a private array at the TOP of the function, above the
// capability test, and then copied that array into a second one for the codec.
// Two consequences, both paid per call:
//
//   - a caps-less, poisoned, or stateless-codec viewer took an N-array on a
//     JSON-only send where it had previously taken none;
//   - a capable viewer took two N-arrays where it had previously taken one,
//     the second a verbatim copy of an array that was already private.
//
// The shipped shape decides at the same place publishWireBatch does: the
// JSON-only send reads the caller's entry as the walk reaches it (it builds
// nothing a later entry's toJSON could go back and rewrite, and it is one
// socket, so no two subscribers can disagree about an entry), and the binary
// send pins once and hands that array to the codec directly.
//
// Variant A is the eager shape, B is the shipped shape. Both are measured on
// the JSON-only path and on the binary path, because the trade runs in opposite
// directions on the two: B removes an allocation from the first and a copy from
// the second, at the cost of one branch per entry on the first.
//
// Usage:
//   node bench/micro-send-wire-batch-ab.mjs [iterations] [rounds]
// Defaults: 200_000 iterations, 9 rounds.

import { performance } from 'node:perf_hooks';

const ITERATIONS = parseInt(process.argv[2] || '200000', 10);
const ROUNDS = parseInt(process.argv[3] || '9', 10);

const ENV_PREFIX = '{"topic":"room","event":"tick","data":';

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function makeEntries(size) {
	const entries = new Array(size);
	for (let i = 0; i < size; i++) entries[i] = { data: { n: i, x: 'payload-' + i } };
	return entries;
}

// Stands in for the codec: reads the whole array it is handed, exactly as a
// real `encode(event + '-batch', { updates }, state)` does.
function encode(batch) {
	let sink = 0;
	const updates = batch.updates;
	for (let i = 0; i < updates.length; i++) sink += updates[i].n;
	return sink;
}

// Variant A: pin eagerly at the top, then copy into `updates` for the codec.
function eager(entries, binary) {
	const count = entries.length;
	const datas = new Array(count);
	for (let i = 0; i < count; i++) datas[i] = entries[i].data;
	const sendJsonFrom = (i) => {
		let sink = 0;
		for (; i < count; i++) sink += (ENV_PREFIX + JSON.stringify(datas[i] ?? null) + '}').length;
		return sink;
	};
	if (!binary) return sendJsonFrom(0);
	const updates = new Array(count);
	for (let i = 0; i < count; i++) updates[i] = datas[i];
	return encode({ updates });
}

// Variant B: decide at the capability test; hand the one array to the codec.
function decided(entries, binary) {
	const count = entries.length;
	const sendJsonFrom = (i, source) => {
		let sink = 0;
		for (; i < count; i++) {
			const d = source === null ? entries[i].data : source[i];
			sink += (ENV_PREFIX + JSON.stringify(d ?? null) + '}').length;
		}
		return sink;
	};
	if (!binary) return sendJsonFrom(0, null);
	const datas = new Array(count);
	for (let i = 0; i < count; i++) datas[i] = entries[i].data;
	return encode({ updates: datas });
}

function run(fn, entries, iterations, binary) {
	let sink = 0;
	const start = performance.now();
	for (let i = 0; i < iterations; i++) sink += fn(entries, binary);
	const elapsed = performance.now() - start;
	if (sink === -1) console.log('unreachable');
	return elapsed;
}

console.log('sendWireBatch payload pinning A/B: eager-at-top vs decided-at-capability');
console.log(`${ITERATIONS} sends per round, ${ROUNDS} rounds, median reported.\n`);

for (const SIZE of [1, 8, 30, 64]) {
	const entries = makeEntries(SIZE);
	const iterations = Math.max(1, Math.round(ITERATIONS / SIZE));
	for (const binary of [false, true]) {
		const a = [];
		const b = [];
		run(eager, entries, 2000, binary);
		run(decided, entries, 2000, binary);
		for (let round = 0; round < ROUNDS; round++) {
			a.push(run(eager, entries, iterations, binary));
			b.push(run(decided, entries, iterations, binary));
		}
		const ma = median(a);
		const mb = median(b);
		const pct = ((mb - ma) / ma) * 100;
		const fmt = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% vs A';
		console.log(`${String(SIZE).padStart(3)} entries x ${iterations} sends, ${binary ? 'binary' : 'JSON-only'}:`);
		console.log(`   A eager at top           ${ma.toFixed(1)} ms`);
		console.log(`   B decided at capability  ${mb.toFixed(1)} ms   ${fmt}`);
	}
	console.log('');
}
