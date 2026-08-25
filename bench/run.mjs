// Benchmark runner -- starts each server, runs autocannon, collects results.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { emptyEvidence, addEvidence, isClean, evidenceLabel } from './autocannon-evidence.mjs';

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
		const evidence = emptyEvidence();
		for (let run = 0; run < RUNS; run++) {
			const result = await runAutocannon(bench.path);
			totalRps += result.requests.average;
			totalLatAvg += result.latency.average;
			totalLatP99 += result.latency.p99;
			totalLatP999 += result.latency.p999;
			totalThroughput += result.throughput.average;
			addEvidence(evidence, result);
			if (run < RUNS - 1) await sleep(300);
		}
		const rps = totalRps / RUNS;
		const latAvg = totalLatAvg / RUNS;
		const latP99 = totalLatP99 / RUNS;
		const latP999 = totalLatP999 / RUNS;
		const throughput = totalThroughput / RUNS;
		const comparable = isClean(evidence);

		results.push({
			name: bench.name,
			rps,
			latAvg,
			latP99,
			latP999,
			throughputMBs: (throughput / 1024 / 1024).toFixed(2),
			evidence,
			comparable,
		});

		console.log(`${rps.toLocaleString()} req/s (avg ${latAvg.toFixed(2)}ms, p99 ${latP99.toFixed(2)}ms)` +
			(comparable ? '' : `  NOT COMPARABLE (${evidenceLabel(evidence)})`));
	} catch (err) {
		// A server that never started (or an autocannon transport failure) is
		// not a measurement; record the failure itself, never a zero row that
		// averages in beside healthy ones.
		console.log(`FAILED: ${err.message}`);
		results.push({ name: bench.name, failed: true, reason: err.message, comparable: false });
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(500);
	}
}

// Summary table. A row is comparable only when its server started and every
// pass finished with zero errors, timeouts, and non-2xx responses; anything
// else prints its evidence and is excluded from ratios and the breakdown.
const baselineComparable = results[0]?.comparable === true;
const baseline = baselineComparable ? results[0].rps : null;

console.log(`\n${'='.repeat(104)}`);
console.log('  RESULTS SUMMARY');
console.log(`${'='.repeat(104)}`);
console.log(
	'  ' +
	'Test'.padEnd(42) +
	'Req/s'.padStart(10) +
	'vs Base'.padStart(10) +
	'Lat avg'.padStart(10) +
	'Lat p99'.padStart(10) +
	'MB/s'.padStart(8) +
	'Err/TO/non-2xx'.padStart(16)
);
console.log('-'.repeat(104));

for (const r of results) {
	if (r.failed) {
		console.log('  ' + r.name.padEnd(42) + `FAILED (not comparable): ${r.reason}`);
		continue;
	}
	const pct = baseline !== null && r.comparable ? `${((r.rps / baseline) * 100).toFixed(1)}%` : 'n/a';
	const ev = `${r.evidence.errors}/${r.evidence.timeouts}/${r.evidence.non2xx}` + (r.comparable ? '' : ' !');
	console.log(
		'  ' +
		r.name.padEnd(42) +
		r.rps.toLocaleString().padStart(10) +
		pct.padStart(10) +
		`${r.latAvg.toFixed(2)}ms`.padStart(10) +
		`${r.latP99.toFixed(2)}ms`.padStart(10) +
		`${r.throughputMBs}`.padStart(8) +
		ev.padStart(16)
	);
}

console.log('-'.repeat(104));
if (results.some((r) => !r.comparable)) {
	console.log('  ! = the row saw errors, timeouts, or non-2xx responses (or never ran):');
	console.log('    its numbers are failure artifacts, not throughput - do not cite or compare them.');
}

// Overhead breakdown - only between rows whose measurements are comparable.
const cmp = (i) => results[i] && results[i].comparable;
// A layer that measured FASTER than the one before it is run-to-run noise;
// print it signed as a gain instead of a double negative.
const overheadText = (diff) => {
	const pct = (Math.abs(diff / results[0].rps) * 100).toFixed(1);
	const sign = diff >= 0 ? '-' : '+';
	return `${sign}${Math.abs(diff).toLocaleString()} req/s (${sign}${pct}% of baseline)`;
};
console.log(`\n  OVERHEAD BREAKDOWN (vs barebones uWS):`);
if (!baselineComparable) {
	console.log('    skipped: the baseline row is not comparable.');
} else {
	const layers = [
		[0, 1, 'cork + status/headers'],
		[1, 2, 'header collection + remoteAddress decode'],
		[2, 3, 'async/AbortController overhead'],
		[3, 4, 'Request() construction'],
	];
	for (const [from, to, label] of layers) {
		if (!cmp(from) || !cmp(to)) {
			console.log(`    ${label.padEnd(45)} skipped: a row is not comparable`);
			continue;
		}
		console.log(`    ${label.padEnd(45)} ${overheadText(results[from].rps - results[to].rps)}`);
	}
	if (cmp(0) && cmp(5)) {
		console.log(`    ${'Static path total overhead'.padEnd(45)} ${overheadText(results[0].rps - results[5].rps)}`);
	} else {
		console.log(`    ${'Static path total overhead'.padEnd(45)} skipped: a row is not comparable`);
	}
	if (cmp(0) && cmp(6)) {
		console.log(`    ${'SSR path total overhead'.padEnd(45)} ${overheadText(results[0].rps - results[6].rps)}`);
	} else {
		console.log(`    ${'SSR path total overhead'.padEnd(45)} skipped: a row is not comparable`);
	}
}

console.log(`\n${'='.repeat(104)}\n`);
