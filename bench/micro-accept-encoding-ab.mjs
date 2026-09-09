// Microbenchmark: A/B the Accept-Encoding decision on the header shapes real
// clients send.
//
// The static lane and the single-chunk SSR lane used to pick a content-coding
// by substring - `header.includes('br')`, then `header.includes('gzip')` - which
// reads `br;q=0` as an acceptance and carries no preference at all. The shipped
// decision (src/runtime/utils/content-coding.js) parses the list once: tokens,
// weights, the wildcard. This bench prices that parse against the two
// substring scans it replaces, per header shape, since it runs on every static
// hit and every compressible SSR response.
//
// Three arms:
//   substring   the replaced expression, transcribed
//   negotiate   the shipped module
//   control     the shipped module loaded a second time - the same code on the
//               same data, so its spread against `negotiate` is the noise floor
//
// Every arm is warmed on every shape before anything is timed, then the arms
// are timed round-robin: timing them one after another leaves the first with a
// monomorphic call site and every later one megamorphic.
//
// Usage:
//   node bench/micro-accept-encoding-ab.mjs [iterations] [rounds]
// Defaults: 2_000_000 iterations per shape and arm, 9 rounds.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ITERATIONS = parseInt(process.argv[2] || '2000000', 10);
const ROUNDS = parseInt(process.argv[3] || '9', 10);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = 'file:///' + path.join(ROOT, 'src/runtime/utils/content-coding.js').replace(/\\/g, '/');

const negotiate = (await import(SHIPPED)).negotiateEncoding;
const control = (await import(SHIPPED + '?control')).negotiateEncoding;

/** The replaced expression, exactly as the two lanes spelled it. */
function substring(header, hasBr, hasGz) {
	if (hasBr && header.includes('br')) return 'br';
	if (hasGz && header.includes('gzip')) return 'gzip';
	return '';
}

const ARMS = [
	['substring', substring],
	['negotiate', negotiate],
	['control', control]
];

// Header shapes, most common first. The weighted ones are what the substring
// scan got wrong; the browser ones are what it was fast on.
const SHAPES = [
	['chrome/firefox', 'gzip, deflate, br, zstd'],
	['safari', 'gzip, deflate, br'],
	['curl --compressed', 'deflate, gzip, br, zstd'],
	['gzip only', 'gzip, deflate'],
	['absent', ''],
	['weighted', 'gzip;q=1.0, br;q=0.5'],
	['refusal', 'br;q=0, gzip'],
	['wildcard', '*;q=0.5, gzip']
];

let sink = 0;

function run(fn, header, n) {
	let acc = 0;
	for (let i = 0; i < n; i++) acc += fn(header, true, true).length;
	return acc;
}

// Warm every arm on every shape.
for (const [, fn] of ARMS) {
	for (const [, header] of SHAPES) sink += run(fn, header, 200000);
}

/** @type {Record<string, Record<string, number[]>>} */
const results = {};
for (const [shape] of SHAPES) {
	results[shape] = {};
	for (const [arm] of ARMS) results[shape][arm] = [];
}

for (let round = 0; round < ROUNDS; round++) {
	for (const [shape, header] of SHAPES) {
		for (const [arm, fn] of ARMS) {
			const t0 = process.hrtime.bigint();
			sink += run(fn, header, ITERATIONS);
			results[shape][arm].push(Number(process.hrtime.bigint() - t0) / ITERATIONS);
		}
	}
}

function quantile(xs, q) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const width = Math.max(...SHAPES.map(([s]) => s.length)) + 2;
console.log('ns per decision, median then 90th percentile, ' + ROUNDS + ' interleaved rounds');
console.log('read every arm against control: its spread against negotiate is the noise floor\n');
console.log('shape'.padEnd(width), ...ARMS.map(([l]) => l.padStart(18)));
for (const [shape] of SHAPES) {
	console.log(
		shape.padEnd(width),
		...ARMS.map(([arm]) => {
			const xs = results[shape][arm];
			return (quantile(xs, 0.5).toFixed(1) + ' / ' + quantile(xs, 0.9).toFixed(1)).padStart(18);
		})
	);
}
console.log('\n(sink ' + sink + ')');
