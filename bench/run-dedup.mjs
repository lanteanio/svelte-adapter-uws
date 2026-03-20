// Benchmark: SSR deduplication — shows render call reduction under concurrent identical requests.
//
// Both servers use a 5ms artificial render delay. We send exactly BURST requests
// to the same URL concurrently, then read each server's render call counter to see
// how many actual renders fired. With dedup: ~1 render per burst. Without: ~BURST renders.
//
// Run: node bench/run-dedup.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9003;

// Requests to fire in each burst. High enough that several will be in flight
// during the 5ms render window.
const BURST = 200;
// Number of bursts to average across
const ROUNDS = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(file) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [path.join(__dirname, file)], {
			env: { ...process.env, PORT: String(PORT) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let started = false;
		child.stdout.on('data', (data) => {
			if (!started && data.toString().includes('listening')) {
				started = true;
				resolve(child);
			}
		});
		child.stderr.on('data', (d) => { process.stderr.write(d); });
		child.on('error', reject);
		child.on('exit', (code) => { if (!started) reject(new Error(`Exit ${code}`)); });
		setTimeout(() => { if (!started) reject(new Error('Timeout')); }, 5000);
	});
}

function httpGet(path) {
	return new Promise((resolve, reject) => {
		http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
			let data = '';
			res.on('data', (c) => { data += c; });
			res.on('end', () => resolve(data));
		}).on('error', reject);
	});
}

function sendBurst(n) {
	const reqs = [];
	for (let i = 0; i < n; i++) {
		reqs.push(httpGet('/page'));
	}
	return Promise.all(reqs);
}

const servers = [
	{ file: '4b-ssr-nodedup.mjs', label: 'No dedup  (every request renders)' },
	{ file: '4c-ssr-dedup.mjs',   label: 'With dedup (shared in-flight render)' },
];

console.log(`\n${'='.repeat(72)}`);
console.log('  SSR Deduplication Benchmark');
console.log(`  ${BURST} concurrent requests to same URL, 5ms render delay`);
console.log(`  ${ROUNDS} rounds averaged`);
console.log(`${'='.repeat(72)}\n`);

const rows = [];
for (const { file, label } of servers) {
	process.stdout.write(`  ${label.padEnd(44)} `);
	let server;
	try {
		server = await startServer(file);
		await sleep(400);

		let totalRendersPerBurst = 0;
		for (let round = 0; round < ROUNDS; round++) {
			await httpGet('/reset');
			await sendBurst(BURST);
			const stats = JSON.parse(await httpGet('/stats'));
			totalRendersPerBurst += stats.renderCalls;
			await sleep(100);
		}
		const avgRenders = totalRendersPerBurst / ROUNDS;
		rows.push({ label, avgRenders });
		console.log(`avg ${avgRenders.toFixed(1)} renders per ${BURST}-request burst`);
	} catch (err) {
		console.log(`FAILED: ${err.message}`);
		rows.push({ label, avgRenders: BURST });
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(500);
	}
}

console.log(`\n${'-'.repeat(72)}`);
if (rows[0]?.avgRenders && rows[1]?.avgRenders) {
	const reduction = (rows[0].avgRenders / rows[1].avgRenders).toFixed(1);
	console.log(`  Render call reduction: ${reduction}x fewer renders with dedup`);
	console.log(`  (${rows[0].avgRenders.toFixed(1)} renders without dedup vs ${rows[1].avgRenders.toFixed(1)} with dedup, per ${BURST}-request burst)`);
	console.log(`\n  Dedup coalesces concurrent anonymous GET/HEAD requests to the same URL`);
	console.log(`  into one render call. The saved renders are pure CPU + memory savings.`);
}
console.log(`${'='.repeat(72)}\n`);
