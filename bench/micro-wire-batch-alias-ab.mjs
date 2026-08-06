// Microbenchmark: A/B the publishWireBatch per-entry reads before vs after
// normalising the caller's entries into private parallel arrays.
//
// The batch used to read the caller's `entries[]` again after application code
// had already run inside the call (a payload's toJSON runs during
// completeEnvelope), so the exclusion target, the payload handed to the binary
// encode, and the entry count could all change between reads.
//
// This file measures two successive answers to that, because the first one was
// not enough. Reading each entry's fields ONCE into parallel arrays (B, D)
// stops anything ALREADY BUILT from being rewritten, but the read for entry i
// still happens in the same iteration as entry i's serialise - so entry 0's
// toJSON runs before entries 1..N-1 have been read, and can still choose what
// the batch publishes for them. Reading the WHOLE array first (F) is what
// closes that, and F is the shipped shape.
//
// The trade is N property reads spread across later loops for array
// allocations plus N stores, and - for F - one array the JSON fast path did
// not previously allocate. publishWireBatch is a per-message path, so this
// measures whether any of that costs anything at the batch sizes that ship.
//
// Variant A is the read-through-entries shape. B is the one-read-per-field
// shape, D the same with the arrays allocated lazily (the shape that shipped
// before F). C is B written with Array.from and a mapper rather than an
// indexed loop - included because a sibling port measured the iterator
// protocol +36% median at 64 entries, and a claim like that is worth
// confirming in THIS tree rather than inheriting.
//
// Every variant pays the real stampSeq + completeEnvelope cost a batch pays,
// so the delta reads as a fraction of real work rather than of a bare loop.
//
// Usage:
//   node bench/micro-wire-batch-alias-ab.mjs [iterations] [rounds]
// Defaults: 200_000 iterations, 9 rounds.

import { performance } from 'node:perf_hooks';
import { stampSeq, completeEnvelope } from '../src/runtime/utils/epoch.js';

const ITERATIONS = parseInt(process.argv[2] || '200000', 10);
const ROUNDS = parseInt(process.argv[3] || '9', 10);

const ENV_PREFIX = '{"topic":"room","event":"tick","data":';
const OPTIONS = { seq: false };

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function makeEntries(count) {
	const entries = new Array(count);
	for (let i = 0; i < count; i++) {
		entries[i] = { data: { x: i, y: i * 2, id: 'e' + i, n: 42 } };
	}
	return entries;
}

// Variant A: stamping loop reads entries[i].data and entries[i].excludeWs, and
// the later loops (resume capture, JSON fan-out, relay) read entries again.
function readThrough(entries, seqMap) {
	const envs = new Array(entries.length);
	const seqs = new Array(entries.length);
	let anyExclude = false;
	for (let i = 0; i < entries.length; i++) {
		const seq = stampSeq(OPTIONS, seqMap, 'room');
		seqs[i] = seq == null ? 0 : seq;
		envs[i] = completeEnvelope(ENV_PREFIX, entries[i].data, seq, null);
		if (entries[i].excludeWs !== undefined && entries[i].excludeWs !== null) anyExclude = true;
	}
	// The downstream loops, as they were: bounds and fields re-read live.
	let sink = 0;
	for (let i = 0; i < entries.length; i++) sink += envs[i].length;
	for (let i = 0; i < entries.length; i++) if (entries[i].excludeWs === null) sink++;
	for (let i = 0; i < entries.length; i++) sink += entries[i].data.n;
	return sink + (anyExclude ? 1 : 0);
}

// Variant B: one read per field into parallel arrays; downstream reads those.
function normalised(entries, seqMap) {
	const count = entries.length;
	const envs = new Array(count);
	const seqs = new Array(count);
	const datas = new Array(count);
	const excludes = new Array(count);
	let anyExclude = false;
	for (let i = 0; i < count; i++) {
		const entry = entries[i];
		const data = entry.data;
		const exclude = entry.excludeWs === undefined ? null : entry.excludeWs;
		datas[i] = data;
		excludes[i] = exclude;
		const seq = stampSeq(OPTIONS, seqMap, 'room');
		seqs[i] = seq == null ? 0 : seq;
		envs[i] = completeEnvelope(ENV_PREFIX, data, seq, null);
		if (exclude !== null) anyExclude = true;
	}
	let sink = 0;
	for (let i = 0; i < count; i++) sink += envs[i].length;
	for (let i = 0; i < count; i++) if (excludes[i] === null) sink++;
	for (let i = 0; i < count; i++) sink += datas[i].n;
	return sink + (anyExclude ? 1 : 0);
}

