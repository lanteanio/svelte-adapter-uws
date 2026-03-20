import process from 'node:process';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { env } from 'ENV';

const host = env('HOST', '0.0.0.0');
const port = env('PORT', '3000');
const shutdown_timeout = parseInt(env('SHUTDOWN_TIMEOUT', '30'), 10);
const shutdown_delay = parseInt(env('SHUTDOWN_DELAY_MS', '0'), 10);
const cluster_workers = env('CLUSTER_WORKERS', '');

const is_primary = cluster_workers && isMainThread;

if (is_primary) {
	// ── Primary thread: spawn workers, coordinate shutdown ──

	const { availableParallelism } = await import('node:os');

	const num = cluster_workers === 'auto'
		? availableParallelism()
		: parseInt(cluster_workers, 10);

	if (isNaN(num) || num < 1) {
		console.error(`Invalid CLUSTER_WORKERS value: '${cluster_workers}'. Use a positive integer or 'auto'.`);
		process.exit(1);
	}

	// On Linux, uWS sets SO_REUSEPORT by default so each worker can bind
	// to the same port independently and the kernel distributes connections.
	// No single-threaded acceptor bottleneck, no single point of failure.
	// On other platforms, fall back to the acceptor model (main thread
	// accepts connections and distributes them to workers via descriptors).
	const cluster_mode = env('CLUSTER_MODE', process.platform === 'linux' ? 'reuseport' : 'acceptor');

	if (cluster_mode === 'reuseport' && process.platform !== 'linux') {
		console.error(
			`CLUSTER_MODE=reuseport requires Linux (SO_REUSEPORT is not reliable on ${process.platform}). ` +
			'Remove CLUSTER_MODE to use the default acceptor mode.'
		);
		process.exit(1);
	}

	if (cluster_mode !== 'reuseport' && cluster_mode !== 'acceptor') {
		console.error(`Invalid CLUSTER_MODE: '${cluster_mode}'. Use 'reuseport' or 'acceptor'.`);
		process.exit(1);
	}

	// Acceptor mode needs a uWS app to receive and distribute connections
	const ssl_cert = env('SSL_CERT', '');
	const ssl_key = env('SSL_KEY', '');
	const is_tls = !!(ssl_cert && ssl_key);

	let uWS, acceptorApp;
	if (cluster_mode === 'acceptor') {
		uWS = (await import('uWebSockets.js')).default;
		acceptorApp = is_tls
			? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
			: uWS.App();
	}

	console.log(`Primary thread starting ${num} workers (${cluster_mode} mode)...`);

	/**
	 * Per-worker metadata.
	 * @typedef {{ descriptor: any, lastHeartbeat: number }} WorkerMeta
	 */

	/** @type {Map<import('node:worker_threads').Worker, WorkerMeta>} */
	const workers = new Map();
	let shutting_down = false;
	let listening = false;
	let listen_socket = null;

	// Exponential backoff for crash-looping workers
	let restart_delay = 0;
	const RESTART_DELAY_MAX = 5000;
	const RESTART_MAX_ATTEMPTS = 50;
	let restart_attempts = 0;
	/** @type {Set<ReturnType<typeof setTimeout>>} */
	const restart_timers = new Set();

	// Worker health monitoring: send a heartbeat every 10 s.
	// A worker that has not responded within 30 s is assumed stuck (deadlock /
	// infinite loop) and terminated so the exit handler can restart it.
	// lastHeartbeat === 0 means the worker has not confirmed it is alive yet
	// (still starting up)  - don't count that as unresponsive.
	const HEARTBEAT_INTERVAL_MS = 10000;
	const HEARTBEAT_TIMEOUT_MS = 30000;

	setInterval(() => {
		if (shutting_down) return;
		const now = Date.now();
		for (const [worker, meta] of workers) {
			if (meta.lastHeartbeat > 0 && now - meta.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
				console.error(
					`[primary] Worker ${worker.threadId} unresponsive ` +
					`(no heartbeat ack in ${HEARTBEAT_TIMEOUT_MS}ms), terminating...`
				);
				worker.terminate();
			} else {
				worker.postMessage({ type: 'heartbeat' });
			}
		}
	}, HEARTBEAT_INTERVAL_MS).unref();

	function spawn_worker() {
		const worker = new Worker(fileURLToPath(import.meta.url), {
			workerData: { mode: cluster_mode }
		});
		// lastHeartbeat starts at 0  - worker is confirmed alive only after the
		// first 'descriptor' / 'ready' / 'heartbeat-ack' message arrives.
		workers.set(worker, { descriptor: null, lastHeartbeat: 0 });

		worker.on('message', (msg) => {
			const meta = workers.get(worker);
			if (msg.type === 'descriptor' && cluster_mode === 'acceptor') {
				meta.descriptor = msg.descriptor;
				meta.lastHeartbeat = Date.now();
				acceptorApp.addChildAppDescriptor(msg.descriptor);
				console.log(`Worker thread ${worker.threadId} registered`);
				// Worker started successfully - reset backoff and attempt counter
				restart_delay = 0;
				restart_attempts = 0;
				for (const t of restart_timers) clearTimeout(t);
				restart_timers.clear();
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
			} else if (msg.type === 'ready' && cluster_mode === 'reuseport') {
				meta.lastHeartbeat = Date.now();
				console.log(`Worker thread ${worker.threadId} listening on :${port}`);
				restart_delay = 0;
				restart_attempts = 0;
				for (const t of restart_timers) clearTimeout(t);
				restart_timers.clear();
			} else if (msg.type === 'heartbeat-ack') {
				if (meta) meta.lastHeartbeat = Date.now();
			} else if (msg.type === 'publish') {
				// Single relay (legacy / non-batched path)
				for (const [w] of workers) {
					if (w !== worker) w.postMessage(msg);
				}
			} else if (msg.type === 'publish-batch') {
				// Batched relay: one postMessage per microtask from the publishing worker.
				// Forward each message individually so receiving workers use the same
				// single-message 'publish' path in their relayPublish handler.
				for (const { topic, envelope } of msg.messages) {
					const relay = { type: 'publish', topic, envelope };
					for (const [w] of workers) {
						if (w !== worker) w.postMessage(relay);
					}
				}
			}
		});

		worker.on('exit', (code) => {
			const meta = workers.get(worker);
			if (cluster_mode === 'acceptor' && meta?.descriptor) {
				try { acceptorApp.removeChildAppDescriptor(meta.descriptor); } catch {}
			}
			workers.delete(worker);
			if (!shutting_down) {
				// In acceptor mode, stop accepting when all workers are down so
				// clients get a clean connection-refused instead of an empty app.
				// In reuseport mode, each worker owns its listen socket -- when
				// it dies, the kernel stops routing to it automatically.
				if (cluster_mode === 'acceptor') {
					const has_live_worker = [...workers.values()].some(m => m.descriptor !== null);
					if (!has_live_worker && listen_socket) {
						uWS.us_listen_socket_close(listen_socket);
						listen_socket = null;
						listening = false;
						console.log('All workers down, acceptor paused until a replacement is ready');
					}
				}
				restart_attempts++;
				if (restart_attempts > RESTART_MAX_ATTEMPTS) {
					console.error(`Worker restart limit reached (${RESTART_MAX_ATTEMPTS}). Exiting.`);
					process.exit(1);
				}
				restart_delay = restart_delay ? Math.min(restart_delay * 2, RESTART_DELAY_MAX) : 100;
				console.log(`Worker thread ${worker.threadId} exited with code ${code}, restarting in ${restart_delay}ms... (attempt ${restart_attempts}/${RESTART_MAX_ATTEMPTS})`);
				const timer = setTimeout(() => {
				restart_timers.delete(timer);
				if (shutting_down) return;
				spawn_worker();
			}, restart_delay);
			restart_timers.add(timer);
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
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		console.log(`Primary received ${reason}, shutting down ${workers.size} workers...`);

		// Cancel all pending worker restarts so we don't spawn during shutdown
		for (const t of restart_timers) clearTimeout(t);
		restart_timers.clear();

		// Phase 1: Keep accepting connections until the load balancer has
		// had time to remove this pod from rotation (Kubernetes rolling updates).
		// SHUTDOWN_DELAY_MS=0 (default) skips this and is correct for non-k8s deploys.
		if (shutdown_delay > 0) {
			console.log(`[primary] Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimeout(resolve, shutdown_delay));
		}

		// Phase 2: Stop accepting new connections (acceptor mode only)
		if (cluster_mode === 'acceptor' && listen_socket) {
			uWS.us_listen_socket_close(listen_socket);
			listen_socket = null;
		}

		// Tell workers to drain and exit (workers handle their own drain timeout)
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
		// Worker thread startup depends on clustering mode
		if (workerData?.mode === 'reuseport') {
			// Reuseport: each worker listens on the shared port directly.
			// The kernel distributes incoming connections via SO_REUSEPORT.
			start(host, parseInt(port, 10));
			parentPort.postMessage({ type: 'ready' });
		} else {
			// Acceptor: register with the main thread's acceptor app
			parentPort.postMessage({ type: 'descriptor', descriptor: getDescriptor() });
		}

		parentPort.on('message', (msg) => {
			if (msg.type === 'shutdown') {
				graceful_shutdown('shutdown');
			} else if (msg.type === 'publish') {
				relayPublish(msg.topic, msg.envelope);
			} else if (msg.type === 'heartbeat') {
				// Respond immediately  - primary uses acks to detect stuck workers.
				parentPort.postMessage({ type: 'heartbeat-ack' });
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

		// Phase 1: Load balancer drain delay (only for OS signals, not when the
		// primary tells us to shutdown  - the primary already waited its own delay).
		if (shutdown_delay > 0 && (reason === 'SIGTERM' || reason === 'SIGINT')) {
			console.log(`${prefix}Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimeout(resolve, shutdown_delay));
		}

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
