// REAL uWS server-CPU-vs-subscriber-count bench for permessage-deflate.
//
// The question this answers: does turning on WS compression hurt the cursor hot
// path (a coalesced BULK frame fanned to thousands of subscribers)? That turns
// on ONE fact about uWS: does it compress a published frame ONCE and fan the
// bytes out (CPU flat in subscriber count) or recompress PER subscriber (CPU
// grows with N)? SHARED_COMPRESSOR has no per-connection context so it can
// compress once; DEDICATED_* keeps a per-connection window (context takeover) so
// the same frame compresses differently per socket and must be recompressed per
// subscriber. We MEASURE it rather than assume.
//
// Method: a live uWS App with one route per compression mode, N real `ws`
// subscribers connected to that route's topic, and a SYNCHRONOUS `app.publish`
// loop timed with hrtime. The synchronous loop never yields, so the N clients'
// receive handlers cannot run during it - the wall-clock IS the server's
// compress+fanout work, uncontaminated by client decompression. We also test the
// per-message `compress: false` flag (the cursor-opt-out lever) and a text
// presence frame for contrast. Frames are precomputed OUTSIDE the timed loop.
//
// Run: node bench/ws-compression-cpu.mjs   (starts its own server + clients; ~1-2 min)

import uWS from 'uWebSockets.js';
import { WebSocket } from 'ws';
import { buildBinaryFrame } from '../files/wire.js';
import { encodeCursor, CURSOR_SCHEMA_VERSION } from '../plugins/cursor/codec.js';
import { encodePresence, PRESENCE_SCHEMA_VERSION } from '../plugins/presence/codec.js';

const PORT = parseInt(process.env.PORT || '9120');

// DEDICATED_256KB omitted: it is byte-identical on the wire (window capped at
// 32 KB) and CPU-comparable to _4KB; it differs only in per-socket memory. _4KB
// is the representative dedicated compressor.
const MODES = [
	['DISABLED', uWS.DISABLED ?? 0],
	['SHARED_COMPRESSOR', uWS.SHARED_COMPRESSOR],
	['DEDICATED_4KB', uWS.DEDICATED_COMPRESSOR_4KB]
];
const NS = [1, 10, 100, 1000];

function cursorBulkFrame(seq, R = 100) {
	const entries = new Array(R);
	for (let i = 0; i < R; i++) {
		entries[i] = { key: 'm' + i, data: { x: ((seq * 31 + i * 7) % 1920) + 0.5, y: ((seq * 17 + i * 13) % 1080) + 0.25 } };
	}
	return Buffer.from(buildBinaryFrame(CURSOR_SCHEMA_VERSION, 1, seq, encodeCursor('bulk', entries)));
}
function presenceHbFrame(seq, R = 50) {
	const roster = {};
	for (let i = 0; i < R; i++) roster['u' + i] = { id: 'u' + i, name: 'User ' + i, color: '#a1b2c3', status: 'active' };
	void PRESENCE_SCHEMA_VERSION; // (binary presence covered elsewhere; here we send the JSON envelope, the text case)
	return Buffer.from(JSON.stringify({ topic: '__presence:board', event: 'heartbeat', data: roster, seq }));
}

const SCENARIOS = [
	{ key: 'cursor bulk R=100 (binary, compress=true)', isBinary: true, compress: true, gen: cursorBulkFrame },
	{ key: 'cursor bulk R=100 (binary, compress=FALSE - the opt-out)', isBinary: true, compress: false, gen: cursorBulkFrame },
	{ key: 'presence heartbeat R=50 (json, compress=true)', isBinary: false, compress: true, gen: presenceHbFrame }
];

