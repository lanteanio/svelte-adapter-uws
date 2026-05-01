// A/B runner for WebSocket publish-throughput experiments.
//
// Alternates between two server scripts (baseline vs variant) and drives
// 23-ws-bench-client.mjs in 'adapter' mode against each. Reports per-
// variant median + stddev of "messages received per second" across
// rounds, then the delta. Mirrors the methodology of run-ab.mjs (HTTP)
// for the WS publish path.
//
// The first round is typically a cold-start outlier (V8 still tiering);
// inspect the steady-state rounds before trusting the median. The
// "Likely noise" verdict checks delta against baseline stddev; a clean
// win must exceed it.
//
// Usage:
//   node bench/run-ws-ab.mjs <baseline-file> <variant-file> [rounds] [duration_s] [clients]
//
// Example:
//   node bench/run-ws-ab.mjs 24-ws-adapter-uws.mjs 24-ws-adapter-uws-variant-dataview.mjs 5 6 50
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.argv.length < 4) {
	console.error('Usage: node bench/run-ws-ab.mjs <baseline-file> <variant-file> [rounds] [duration_s] [clients]');
	process.exit(1);
}

const baselineFile = process.argv[2];
const variantFile = process.argv[3];
const ROUNDS = parseInt(process.argv[4] || '5', 10);
const DURATION = parseInt(process.argv[5] || '6', 10);
const CLIENTS = parseInt(process.argv[6] || '50', 10);
const PORT = 9015;

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

function runClient() {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [
			path.join(__dirname, '23-ws-bench-client.mjs'),
			'adapter',
			String(CLIENTS),
			String(DURATION)
		], {
			env: { ...process.env, PORT: String(PORT) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		child.stdout.on('data', (d) => out += d);
		child.stderr.on('data', (d) => process.stderr.write(d));
		child.on('close', () => resolve(out));
		child.on('error', reject);
	});
}

// Parse "Messages received: 1,234,567 (123,456/s)" - we want the per-second
// figure. Accepts either ',' or '.' as thousands separator (locale-aware
// Number.toLocaleString varies between Windows and Linux).
function parseRecvRate(out) {
	const m = out.match(/Messages received:[^\(]+\(([\d.,]+)\/s\)/);
	if (!m) throw new Error('Could not parse recv rate from client output:\n' + out);
	return parseInt(m[1].replace(/[.,]/g, ''), 10);
}

async function benchOne(file) {
	let server;
	try {
		server = await startServer(file);
		process.stdout.write('warmup ');
		await sleep(400);
		// Discard a warmup pass so JIT settles before the measured pass.
		await runClient();
		await sleep(300);
		process.stdout.write('measure ');
		const out = await runClient();
		return parseRecvRate(out);
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(600);
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

console.log(`\nWS A/B: ${baselineFile} vs ${variantFile}`);
console.log(`${ROUNDS} rounds x ${DURATION}s, ${CLIENTS} clients, alternating\n`);

const baselineRps = [];
const variantRps = [];

for (let i = 0; i < ROUNDS; i++) {
	process.stdout.write(`Round ${i + 1}/${ROUNDS} A: `);
	const a = await benchOne(baselineFile);
	baselineRps.push(a);
	process.stdout.write(`${a.toLocaleString()} msg/s  |  B: `);

	const b = await benchOne(variantFile);
	variantRps.push(b);
	process.stdout.write(`${b.toLocaleString()} msg/s\n`);
}

const aMed = median(baselineRps);
const bMed = median(variantRps);
const aMean = mean(baselineRps);
const bMean = mean(variantRps);
const aSd = stddev(baselineRps);
const bSd = stddev(variantRps);
// Delta: positive means variant is FASTER (delivered more messages).
const deltaPct = ((bMed - aMed) / aMed) * 100;
const noiseFloor = (aSd / aMed) * 100;

console.log(`\n${'='.repeat(70)}`);
console.log(`  ${'baseline'.padEnd(20)} median ${aMed.toLocaleString().padStart(12)} msg/s   mean ${aMean.toFixed(0).padStart(8)} +/- ${aSd.toFixed(0)}`);
console.log(`  ${'variant'.padEnd(20)} median ${bMed.toLocaleString().padStart(12)} msg/s   mean ${bMean.toFixed(0).padStart(8)} +/- ${bSd.toFixed(0)}`);
console.log(`  ${'delta'.padEnd(20)} ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%   (positive = variant faster)`);
console.log(`  ${'noise floor'.padEnd(20)} +/- ${noiseFloor.toFixed(2)}%   (baseline stddev / median)`);
console.log(`${'='.repeat(70)}\n`);

if (Math.abs(deltaPct) <= noiseFloor) {
	console.log(`  VERDICT: noise -> change has no measurable effect, do not land`);
} else if (deltaPct >= 1) {
	console.log(`  VERDICT: variant wins by ${deltaPct.toFixed(2)}% -> land`);
} else if (deltaPct <= -1) {
	console.log(`  VERDICT: variant LOSES by ${Math.abs(deltaPct).toFixed(2)}% -> KEEP BASELINE`);
} else {
	console.log(`  VERDICT: borderline (${deltaPct.toFixed(2)}%) -> not worth landing`);
}
console.log();
