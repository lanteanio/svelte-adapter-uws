// @ts-check
//
// Encode-once vs per-subscriber encode: where is the crossover? Run with:
// node bench/encode-crossover.mjs
//
// The broadcast fan-out has three codec-state regimes (all live in
// src/runtime/handler/platform.js):
//
//   1. STATELESS encode-once-send-many: one wire.encode per broadcast, every
//      capable subscriber receives the same frame (the shared-cohort ideal;
//      the CRDT and presence codecs ride this).
//   2. STATEFUL per-subscriber encode: the cursor dict wire (protocol 3/4/5)
//      encodes against each connection's OWN dictionary - smaller frames,
//      but one encode PER SUBSCRIBER per broadcast.
//   3. SHARED + PER-CLIENT TAIL: encode the shared portion once, append a
//      small per-client delta (the industry middle ground for state sync).
//
// The measured quantities, per subscriber count N:
//   - CPU per broadcast (all N subscribers served) and ns per subscriber,
//   - wire bytes per frame (the stateful dict's entire justification).
//
// The workload drives the REAL cursor codec: a 64-cursor room at steady
// state (every key already interned, positions moving in small deltas - the
// regime where the dict wire is at its best), one 'update' broadcast per
// cursor per round. The stateless comparator is the same codec's protocol-2
// (full-string) encoder; the shared+tail model reuses the stateless bytes
// and appends an 8-byte per-client tail.

import {
	encodeCursor,
	CursorStreamEncodeDict
} from '../src/plugins/cursor/codec.js';

const CURSORS = 64;
const ROUNDS = 400; // broadcasts measured per (shape, N) cell
const SUBSCRIBER_COUNTS = [1, 8, 32, 128, 512, 2048];

let _t = 0;
const timeSource = () => (_t += 4);

/** One steady-state cursor update per round, small position deltas. */
function makeUpdate(round, c) {
	return {
		key: 'user-' + c,
		data: { x: 100 + ((round * 3 + c) % 50) * 0.5, y: 200 + ((round * 5 + c) % 40) * 0.5 }
	};
}

/** Warm a dict so every key is interned (steady state, not first-sight). */
function warmDict(dict) {
	for (let c = 0; c < CURSORS; c++) encodeCursor('update', makeUpdate(0, c), dict);
	return dict;
}

function measureStateful(n) {
	const dicts = [];
	for (let i = 0; i < n; i++) dicts.push(warmDict(new CursorStreamEncodeDict(timeSource)));
	let bytes = 0;
	let frames = 0;
	const start = process.hrtime.bigint();
	for (let r = 1; r <= ROUNDS; r++) {
		const update = makeUpdate(r, r % CURSORS);
		for (let i = 0; i < n; i++) {
			const out = encodeCursor('update', update, dicts[i]);
			if (out) { bytes += out.length; frames++; }
		}
	}
	const elapsedNs = Number(process.hrtime.bigint() - start);
	return { elapsedNs, bytesPerFrame: bytes / frames };
}

function measureStateless(n) {
	let bytes = 0;
	let frames = 0;
	let sink = 0;
	const start = process.hrtime.bigint();
	for (let r = 1; r <= ROUNDS; r++) {
		const update = makeUpdate(r, r % CURSORS);
		const out = encodeCursor('update', update, null); // protocol-2: stateless
		if (out) { bytes += out.length; frames++; }
		// Fan-out is a native single publish in production (one frame, N
		// receivers); model the per-subscriber cost as a pointer touch.
		for (let i = 0; i < n; i++) sink += out ? out.length : 0;
	}
	const elapsedNs = Number(process.hrtime.bigint() - start);
	if (sink === -1) console.log(sink);
	return { elapsedNs, bytesPerFrame: bytes / frames };
}

function measureSharedTail(n) {
	let bytes = 0;
	let frames = 0;
	const tail = new Uint8Array(8);
	const start = process.hrtime.bigint();
	for (let r = 1; r <= ROUNDS; r++) {
		const update = makeUpdate(r, r % CURSORS);
		const shared = encodeCursor('update', update, null);
		if (!shared) continue;
		for (let i = 0; i < n; i++) {
			// Per-client tail: allocate the concatenated frame and stamp an
			// 8-byte client-specific suffix (ack/interest bits) - the
			// shared-pass + per-view-delta shape.
			const frame = new Uint8Array(shared.length + tail.length);
			frame.set(shared, 0);
			tail[0] = i & 0xff;
			frame.set(tail, shared.length);
			bytes += frame.length;
			frames++;
		}
	}
	const elapsedNs = Number(process.hrtime.bigint() - start);
	return { elapsedNs, bytesPerFrame: bytes / frames };
}

function fmt(n, digits = 1) {
	return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function report(label, n, r) {
	const perBroadcastUs = r.elapsedNs / ROUNDS / 1000;
	const perSubNs = r.elapsedNs / ROUNDS / n;
	console.log(
		label.padEnd(12) + ' | N=' + String(n).padStart(5) +
		' | ' + fmt(perBroadcastUs).padStart(9) + ' us/broadcast' +
		' | ' + fmt(perSubNs, 0).padStart(8) + ' ns/subscriber' +
		' | ' + fmt(r.bytesPerFrame).padStart(6) + ' B/frame'
	);
	return perBroadcastUs;
}

console.log('encode-once vs per-subscriber encode crossover (' + CURSORS + '-cursor room, steady state, ' + ROUNDS + ' broadcasts/cell)\n');

// Warm-up pass discarded (JIT).
measureStateful(8); measureStateless(8); measureSharedTail(8);

const crossovers = [];
for (const n of SUBSCRIBER_COUNTS) {
	const stateless = report('stateless', n, measureStateless(n));
	const sharedTail = report('shared+tail', n, measureSharedTail(n));
	const stateful = report('stateful', n, measureStateful(n));
	crossovers.push({ n, ratio: stateful / stateless, tailRatio: stateful / sharedTail });
	console.log('');
}

console.log('stateful-vs-stateless CPU ratio by N: ' + crossovers.map((c) => 'N=' + c.n + ': ' + fmt(c.ratio) + 'x').join('  '));
console.log('stateful-vs-shared+tail CPU ratio by N: ' + crossovers.map((c) => 'N=' + c.n + ': ' + fmt(c.tailRatio) + 'x').join('  '));
console.log('\nReading: the stateful dict buys its B/frame reduction with CPU that scales');
console.log('linearly in N while encode-once stays flat; the ratio row is the crossover');
console.log('curve. Weigh it against the frame-size column: below the N where encode CPU');
console.log('binds, the dict wire wins on bytes; past it, the shared(+tail) shapes win.');
