import { spawn } from 'node:child_process';

const entry = process.argv[2];
const cwd = process.env.RESPAWNER_CWD;
if (!entry || !cwd || typeof process.send !== 'function') {
	throw new Error('external-respawner requires an entry, RESPAWNER_CWD, and an IPC parent');
}

let child = null;
let generation = 0;
let restartTimer = null;
let stopping = false;
let stopTimer = null;

function report(message) {
	try { process.send?.(message); } catch { /* parent already left */ }
}

function start() {
	if (stopping) return;
	generation += 1;
	const ownGeneration = generation;
	const proc = spawn(process.execPath, [entry], {
		cwd,
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child = proc;
	report({ type: 'spawn', generation: ownGeneration, pid: proc.pid });
	proc.once('error', (error) => {
		report({ type: 'spawn-error', generation: ownGeneration, message: error.message });
	});
	proc.stdout.on('data', (chunk) => process.stdout.write(chunk));
	proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
	proc.once('exit', (code, signal) => {
		report({ type: 'exit', generation: ownGeneration, pid: proc.pid, code, signal });
		if (child === proc) child = null;
		if (stopping) {
			if (stopTimer !== null) clearTimeout(stopTimer);
			process.exit(0);
			return;
		}
		restartTimer = setTimeout(start, 250);
	});
}

function stop() {
	if (stopping) return;
	stopping = true;
	if (restartTimer !== null) clearTimeout(restartTimer);
	if (child === null) {
		process.exit(0);
		return;
	}
	child.kill('SIGTERM');
	stopTimer = setTimeout(() => child?.kill('SIGKILL'), 15000);
}

process.on('message', (message) => {
	if (message?.type === 'kill-primary') child?.kill('SIGKILL');
	if (message?.type === 'stop') stop();
});
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start();
