// Quick WS-only benchmark runner
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS_PORT = 9002;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(file) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [path.join(__dirname, file)], {
			env: { ...process.env, PORT: String(WS_PORT) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let started = false;
		child.stdout.on('data', (data) => {
			if (!started && data.toString().includes('listening')) { started = true; resolve(child); }
		});
		child.stderr.on('data', d => process.stderr.write(d));
		child.on('error', reject);
		child.on('exit', (code) => { if (!started) reject(new Error(`Exit ${code}`)); });
		setTimeout(() => { if (!started) reject(new Error('Timeout')); }, 8000);
	});
}

function runWsBench(mode) {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [
			path.join(__dirname, '23-ws-bench-client.mjs'),
			mode, '50', '8'
		], {
			env: { ...process.env, PORT: String(WS_PORT) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		child.stdout.on('data', d => out += d);
		child.stderr.on('data', d => process.stderr.write(d));
		child.on('close', () => resolve(out));
		child.on('error', reject);
	});
}

const benches = [
	{ file: '20-ws-uws.mjs',          name: 'uWS native (barebones)',   mode: 'uws' },
	{ file: '24-ws-adapter-uws.mjs',  name: 'adapter-uws WS handler',  mode: 'adapter' },
	{ file: '22-ws-ws.mjs',           name: 'ws library',               mode: 'ws' },
	{ file: '21-ws-socketio.mjs',     name: 'socket.io',                mode: 'socketio' },
];

console.log(`\n${'='.repeat(70)}`);
console.log('  WEBSOCKET BENCHMARK: 50 clients, 10 senders, 50 msg/tick, 8s');
console.log(`${'='.repeat(70)}\n`);

for (const bench of benches) {
	console.log(`  --- ${bench.name} ---`);
	let server;
	try {
		server = await startServer(bench.file);
		await sleep(500);
		const output = await runWsBench(bench.mode);
		process.stdout.write(output);
	} catch (err) {
		console.log(`  FAILED: ${err.message}\n`);
	} finally {
		if (server) server.kill('SIGTERM');
		await sleep(800);
	}
}
