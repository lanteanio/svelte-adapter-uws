// A/B the Accept-Encoding decision inside the two request lanes that make it,
// under real HTTP load.
//
// The static 200 path and the single-chunk SSR path used to pick a
// content-coding by substring; the shipped decision parses the header's weights
// (src/runtime/utils/content-coding.js). The microbenchmark prices the parse in
// isolation; this bench puts each spelling inside the lane it runs in, on a
// real uWS server, and measures requests per second with the header a browser
// sends. Both lanes are the shipped code with only the selection swapped, and a
// control arm (the shipped decision a second time) gives each lane's noise
// floor. When the fixture is built, a fourth static arm runs the built
// `serveStatic` itself, so the transcription can be read against the real lane.
//
// One process, one port, one route per arm, autocannon against each in turn
// for every round. Alternation controls for system-state drift; a delta inside
// the control's spread is noise.
//
// Usage:
//   node bench/38-content-coding-lanes-ab.mjs [rounds] [duration]
// Defaults: 6 rounds of 5 seconds per arm. Honors PORT (default 9012).
//
// Environment: native (uWebSockets.js) plus autocannon; idle, fixed-power host.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { runEvidence, isClean, evidenceLabel } from './autocannon-evidence.mjs';

const require = createRequire(import.meta.url);
const uWS = require('uWebSockets.js');
const autocannon = require('autocannon');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = parseInt(process.argv[2] || '6', 10);
const DURATION = parseInt(process.argv[3] || '5', 10);
const PORT = parseInt(process.env.PORT || '9012', 10);
const CONNECTIONS = 100;
const PIPELINING = 10;
const ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

const shippedUrl = 'file:///' + path.join(ROOT, 'src/runtime/utils/content-coding.js').replace(/\\/g, '/');
const negotiate = (await import(shippedUrl)).negotiateEncoding;
const control = (await import(shippedUrl + '?control')).negotiateEncoding;

function substring(header, hasBr, hasGz) {
	if (hasBr && header.includes('br')) return 'br';
	if (hasGz && header.includes('gzip')) return 'gzip';
	return '';
}

const DECISIONS = { substring, negotiate, control };

// ---- the static lane ---------------------------------------------------------
// One indexed asset with a brotli and a gzip sibling, shaped as cacheDir shapes
// it: identity tuples plus per-coding tuples carrying their own validator.
const IDENTITY = Buffer.from(Array.from({ length: 200 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog\n`).join(''));
const BR = zlib.brotliCompressSync(IDENTITY);
const GZ = zlib.gzipSync(IDENTITY);
const ETAG = 'W/"abc-1"';
const baseHeaders = [
	['x-content-type-options', 'nosniff'],
	['vary', 'Accept-Encoding'],
	['accept-ranges', 'bytes'],
	['cache-control', 'no-cache'],
	['etag', ETAG],
	['last-modified', new Date(0).toUTCString()]
];
const variant = (coding) => baseHeaders.map(([k, v]) => [k, k === 'etag' ? ETAG.slice(0, -1) + '-' + coding + '"' : v]).concat([['content-encoding', coding]]);
const entry = {
	buffer: IDENTITY, brBuffer: BR, gzBuffer: GZ, contentType: 'text/plain',
	headers: baseHeaders, brHeaders: variant('br'), gzHeaders: variant('gzip')
};
const DATE = new Date().toUTCString();

function staticLane(decide) {
	return (res, req) => {
		const acceptEncoding = req.getHeader('accept-encoding');
		let headers = entry.headers;
		let body = entry.buffer;
		const encoding = decide(acceptEncoding, entry.brBuffer !== undefined, entry.gzBuffer !== undefined);
		if (encoding === 'br') { headers = entry.brHeaders; body = entry.brBuffer; }
		else if (encoding === 'gzip') { headers = entry.gzHeaders; body = entry.gzBuffer; }
		res.cork(() => {
			res.writeStatus('200 OK');
			res.writeHeader('content-type', entry.contentType);
			res.writeHeader('date', DATE);
			for (let i = 0; i < headers.length; i++) res.writeHeader(headers[i][0], headers[i][1]);
			res.end(body);
		});
	};
}

// ---- the single-chunk SSR lane ------------------------------------------------
// A 4 KiB HTML body compressed per request exactly as writeResponse does it:
// brotli quality 4 or gzip level 6, kept only when smaller.
const HTML = Buffer.from('<!doctype html><html><body>' + '<p>The quick brown fox jumps over the lazy dog.</p>'.repeat(80) + '</body></html>');

function ssrLane(decide) {
	return (res, req) => {
		const acceptEncoding = req.getHeader('accept-encoding');
		let body = HTML;
		let encoding = '';
		if (acceptEncoding && body.byteLength >= 1024) {
			const chosen = decide(acceptEncoding, true, true);
			if (chosen !== '') {
				const compressed = chosen === 'br'
					? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
					: zlib.gzipSync(body, { level: 6 });
				if (compressed.byteLength < body.byteLength) { body = compressed; encoding = chosen; }
			}
		}
		res.cork(() => {
			res.writeStatus('200 OK');
			res.writeHeader('content-type', 'text/html');
			if (encoding) {
				res.writeHeader('content-encoding', encoding);
				res.writeHeader('vary', 'Accept-Encoding');
			}
			res.end(body);
		});
	};
}

// ---- the built lane, when a fixture build exists -------------------------------
const builtStatic = path.join(ROOT, 'test/fixture/build/handler/static-assets.js');
let shippedServe = null;
if (fs.existsSync(builtStatic)) {
	try {
		const mod = await import('file:///' + builtStatic.replace(/\\/g, '/'));
		const { staticCache } = await import('file:///' + path.join(ROOT, 'test/fixture/build/handler/state.js').replace(/\\/g, '/'));
		const dir = fs.mkdtempSync(path.join(ROOT, 'bench', '_tmp_coding-'));
		fs.writeFileSync(path.join(dir, 'asset.txt'), IDENTITY);
		fs.writeFileSync(path.join(dir, 'asset.txt.br'), BR);
		fs.writeFileSync(path.join(dir, 'asset.txt.gz'), GZ);
		mod.cacheDir(dir, '/built', false);
		const built = staticCache.get('/built/asset.txt');
		fs.rmSync(dir, { recursive: true, force: true });
		if (built && built.brBuffer && built.gzBuffer) {
			shippedServe = (res, req) => mod.serveStatic(
				res, built, req.getHeader('accept-encoding'), req.getHeader('if-none-match'), false,
				req.getHeader('range'), req.getHeader('if-range'), req.getHeader('if-match'),
				req.getHeader('if-unmodified-since'), req.getHeader('if-modified-since')
			);
		}
	} catch (error) {
		console.log('built static lane unavailable: ' + (error && error.message));
	}
}

const ARMS = [];
for (const name of Object.keys(DECISIONS)) {
	ARMS.push(['static/' + name, staticLane(DECISIONS[name])]);
}
if (shippedServe) ARMS.push(['static/shipped', shippedServe]);
for (const name of Object.keys(DECISIONS)) {
	ARMS.push(['ssr/' + name, ssrLane(DECISIONS[name])]);
}

const app = uWS.App();
for (const [name, handler] of ARMS) app.get('/' + name, handler);

await new Promise((resolve, reject) => {
	app.listen('127.0.0.1', PORT, (sock) => (sock ? resolve(sock) : reject(new Error('listen failed on ' + PORT))));
});

function cannon(route) {
	return new Promise((resolve, reject) => {
		autocannon({
			url: `http://127.0.0.1:${PORT}/${route}`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION,
			headers: { 'accept-encoding': ACCEPT_ENCODING }
		}, (err, result) => (err ? reject(err) : resolve(result)));
	});
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs) { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); }

