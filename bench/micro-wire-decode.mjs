// Cursor wire decode microbench: binary 0x03 decode vs JSON.parse of the
// equivalent cursor BULK frame. This is the headline decode win - the binary
// path must never touch JSON.parse and should be many times faster.
//
// Pure JS, no uWS, no real WS. Deterministic, < 1 s.

import { performance } from 'node:perf_hooks';
import { buildBinaryFrame, parseBinaryFrame } from '../files/wire.js';
import { encodeCursor, decodeCursor, CURSOR_SCHEMA_VERSION } from '../plugins/cursor/codec.js';

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Realistic cursor positions: fractional doubles (clientX - rect.left), the
// shape the demo actually sends.
function makeBulk(count) {
	const entries = [];
	for (let i = 0; i < count; i++) {
		entries.push({ key: String(i), data: { x: Math.random() * 1920, y: Math.random() * 1080 } });
	}
	return entries;
}

function benchProfile(count) {
	const entries = makeBulk(count);
	const jsonStr = JSON.stringify({ topic: '__cursor:board', event: 'bulk', data: entries, seq: 12345 });
	const frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 1, 12345, encodeCursor('bulk', entries));

	const ITER = Math.max(1, Math.round(200000 / count));
	const ROUNDS = 7;

	// Sum x to force the full object walk (defeats dead-code elimination) and
	// mirror what the store handler does (touch every decoded entry).
	function runJson() {
		let acc = 0;
		const start = performance.now();
		for (let i = 0; i < ITER; i++) {
			const msg = JSON.parse(jsonStr);
			const arr = msg.data;
			for (let j = 0; j < arr.length; j++) acc += arr[j].data.x;
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}
	function runBin() {
		let acc = 0;
		const start = performance.now();
		for (let i = 0; i < ITER; i++) {
			const out = decodeCursor(parseBinaryFrame(frame).payload);
			const arr = out.data;
			for (let j = 0; j < arr.length; j++) acc += arr[j].data.x;
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}

	// Warmup
	for (let r = 0; r < 3; r++) { runJson(); runBin(); }

	const json = [];
	const bin = [];
	for (let r = 0; r < ROUNDS; r++) {
		json.push(runJson().ns);
		bin.push(runBin().ns);
	}
	const jMed = median(json);
	const bMed = median(bin);

	console.log('\nBULK ' + count + ' entries  (json ' + jsonStr.length + ' B, binary ' + frame.length + ' B, ' +
		(100 - (100 * frame.length) / jsonStr.length).toFixed(1) + '% smaller)');
	console.log('  JSON.parse + walk  median ' + jMed.toFixed(0).padStart(7) + ' ns/frame');
	console.log('  0x03 decode + walk median ' + bMed.toFixed(0).padStart(7) + ' ns/frame');
	console.log('  speedup            ' + (jMed / bMed).toFixed(1) + 'x faster, never touches JSON.parse');
}

console.log('Cursor wire decode microbench (binary vs JSON.parse)');
benchProfile(221);  // measured 2026-05-23 average BULK density
benchProfile(1000); // catalog-scale
console.log();
