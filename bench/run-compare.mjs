// Comparative benchmark runner: adapter-uws vs adapter-node vs socket.io vs ws
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const autocannon = require('autocannon');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 9001;
const WS_PORT = 9002;
const DURATION = 10;
const CONNECTIONS = 100;
const PIPELINING = 10;
const RUNS = 2;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(file, port) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [path.join(__dirname, file)], {
			env: { ...process.env, PORT: String(port) },
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
		child.stderr.on('data', (data) => { process.stderr.write(data); });
		child.on('error', reject);
		child.on('exit', (code) => { if (!started) reject(new Error(`Exit ${code}`)); });
		setTimeout(() => { if (!started) reject(new Error('Timeout')); }, 8000);
	});
}

function runAutocannon(port, urlPath) {
	return new Promise((resolve, reject) => {
		autocannon({
			url: `http://127.0.0.1:${port}${urlPath}`,
			connections: CONNECTIONS,
			pipelining: PIPELINING,
			duration: DURATION,
		}, (err, result) => {
			if (err) return reject(err);
			resolve(result);
		});
	});
}

function runWsBench(mode, port) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [
			path.join(__dirname, '23-ws-bench-client.mjs'),
			mode, '50', '8'
		], {
			env: { ...process.env, PORT: String(port) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		child.stdout.on('data', d => out += d);
		child.stderr.on('data', d => process.stderr.write(d));
		child.on('close', () => resolve(out));
		child.on('error', reject);
	});
}

// ==================== HTTP BENCHMARKS ====================

console.log(`\n${'='.repeat(78)}`);
console.log('  HTTP BENCHMARK: adapter-uws vs adapter-node');
console.log(`  ${CONNECTIONS} connections x ${PIPELINING} pipeline x ${DURATION}s x ${RUNS} runs`);
console.log(`${'='.repeat(78)}\n`);

const httpBenches = [
	{ file: '1-baseline-uws.mjs',   name: 'Barebones uWS',             path: '/' },
	{ file: '10-node-baseline.mjs',  name: 'Barebones Node http',       path: '/' },
	{ file: '3-static-sim.mjs',      name: 'adapter-uws static path',   path: '/index.html' },
	{ file: '11-node-polka-sirv.mjs', name: 'adapter-node static path', path: '/index.html' },
	{ file: '4-ssr-sim.mjs',         name: 'adapter-uws SSR path',      path: '/' },
	{ file: '12-node-ssr-sim.mjs',   name: 'adapter-node SSR path',     path: '/' },
];

const httpResults = [];

for (const bench of httpBenches) {
	process.stdout.write(`  ${bench.name.padEnd(32)} `);
	let server;
	try {
		server = await startServer(bench.file, HTTP_PORT);
		await sleep(500);

		let totalRps = 0, totalLatAvg = 0, totalLatP99 = 0, totalThroughput = 0;
		for (let run = 0; run < RUNS; run++) {
			const result = await runAutocannon(HTTP_PORT, bench.path);
			totalRps += result.requests.average;
			totalLatAvg += result.latency.average;
			totalLatP99 += result.latency.p99;
			totalThroughput += result.throughput.average;
			if (run < RUNS - 1) await sleep(300);
		}

		const rps = totalRps / RUNS;
		const latAvg = totalLatAvg / RUNS;
		const latP99 = totalLatP99 / RUNS;
		const throughput = totalThroughput / RUNS;

		httpResults.push({ name: bench.name, rps, latAvg, latP99, throughputMBs: (throughput / 1024 / 1024).toFixed(2) });
		console.log(`${rps.toLocaleString()} req/s  avg ${latAvg.toFixed(2)}ms  p99 ${latP99.toFixed(1)}ms`);
	} catch (err) {
		console.log(`FAILED: ${err.message}`);
		httpResults.push({ name: bench.name, rps: 0, latAvg: 0, latP99: 0, throughputMBs: '0' });
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(500);
	}
}

// HTTP Summary
console.log(`\n${'-'.repeat(78)}`);
console.log('  HTTP RESULTS:');
console.log(`${'-'.repeat(78)}`);
console.log('  ' + 'Test'.padEnd(34) + 'Req/s'.padStart(12) + 'Lat avg'.padStart(10) + 'Lat p99'.padStart(10) + 'MB/s'.padStart(8));
console.log('-'.repeat(78));
for (const r of httpResults) {
	console.log(
		'  ' + r.name.padEnd(34) +
		r.rps.toLocaleString().padStart(12) +
		`${r.latAvg.toFixed(2)}ms`.padStart(10) +
		`${r.latP99.toFixed(1)}ms`.padStart(10) +
		r.throughputMBs.padStart(8)
	);
}

// Multiplier comparisons
if (httpResults[0]?.rps && httpResults[1]?.rps) {
	console.log(`\n  Baseline: uWS is ${(httpResults[0].rps / httpResults[1].rps).toFixed(1)}x faster than Node http`);
}
if (httpResults[2]?.rps && httpResults[3]?.rps) {
	console.log(`  Static:   adapter-uws is ${(httpResults[2].rps / httpResults[3].rps).toFixed(1)}x faster than adapter-node`);
}
if (httpResults[4]?.rps && httpResults[5]?.rps) {
	console.log(`  SSR:      adapter-uws is ${(httpResults[4].rps / httpResults[5].rps).toFixed(1)}x faster than adapter-node`);
}

// ==================== WEBSOCKET BENCHMARKS ====================

console.log(`\n\n${'='.repeat(78)}`);
console.log('  WEBSOCKET BENCHMARK: uWS native vs adapter-uws vs socket.io vs ws');
console.log('  50 clients, 5 senders, 8s per test');
console.log(`${'='.repeat(78)}\n`);

const wsBenches = [
	{ file: '20-ws-uws.mjs',          name: 'uWS native (barebones)',   mode: 'uws' },
	{ file: '24-ws-adapter-uws.mjs',  name: 'adapter-uws WS handler',  mode: 'adapter' },
	{ file: '22-ws-ws.mjs',           name: 'ws library',               mode: 'ws' },
	{ file: '21-ws-socketio.mjs',     name: 'socket.io',                mode: 'socketio' },
];

for (const bench of wsBenches) {
	console.log(`  --- ${bench.name} ---`);
	let server;
	try {
		server = await startServer(bench.file, WS_PORT);
		await sleep(500);

		const output = await runWsBench(bench.mode, WS_PORT);
		process.stdout.write(output);
	} catch (err) {
		console.log(`  FAILED: ${err.message}\n`);
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(800);
	}
}

console.log(`${'='.repeat(78)}\n`);
