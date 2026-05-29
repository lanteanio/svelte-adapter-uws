// Fan-out crossover microbench: encode-once-send-many vs per-connection encode.
//
// The full-string wire (schemaVersion 1) is stateless, so platform.publishWire
// encodes the payload ONCE and reuses it for every capable subscriber (uWS even
// fans the bytes out from one buffer). The short-id dictionary (schemaVersion 2)
// is per-connection stateful: each subscriber's frame references that
// subscriber's own dictionary, so the payload must be encoded PER subscriber -
// encode-once-send-many no longer holds. This bench measures the crossover at
// N = 1 / 10 / 100 / 1000 capable subscribers: the JS encode+frame-build CPU per
// publish, and the total wire bytes per publish, for both models.
//
// The send itself (ws.send / uWS fan-out) is C++ and not measured here; this
// isolates the NEW cost the dictionary introduces (the per-subscriber encode)
// against the bandwidth it buys back. Pure JS, no uWS, no real WS. < 1 s.

import { performance } from 'node:perf_hooks';
import { buildBinaryFrame } from '../files/wire.js';
import {
	encodeCursor,
	CursorEncodeDict,
	CURSOR_SCHEMA_VERSION,
	CURSOR_SCHEMA_VERSION_DICT
} from '../plugins/cursor/codec.js';

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Realistic clustered keys - the case the dictionary is built for.
function makeBulk(count) {
	const entries = [];
	for (let i = 0; i < count; i++) entries.push({ key: 'instance-7f3a9c:' + i, data: { x: Math.random() * 1920, y: Math.random() * 1080 } });
	return entries;
}

const ENTRIES = makeBulk(221);
const ROUNDS = 7;

// One v1 payload, shared across all subscribers (encode-once-send-many).
const v1Payload = encodeCursor('bulk', ENTRIES);
const v1FrameBytes = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 1, 12345, v1Payload).length;

console.log('Fan-out crossover microbench (encode-once-send-many vs per-connection dictionary encode)');
console.log('BULK ' + ENTRIES.length + ' entries, clustered keys. v1 frame ' + v1FrameBytes + ' B/subscriber (shared encode).');

for (const N of [1, 10, 100, 1000]) {
	// One warm dictionary per subscriber (steady state: keys already announced,
	// so every entry encodes as a REF).
	const dicts = [];
	for (let i = 0; i < N; i++) { const d = new CursorEncodeDict(); encodeCursor('bulk', ENTRIES, d); dicts.push(d); }
	const v2WarmBytes = buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, 1, 1, encodeCursor('bulk', ENTRIES, dicts[0])).length;

	// Scale iterations inversely with N so total work per round stays bounded.
	const iter = Math.max(20, Math.round(4000 / N));

	// Foundation model: encode the v1 payload once, build one frame, reuse for
	// all N subscribers (the topic-id header is identical when N subscribers
	// share the topic's first wire-id; the realistic common case).
	function runOnce() {
		const start = performance.now();
		let acc = 0;
		for (let it = 0; it < iter; it++) {
			const payload = encodeCursor('bulk', ENTRIES);          // 1 encode
			const frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION, 1, 12345, payload); // 1 build
			acc += frame.length; // N sends of `frame` would follow (C++, not timed)
		}
		return { ns: ((performance.now() - start) * 1e6) / iter, acc };
	}
	// Dictionary model: encode + build PER subscriber against its own warm dict.
	function runPerSub() {
		const start = performance.now();
		let acc = 0;
		for (let it = 0; it < iter; it++) {
			for (let s = 0; s < N; s++) {
				const payload = encodeCursor('bulk', ENTRIES, dicts[s]);            // per-subscriber encode
				const frame = buildBinaryFrame(CURSOR_SCHEMA_VERSION_DICT, s + 1, 12345, payload); // per-subscriber build
				acc += frame.length;
			}
		}
		return { ns: ((performance.now() - start) * 1e6) / iter, acc };
	}

	for (let r = 0; r < 3; r++) { runOnce(); runPerSub(); }
	const once = [], per = [];
	for (let r = 0; r < ROUNDS; r++) { once.push(runOnce().ns); per.push(runPerSub().ns); }
	const onceMed = median(once), perMed = median(per);

	const v1WireBytes = N * v1FrameBytes;
	const v2WireBytes = N * v2WarmBytes;
	const bytesSaved = v1WireBytes - v2WireBytes;
	const cpuDelta = perMed - onceMed; // >0 = dict costs more CPU; <0 = dict is cheaper
	const cpuNote = cpuDelta <= 0
		? 'dictionary is ' + (onceMed / perMed).toFixed(1) + 'x CHEAPER CPU (warm REF encode beats one full-string encode)'
		: 'dictionary costs ' + (perMed / onceMed).toFixed(1) + 'x the CPU (per-subscriber encode)';

	console.log('\nN=' + N + ' capable subscribers  (iter ' + iter + ')');
	console.log('  CPU/publish  encode-once ' + onceMed.toFixed(0).padStart(9) + ' ns   per-connection ' + perMed.toFixed(0).padStart(9) + ' ns   (' + cpuNote + ')');
	console.log('  wire/publish v1 ' + v1WireBytes + ' B   v2 ' + v2WireBytes + ' B   (saves ' + bytesSaved + ' B/publish, ' + (100 * bytesSaved / v1WireBytes).toFixed(1) + '% vs the full-string wire)');
}
console.log();