// Variant C: the same normalisation via Array.from + mapper (iterator protocol).
function normalisedIterator(entries, seqMap) {
	const count = entries.length;
	const records = Array.from(entries, (entry) => ({
		data: entry.data,
		exclude: entry.excludeWs === undefined ? null : entry.excludeWs
	}));
	const envs = new Array(count);
	const seqs = new Array(count);
	let anyExclude = false;
	for (let i = 0; i < count; i++) {
		const seq = stampSeq(OPTIONS, seqMap, 'room');
		seqs[i] = seq == null ? 0 : seq;
		envs[i] = completeEnvelope(ENV_PREFIX, records[i].data, seq, null);
		if (records[i].exclude !== null) anyExclude = true;
	}
	let sink = 0;
	for (let i = 0; i < count; i++) sink += envs[i].length;
	for (let i = 0; i < count; i++) if (records[i].exclude === null) sink++;
	for (let i = 0; i < count; i++) sink += records[i].data.n;
	return sink + (anyExclude ? 1 : 0);
}

// Variant D: normalised, but the two arrays are allocated only when something
// will read them. `datas` is needed only by the binary walk and the relay, both
// known before the loop; `excludes` only once an entry actually carries one. The
// JSON fast path - no capable subscriber, no exclusion - therefore allocates
// exactly what it allocates today.
//
// `needsData` is a PLAIN parameter, as the shipped code has it. It was written
// as `{ needsData = false } = {}` here, which bound a fresh default object on
// every call that the shipped code never pays - and since the runner passed no
// third argument, the true branch never ran at all. D then read consistently
// worse than B, which is the same shape without the extra parameter, and that
// gap was the measurement artefact rather than the change.
function normalisedLazy(entries, seqMap, needsData) {
	const count = entries.length;
	const envs = new Array(count);
	const seqs = new Array(count);
	const datas = needsData ? new Array(count) : null;
	let excludes = null;
	let anyExclude = false;
	for (let i = 0; i < count; i++) {
		const entry = entries[i];
		const data = entry.data;
		if (needsData) datas[i] = data;
		const exclude = entry.excludeWs === undefined ? null : entry.excludeWs;
		if (exclude !== null) {
			if (excludes === null) excludes = new Array(count);
			excludes[i] = exclude;
			anyExclude = true;
		}
		const seq = stampSeq(OPTIONS, seqMap, 'room');
		seqs[i] = seq == null ? 0 : seq;
		envs[i] = completeEnvelope(ENV_PREFIX, data, seq, null);
	}
	let sink = 0;
	for (let i = 0; i < count; i++) sink += envs[i].length;
	if (anyExclude) for (let i = 0; i < count; i++) if (excludes[i] === undefined) sink++;
	else sink += count;
	if (needsData) for (let i = 0; i < count; i++) sink += datas[i].n;
	else for (let i = 0; i < count; i++) sink += entries[i].data.n;
	return sink + (anyExclude ? 1 : 0);
}

