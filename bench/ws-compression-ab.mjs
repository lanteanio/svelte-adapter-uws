// REAL uWS permessage-deflate A/B: does the binary wire still beat JSON once the
// actual uWebSockets.js compressor is in the path? No zlib estimate, no mock - a
// live uWS server (one route per compression mode), a real `ws` client
// negotiating permessage-deflate, and the true compressed bytes counted off the
// client's TCP socket (net.Socket.bytesRead).
//
// For each (compression mode x payload), the server streams K frames in BOTH
// formats (binary 0x03 codec frame, and the JSON envelope the publish path sends
// today); the client measures wire bytes/frame for each and reports the binary
// vs JSON delta. Sequences vary realistically (cursor positions change each
// frame; a presence roster is stable across heartbeats) so DEDICATED_*'s
// cross-frame context takeover is exercised, not faked.
//
// Run: node bench/ws-compression-ab.mjs    (starts its own server + client; ~10-30 s)

import uWS from 'uWebSockets.js';
import { WebSocket } from 'ws';
import { buildBinaryFrame } from '../src/runtime/wire.js';
import {
	encodeCursor,
	CursorEncodeDict,
	CURSOR_SCHEMA_VERSION,
	CURSOR_SCHEMA_VERSION_DICT
} from '../src/plugins/cursor/codec.js';
import { encodePresence, PRESENCE_SCHEMA_VERSION } from '../src/plugins/presence/codec.js';

const PORT = parseInt(process.env.PORT || '9100');
const TARGET_BYTES = 8_000_000; // raw bytes streamed per measurement -> sets K

// ---- compression modes to test (as many as make sense) ----
const MODES = [
	['DISABLED', uWS.DISABLED ?? 0],
	['SHARED_COMPRESSOR', uWS.SHARED_COMPRESSOR],
	['DEDICATED_3KB', uWS.DEDICATED_COMPRESSOR_3KB],
	['DEDICATED_4KB', uWS.DEDICATED_COMPRESSOR_4KB],
	['DEDICATED_8KB', uWS.DEDICATED_COMPRESSOR_8KB],
	['DEDICATED_16KB', uWS.DEDICATED_COMPRESSOR_16KB],
	['DEDICATED_32KB', uWS.DEDICATED_COMPRESSOR_32KB],
	['DEDICATED_64KB', uWS.DEDICATED_COMPRESSOR_64KB],
	['DEDICATED_128KB', uWS.DEDICATED_COMPRESSOR_128KB],
	['DEDICATED_256KB', uWS.DEDICATED_COMPRESSOR_256KB]
];

// ---- payload scenarios ----
const SCENARIOS = [
	{ key: 'cursor-bulk-v1', label: 'cursor bulk R=100 (full-string v1)', kind: 'cursor-bulk', R: 100, dict: false },
	{ key: 'cursor-bulk-v2', label: 'cursor bulk R=100 (short-id dict v2)', kind: 'cursor-bulk', R: 100, dict: true },
	{ key: 'cursor-update', label: 'cursor update single mover (v1)', kind: 'cursor-update', R: 1, dict: false },
	{ key: 'presence-hb-50', label: 'presence heartbeat R=50', kind: 'presence-heartbeat', R: 50 },
	{ key: 'presence-hb-500', label: 'presence heartbeat R=500', kind: 'presence-heartbeat', R: 500 },
	{ key: 'presence-state-50', label: 'presence state R=50', kind: 'presence-state', R: 50 },
	{ key: 'presence-diff', label: 'presence diff (1 join)', kind: 'presence-diff', R: 50 }
];

// ---------------------------------------------------------------- frame builders
function cursorEntries(R, seq) {
	const arr = new Array(R);
	for (let i = 0; i < R; i++) {
		arr[i] = { key: 'm' + i, data: { x: ((seq * 31 + i * 7) % 1920) + 0.5, y: ((seq * 17 + i * 13) % 1080) + 0.25 } };
	}
	return arr;
}
function presenceRoster(R) {
	const r = {};
	for (let i = 0; i < R; i++) r['u' + i] = { id: 'u' + i, name: 'User ' + i, color: '#a1b2c3', status: 'active' };
	return r;
}

