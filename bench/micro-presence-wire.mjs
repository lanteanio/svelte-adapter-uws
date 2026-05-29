// Presence binary wire microbench: bandwidth and codec CPU vs the JSON envelope.
//
// Unlike the cursor wire (whose f32 positions make binary decode dramatically
// faster than JSON.parse), a presence value is arbitrary user JSON carried as a
// length-prefixed JSON string. So the presence codec is NOT a decode-speed play -
// it is a BANDWIDTH + protocol-uniformity play, and an honest bench has to show
// that. What it measures, for full-roster state/heartbeat frames of a few sizes:
//
//   - wire bytes: the 0x03 binary frame vs the JSON envelope the publish path
//     sends today. The saving is the envelope overhead (the channel-name string,
//     the {"topic":..,"event":..,"data":..,"seq":..} structure) collapsed into a
//     ~4-byte binary header; the per-user value JSON is the same bytes on both.
//     So the win is larger on small rosters and shrinks as the value JSON grows.
//   - encode CPU: one encode per publish on BOTH paths (the codec is stateless,
//     so binary keeps encode-once-send-many exactly as JSON does).
//   - decode CPU: binary decode (per-entry JSON.parse + byte reads) vs one
//     JSON.parse of the whole envelope. Reported honestly - presence is a cold
//     path (a diff on join/leave, one heartbeat per interval), not a 60 Hz hot
//     primitive, so a slower decode here is not a regression on anything hot.
//
// Pure JS, no uWS, no real WS. < 1 s.

import { performance } from 'node:perf_hooks';
import { buildBinaryFrame } from '../files/wire.js';
import { encodePresence, decodePresence, PRESENCE_SCHEMA_VERSION } from '../plugins/presence/codec.js';

// NOTE: this bench measures RAW (uncompressed) wire bytes + codec CPU only. For
// the bytes that actually cross the wire under uWS permessage-deflate (SHARED /
// DEDICATED), see bench/ws-compression-ab.mjs, which runs a live uWS server with
// each real compressor and counts bytes off the socket. (A per-message zlib
// estimate is NOT a faithful proxy: it cannot model DEDICATED's cross-frame
// context takeover, which is exactly where the binary-vs-JSON balance shifts.)

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// A typical select()-ed presence value: id + display fields, ~70 B of JSON.
function makeRoster(size, keyKind) {
	const roster = {};
	for (let i = 0; i < size; i++) {
		const key = keyKind === 'conn' ? '__conn:' + i
			: keyKind === 'uuidish' ? '7f3a9c2e-' + i
			: String(1000 + i);
		roster[key] = { id: key, name: 'User ' + i, color: '#a1b2c3', status: 'active' };
	}
	return roster;
}

const ROUNDS = 7;
const TOPIC = '__presence:board';

function timeNs(fn, iter) {
	const start = performance.now();
	let acc = 0;
	for (let i = 0; i < iter; i++) acc += fn();
	return { ns: ((performance.now() - start) * 1e6) / iter, acc };
}

console.log('Presence binary wire microbench (presence.protocol:1) - bandwidth + codec CPU vs JSON');

for (const keyKind of ['short-numeric', 'conn', 'uuidish']) {
	console.log('\n=== key kind: ' + keyKind + ' ===');
	for (const size of [5, 50, 500]) {
		const roster = makeRoster(size, keyKind);

		// Binary: one stateless encode, wrapped in the 0x03 frame.
		const payload = encodePresence('state', roster);
		const binFrame = buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 1, 1, payload);
		const binBytes = binFrame.length;

		// JSON: the envelope the publish path sends today.
		const jsonStr = JSON.stringify({ topic: TOPIC, event: 'state', data: roster, seq: 1 });
		const jsonBytes = Buffer.byteLength(jsonStr);

		const savedPct = (100 * (jsonBytes - binBytes) / jsonBytes);

		// Scale iterations so total work per round stays bounded across sizes.
		const iter = Math.max(200, Math.round(60000 / size));

		// Encode CPU: one encode per publish on both paths.
		const encBin = () => encodePresence('state', roster).length;
		const encJson = () => JSON.stringify({ topic: TOPIC, event: 'state', data: roster, seq: 1 }).length;
		// Decode CPU: binary per-entry decode vs one JSON.parse of the envelope.
		const decBin = () => decodePresence(payload, null, PRESENCE_SCHEMA_VERSION) ? 1 : 0;
		const decJson = () => { const o = JSON.parse(jsonStr); return o.data ? 1 : 0; };

		for (let r = 0; r < 3; r++) { encBin(); encJson(); decBin(); decJson(); } // warm
		const eB = [], eJ = [], dB = [], dJ = [];
		for (let r = 0; r < ROUNDS; r++) {
			eB.push(timeNs(encBin, iter).ns);
			eJ.push(timeNs(encJson, iter).ns);
			dB.push(timeNs(decBin, iter).ns);
			dJ.push(timeNs(decJson, iter).ns);
		}
		const encB = median(eB), encJ = median(eJ), decB = median(dB), decJ = median(dJ);

		console.log('\n  roster ' + String(size).padStart(3) + ' users');
		console.log('    wire raw  binary ' + String(binBytes).padStart(6) + ' B   JSON ' + String(jsonBytes).padStart(6) + ' B   (' + savedPct.toFixed(1) + '% smaller; compressed numbers: bench/ws-compression-ab.mjs)');
		console.log('    encode  binary ' + encB.toFixed(0).padStart(7) + ' ns   JSON ' + encJ.toFixed(0).padStart(7) + ' ns');
		console.log('    decode  binary ' + decB.toFixed(0).padStart(7) + ' ns   JSON ' + decJ.toFixed(0).padStart(7) + ' ns   (' + (decB <= decJ ? (decJ / decB).toFixed(2) + 'x faster' : (decB / decJ).toFixed(2) + 'x slower') + ' than JSON.parse; presence is a cold path)');
	}
}
console.log();
