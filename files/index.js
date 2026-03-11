import process from 'node:process';
import { isMainThread, parentPort, threadId, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { env } from 'ENV';

const host = env('HOST', '0.0.0.0');
const port = env('PORT', '3000');
const shutdown_timeout = parseInt(env('SHUTDOWN_TIMEOUT', '30'), 10);
const cluster_workers = env('CLUSTER_WORKERS', '');

const is_primary = cluster_workers && isMainThread;

if (is_primary) {
	// ── Primary thread: accept connections, distribute to worker threads ──

	const { availableParallelism } = await import('node:os');
	const uWS = (await import('uWebSockets.js')).default;

	const num = cluster_workers === 'auto'
		? availableParallelism()
		: parseInt(cluster_workers, 10);

	if (isNaN(num) || num < 1) {
		console.error(`Invalid CLUSTER_WORKERS value: '${cluster_workers}'. Use a positive integer or 'auto'.`);
		process.exit(1);
	}

	// Acceptor app must match worker SSL mode
	const ssl_cert = env('SSL_CERT', '');
	const ssl_key = env('SSL_KEY', '');
	const is_tls = !!(ssl_cert && ssl_key);

	const acceptorApp = is_tls
		? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
		: uWS.App();

	console.log(`Primary thread starting ${num} workers...`);

	/** @type {Map<import('node:worker_threads').Worker, any>} */
	const workers = new Map();
	let shutting_down = false;
	let listening = false;
	let listen_socket = null;

	// Exponential backoff for crash-looping workers
	let restart_delay = 0;
	const RESTART_DELAY_MAX = 5000;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let backoff_reset_timer = null;

	function spawn_worker() {
		const worker = new Worker(fileURLToPath(import.meta.url));
		workers.set(worker, null);

		worker.on('message', (msg) => {
			if (msg.type === 'descriptor') {
				workers.set(worker, msg.descriptor);
				acceptorApp.addChildAppDescriptor(msg.descriptor);
				console.log(`Worker thread ${worker.threadId} registered`);
				// Worker started successfully  - reset backoff
				restart_delay = 0;
				if (backoff_reset_timer) { clearTimeout(backoff_reset_timer); backoff_reset_timer = null; }
				// Start (or resume) listening once a worker is ready to handle requests
				if (!listening) {
					listening = true;
					const portNum = parseInt(port, 10);
					acceptorApp.listen(host, portNum, (socket) => {
						if (socket) {
							listen_socket = socket;
							console.log(`Acceptor listening on ${is_tls ? 'https' : 'http'}://${host}:${portNum}`);
						} else {
							console.error(`Failed to listen on ${host}:${portNum}`);
							process.exit(1);
						}
					});
				}
			} else if (msg.type === 'publish') {
				// Relay pub/sub to all OTHER workers
				for (const [w] of workers) {
					if (w !== worker) w.postMessage(msg);
				}
			}
		});

		worker.on('exit', (code) => {
			const descriptor = workers.get(worker);
			if (descriptor) {
				try { acceptorApp.removeChildAppDescriptor(descriptor); } catch {}
			}
			workers.delete(worker);
			if (!shutting_down) {
				// If no workers have descriptors, stop accepting connections so
				// clients get a clean connection-refused instead of an empty app.
				const has_live_worker = [...workers.values()].some(d => d !== null);
				if (!has_live_worker && listen_socket) {
					uWS.us_listen_socket_close(listen_socket);
					listen_socket = null;
					listening = false;
					console.log('All workers down, acceptor paused until a replacement is ready');
				}
				restart_delay = restart_delay ? Math.min(restart_delay * 2, RESTART_DELAY_MAX) : 100;
				console.log(`Worker thread ${worker.threadId} exited with code ${code}, restarting in ${restart_delay}ms...`);
				backoff_reset_timer = setTimeout(() => { spawn_worker(); }, restart_delay);
			}
			// If shutting down and all workers have exited, exit immediately
			if (shutting_down && workers.size === 0) {
				process.exit(0);
			}
		});

		worker.on('error', (err) => {
			console.error('Worker thread error:', err);
		});
	}

	for (let i = 0; i < num; i++) spawn_worker();

	/** @param {'SIGINT' | 'SIGTERM'} reason */
	function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		console.log(`Primary received ${reason}, shutting down ${workers.size} workers...`);

		// Cancel any pending worker restart so we don't spawn during shutdown
		if (backoff_reset_timer) {
			clearTimeout(backoff_reset_timer);
			backoff_reset_timer = null;
		}

		// Stop accepting new connections
		if (listen_socket) {
			uWS.us_listen_socket_close(listen_socket);
			listen_socket = null;
		}

		// Tell workers to drain and exit
		for (const [worker] of workers) {
			worker.postMessage({ type: 'shutdown' });
		}

		// Force terminate after timeout
		setTimeout(() => {
			for (const [worker] of workers) worker.terminate();
			process.exit(0);
		}, shutdown_timeout * 1000).unref();
	}

	process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
	process.on('SIGINT', () => graceful_shutdown('SIGINT'));
} else {
	// ── Worker thread or single-process mode ─────────────────────────────

	const { start, shutdown, drain, getDescriptor, relayPublish } = await import('HANDLER');

	if (isMainThread) {
		// Single-process mode (no clustering)
		start(host, parseInt(port, 10));
	} else {
		// Worker thread  - register with acceptor, don't listen
		parentPort.postMessage({ type: 'descriptor', descriptor: getDescriptor() });

		parentPort.on('message', (msg) => {
			if (msg.type === 'shutdown') {
				graceful_shutdown('shutdown');
			} else if (msg.type === 'publish') {
				relayPublish(msg.topic, msg.envelope);
			}
		});
	}

	let shutting_down = false;

	/** @param {'SIGINT' | 'SIGTERM' | 'shutdown'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		const prefix = isMainThread ? '' : `[worker ${threadId}] `;
		console.log(`${prefix}Received ${reason}, shutting down gracefully...`);
		shutdown();
		await Promise.race([
			drain(),
			new Promise((resolve) => setTimeout(resolve, shutdown_timeout * 1000).unref())
		]);
		// Emit after drain so handlers can safely close DB pools etc.
		// @ts-expect-error custom events cannot be typed
		process.emit('sveltekit:shutdown', reason);
		console.log(`${prefix}Shutdown complete.`);
		process.exit(0);
	}

	if (isMainThread) {
		process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
		process.on('SIGINT', () => graceful_shutdown('SIGINT'));
	}
}

export { host, port };
