import process from 'node:process';
import { env } from 'ENV';

/* global WS_ENABLED */

const host = env('HOST', '0.0.0.0');
const port = env('PORT', '3000');
const shutdown_timeout = parseInt(env('SHUTDOWN_TIMEOUT', '30'), 10);
const cluster_workers = env('CLUSTER_WORKERS', '');

const is_primary = cluster_workers
	&& process.platform === 'linux'
	&& !WS_ENABLED
	&& process.env.__UWS_WORKER !== '1';

if (is_primary) {
	// ── Primary process: fork workers, monitor, restart ─────────────────────

	const { availableParallelism } = await import('node:os');
	const { fork } = await import('node:child_process');

	const num = cluster_workers === 'auto'
		? availableParallelism()
		: parseInt(cluster_workers, 10);

	if (isNaN(num) || num < 1) {
		console.error(`Invalid CLUSTER_WORKERS value: '${cluster_workers}'. Use a positive integer or 'auto'.`);
		process.exit(1);
	}

	console.log(`Primary process ${process.pid} starting ${num} workers...`);

	/** @type {Set<import('node:child_process').ChildProcess>} */
	const workers = new Set();
	let shutting_down = false;

	function spawn_worker() {
		const worker = fork(process.argv[1], {
			env: { ...process.env, __UWS_WORKER: '1' }
		});
		workers.add(worker);
		worker.on('exit', (code) => {
			workers.delete(worker);
			if (!shutting_down) {
				console.log(`Worker ${worker.pid} exited with code ${code}, restarting...`);
				spawn_worker();
			}
		});
	}

	for (let i = 0; i < num; i++) {
		spawn_worker();
	}

	/** @param {'SIGINT' | 'SIGTERM'} reason */
	function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		console.log(`Primary received ${reason}, shutting down ${workers.size} workers...`);
		for (const worker of workers) {
			worker.kill(reason);
		}
		setTimeout(() => {
			for (const worker of workers) {
				worker.kill('SIGKILL');
			}
			process.exit(0);
		}, shutdown_timeout * 1000).unref();
	}

	process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
	process.on('SIGINT', () => graceful_shutdown('SIGINT'));
} else {
	// ── Worker (single-process or forked child) ─────────────────────────────

	if (cluster_workers && !WS_ENABLED && process.platform !== 'linux') {
		console.warn(
			`Warning: CLUSTER_WORKERS is only supported on Linux (current platform: ${process.platform}).\n` +
			'Starting in single-process mode.'
		);
	}
	if (cluster_workers && WS_ENABLED) {
		console.warn(
			'Warning: CLUSTER_WORKERS is ignored when WebSocket is enabled.\n' +
			'uWS pub/sub is per-process - clustering would cause missed messages.\n' +
			'Starting in single-process mode.'
		);
	}

	const { start, shutdown, drain } = await import('HANDLER');

	start(host, parseInt(port, 10));

	let shutting_down = false;

	/** @param {'SIGINT' | 'SIGTERM'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		console.log(`Received ${reason}, shutting down gracefully...`);
		shutdown();
		// @ts-expect-error custom events cannot be typed
		process.emit('sveltekit:shutdown', reason);
		await Promise.race([
			drain(),
			new Promise((resolve) => setTimeout(resolve, shutdown_timeout * 1000).unref())
		]);
		console.log('Shutdown complete, exiting.');
		process.exit(0);
	}

	process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
	process.on('SIGINT', () => graceful_shutdown('SIGINT'));
}

export { host, port };
