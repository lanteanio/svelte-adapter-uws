// Benchmark runner -- starts each server, runs autocannon, collects results.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const autocannon = require('autocannon');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9001;
const DURATION = 10; // seconds per benchmark
const CONNECTIONS = 100;
const PIPELINING = 10;
const RUNS = 2; // average over N runs

const benchmarks = [
	{ file: '1-baseline-uws.mjs',  name: 'Barebones uWS (res.end)',        path: '/' },
	{ file: '2-baseline-cork.mjs', name: 'uWS + cork + headers',           path: '/' },
	{ file: '7-header-iter.mjs',   name: '+ header collection + remoteAddr', path: '/' },
	{ file: '6-async-overhead.mjs', name: '+ async/AbortController',        path: '/' },
	{ file: '5-request-only.mjs',  name: '+ Request construction (sync)',   path: '/' },
	{ file: '3-static-sim.mjs',    name: 'Static file path (full)',         path: '/index.html' },
	{ file: '4-ssr-sim.mjs',       name: 'SSR path (full, trivial handler)', path: '/' },
];

const results = [];

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

function startServer(file) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [path.join(__dirname, file)], {
			env: { ...process.env, PORT: String(PORT) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let started = false;
		child.stdout.on('data', (data) => {
			const line = data.toString();
			if (!started && line.includes('listening')) {
				started = true;
				resolve(child);
			}
		});
		child.stderr.on('data', (data) => {
			process.stderr.write(data);
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (!started) reject(new Error(`Server exited with code ${code}`));
		});
		setTimeout(() => {
			if (!started) reject(new Error('Server start timeout'));
		}, 5000);
	});
}

function runAutocannon(urlPath) {
	return new Promise((resolve, reject) => {
		const instance = autocannon({
			url: `http://127.0.0.1:${PORT}${urlPath}`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION,
		}, (err, result) => {
			if (err) return reject(err);
			resolve(result);
		});
	});
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  svelte-adapter-uws Performance Analysis`);
console.log(`  ${CONNECTIONS} connections x ${PIPELINING} pipeline x ${DURATION}s x ${RUNS} runs per test`);
console.log(`${'='.repeat(70)}\n`);

for (const bench of benchmarks) {
	process.stdout.write(`Running: ${bench.name} ... `);
	let server;
	try {
		server = await startServer(bench.file);
		await sleep(500); // let the server stabilize

		// Run multiple passes and average
		let totalRps = 0, totalLatAvg = 0, totalLatP99 = 0, totalLatP999 = 0, totalThroughput = 0;
		for (let run = 0; run < RUNS; run++) {
			const result = await runAutocannon(bench.path);
			totalRps += result.requests.average;
			totalLatAvg += result.latency.average;
			totalLatP99 += result.latency.p99;
			totalLatP999 += result.latency.p999;
			totalThroughput += result.throughput.average;
			if (run < RUNS - 1) await sleep(300);
		}
		const rps = totalRps / RUNS;
		const latAvg = totalLatAvg / RUNS;
		const latP99 = totalLatP99 / RUNS;
		const latP999 = totalLatP999 / RUNS;
		const throughput = totalThroughput / RUNS;

		results.push({
			name: bench.name,
			rps,
			latAvg,
			latP99,
			latP999,
			throughputMBs: (throughput / 1024 / 1024).toFixed(2),
		});

		console.log(`${rps.toLocaleString()} req/s (avg ${latAvg.toFixed(2)}ms, p99 ${latP99.toFixed(2)}ms)`);
	} catch (err) {
		console.log(`FAILED: ${err.message}`);
		results.push({ name: bench.name, rps: 0, latAvg: 0, latP99: 0, latP999: 0, throughputMBs: '0' });
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(500);
	}
}

// Summary table
const baseline = results[0]?.rps || 1;

console.log(`\n${'='.repeat(90)}`);
console.log('  RESULTS SUMMARY');
console.log(`${'='.repeat(90)}`);
console.log(
	'  ' +
	'Test'.padEnd(42) +
	'Req/s'.padStart(10) +
	'vs Base'.padStart(10) +
	'Lat avg'.padStart(10) +
	'Lat p99'.padStart(10) +
	'MB/s'.padStart(8)
);
console.log('-'.repeat(90));

for (const r of results) {
	const pct = ((r.rps / baseline) * 100).toFixed(1);
	const overhead = (100 - parseFloat(pct)).toFixed(1);
	console.log(
		'  ' +
		r.name.padEnd(42) +
		r.rps.toLocaleString().padStart(10) +
		`${pct}%`.padStart(10) +
		`${r.latAvg.toFixed(2)}ms`.padStart(10) +
		`${r.latP99.toFixed(2)}ms`.padStart(10) +
		`${r.throughputMBs}`.padStart(8)
	);
}

console.log('-'.repeat(90));

// Overhead breakdown
console.log(`\n  OVERHEAD BREAKDOWN (vs barebones uWS):`);
const layers = [
	[0, 1, 'cork + status/headers'],
	[1, 2, 'header collection + remoteAddress decode'],
	[2, 3, 'async/AbortController overhead'],
	[3, 4, 'Request() construction'],
];
for (const [from, to, label] of layers) {
	if (results[from] && results[to]) {
		const diff = results[from].rps - results[to].rps;
		const pct = ((diff / results[0].rps) * 100).toFixed(1);
		console.log(`    ${label.padEnd(45)} -${diff.toLocaleString()} req/s (${pct}% of baseline)`);
	}
}

if (results[0] && results[5]) {
	const diff = results[0].rps - results[5].rps;
	const pct = ((diff / results[0].rps) * 100).toFixed(1);
	console.log(`    ${'Static path total overhead'.padEnd(45)} -${diff.toLocaleString()} req/s (${pct}% of baseline)`);
}
if (results[0] && results[6]) {
	const diff = results[0].rps - results[6].rps;
	const pct = ((diff / results[0].rps) * 100).toFixed(1);
	console.log(`    ${'SSR path total overhead'.padEnd(45)} -${diff.toLocaleString()} req/s (${pct}% of baseline)`);
}

console.log(`\n${'='.repeat(90)}\n`);
