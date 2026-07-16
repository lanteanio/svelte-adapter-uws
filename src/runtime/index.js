import process from 'node:process';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { env } from 'ENV';
import { applyServerNames, createCertWatcher, reloadClusterTls } from './utils/tls-reload.js';
import { monotonicNow, setTimer, setIntervalTimer, clearTimer } from './runtime.js';
import { createRelayRingBuffer, RingWriter, RingReader, decodeRelayFrame } from './relay-ring.js';
import { createStateHashDetector } from './state-hash-detector.js';
import { createRestartSupervisor } from './restart-supervisor.js';
import { classifyWorkerHealth, resolveBootTimeout, routeWorkerMessage } from './worker-watchdog.js';
import { readFdLimits, fdPreflightWarning } from './utils/fd-limit.js';
import { createSdNotify } from './utils/sd-notify.js';

// systemd readiness + watchdog (auto-detected from NOTIFY_SOCKET; a no-op
// everywhere else). Only the main thread talks to systemd - it owns the
// service's MainPID - so every call site below is main-thread-gated.
const sdNotify = createSdNotify();
let sd_ready_sent = false;
function sdReadyOnce() {
	if (sd_ready_sent || !isMainThread) return;
	sd_ready_sent = true;
	sdNotify.ready();
	sdNotify.armWatchdog();
}

const host = env('HOST', '0.0.0.0');
const port_raw = env('PORT', '3000');

function parseIntEnv(name, raw, min) {
	const trimmed = raw.trim();
	const n = Number(trimmed);
	if (trimmed === '' || !Number.isInteger(n)) throw new Error(`${name} must be a valid integer, got "${raw}"`);
	if (n < min) throw new Error(`${name} must be >= ${min}, got ${n}`);
	return n;
}

const port = parseIntEnv('PORT', port_raw, 0);
const shutdown_timeout = parseIntEnv('SHUTDOWN_TIMEOUT', env('SHUTDOWN_TIMEOUT', '30'), 0);
const shutdown_delay = parseIntEnv('SHUTDOWN_DELAY_MS', env('SHUTDOWN_DELAY_MS', '0'), 0);
const cluster_workers = env('CLUSTER_WORKERS', '');

// Shared-memory relay ring size per direction per worker, in KB. The cluster
// relay's hot path (publish fan-out across workers) rides two
// SharedArrayBuffer rings per worker (worker->primary, primary->worker)
// instead of structured-clone postMessage: the publisher encodes each message
// to bytes once, the primary forwards the framed bytes verbatim, and only the
// receiving workers decode. A ring that fills spills into the producer's
// pending queue and flushes as the consumer drains - order always preserved.
// 0 disables the rings (every relay rides postMessage exactly as before).
const relay_ring_kb = parseIntEnv('CLUSTER_RELAY_RING_KB', env('CLUSTER_RELAY_RING_KB', '256'), 0);

// Cross-worker state-hash divergence ACTION gate. The primary owns
// worker.terminate() and never sees the per-build websocket options, so the
// restart action is threaded as a primary-level env var (consistent with the
// other cluster knobs above). Default off: a detected divergence is logged and
// counted (via a notice the worker increments) but no worker is auto-killed.
const restart_on_state_divergence = env('RESTART_ON_STATE_DIVERGENCE', '') === '1';
// Optional primary override for the epoch-bucket width used to group worker hash
// reports. Unset (0) derives it from each worker's advertised reporting interval
// (twice the interval, so one fixed-period round from every worker lands in one
// bucket); set it only to tune the bucketing without rebuilding the workers.
const state_hash_epoch_ms = parseIntEnv('STATE_HASH_EPOCH_MS', env('STATE_HASH_EPOCH_MS', '0'), 0);

const is_primary = cluster_workers && isMainThread;