// Variant F: TWO PASSES - every entry's fields are read before any envelope is
// built. A, B, C and D all read entry i and then serialise entry i in the same
// iteration, and completeEnvelope runs the payload's toJSON, so entry 0's
// application code still runs before entries 1..N-1 have been read: it can
// replace a later payload, a later exclusion, or the array itself. Only
// separating the passes closes that, and it forces `datas` to exist even on the
// JSON path, because N references have to be held before the first serialise.
// This measures what that costs.
function normalisedTwoPass(entries, seqMap, needsData) {
	const count = entries.length;
	const datas = new Array(count);
	let excludes = null;
	let anyExclude = false;
	for (let i = 0; i < count; i++) {
		const entry = entries[i];
		datas[i] = entry.data;
		const exclude = entry.excludeWs === undefined ? null : entry.excludeWs;
		if (exclude !== null) {
			if (excludes === null) excludes = new Array(count);
			excludes[i] = exclude;
			anyExclude = true;
		}
	}
	const envs = new Array(count);
	const seqs = new Array(count);
	for (let i = 0; i < count; i++) {
		const seq = stampSeq(OPTIONS, seqMap, 'room');
		seqs[i] = seq == null ? 0 : seq;
		envs[i] = completeEnvelope(ENV_PREFIX, datas[i], seq, null);
	}
	let sink = 0;
	for (let i = 0; i < count; i++) sink += envs[i].length;
	if (anyExclude) for (let i = 0; i < count; i++) if (excludes[i] === undefined) sink++;
	else sink += count;
	for (let i = 0; i < count; i++) sink += datas[i].n;
	if (needsData) sink += 0;
	return sink + (anyExclude ? 1 : 0);
}

// Every variant is called with the SAME arity, so none of them differs from the
// others by an argument-shape the shipped code does not have. A, B and C ignore
// the third argument; only D and F read it.
function run(fn, entries, iterations, needsData = false) {
	const seqMap = new Map();
	let sink = 0;
	const start = performance.now();
	for (let i = 0; i < iterations; i++) sink += fn(entries, seqMap, needsData);
	const elapsed = performance.now() - start;
	if (sink === -1) console.log('unreachable');
	return elapsed;
}

console.log('publishWireBatch entry-read A/B: read-through vs normalised parallel arrays');
console.log(`${ITERATIONS} batches per round, ${ROUNDS} rounds, median reported.\n`);

for (const SIZE of [1, 8, 64]) {
	const entries = makeEntries(SIZE);
	const iterations = Math.max(1, Math.round(ITERATIONS / SIZE));
	const a = [];
	const b = [];
	const c = [];
	const d = [];
	const e = [];
	const f = [];
	// Warm every shape before measuring so none pays first-call compilation.
	run(readThrough, entries, 2000);
	run(normalised, entries, 2000);
	run(normalisedIterator, entries, 2000);
	run(normalisedLazy, entries, 2000, false);
	run(normalisedLazy, entries, 2000, true);
	run(normalisedTwoPass, entries, 2000, false);
	for (let round = 0; round < ROUNDS; round++) {
		a.push(run(readThrough, entries, iterations));
		b.push(run(normalised, entries, iterations));
		c.push(run(normalisedIterator, entries, iterations));
		d.push(run(normalisedLazy, entries, iterations, false));
		e.push(run(normalisedLazy, entries, iterations, true));
		f.push(run(normalisedTwoPass, entries, iterations, false));
	}
	const ma = median(a);
	const mb = median(b);
	const mc = median(c);
	const md = median(d);
	const me = median(e);
	const mf = median(f);
	const pct = (x) => ((x - ma) / ma) * 100;
	const fmt = (x) => (pct(x) >= 0 ? '+' : '') + pct(x).toFixed(1) + '% vs A';
	console.log(`${String(SIZE).padStart(3)} entries x ${iterations} batches:`);
	console.log(`   A read-through           ${ma.toFixed(1)} ms`);
	console.log(`   B normalised (eager)     ${mb.toFixed(1)} ms   ${fmt(mb)}`);
	console.log(`   C Array.from mapper      ${mc.toFixed(1)} ms   ${fmt(mc)}`);
	console.log(`   D normalised (lazy)      ${md.toFixed(1)} ms   ${fmt(md)}   <- previous shape, JSON fast path`);
	console.log(`   E normalised (lazy, bin) ${me.toFixed(1)} ms   ${fmt(me)}   <- previous shape, binary/relay path`);
	const vsD = ((mf - md) / md) * 100;
	console.log(`   F two-pass (alias-safe)  ${mf.toFixed(1)} ms   ${fmt(mf)}   <- SHIPPED shape: reads every entry before any toJSON runs`);
	console.log(`     F vs D (the shape it replaced): ${vsD >= 0 ? '+' : ''}${vsD.toFixed(1)}%\n`);
}
