// Generic A/B runner for perf experiments.
//
// Alternates between two server scripts (baseline vs variant) and runs
// autocannon for a short window each. Alternation controls for system-
// state drift between runs. Reports per-variant median + stddev across
// rounds and computes the delta.
//
// The first round is typically a cold-start outlier (V8 still JITting and
// warming inline caches); inspect the steady-state rounds before trusting
// the median. The "Likely noise" verdict checks delta against baseline
// stddev; a clean win must exceed it.
//
// Usage:
//   node bench/run-ab.mjs <baseline-file> <variant-file> [rounds] [duration]
//
// Example:
//   node bench/run-ab.mjs 4-ssr-sim.mjs 4-ssr-sim-variant.mjs 6 5
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const autocannon = require('autocannon');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.argv.length < 4) {
	console.error('Usage: node bench/run-ab.mjs <baseline-file> <variant-file> [rounds] [duration]');
	process.exit(1);
}

const baselineFile = process.argv[2];
const variantFile = process.argv[3];
const ROUNDS = parseInt(process.argv[4] || '6', 10);
const DURATION = parseInt(process.argv[5] || '5', 10);
const PORT = 9011;
const CONNECTIONS = 100;
const PIPELINING = 10;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(file) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [path.join(__dirname, file)], {
			env: { ...process.env, PORT: String(PORT) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let started = false;
		child.stdout.on('data', (data) => {
			if (!started && data.toString().includes('listening')) {
				started = true;
				resolve(child);
			}
		});
		child.stderr.on('data', (d) => process.stderr.write(d));
		child.on('error', reject);
		child.on('exit', (code) => { if (!started) reject(new Error(`Exit ${code}`)); });
		setTimeout(() => { if (!started) reject(new Error('Server start timeout')); }, 8000);
	});
}

function runAutocannon() {
	return new Promise((resolve, reject) => {
		autocannon({
			url: `http://127.0.0.1:${PORT}/`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION
		}, (err, result) => {
			if (err) return reject(err);
			resolve(result);
		});
	});
}

async function benchOne(file) {
	let server;
	try {
		server = await startServer(file);
		await sleep(400);
		// Warmup pass discarded
		await runAutocannon();
		await sleep(200);
		const result = await runAutocannon();
		return result;
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(400);
	}
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function stddev(xs) {
	const m = mean(xs);
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

console.log(`\nA/B: ${baselineFile} vs ${variantFile}`);
console.log(`${ROUNDS} rounds x ${DURATION}s, ${CONNECTIONS}c x ${PIPELINING}pip alternating\n`);

const baselineRps = [];
const variantRps = [];
const baselineP99 = [];
const variantP99 = [];

for (let i = 0; i < ROUNDS; i++) {
	process.stdout.write(`Round ${i + 1}/${ROUNDS} A: `);
	const a = await benchOne(baselineFile);
	baselineRps.push(a.requests.average);
	baselineP99.push(a.latency.p99);
	process.stdout.write(`${a.requests.average.toFixed(0)} req/s, p99 ${a.latency.p99.toFixed(1)}ms  |  B: `);

	const b = await benchOne(variantFile);
	variantRps.push(b.requests.average);
	variantP99.push(b.latency.p99);
	process.stdout.write(`${b.requests.average.toFixed(0)} req/s, p99 ${b.latency.p99.toFixed(1)}ms\n`);
}

const aMed = median(baselineRps);
const bMed = median(variantRps);
const aMean = mean(baselineRps);
const bMean = mean(variantRps);
const aSd = stddev(baselineRps);
const bSd = stddev(variantRps);
const deltaPct = ((bMed - aMed) / aMed) * 100;

console.log(`\n${'='.repeat(70)}`);
console.log(`  ${'baseline'.padEnd(20)} median ${aMed.toFixed(0).padStart(8)} req/s   mean ${aMean.toFixed(0).padStart(8)} +/- ${aSd.toFixed(0)}`);
console.log(`  ${'variant'.padEnd(20)} median ${bMed.toFixed(0).padStart(8)} req/s   mean ${bMean.toFixed(0).padStart(8)} +/- ${bSd.toFixed(0)}`);
console.log(`  ${'delta'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (median to median)`);
console.log(`  ${'p99 baseline'.padEnd(20)} median ${median(baselineP99).toFixed(1)}ms`);
console.log(`  ${'p99 variant'.padEnd(20)} median ${median(variantP99).toFixed(1)}ms`);
console.log(`${'='.repeat(70)}\n`);

if (Math.abs(deltaPct) < (aSd / aMed) * 100) {
	console.log(`  Delta is within baseline stddev. Likely noise.`);
} else if (deltaPct >= 1) {
	console.log(`  Variant wins by ${deltaPct.toFixed(2)}%.`);
} else if (deltaPct <= -1) {
	console.log(`  Variant LOSES by ${Math.abs(deltaPct).toFixed(2)}%.`);
} else {
	console.log(`  No measurable change.`);
}
console.log();