console.log(`content-coding lanes A/B: ${ROUNDS} rounds x ${DURATION}s, ${CONNECTIONS}c x ${PIPELINING}pip, accept-encoding "${ACCEPT_ENCODING}"`);
console.log('arms per round, in order: ' + ARMS.map(([n]) => n).join(', ') + '\n');

/** @type {Record<string, { rps: number[], p99: number[] }>} */
const results = Object.fromEntries(ARMS.map(([n]) => [n, { rps: [], p99: [] }]));

// One discarded warm-up pass per arm.
for (const [name] of ARMS) await cannon(name);

for (let round = 0; round < ROUNDS; round++) {
	const line = [];
	let dropped = false;
	const roundResults = [];
	for (const [name] of ARMS) {
		const result = await cannon(name);
		const ev = runEvidence(result);
		roundResults.push([name, result]);
		line.push(`${name} ${result.requests.average.toFixed(0)} req/s p99 ${result.latency.p99.toFixed(1)}ms` + (isClean(ev) ? '' : ` [${evidenceLabel(ev)}]`));
		if (!isClean(ev)) dropped = true;
	}
	console.log(`round ${round + 1}: ` + line.join(' | '));
	if (dropped) { console.log('  dropped: not comparable'); continue; }
	for (const [name, result] of roundResults) {
		results[name].rps.push(result.requests.average);
		results[name].p99.push(result.latency.p99);
	}
}

console.log('\nrequests/s median (stddev) and p99 median, then delta from the lane\'s control arm');
for (const lane of ['static', 'ssr']) {
	const ctl = results[lane + '/control'];
	if (ctl.rps.length === 0) { console.log(lane + ': no clean rounds'); continue; }
	const ctlMedian = median(ctl.rps);
	for (const [name] of ARMS) {
		if (!name.startsWith(lane + '/')) continue;
		const r = results[name];
		const m = median(r.rps);
		const delta = ((m - ctlMedian) / ctlMedian) * 100;
		const noise = (stddev(ctl.rps) / ctlMedian) * 100;
		console.log(
			name.padEnd(18),
			`${m.toFixed(0)} (${stddev(r.rps).toFixed(0)})`.padStart(16),
			`p99 ${median(r.p99).toFixed(2)}ms`.padStart(14),
			`${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`.padStart(9),
			Math.abs(delta) <= noise ? '  inside control spread (' + noise.toFixed(2) + '%)' : ''
		);
	}
}
process.exit(0);