// ---- server: one route per mode, each subscribes opened sockets to its topic
const app = uWS.App();
const topics = MODES.map((_, m) => 't' + m);
for (let m = 0; m < MODES.length; m++) {
	const [, compression] = MODES[m];
	const topic = topics[m];
	app.ws('/m' + m, {
		compression,
		maxPayloadLength: 64 * 1024 * 1024,
		maxBackpressure: 512 * 1024 * 1024,
		idleTimeout: 0,
		open: (ws) => { ws.subscribe(topic); },
		message: () => {},
		close: () => {}
	});
}
await new Promise((res, rej) => app.listen('127.0.0.1', PORT, (s) => s ? res(s) : rej(new Error('listen failed'))));

// ---- client pool
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function openClient(m) {
	return new Promise((res, rej) => {
		const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/m' + m, { perMessageDeflate: true });
		ws.binaryType = 'nodebuffer';
		ws.on('message', () => {}); // drain (handlers only run between sync loops)
		ws.on('open', () => res(ws));
		ws.on('error', rej);
	});
}
async function openN(m, n) {
	const out = [];
	while (out.length < n) {
		const batch = [];
		for (let b = 0; b < Math.min(100, n - out.length); b++) batch.push(openClient(m));
		out.push(...await Promise.all(batch));
	}
	return out;
}
function closeAll(cs) {
	return Promise.all(cs.map((ws) => new Promise((r) => { ws.on('close', r); try { ws.close(); } catch { r(); } })));
}

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function kFor(n) { return Math.max(40, Math.min(600, Math.round(40000 / n))); }

const results = {}; // scenario -> mode -> N -> ns/publish
for (const s of SCENARIOS) { results[s.key] = {}; for (const [mn] of MODES) results[s.key][mn] = {}; }

for (let m = 0; m < MODES.length; m++) {
	const [modeName] = MODES[m];
	const topic = topics[m];
	process.stderr.write('measuring ' + modeName + ' ...\n');
	let clients = [];
	for (const N of NS) {
		if (clients.length < N) clients.push(...await openN(m, N - clients.length));
		await delay(150); // let subscribes settle
		for (const s of SCENARIOS) {
			const K = kFor(N);
			const frames = new Array(K);
			for (let k = 0; k < K; k++) frames[k] = s.gen(k + 1); // precomputed, NOT timed
			for (let k = 0; k < Math.min(K, 20); k++) app.publish(topic, frames[k], s.isBinary, s.compress); // warm
			await delay(60);
			const samples = [];
			for (let r = 0; r < 5; r++) {
				const t0 = process.hrtime.bigint();
				for (let k = 0; k < K; k++) app.publish(topic, frames[k], s.isBinary, s.compress);
				const t1 = process.hrtime.bigint();
				samples.push(Number(t1 - t0) / K); // ns per publish (one frame -> N subscribers)
				await delay(40); // let buffers drain between reps
			}
			results[s.key][modeName][N] = median(samples);
		}
	}
	await closeAll(clients);
	await delay(150);
}

// ---- report
const pad = (s, n) => String(s).padStart(n);
const us = (ns) => (ns / 1000).toFixed(1); // microseconds, 1 publish = 1 frame fanned to N subscribers
console.log('\nREAL uWS server CPU per publish (one frame fanned to N subscribers), microseconds. Lower = better.');
console.log('Synchronous publish loop => wall-clock isolates server compress+fanout (clients idle during it).');
console.log('Key question: is the column FLAT as N grows (compress-once) or does it CLIMB (recompress per subscriber)?\n');

for (const s of SCENARIOS) {
	console.log(s.key);
	console.log('  ' + pad('mode', 18) + NS.map((n) => pad('N=' + n, 11)).join('') + '   growth 1->1000');
	for (const [modeName] of MODES) {
		const row = results[s.key][modeName];
		const cells = NS.map((n) => pad(us(row[n]), 11)).join('');
		const growth = (row[NS[NS.length - 1]] / row[NS[0]]).toFixed(0) + 'x';
		console.log('  ' + pad(modeName, 18) + cells + '   ' + pad(growth, 8));
	}
	console.log();
}
process.exit(0);
