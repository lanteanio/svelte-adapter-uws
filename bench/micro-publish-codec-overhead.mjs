// Publish hot-path overhead microbench (credo rule 4: no single-digit-% loss
// on a hot primitive). Three arms over the same cursor frames:
//
//   A. JSON publish        - the current platform.publish envelope build.
//   B. publishWire (JSON)   - the path a JSON-only deployment takes: same
//                             envelope build plus the capCounts.has(cap) miss
//                             that decides "no capable client -> app.publish".
//                             B must stay within noise of A (the no-regression
//                             gate: opting a plugin into binary costs nothing
//                             when no client wants binary).
//   C. publishWire (binary) - encode-once + frame build for a capable room.
//
// This design touches platform.publish ZERO instructions (publishWire
// is a sibling method), so A is the literal current code; B adds one Map.get.
//
// Pure JS, no uWS, no real WS. Deterministic, < 1 s.

import { performance } from 'node:perf_hooks';
import { completeEnvelope, esc } from '../files/utils.js';
import { buildBinaryFrame, createCapCounts } from '../files/wire.js';
import { encodeCursor, CURSOR_SCHEMA_VERSION, CURSOR_CAPABILITY } from '../plugins/cursor/codec.js';

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// envelopePrefix(topic,event) equivalent (handler.js caches it; here we build
// it once per call as the un-cached worst case, identical in A and B).
function prefix(topic, event) {
	return '{"topic":' + esc(topic) + ',"event":' + esc(event) + ',"data":';
}

function makeBulk(count) {
	const entries = [];
	for (let i = 0; i < count; i++) entries.push({ key: String(i), data: { x: Math.random() * 1920, y: Math.random() * 1080 } });
	return entries;
}

function benchProfile(label, event, data) {
	const topic = '__cursor:board';
	const wire = { capability: CURSOR_CAPABILITY, schemaVersion: CURSOR_SCHEMA_VERSION, encode: encodeCursor };

	const ccEmpty = createCapCounts();                     // no capable clients
	const ccFull = createCapCounts(); ccFull.adjust(undefined, new Set([CURSOR_CAPABILITY]));

	const ITER = 50000;
	const ROUNDS = 7;
	let seq = 0;

	function armA() { // JSON publish envelope build
		const start = performance.now();
		let acc = 0;
		for (let i = 0; i < ITER; i++) {
			const env = completeEnvelope(prefix(topic, event), data, ++seq);
			acc += env.length;
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}
	function armB() { // publishWire JSON fast path (no capable client)
		const start = performance.now();
		let acc = 0;
		for (let i = 0; i < ITER; i++) {
			const env = completeEnvelope(prefix(topic, event), data, ++seq);
			const payload = ccEmpty.has(wire.capability) ? wire.encode(event, data) : null;
			acc += env.length + (payload ? 1 : 0);
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}
	function armC() { // publishWire binary path (capable room): envelope + encode-once + one frame
		const start = performance.now();
		let acc = 0;
		for (let i = 0; i < ITER; i++) {
			const env = completeEnvelope(prefix(topic, event), data, ++seq);
			const payload = ccFull.has(wire.capability) ? wire.encode(event, data) : null;
			const frame = payload ? buildBinaryFrame(wire.schemaVersion, 1, seq, payload) : null;
			acc += env.length + (frame ? frame.length : 0);
		}
		return { ns: ((performance.now() - start) * 1e6) / ITER, acc };
	}

	for (let r = 0; r < 3; r++) { armA(); armB(); armC(); }
	const a = [], b = [], c = [];
	for (let r = 0; r < ROUNDS; r++) { a.push(armA().ns); b.push(armB().ns); c.push(armC().ns); }
	const aMed = median(a), bMed = median(b), cMed = median(c);
	const deltaBA = ((bMed - aMed) / aMed) * 100;

	console.log('\n' + label);
	console.log('  A JSON publish               median ' + aMed.toFixed(0).padStart(6) + ' ns/op');
	console.log('  B publishWire JSON fast path median ' + bMed.toFixed(0).padStart(6) + ' ns/op  (delta vs A ' + (deltaBA >= 0 ? '+' : '') + deltaBA.toFixed(2) + '%)');
	console.log('  C publishWire binary encode  median ' + cMed.toFixed(0).padStart(6) + ' ns/op');
	console.log('  GATE B vs A: ' + (Math.abs(deltaBA) < 5 ? 'PASS (within noise, no regression)' : (deltaBA > 0 ? 'REVIEW slower by ' + deltaBA.toFixed(2) + '%' : 'faster by ' + Math.abs(deltaBA).toFixed(2) + '%')));
}

console.log('Publish hot-path overhead microbench (JSON-no-regression gate)');
benchProfile('UPDATE single mover', 'update', { key: '42', data: { x: 523.5, y: 128.25 } });
benchProfile('BULK 221 movers', 'bulk', makeBulk(221));
console.log();