// Descriptor-budget preflight: fires once per process (main thread only -
// worker threads share the single process fd table, so per-worker repeats
// would be noise) when the soft limit is EMFILE-low for a socket server.
// The probes return null on platforms without a limit source, so this is a
// silent no-op there.
if (isMainThread) {
	const fdWarning = fdPreflightWarning(readFdLimits());
	if (fdWarning !== null) console.warn(fdWarning);
}

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

	// Worker roles: split the pool into I/O workers (listen + serve) and compute
	// workers (never listen; driven entirely by the app via shared memory seeded
	// in primaryInit, so a latency-critical tick pays no I/O jitter). WORKERS_CONFIG
	// is the serialized `websocket.workers` option; `compute` is how many of the
	// `num` total workers are compute workers (io = num - compute).
	const workers_config = WORKERS_CONFIG;
	const compute_count = Math.max(0, Math.floor(workers_config?.compute ?? 0));
	if (compute_count >= num) {
		console.error(`websocket.workers.compute (${compute_count}) must be less than the total worker count (${num}).`);
		process.exit(1);
	}
	const io_count = num - compute_count;

	// primaryInit: run the app's optional primary-thread hook ONCE, before any
	// worker spawns. Its return value is retained and replayed as the IDENTICAL
	// `workerData.app` to every worker AND every respawn (a SharedArrayBuffer is
	// shared by reference through workerData, so all workers - and a crashed
	// worker's replacement - see the same backing memory). Bundled as its own
	// isolated entry, so importing it never pulls the app graph into the primary.
	const { default: primaryInit } = await import('PRIMARY_INIT');
	let app_worker_data = null;
	if (typeof primaryInit === 'function') {
		app_worker_data = (await primaryInit({ env: process.env })) ?? null;
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
			'Remove CLUSTER_MODE to use the default acceptor mode.\n' +
			'  See: https://svti.me/cluster-mode'
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
	// TLS cert hot-reload knobs, mirrored from the worker config (config.js) so the
	// primary reads the same env. Default-ON when SSL is configured (opt out with
	// SSL_WATCH=0). The primary owns the cert-directory watch in cluster mode; a
	// single-process server watches worker-side (lifecycle.js).
	const ssl_watch = is_tls && env('SSL_WATCH', '1') !== '0';
	const _ssl_debounce_raw = parseInt(env('SSL_RELOAD_DEBOUNCE_MS', '500'), 10);
	const ssl_reload_debounce_ms = Number.isFinite(_ssl_debounce_raw) && _ssl_debounce_raw >= 0 ? _ssl_debounce_raw : 500;
	const ssl_sni_hosts = env('SSL_SNI_HOSTS', '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

	let uWS, acceptorApp;
	if (cluster_mode === 'acceptor') {
		uWS = (await import('uWebSockets.js')).default;
		acceptorApp = is_tls
			? uWS.SSLApp({ cert_file_name: ssl_cert, key_file_name: ssl_key })
			: uWS.App();
	}

	console.log(
		`Primary thread starting ${num} workers ` +
		`(${io_count} io${compute_count ? `, ${compute_count} compute` : ''}, ${cluster_mode} mode)...`
	);

	/**
	 * Per-worker metadata. `role` is the worker's assigned role ('io' | 'compute')
	 * and `slot` is its stable `{ role, index }` identity, both retained so a
	 * respawn re-creates the SAME role in the SAME slot after a crash.
	 * @typedef {{ descriptor: any, lastHeartbeat: number, spawnedAt: number, ready: boolean, role: 'io' | 'compute', slot: { role: 'io' | 'compute', index: number } }} WorkerMeta
	 */

	/** @type {Map<import('node:worker_threads').Worker, WorkerMeta>} */
	const workers = new Map();

	// Cross-worker state-hash divergence detector. Buckets the workers' periodic
	// hash reports by a primary-assigned monotonic epoch and judges a bucket once
	// every live worker has reported into it. Inert until workers actually report
	// (which they only do when stateHashIntervalMs is configured), so an
	// unconfigured cluster never pays for it beyond an empty Map.
	const stateHashDetector = createStateHashDetector({ epochMs: state_hash_epoch_ms > 0 ? state_hash_epoch_ms : 60000, monotonicNow });

	let shutting_down = false;
	let listening = false;
	let listen_socket = null;

	// Per-slot crash-restart budgets. A cluster has a fixed set of worker slots
	// (io_count io + compute_count compute); the supervisor keeps each slot's
	// restart attempts, exponential backoff, and pending respawn timer separate,
	// so one slot becoming ready never resets or cancels another slot's restart.
	// A cohort-global budget let a simultaneous two-worker flap lose one slot's
	// respawn permanently - see restart-supervisor.js. A slot's budget resets only
	// after a worker has been ready for RESTART_STABLE_MS, so a slot that flaps a
	// brief ready between crashes exhausts instead of resetting forever.
	const RESTART_DELAY_MAX = 5000;
	const RESTART_MAX_ATTEMPTS = 50;
	const RESTART_STABLE_MS = 30000;
	const restartSupervisor = createRestartSupervisor({
		setTimer,
		clearTimer,
		now: monotonicNow,
		spawn: (slot) => spawn_worker(slot),
		onExhausted: (slot) => {
			console.error(
				`Worker restart limit reached for ${slot.role}#${slot.index} (${RESTART_MAX_ATTEMPTS}). Exiting.\n` +
				'  See: https://svti.me/worker-restart-limit'
			);
			primaryHardExit(1);
		},
		shuttingDown: () => shutting_down,
		delayBase: 100,
		delayMax: RESTART_DELAY_MAX,
		maxAttempts: RESTART_MAX_ATTEMPTS,
		stableMs: RESTART_STABLE_MS
	});

	// Worker health monitoring: send a heartbeat every 10 s.
	// A worker that has not responded within 30 s is assumed stuck (deadlock /
	// infinite loop) and terminated so the exit handler can restart it.
	// lastHeartbeat === 0 means the worker has not confirmed it is alive yet
	// (still starting up)  - don't count that as unresponsive.
	const HEARTBEAT_INTERVAL_MS = 10000;
	const HEARTBEAT_TIMEOUT_MS = 30000;

	// Boot-deadline watchdog. A worker whose `init` hook wedges (a sync infinite
	// loop or a native hang) never confirms ready, so the steady-state timeout
	// above - which only judges a worker that HAS confirmed ready - never
	// escalates it and its cluster slot is stranded (permanent capacity loss).
	// The boot deadline closes that window: a still-booting worker whose liveness
	// clock goes stale past it is escalated and respawned via the normal exit
	// path. A slow-but-healthy init keeps acking the heartbeats (its pre-start
	// liveness responder answers while the event loop is free), so its clock never
	// goes stale - only a genuine no-ack wedge reaches the deadline. Kept distinct
	// from HEARTBEAT_TIMEOUT_MS and generously defaulted so a long-but-legitimate
	// warmup (cron registration, dataset load, external connections) is never
	// false-killed into a restart loop. 0 disables it (a wedged boot then stays
	// stranded, the pre-fix behavior); a sync-blocking warmup that never yields the
	// event loop cannot ack and so still reads as wedged (a documented non-goal).
	// Clamped to at least two heartbeat intervals: a worker cannot ack before its
	// first ping (one interval after spawn) and its liveness clock then trails by up
	// to one interval between pings, so a shorter deadline could false-kill a healthy
	// slow boot at a sweep boundary. Two intervals leaves a full interval of headroom.
	const WORKER_BOOT_TIMEOUT_FLOOR_MS = 2 * HEARTBEAT_INTERVAL_MS;
	const _boot_timeout_raw = parseIntEnv('WORKER_BOOT_TIMEOUT_MS', env('WORKER_BOOT_TIMEOUT_MS', '60000'), 0);
	const { bootTimeoutMs: WORKER_BOOT_TIMEOUT_MS, clamped: _boot_timeout_clamped } = resolveBootTimeout(_boot_timeout_raw, WORKER_BOOT_TIMEOUT_FLOOR_MS);
	if (_boot_timeout_clamped) {
		console.warn(
			`[primary] WORKER_BOOT_TIMEOUT_MS=${_boot_timeout_raw}ms is below the ${WORKER_BOOT_TIMEOUT_FLOOR_MS}ms floor ` +
			`(two heartbeat intervals) and would risk false-killing a healthy slow boot; using ${WORKER_BOOT_TIMEOUT_FLOOR_MS}ms.`
		);
	}

	// A worker thread holds uWS's raw libuv socket handles, so `worker.terminate()`
	// on a worker that still holds a uWS App aborts the WHOLE process
	// (`uv_loop_close() while having open handles`). Instead, ask the worker to
	// close its App and exit itself (clean); if it does not (a genuine deadlock -
	// it cannot process the message), SIGKILL the whole process for a clean
	// orchestrator respawn. The grace is generous: a busy-but-alive worker closes
	// and exits in well under it, so only a real wedge reaches the SIGKILL.
	const WORKER_EXIT_GRACE_MS = 5000;
	/** @type {Set<import('node:worker_threads').Worker>} */
	const exit_requested = new Set();
	/** @param {import('node:worker_threads').Worker} worker @param {number} code */
	function requestWorkerExit(worker, code) {
		if (exit_requested.has(worker)) return;
		exit_requested.add(worker);
		try { worker.postMessage({ type: 'terminate', code }); } catch {}
		const t = setTimer(() => {
			if (workers.has(worker)) {
				console.error(
					`[primary] Worker ${worker.threadId} did not exit within ${WORKER_EXIT_GRACE_MS}ms; ` +
					'SIGKILL-ing the process for a clean respawn (a wedged worker cannot self-close, ' +
					'and worker.terminate() would abort the process).'
				);
				process.kill(process.pid, 'SIGKILL');
			}
		}, WORKER_EXIT_GRACE_MS);
		if (t && t.unref) t.unref();
	}
	/**
	 * Terminal primary exit. A main-thread `process.exit()` while worker threads
	 * still hold uWS Apps aborts the process (same `uv_loop_close` hazard), so with
	 * any worker still alive we SIGKILL for a clean signal (the orchestrator
	 * respawns); with no live workers left we exit normally with the code.
	 * @param {number} code
	 */
	function primaryHardExit(code) {
		if (workers.size > 0) {
			console.error(`[primary] hard exit with ${workers.size} live worker(s); SIGKILL for a clean teardown (orchestrator respawns).`);
			process.kill(process.pid, 'SIGKILL');
		} else {
			process.exit(code);
		}
	}

	setIntervalTimer(() => {
		if (shutting_down) return;
		const t = monotonicNow();
		for (const [worker, meta] of workers) {
			// A ready worker is judged by the tight steady-state timeout; a
			// still-booting one by the generous, separate boot deadline (regimes
			// flipped at ready/descriptor, not at the first ack). A slow-but-healthy
			// init acks throughout boot via its pre-start liveness responder, so its
			// clock stays fresh under either timeout - only a genuine wedge goes stale.
			const verdict = classifyWorkerHealth(meta, t, { steadyTimeoutMs: HEARTBEAT_TIMEOUT_MS, bootTimeoutMs: WORKER_BOOT_TIMEOUT_MS });
			if (verdict.escalate) {
				console.error(
					`[primary] Worker ${worker.threadId} (${meta.slot.role}#${meta.slot.index}) ${verdict.reason}, asking it to exit...`
				);
				requestWorkerExit(worker, 1);
			} else {
				worker.postMessage({ type: 'heartbeat' });
			}
		}
		// Self-heal the live-plus-spawning-plus-pending invariant: if any slot has
		// somehow ended up with no live worker, no booting worker, and no pending
		// respawn, schedule its restart. A correct event path never leaves a slot
		// stranded; this only fires against a future regression, and it skips
		// still-booting slots so it never double-spawns.
		const backfilled = restartSupervisor.reconcile();
		if (backfilled > 0) console.error(`[primary] reconciled ${backfilled} stranded worker slot(s)`);
	}, HEARTBEAT_INTERVAL_MS).unref();

	/** @param {{ role: 'io' | 'compute', index: number }} slot */
	function spawn_worker(slot) {
		// This worker is (re)occupying its slot: reset the slot's not-yet-live
		// flag and drop any pending respawn timer before the new thread starts.
		restartSupervisor.noteSpawn(slot);
		const role = slot.role;
		// Shared-memory relay rings for this worker (fresh per spawn AND per
		// respawn - a replacement never inherits a dead worker's stream state).
		const relay_ring = relay_ring_kb > 0
			? { up: createRelayRingBuffer(relay_ring_kb * 1024), down: createRelayRingBuffer(relay_ring_kb * 1024) }
			: null;
		const worker = new Worker(fileURLToPath(import.meta.url), {
			// `app` is the retained primaryInit output, replayed identically on every
			// spawn and respawn so a compute worker's replacement rejoins the same
			// shared-memory world.
			workerData: { mode: cluster_mode, role, app: app_worker_data, relayRing: relay_ring }
		});
		// lastHeartbeat starts at 0  - worker is confirmed alive only after the
		// first 'descriptor' / 'ready' / 'heartbeat-ack' message arrives. spawnedAt
		// anchors the boot deadline before the first ack; ready flips the watchdog
		// from the boot regime to the steady-state regime at descriptor/ready.
		const meta = { descriptor: null, lastHeartbeat: 0, spawnedAt: monotonicNow(), ready: false, role, slot, ringWriter: null, ringReader: null };
		if (relay_ring !== null) {
			meta.ringWriter = new RingWriter(relay_ring.down);
			// Forward each inbound frame VERBATIM to every other worker's ring -
			// the primary never parses relay traffic, it moves bytes. Ring
			// activity also proves the worker alive (the same reasoning as the
			// any-postMessage-advances-the-heartbeat rule: a worker saturating
			// the relay is busy, not dead).
			meta.ringReader = new RingReader(relay_ring.up, (frame) => {
				meta.lastHeartbeat = monotonicNow();
				for (const [w, m] of workers) {
					if (w !== worker && m.ringWriter !== null) {
						m.ringWriter.write(frame);
						m.ringWriter.notify();
					}
				}
			});
			meta.ringReader.start();
		}
		workers.set(worker, meta);

		worker.on('message', (msg) => {
			const meta = workers.get(worker);
			// Any inbound message proves the worker is alive: advance the heartbeat
			// clock so a worker saturated with publish/relay traffic (whose
			// heartbeat-ack queues behind the publishes) is never false-flagged as
			// unresponsive under sustained fan-out - the false-positive that used to
			// force-terminate a busy-but-alive worker and abort the whole process.
			if (meta) meta.lastHeartbeat = monotonicNow();
			if (msg.type === 'descriptor' && cluster_mode === 'acceptor') {
				meta.descriptor = msg.descriptor;
				meta.lastHeartbeat = monotonicNow();
				meta.ready = true;
				acceptorApp.addChildAppDescriptor(msg.descriptor);
				console.log(`Worker thread ${worker.threadId} registered`);
				// Worker started successfully - mark this slot ready and stamp its
				// uptime clock. The backoff/attempt budget resets on the NEXT exit,
				// and only after the worker has stayed up past the stable window.
				if (meta.slot) restartSupervisor.noteReady(meta.slot);
				// Start (or resume) listening once a worker is ready to handle requests
				if (!listening) {
					listening = true;
					const portNum = port;
					acceptorApp.listen(host, portNum, (socket) => {
						if (socket) {
							listen_socket = socket;
							console.log(`Acceptor listening on ${is_tls ? 'https' : 'http'}://${host}:${portNum}`);
							sdReadyOnce();
						} else {
							console.error(`Failed to listen on ${host}:${portNum}`);
							primaryHardExit(1);
						}
					});
				}
			} else if (msg.type === 'ready' && (cluster_mode === 'reuseport' || msg.role === 'compute')) {
				// A reuseport io worker reports 'ready' once it is listening; a compute
				// worker (any mode) reports 'ready' once its init hook has resolved. Both
				// mark the worker confirmed-alive and stamp its uptime clock; the
				// crash-restart budget resets on a later exit only if it stayed up.
				meta.lastHeartbeat = monotonicNow();
				meta.ready = true;
				if (msg.role === 'compute') console.log(`Compute worker ${worker.threadId} ready`);
				else {
					console.log(`Worker thread ${worker.threadId} listening on :${port}`);
					// First listening worker = the service accepts traffic.
					sdReadyOnce();
				}
				if (meta.slot) restartSupervisor.noteReady(meta.slot);
			} else if (msg.type === 'heartbeat-ack') {
				if (meta) meta.lastHeartbeat = monotonicNow();
			} else if (msg.type === 'publish') {
				// Single relay (legacy / non-batched path)
				for (const [w] of workers) {
					if (w !== worker) w.postMessage(msg);
				}
			} else if (msg.type === 'publish-batch') {
				// Batched relay: one postMessage per microtask from the publishing worker.
				// Forward each message individually so receiving workers use the same
				// single-message 'publish' path in their relayPublish handler. The
				// stamped seq rides along so the receiver can advance its
				// delivered-seq tracker without re-parsing the envelope.
				for (const { topic, envelope, compress, seq, capability, event, data } of msg.messages) {
					const relay = { type: 'publish', topic, envelope, compress, seq, capability, event, data };
					for (const [w] of workers) {
						if (w !== worker) w.postMessage(relay);
					}
				}
			} else if (msg.type === 'publish-batched') {
				// Wire-level batched relay (platform.publishBatched). Forward
				// the whole event list as one IPC frame so receiving workers
				// can re-detect the fast path locally and dispatch a single
				// batch envelope, instead of degrading to N individual relays.
				for (const [w] of workers) {
					if (w !== worker) w.postMessage(msg);
				}
			} else if (msg.type === 'state-hash') {
				// A worker's periodic structure-only state hash. Stamp it with the
				// primary's own epoch (dodges worker wall-clock skew) and compare
				// once every live worker has reported into that epoch. Only the
				// integer hash + thread id crossed the boundary - no topic strings,
				// no payloads.
				if (meta) meta.lastHeartbeat = monotonicNow();
				// Live = a worker that has confirmed itself alive at least once;
				// a still-starting worker (lastHeartbeat 0) cannot stall the
				// comparison or be judged a phantom minority.
				const liveThreadIds = [];
				for (const [w, m] of workers) if (m.lastHeartbeat > 0) liveThreadIds.push(w.threadId);
				// Bucket width: an explicit primary override, else twice the worker's
				// advertised reporting interval so one fixed-period round from every
				// worker lands in one bucket (the reporter jitters only its first fire).
				const epochMs = state_hash_epoch_ms > 0
					? state_hash_epoch_ms
					: 2 * (msg.intervalMs > 0 ? msg.intervalMs : 30000);
				const divergence = stateHashDetector.record(msg.threadId, msg.hash, liveThreadIds, epochMs);
				if (divergence) {
					const minoritySet = new Set(divergence.minorityThreadIds);
					// One structured log line: the operator's divergence signal.
					// Event name + epoch + per-thread hash + the majority/minority
					// split; no topic strings, no payloads (the hash is structure
					// only). This is the PRIMARY signal; the metric is supplementary
					// (it round-trips through a worker and can under-count if the
					// divergent worker is the one that died).
					console.error(
						'[primary] state-divergence epoch=%d majorityHash=%d minority=%o hashes=%o',
						divergence.epoch, divergence.majorityHash, divergence.minorityThreadIds, divergence.hashesByThread
					);
					// Notice each live worker so it increments its own registry
					// counter with its role (the primary holds no registry over the
					// thread boundary). Epoch-deduped at the detector, so one
					// increment per role per divergent epoch.
					for (const [w] of workers) {
						const role = minoritySet.has(w.threadId) ? 'minority' : 'majority';
						w.postMessage({ type: 'state-divergence', epoch: divergence.epoch, role });
					}
					// Action gate (default OFF): only when explicitly enabled does
					// the primary terminate the minority worker(s); the existing
					// exit handler respawns them under the restart budget so they
					// reconnect and re-converge. Off = log + metric only, never
					// auto-kill.
					if (restart_on_state_divergence) {
						for (const [w] of workers) {
							if (minoritySet.has(w.threadId)) {
								console.error('[primary] asking minority worker %d to exit to re-converge (RESTART_ON_STATE_DIVERGENCE=1)', w.threadId);
								requestWorkerExit(w, 1);
							}
						}
					}
				}
			}
		});

		worker.on('exit', (code) => {
			const meta = workers.get(worker);
			// The dead worker's slot ({ role, index }) drives the respawn so its
			// replacement re-occupies the SAME slot in the SAME role with the same
			// replayed workerData.app. `role` here is only the fallback for the
			// (never-hit, meta is captured above before the delete below) missing-meta
			// case in the noteExit call.
			const role = meta?.role ?? 'io';
			if (cluster_mode === 'acceptor' && meta?.descriptor) {
				try { acceptorApp.removeChildAppDescriptor(meta.descriptor); } catch {}
			}
			// Drop this worker's pending presence from any open state-hash bucket
			// so its absence never stalls a comparison and a stale report cannot
			// be judged a phantom divergence.
			stateHashDetector.forget(worker.threadId);
			// Release the relay rings: close() unblocks each side's pending
			// Atomics wait so no promise (or the SharedArrayBuffer it retains)
			// outlives the worker.
			if (meta?.ringReader) meta.ringReader.close();
			if (meta?.ringWriter) meta.ringWriter.close();
			workers.delete(worker);
			exit_requested.delete(worker);
			if (!shutting_down) {
				// In acceptor mode, stop accepting when all workers are down so
				// clients get a clean connection-refused instead of an empty app.
				// In reuseport mode, each worker owns its listen socket - when
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
				// Charge the attempt against THIS slot only and schedule ITS own
				// respawn after ITS own backoff. onExhausted (hard-exit) fires from
				// inside the supervisor when the slot passes its attempt cap.
				const slot = meta?.slot ?? { role, index: 0 };
				const outcome = restartSupervisor.noteExit(slot);
				if (outcome && !('exhausted' in outcome)) {
					console.log(
						`Worker thread ${worker.threadId} (${slot.role}#${slot.index}) exited with code ${code}, ` +
						`restarting in ${outcome.delay}ms... (attempt ${outcome.attempts}/${RESTART_MAX_ATTEMPTS})`
					);
				}
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

	// One stable slot per desired worker. Registering every slot up front lets
	// the supervisor account for it (desired() / reconcile()) before its first
	// worker reports, and a respawn always targets the same { role, index }.
	for (let i = 0; i < io_count; i++) restartSupervisor.register({ role: 'io', index: i });
	for (let i = 0; i < compute_count; i++) restartSupervisor.register({ role: 'compute', index: i });
	for (let i = 0; i < io_count; i++) spawn_worker({ role: 'io', index: i });
	for (let i = 0; i < compute_count; i++) spawn_worker({ role: 'compute', index: i });

	// --- TLS certificate hot-reload (cluster primary half) ---
	// The primary watches the cert directory and, on a renewed cert (certbot /
	// cert-manager), broadcasts {type:'tls-reload'} so every worker swaps its own
	// app's SNI context in place (validated before touching the app; a bad cert
	// keeps the previous one). In acceptor mode the primary also reloads
	// acceptorApp, which terminates TLS on this thread. Reloading BOTH is correct
	// whether TLS terminates on the acceptor or the child worker apps. The listen
	// socket is never re-bound and live connections survive. Non-SNI / unmatched
	// clients keep the boot cert until a restart (the SSLApp default context is
	// not swappable) - the documented caveat covering the SNI-sending majority.
	let primaryCertWatcher = null;
	let acceptorTlsHosts = [];
	function onCertChange() {
		acceptorTlsHosts = reloadClusterTls({
			workers: workers.keys(),
			acceptorApp: cluster_mode === 'acceptor' ? acceptorApp : null,
			source: { certPath: ssl_cert, keyPath: ssl_key, hosts: ssl_sni_hosts },
			acceptorHosts: acceptorTlsHosts,
			onError: (err) => console.error('[tls] acceptor certificate reload skipped, kept the previous cert:', err && err.message ? err.message : err)
		});
	}
	if (is_tls && ssl_watch) {
		// Register the acceptor's SNI host(s) at boot so its context is reloadable
		// (a worker registers its own hosts in start()). A parse failure disables
		// the acceptor reload but never drops TLS.
		if (cluster_mode === 'acceptor' && acceptorApp) {
			try {
				acceptorTlsHosts = applyServerNames(acceptorApp, { certPath: ssl_cert, keyPath: ssl_key, hosts: ssl_sni_hosts }, []);
			} catch (err) {
				console.error('[tls] acceptor SNI registration failed, hot-reload disabled on the acceptor context:', err && err.message ? err.message : err);
			}
		}
		// Guard the watcher start: fs.watch throws ENOENT synchronously when the
		// cert's parent directory does not exist (a not-yet-mounted secret volume,
		// a mistyped path). Single-process degrades gracefully here (its cert-read
		// gates the watcher), so the cluster primary must too - log and disable
		// hot-reload rather than crash-loop the whole process at boot.
		try {
			primaryCertWatcher = createCertWatcher({
				certPath: ssl_cert,
				debounceMs: ssl_reload_debounce_ms,
				onChange: onCertChange
			});
			primaryCertWatcher.start();
			console.log(`[tls] primary watching ${dirname(ssl_cert)} for certificate renewals (cluster broadcast reload)`);
		} catch (err) {
			primaryCertWatcher = null;
			console.error('[tls] primary cert watch failed to start, cluster hot-reload disabled (server keeps running):', err && err.message ? err.message : err);
		}
	}

	/** @param {'SIGINT' | 'SIGTERM'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		sdNotify.stopping();
		sdNotify.disarmWatchdog();
		console.log(`Primary received ${reason}, shutting down ${workers.size} workers...`);

		// Cancel all pending worker restarts so we don't spawn during shutdown.
		// (The supervisor also re-checks shutting_down when a timer fires, so a
		// respawn already in flight is a no-op even if it races this.)
		restartSupervisor.stopAll();

		// Stop the cert-directory watcher so it never holds the loop or fires a
		// broadcast at exiting workers.
		if (primaryCertWatcher) { primaryCertWatcher.stop(); primaryCertWatcher = null; }

		// Step 1: Keep accepting connections until the load balancer has
		// had time to remove this pod from rotation (Kubernetes rolling updates).
		// SHUTDOWN_DELAY_MS=0 (default) skips this and is correct for non-k8s deploys.
		if (shutdown_delay > 0) {
			console.log(`[primary] Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimer(resolve, shutdown_delay));
		}

		// Step 2: Stop accepting new connections (acceptor mode only)
		if (cluster_mode === 'acceptor' && listen_socket) {
			uWS.us_listen_socket_close(listen_socket);
			listen_socket = null;
		}

		// Tell workers to drain and exit (workers handle their own drain timeout)
		for (const [worker] of workers) {
			worker.postMessage({ type: 'shutdown' });
		}

		// Force-exit after timeout: ask any still-running worker to close its App
		// and exit itself (worker.terminate() would abort the process; a bare
		// primary process.exit(0) with live uWS workers would too). Each request
		// carries its own SIGKILL fallback for a genuinely wedged worker; the last
		// worker's exit handler (workers.size === 0) performs the clean primary
		// process.exit(0).
		setTimer(() => {
			for (const [worker] of workers) requestWorkerExit(worker, 0);
		}, shutdown_timeout * 1000).unref();
	}

	process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
	process.on('SIGINT', () => graceful_shutdown('SIGINT'));
} else {
	// ── Worker thread or single-process mode ─────────────────────────────

	const { start, shutdown, drain, getDescriptor, relayPublish, relayPublishBatched, forceCloseApp, reloadTls, setRelayRingWriter } = await import('HANDLER');

	// Clean worker-thread exit. A worker thread holds uWS's untracked libuv socket
	// handles, so a bare process.exit() aborts the whole process
	// (`uv_loop_close() while having open handles`). Close the App (drops all
	// sockets, incl. the listen socket), let ONE real loop turn run so uv's close
	// callbacks complete, then exit. The main thread (single-process) has no
	// worker-teardown hazard and exits directly.
	function exitWorkerClean(code) {
		if (isMainThread) { process.exit(code); return; }
		try { forceCloseApp(); } catch { /* nothing to close */ }
		const t = setTimer(() => process.exit(code), 0);
		if (t && t.unref) t.unref();
	}

	if (!isMainThread) {
		// Route a hard-tier fatal() through the clean worker exit instead of the
		// default raw process.exit(code), which would abort the worker (same
		// uv_loop_close hazard). The sink is the module-level assertions singleton
		// the handler graph already uses, so fatal() picks it up.
		const { setFatalSink } = await import('./utils/assertions.js');
		setFatalSink({ exit: exitWorkerClean });
	}

	// Shutdown is shared by single-process (OS signals) and worker-thread (primary
	// 'shutdown' message) modes. The worker's message handler is registered BEFORE
	// `await start()` below and can dispatch a buffered shutdown, so this is
	// declared ahead of both branches rather than after them.
	let shutting_down = false;

	/** @param {'SIGINT' | 'SIGTERM' | 'shutdown'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		if (isMainThread) {
			sdNotify.stopping();
			sdNotify.disarmWatchdog();
		}
		const prefix = isMainThread ? '' : `[worker ${threadId}] `;
		console.log(`${prefix}Received ${reason}, shutting down gracefully...`);

		// Step 1: Load balancer drain delay (only for OS signals, not when the
		// primary tells us to shutdown  - the primary already waited its own delay).
		if (shutdown_delay > 0 && (reason === 'SIGTERM' || reason === 'SIGINT')) {
			console.log(`${prefix}Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimer(resolve, shutdown_delay));
		}

		// Awaiting `shutdown()` lets the hooks.ws `shutdown` hook flush app
		// state (last metrics, cron drain, external bridge teardown) before
		// the listen socket closes. Throws are logged-and-ignored inside
		// shutdown() since we cannot refuse to stop.
		await shutdown();
		await Promise.race([
			drain(),
			new Promise((resolve) => setTimer(resolve, shutdown_timeout * 1000).unref())
		]);
		// Emit after drain so handlers can safely close DB pools etc.
		// @ts-expect-error custom events cannot be typed
		process.emit('sveltekit:shutdown', reason);
		console.log(`${prefix}Shutdown complete.`);
		exitWorkerClean(0);
	}

	if (isMainThread) {
		// Single-process mode (no clustering). Awaiting `start()` lets the
		// hooks.ws `init` hook run to completion (cron registration, warmup
		// tasks, etc.) before this entry script returns. A throwing init
		// surfaces as an unhandled promise rejection and crashes the
		// process - which is the right behavior for boot failure.
		await start(host, port);
		sdReadyOnce();
	} else {
		// Worker thread startup depends on role, then clustering mode.
		const role = workerData?.role ?? 'io';

		// Worker message dispatch, registered BEFORE `await start()` so a worker
		// still running - or wedged in - its `init` hook still answers the primary's
		// liveness heartbeats. A healthy async init keeps its event loop free and
		// keeps acking, so the primary tells it apart from a wedge (a blocked loop
		// that never acks) and never boot-kills it; a genuine wedge stops acking and
		// the primary's boot-deadline watchdog escalates the slot. Until the handler
		// graph is live (`booted`), ONLY heartbeat (liveness) and terminate are
		// actioned - relay and other control traffic is buffered and replayed in
		// arrival order once boot completes, never dispatched into a half-built graph.
		let booted = false;
		/** @type {any[]} */
		const boot_backlog = [];
		function dispatchControl(msg) {
			if (msg.type === 'shutdown') {
				graceful_shutdown('shutdown');
			} else if (msg.type === 'publish') {
				relayPublish(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data);
			} else if (msg.type === 'publish-batched') {
				relayPublishBatched(msg.events, msg.compress);
			} else if (msg.type === 'tls-reload') {
				// Primary detected a renewed cert on disk and broadcast a reload.
				// Swap this worker app's SNI context in place (validated before the
				// swap; a bad cert keeps the previous one). No-op unless is_tls +
				// ssl_watch, so a non-TLS or opted-out worker ignores it.
				reloadTls();
			}
		}
		parentPort.on('message', (msg) => {
			const action = routeWorkerMessage(msg.type, booted);
			if (action === 'ack') {
				// Liveness ack - answered even mid-init (this handler is live before
				// `await start()`) so a slow-but-healthy boot is never mistaken for a
				// wedge. The primary advances its heartbeat clock on any inbound
				// message, so this doubles as the boot-liveness signal.
				parentPort.postMessage({ type: 'heartbeat-ack' });
			} else if (action === 'terminate') {
				// Primary asked us to close the uWS App and exit (steady-state or
				// boot-deadline timeout, state divergence, or shutdown timeout).
				// Honored during init too so a boot-deadline escalation lands cleanly;
				// a genuinely wedged loop cannot process it and the primary SIGKILLs
				// the whole process as the fallback. exitWorkerClean avoids the
				// worker-teardown abort.
				exitWorkerClean(typeof msg.code === 'number' ? msg.code : 0);
			} else if (action === 'dispatch') {
				dispatchControl(msg);
			} else {
				// buffer: handler graph not built yet - hold relay / shutdown /
				// tls-reload until boot completes, then replay in arrival order.
				boot_backlog.push(msg);
			}
		});

		if (role === 'compute') {
			// Compute worker: fire the app's `init` hook (which receives
			// `workerData.app` - the shared memory seeded in primaryInit) but never
			// bind a listen socket, so a latency-critical tick pays no connection-I/O
			// jitter. `ready` is posted once init resolves, in any cluster mode.
			await start(host, port, { listen: false });
			parentPort.postMessage({ type: 'ready', role });
		} else if (workerData?.mode === 'reuseport') {
			// Reuseport: each worker listens on the shared port directly.
			// The kernel distributes incoming connections via SO_REUSEPORT.
			// `init` fires once per worker; `ready` is posted only after
			// the hook resolves so the primary's worker-ready bookkeeping
			// matches actual readiness.
			await start(host, port);
			parentPort.postMessage({ type: 'ready', role });
		} else {
			// Acceptor: fire the app's `init` hook (listen:false - the primary's
			// acceptor owns the listen socket and distributes connections to this
			// child app by descriptor) BEFORE registering, so an acceptor io worker
			// runs the SAME documented per-worker init - DB connectivity checks, pool
			// warmup, migration validation - as a reuseport or compute worker, and
			// never takes traffic uninitialized. Registering only after `await start()`
			// resolves makes registration success-gated (a throwing init crashes the
			// boot loudly instead of serving a half-initialized worker) and brings the
			// acceptor path under the boot-deadline watchdog like every other role.
			await start(host, port, { listen: false });
			parentPort.postMessage({ type: 'descriptor', descriptor: getDescriptor() });
		}

		// Handler graph is live: drain any relay / control traffic that arrived
		// during init, in arrival order, then switch to live dispatch.
		booted = true;
		for (const msg of boot_backlog) dispatchControl(msg);
		boot_backlog.length = 0;

		// Shared-memory relay rings (when the primary enabled them): outbound
		// relays ride the up ring (see handler/relay.js), and inbound frames -
		// forwarded verbatim by the primary from a sibling worker - decode here
		// into the exact dispatch the postMessage path performs. Started after the
		// graph is live; the postMessage path above is the fallback / control lane.
		if (workerData?.relayRing) {
			setRelayRingWriter(new RingWriter(workerData.relayRing.up));
			const relayReader = new RingReader(workerData.relayRing.down, (frame) => {
				const msg = decodeRelayFrame(frame);
				if (msg === null) return;
				if (msg.type === 'publish') {
					relayPublish(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data);
				} else if (msg.type === 'publish-batched') {
					relayPublishBatched(msg.events, msg.compress);
				}
			});
			relayReader.start();
		}
	}

	if (isMainThread) {
		process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
		process.on('SIGINT', () => graceful_shutdown('SIGINT'));
	}
}

export { host, port };