// Returns { bytes, isBinary } for one frame of a scenario at sequence `seq`.
function makeFrame(scn, seq, dict, rosterCache) {
	const CT = '__cursor:board';
	const PT = '__presence:board';
	switch (scn.kind) {
		case 'cursor-bulk': {
			const entries = cursorEntries(scn.R, seq);
			return {
				json: JSON.stringify({ topic: CT, event: 'bulk', data: entries, seq }),
				bin: buildBinaryFrame(scn.dict ? CURSOR_SCHEMA_VERSION_DICT : CURSOR_SCHEMA_VERSION, 1, seq, encodeCursor('bulk', entries, scn.dict ? dict : undefined))
			};
		}
		case 'cursor-update': {
			const e = { key: 'm0', data: { x: ((seq * 31) % 1920) + 0.5, y: ((seq * 17) % 1080) + 0.25 } };
			return {
				json: JSON.stringify({ topic: CT, event: 'update', data: e, seq }),
				bin: buildBinaryFrame(scn.dict ? CURSOR_SCHEMA_VERSION_DICT : CURSOR_SCHEMA_VERSION, 1, seq, encodeCursor('update', e, scn.dict ? dict : undefined))
			};
		}
		case 'presence-heartbeat':
		case 'presence-state': {
			const ev = scn.kind === 'presence-state' ? 'state' : 'heartbeat';
			const roster = rosterCache; // stable across frames (realistic)
			return {
				json: JSON.stringify({ topic: PT, event: ev, data: roster, seq }),
				bin: buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 1, seq, encodePresence(ev, roster))
			};
		}
		case 'presence-diff': {
			const d = { joins: { ['u' + (seq % scn.R)]: { id: 'u' + (seq % scn.R), name: 'User ' + (seq % scn.R), color: '#a1b2c3', status: 'active' } }, leaves: {} };
			return {
				json: JSON.stringify({ topic: PT, event: 'diff', data: d, seq }),
				bin: buildBinaryFrame(PRESENCE_SCHEMA_VERSION, 1, seq, encodePresence('diff', d))
			};
		}
	}
}

// ---------------------------------------------------------------- server
const app = uWS.App();
for (let m = 0; m < MODES.length; m++) {
	const [, compression] = MODES[m];
	app.ws('/m' + m, {
		compression,
		maxPayloadLength: 64 * 1024 * 1024,
		maxBackpressure: 256 * 1024 * 1024,
		idleTimeout: 0,
		open: () => {},
		message: (ws, message) => {
			let cmd;
			try { cmd = JSON.parse(Buffer.from(message).toString()); } catch { return; }
			if (cmd.cmd !== 'send') return;
			const scn = SCENARIOS.find((s) => s.key === cmd.key);
			if (!scn) return;
			const dict = scn.dict ? new CursorEncodeDict() : null;
			const roster = (scn.kind === 'presence-heartbeat' || scn.kind === 'presence-state') ? presenceRoster(scn.R) : null;
			const K = cmd.count;
			const binary = cmd.format === 'binary';
			let raw = 0;
			let i = 0;
			const BATCH = 32;
			const pump = () => {
				const end = Math.min(i + BATCH, K);
				for (; i < end; i++) {
					const f = makeFrame(scn, i + 1, dict, roster);
					if (binary) { raw += f.bin.length; ws.send(f.bin, true, true); }
					else { const b = Buffer.from(f.json); raw += b.length; ws.send(b, false, true); }
				}
				if (i < K) setImmediate(pump);
				else ws.send(JSON.stringify({ type: 'done', raw, count: K }), false, true);
			};
			pump();
		}
	});
}

await new Promise((resolve, reject) => {
	app.listen('127.0.0.1', PORT, (sock) => sock ? resolve(sock) : reject(new Error('listen failed')));
});

