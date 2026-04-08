import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');
const coverageDir = process.env.NODE_V8_COVERAGE || path.resolve(__dirname, '../../coverage/e2e-tmp');

/** Strip ANSI escape codes for reliable substring matching. */
function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function isReady(text) {
	const clean = stripAnsi(text);
	return clean.includes('localhost:') || clean.includes('Listening on');
}

function startServer(script, port) {
	mkdirSync(coverageDir, { recursive: true });

	return new Promise((resolve, reject) => {
		const proc = spawn('node', [path.resolve(__dirname, script), String(port)], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, NODE_V8_COVERAGE: coverageDir }
		});

		let output = '';
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill();
				reject(new Error(`Server did not start within 30s.\noutput: ${output}`));
			}
		}, 30000);

		function check() {
			if (!resolved && isReady(output)) {
				resolved = true;
				clearTimeout(timeout);
				resolve(proc);
			}
		}

		proc.stdout.on('data', (chunk) => { output += chunk.toString(); check(); });
		proc.stderr.on('data', (chunk) => { output += chunk.toString(); check(); });

		proc.on('error', (err) => {
			if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
		});

		proc.on('exit', (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				reject(new Error(`Server exited with code ${code}.\noutput: ${output}`));
			}
		});
	});
}

export default async function globalSetup() {
	const devProc = await startServer('dev-server.js', 49321);
	const prodProc = await startServer('prod-server.js', 49322);
	globalThis.__e2eServers = [devProc, prodProc];
}
