// Cursor wire decode microbench: binary 0x03 decode vs JSON.parse of the
// equivalent cursor BULK frame, for both wire schemas:
//
//   v1 (full-string keys, schemaVersion 1): every entry carries its key string,
//      so decode allocates a string per entry (TextDecoder) - same work
//      JSON.parse does, hence a modest multiplier.
//   v2 (short-id dictionary, schemaVersion 2): a warm frame carries a 1-2 byte
//      id per entry and the decoder resolves it to a cached key via Map.get -
//      no per-entry string allocation, so decode unbinds from string cost and
//      the multiplier climbs.
//
// The binary path must never touch JSON.parse. Pure JS, no uWS, no real WS.
// Deterministic, < 1 s.

import { performance } from 'node:perf_hooks';
import { buildBinaryFrame, parseBinaryFrame } from '../files/wire.js';
import {
	encodeCursor,
	decodeCursor,
	CursorEncodeDict,
	CursorDecodeDict,
	CURSOR_SCHEMA_VERSION,
	CURSOR_SCHEMA_VERSION_DICT
} from '../plugins/cursor/codec.js';

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Realistic cursor positions: fractional doubles (clientX - rect.left), the
// shape the demo actually sends.
function makeBulk(count, keyFn) {
	const entries = [];
	for (let i = 0; i < count; i++) {
		entries.push({ key: keyFn(i), data: { x: Math.random() * 1920, y: Math.random() * 1080 } });
	}
	return entries;
}

function benchProfile(count, keyFn, label) {
	const entries = makeBulk(count, keyFn);
	const jsonStr = JSON.stringify({ topic: '__cursor:board', event: 'bulk', data: entries, seq: 12345 });

	// v1 frame: full-string keys, every frame.
	const v1Frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 1, 12345, encodeCursor('bulk', entries));

	// v2 warm frame: warm an encoder + decoder dictionary on this entry set, then
	// re-encode so every key is a REF (the steady-state shape after the first
	// announce). The timed decode runs against the warm decoder dictionary.
	const enc = new CursorEncodeDict();
	const decWarm = new CursorDecodeDict();
	decodeCursor(parseBinaryFrame(buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, 1, 1, encodeCursor('bulk', entries, enc))).payload, decWarm, CURSOR_SCHEMA_VERSION_DICT);
	const v2Frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, 1, 12346, encodeCursor('bulk', entries, enc));

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
	function runV1() {
		let acc = 0;
		const start = performance.now();
		for (let i = 0; i < ITER; i++) {
			const out = decodeCursor(parseBinaryFrame(v1Frame).payload);
			const arr = out.data;
			for (let j = 0; j < arr.length; j++) acc += arr[j].data.x;
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}
	function runV2() {
		let acc = 0;
		const start = performance.now();
		for (let i = 0; i < ITER; i++) {
			const out = decodeCursor(parseBinaryFrame(v2Frame).payload, decWarm, CURSOR_SCHEMA_VERSION_DICT);
			const arr = out.data;
			for (let j = 0; j < arr.length; j++) acc += arr[j].data.x;
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}

	for (let r = 0; r < 3; r++) { runJson(); runV1(); runV2(); }

	const json = [], v1 = [], v2 = [];
	for (let r = 0; r < ROUNDS; r++) { json.push(runJson().ns); v1.push(runV1().ns); v2.push(runV2().ns); }
	const jMed = median(json), v1Med = median(v1), v2Med = median(v2);
	const jB = jsonStr.length, v1B = v1Frame.length, v2B = v2Frame.length;

	console.log('\nBULK ' + count + ' entries  (' + label + ')');
	console.log('  json ' + jB + ' B | v1 (full-string) ' + v1B + ' B (' + (100 - (100 * v1B) / jB).toFixed(1) + '% smaller) | v2 warm (short-id) ' + v2B + ' B (' + (100 - (100 * v2B) / jB).toFixed(1) + '% smaller)');
	console.log('  JSON.parse + walk      median ' + jMed.toFixed(0).padStart(7) + ' ns/frame');
	console.log('  v1 0x03 decode + walk  median ' + v1Med.toFixed(0).padStart(7) + ' ns/frame  (' + (jMed / v1Med).toFixed(1) + 'x faster than JSON)');
	console.log('  v2 0x03 decode + walk  median ' + v2Med.toFixed(0).padStart(7) + ' ns/frame  (' + (jMed / v2Med).toFixed(1) + 'x faster than JSON, ' + (v1Med / v2Med).toFixed(2) + 'x faster than v1)');
}

console.log('Cursor wire decode microbench (JSON vs v1 full-string vs v2 short-id dictionary)');
// Short in-process keys: the dictionary win is mostly decode (no per-entry
// string alloc); bandwidth gain over v1 is small because the keys are tiny.
benchProfile(221, (i) => String(i), 'in-process keys "0".."220"');
benchProfile(1000, (i) => String(i), 'in-process keys "0".."999"');
// Realistic clustered keys: the dictionary win is both decode AND bandwidth -
// the long "<instanceId>:<counter>" key leaves the wire after its first announce.
benchProfile(221, (i) => 'instance-7f3a9c:' + i, 'clustered keys "instance-7f3a9c:N"');
console.log();