// ---------------------------------------------------------------- client
function connect(modeIndex) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/m' + modeIndex, { perMessageDeflate: true });
		ws.binaryType = 'nodebuffer';
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

// Measure compressed wire bytes for K frames of one (scenario, format).
function measure(ws, key, format, count) {
	return new Promise((resolve, reject) => {
		const sock = ws._socket;
		const before = sock.bytesRead;
		const to = setTimeout(() => reject(new Error('measure timeout ' + key + '/' + format)), 60000);
		const onMsg = (data, isBinary) => {
			if (isBinary) return; // data frames in binary format - ignore for done-detection
			let m; try { m = JSON.parse(data.toString()); } catch { return; }
			if (m && m.type === 'done') {
				clearTimeout(to);
				ws.off('message', onMsg);
				const wire = sock.bytesRead - before;
				resolve({ wirePerFrame: wire / m.count, rawPerFrame: m.raw / m.count, count: m.count });
			}
		};
		ws.on('message', onMsg);
		ws.send(JSON.stringify({ cmd: 'send', key, format, count }));
	});
}

// Pick K so ~TARGET_BYTES of raw JSON is streamed (both formats use the same K).
function pickCount(scn) {
	const roster = (scn.kind === 'presence-heartbeat' || scn.kind === 'presence-state') ? presenceRoster(scn.R) : null;
	const sample = makeFrame(scn, 1, scn.dict ? new CursorEncodeDict() : null, roster);
	const jsonSize = Buffer.byteLength(sample.json);
	return Math.max(100, Math.min(4000, Math.round(TARGET_BYTES / jsonSize)));
}

const results = {}; // key -> mode -> { bin, json }
const rawRef = {};   // key -> { binRaw, jsonRaw }

for (const scn of SCENARIOS) results[scn.key] = {};

for (let m = 0; m < MODES.length; m++) {
	const [modeName] = MODES[m];
	const ws = await connect(m);
	for (const scn of SCENARIOS) {
		const K = pickCount(scn);
		const bin = await measure(ws, scn.key, 'binary', K);
		const json = await measure(ws, scn.key, 'json', K);
		results[scn.key][modeName] = { bin: bin.wirePerFrame, json: json.wirePerFrame };
		if (!rawRef[scn.key]) rawRef[scn.key] = { binRaw: bin.rawPerFrame, jsonRaw: json.rawPerFrame };
	}
	ws.close();
}

// ---------------------------------------------------------------- report
const pad = (s, n) => String(s).padStart(n);
console.log('\nREAL uWS permessage-deflate A/B - compressed wire bytes/frame (binary 0x03 codec vs JSON envelope)');
console.log('Client: ws perMessageDeflate negotiated; bytes measured off the TCP socket (incl. WS framing).');

for (const scn of SCENARIOS) {
	const r = rawRef[scn.key];
	console.log('\n' + scn.label);
	console.log('  raw (uncompressed): binary ' + pad(r.binRaw.toFixed(0), 7) + ' B   JSON ' + pad(r.jsonRaw.toFixed(0), 7) + ' B   (' + (100 * (r.jsonRaw - r.binRaw) / r.jsonRaw).toFixed(1) + '% smaller)');
	console.log('  ' + pad('mode', 18) + '  ' + pad('binary B/f', 11) + '  ' + pad('JSON B/f', 11) + '  ' + pad('binary vs JSON', 16));
	for (const [modeName] of MODES) {
		const e = results[scn.key][modeName];
		const pct = 100 * (e.json - e.bin) / e.json;
		const verdict = pct >= 0 ? pct.toFixed(1) + '% smaller' : (-pct).toFixed(1) + '% LARGER';
		console.log('  ' + pad(modeName, 18) + '  ' + pad(e.bin.toFixed(1), 11) + '  ' + pad(e.json.toFixed(1), 11) + '  ' + pad(verdict, 16));
	}
}
console.log();
process.exit(0);
