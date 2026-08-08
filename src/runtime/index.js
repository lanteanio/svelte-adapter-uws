// Substituted by the adapter's build step; a free identifier until then.
/* global WORKERS_CONFIG */
import process from 'node:process';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { env } from 'ENV';
import { certExpiryAlert, createCertWatcher, readCertIdentity, reloadClusterTls } from './utils/tls-reload.js';
import { monotonicNow, wallEpoch, randomUuid, randomBytes as runtimeRandomBytes, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from './runtime.js';
import { createRelayRingBuffer, RingWriter, RingReader, decodeRelayFrame } from './relay-ring.js';
import { createRelaySpillQuarantine, attributeRelayIncident, relayEligible } from './relay-spill-policy.js';
import { createStateHashDetector } from './state-hash-detector.js';
import { buildDivergenceDiagnostic, DIVERGENCE_DIAGNOSTIC_LIMIT, DIVERGENCE_TOPIC_LIMIT } from './divergence-diagnostics.js';
import { createRestartSupervisor } from './restart-supervisor.js';
import { createMetricsCollections } from './metrics-collector.js';
import { classifyWorkerHealth, resolveBootTimeout, routeWorkerMessage } from './worker-watchdog.js';
import { readFdLimits, fdPreflightWarning } from './utils/fd-limit.js';
import { createSdNotify } from './utils/sd-notify.js';
import { emitOperationalDiagnostic, listenFailureDiagnostic } from './utils/operational-diagnostic.js';
import { emitOperationalEvent, diagnosticError } from './diagnostic.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from './error-registry.js';
import { privateValueMetadata } from './utils/observability-privacy.js';
import { formatVersionBanner, runtimeVersionInfo } from './version-info.js';

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
// Seconds allowed for the WHOLE graceful shutdown sequence: the app's ws
// `shutdown` hook, the in-flight drain, and the `sveltekit:shutdown` listeners.
//
// 0 is the spelling for NO BUDGET - wait as long as it takes. It has to have a
// spelling: application code runs in two of those three phases, an app that
// flushes a ledger or closes a pool on the way out is entitled to say "never cut
// me off", and every positive value is a cut-off. 0 was chosen for it because
// that is what a disabled timeout is spelled as everywhere else in Node (a 0
// `server.timeout`, `requestTimeout`, `headersTimeout` all mean "no limit").
// The trade is explicit and is announced on the shutdown path: with no budget a
// wedged hook holds the process until the supervisor kills it.
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
// A receiving worker that stops draining its ring must not turn the primary
// into an unbounded spill buffer. These finite per-peer ceilings quarantine
// that worker through the normal clean-exit/restart supervisor. Bytes bound
// memory immediately; age catches a small spill that otherwise sits forever.
const relay_pending_max_bytes = parseIntEnv(
	'CLUSTER_RELAY_MAX_PENDING_KB', env('CLUSTER_RELAY_MAX_PENDING_KB', '4096'), 1
) * 1024;
const relay_pending_max_ms = parseIntEnv(
	'CLUSTER_RELAY_MAX_PENDING_MS', env('CLUSTER_RELAY_MAX_PENDING_MS', '5000'), 1
);
// Largest serialized envelope a worker will hand to the cluster relay. This is
// the SENDER's ceiling and it is a different question from the two above: those
// describe a receiving peer's failure to drain, this describes the size of one
// frame, which is nobody's fault and identical for every peer. Keeping them
// apart is the point - conflating them is what let one large publish quarantine
// every healthy sibling at once.
//
// It defaults to the per-peer byte ceiling, so one admitted frame can never be
// larger than the backlog budget it will occupy, and the pathological publish is
// refused at its source instead of being reassembled whole in the primary's heap
// on its way to bouncing the cluster. `0` disables it, for a deployment that
// genuinely relays frames larger than its spill budget and accepts the memory.
const relay_frame_max_bytes = parseIntEnv(
	'CLUSTER_RELAY_MAX_FRAME_KB',
	env('CLUSTER_RELAY_MAX_FRAME_KB', String(Math.floor(relay_pending_max_bytes / 1024))),
	0
) * 1024;

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

// Exactly once per process. Worker threads share the primary's package graph,
// so only their main thread announces the resolved ecosystem tuple.
if (isMainThread) console.log(formatVersionBanner(runtimeVersionInfo));

// Descriptor-budget preflight: fires once per process (main thread only -
// worker threads share the single process fd table, so per-worker repeats
// would be noise) when the soft limit is EMFILE-low for a socket server.
// The probes return null on platforms without a limit source, so this is a
// silent no-op there.
if (isMainThread) {
	const fdWarning = fdPreflightWarning(readFdLimits());
	if (fdWarning !== null) console.warn('[svelte-adapter-uws] ' + fdWarning);
}

if (is_primary) {
	// ── Primary thread: spawn workers, coordinate shutdown ──

	const { availableParallelism } = await import('node:os');

	const num = cluster_workers === 'auto'
		? availableParallelism()
		: parseInt(cluster_workers, 10);

	if (isNaN(num) || num < 1) {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_WORKERS,
			`${cluster_workers}'. Use a positive integer or 'auto'.`));
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
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_COMPUTE,
			`${compute_count}) must be less than the total worker count (${num}).`));
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
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_REUSEPORT,
			`${process.platform}). Remove CLUSTER_MODE to use the default acceptor mode.`));
		process.exit(1);
	}

	if (cluster_mode !== 'reuseport' && cluster_mode !== 'acceptor') {
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLUSTER_CONFIG_MODE,
			`${cluster_mode}'. Use 'reuseport' or 'acceptor'.`));
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
		`[svelte-adapter-uws] Primary thread starting ${num} workers ` +
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
	// One random key is shared with every worker and every respawn in this
	// primary lifetime. Workers use it only to HMAC topic names for a cold-path
	// diagnostic snapshot; the key itself never crosses back into logs, metrics,
	// or the admin response. A restart rotates all stream identifiers.
	const divergenceDiagnosticKey = runtimeRandomBytes(32);
	/** @type {Map<string, { epoch: number, observedAt: number, expectedThreadIds: number[], minorityThreadIds: number[], reports: Map<number, any>, timer: any }>} */
	const divergenceCollections = new Map();
	/** @type {Map<string, any>} */
	const completedDivergenceDiagnostics = new Map();

	/** Finish one collection with complete or explicitly-partial evidence. */
	function finishDivergenceCollection(diagnosticId) {
		const entry = divergenceCollections.get(diagnosticId);
		if (!entry) return;
		divergenceCollections.delete(diagnosticId);
		clearTimer(entry.timer);
		const diagnostic = buildDivergenceDiagnostic({
			diagnosticId,
			epoch: entry.epoch,
			observedAt: entry.observedAt,
			expectedThreadIds: entry.expectedThreadIds,
			minorityThreadIds: entry.minorityThreadIds,
			reports: [...entry.reports.values()]
		});
		completedDivergenceDiagnostics.delete(diagnosticId);
		completedDivergenceDiagnostics.set(diagnosticId, diagnostic);
		while (completedDivergenceDiagnostics.size > DIVERGENCE_DIAGNOSTIC_LIMIT) {
			completedDivergenceDiagnostics.delete(completedDivergenceDiagnostics.keys().next().value);
		}
		for (const [target] of workers) {
			try { target.postMessage({ type: 'state-divergence-diagnostic', diagnostic }); } catch {}
		}
	}

	/** Begin the bounded second stage after the aggregate detector fires. */
	function beginDivergenceCollection(divergence, liveThreadIds) {
		if (divergenceCollections.size >= DIVERGENCE_DIAGNOSTIC_LIMIT) {
			finishDivergenceCollection(divergenceCollections.keys().next().value);
		}
		const diagnosticId = randomUuid();
		const entry = {
			epoch: divergence.epoch,
			observedAt: wallEpoch(),
			expectedThreadIds: liveThreadIds.slice().sort((a, b) => a - b),
			minorityThreadIds: divergence.minorityThreadIds.slice(),
			reports: new Map(),
			timer: null
		};
		divergenceCollections.set(diagnosticId, entry);
		entry.timer = setTimer(() => finishDivergenceCollection(diagnosticId), 1000);
		if (entry.timer?.unref) entry.timer.unref();
		return diagnosticId;
	}

	// Cluster metrics collection. Every worker holds its own registry and they
	// all serve one port, so a scrape can only see the whole cluster by asking
	// the primary to gather every worker's mirrored values. The primary is a
	// router and nothing more: it holds no registry, applies no aggregation law,
	// and never looks inside a sample - it forwards structured values back to
	// the workers that asked, which merge them against the manifest.
	//
	// At most ONE collection runs at a time and later requests join it. That
	// bound has to live here: a per-worker guard lets N workers each start one
	// and each fan out to all N, and this thread is also the cross-worker
	// publish relay, so that amplification would land on the latency every
	// WebSocket client depends on.
	const metricsCollections = createMetricsCollections();

	/** Answer every requester with whatever arrived, and forget the collection. */
	const finishMetricsCollection = () => {
		const entry = metricsCollections.take();
		if (entry === null) return;
		clearTimer(entry.timer);
		// Exited workers' carried counter totals ride along as one more report,
		// so the merge sums them like any other contribution.
		// Three contributions, each counted exactly once: what arrived, the
		// carried totals of workers that have exited, and the last known counter
		// totals of workers that were asked and did not answer. The third is what
		// keeps a merely-slow worker from dropping the cluster counter and then
		// restoring it, which Prometheus would record as a reset.
		const carried = metricsCollections.retiredReport();
		const reports = [...entry.reports];
		if (entry.stale.length > 0) reports.push({ worker: 'stale', samples: entry.stale });
		if (carried !== null) reports.push(carried);
		for (const { worker: requester, id } of entry.requesters) {
			try {
				requester.postMessage({
					type: 'metrics-result', id, reports, expected: entry.expected, reporting: entry.answered
				});
			} catch {
				// Requester exited while the collection was out; its own deadline
				// already answered whatever route was waiting.
			}
		}
	};

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
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.WORKER_RESTART_LIMIT,
				`${slot.role}#${slot.index} (${RESTART_MAX_ATTEMPTS}). Exiting.`));
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
		// The ceilings travel with the buffers so BOTH directions are bounded by
		// the same numbers. Only the down direction had them; a worker's up writer
		// was built with no options at all, so a stalled primary let every
		// publisher spill without limit in its own heap.
		const relay_ring = relay_ring_kb > 0
			? {
				up: createRelayRingBuffer(relay_ring_kb * 1024),
				down: createRelayRingBuffer(relay_ring_kb * 1024),
				maxPendingBytes: relay_pending_max_bytes,
				maxPendingAgeMs: relay_pending_max_ms
			}
			: null;
		const worker = new Worker(fileURLToPath(import.meta.url), {
			// `app` is the retained primaryInit output, replayed identically on every
			// spawn and respawn so a compute worker's replacement rejoins the same
			// shared-memory world.
			// `ioWorkers` is a correctness input, not diagnostics: worker-local
			// features that promise one authoritative in-memory home (notably the
			// game lane) must reject a topology in which sockets can land on more
			// than one I/O worker. Passing the resolved count also handles `auto`
			// without asking a worker to guess from the original env spelling.
			workerData: {
				mode: cluster_mode,
				role,
				totalWorkers: num,
				ioWorkers: io_count,
				app: app_worker_data,
				relayRing: relay_ring,
				// Threaded rather than re-read from env in the worker: the
				// sender-side ceiling is derived from the primary's spill budget,
				// and every worker must apply the SAME one or a large publish is
				// refused by some siblings and relayed by others.
				relayMaxFrameBytes: relay_frame_max_bytes,
				divergenceDiagnosticKey
			}
		});
		// lastHeartbeat starts at 0  - worker is confirmed alive only after the
		// first 'descriptor' / 'ready' / 'heartbeat-ack' message arrives. spawnedAt
		// anchors the boot deadline before the first ack; ready flips the watchdog
		// from the boot regime to the steady-state regime at descriptor/ready.
		// threadId is captured HERE, at spawn, and never read off the Worker in the
		// exit handler. Node nulls the worker's handle before emitting 'exit', and
		// `worker.threadId` degrades to -1 from that point on - so any cleanup that
		// keys on the thread id silently addresses a worker that never existed.
		const meta = {
			threadId: worker.threadId,
			descriptor: null,
			lastHeartbeat: 0,
			spawnedAt: monotonicNow(),
			ready: false,
			role,
			slot,
			ringWriter: null,
			ringReader: null,
			relayQuarantined: false
		};
		if (relay_ring !== null) {
			const quarantineRelaySpill = createRelaySpillQuarantine({
				worker,
				meta,
				workers,
				requestWorkerExit
			});
			meta.ringWriter = new RingWriter(relay_ring.down, {
				maxPendingBytes: relay_pending_max_bytes,
				maxPendingAgeMs: relay_pending_max_ms,
				onOverflow: quarantineRelaySpill
			});
			// Forward each inbound frame VERBATIM to every other worker's ring -
			// the primary never parses relay traffic, it moves bytes. Ring
			// activity also proves the worker alive (the same reasoning as the
			// any-postMessage-advances-the-heartbeat rule: a worker saturating
			// the relay is busy, not dead).
			meta.ringReader = new RingReader(relay_ring.up, (frame) => {
				meta.lastHeartbeat = monotonicNow();
				for (const [w, m] of workers) {
					if (w !== worker && m.ringWriter !== null && relayEligible(m)) {
						const accepted = m.ringWriter.write(frame);
						if (accepted) {
							m.ringWriter.notify();
						}
					}
				}
			}, {
				// Generous headroom over the sender's ENVELOPE ceiling: a frame also
				// carries the topic, the event, the raw payload and the stream
				// stamps, so it is legitimately a multiple of the envelope it was
				// measured from. This bounds unbounded growth rather than fitting
				// tightly - a frame this far past it means a peer not applying the
				// ceiling, or a corrupt stream.
				maxFrameBytes: relay_frame_max_bytes > 0 ? relay_frame_max_bytes * 4 : Infinity,
				onOversized: (event) => {
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.cluster-relay',
						event: 'cluster-relay.frame-oversized',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'A worker sent a relay frame larger than this process will reassemble; its relay stream was stopped.',
						attributes: { declaredBytes: event.declaredBytes, maxFrameBytes: event.maxFrameBytes }
					});
					// The primary has no metrics registry; count the incident once
					// on a surviving sibling, never on the sender whose stream this
					// stop just cut off (its up spill is about to retire it).
					attributeRelayIncident(workers, worker, {
						type: 'relay-frame-oversized',
						declaredBytes: event.declaredBytes,
						maxFrameBytes: event.maxFrameBytes
					});
				}
			});
			meta.ringReader.start();
		}
		workers.set(worker, meta);
		const replayDivergenceDiagnostics = () => {
			// Ready means the handler graph has installed its diagnostic listener.
			// Replaying earlier would let the boot-time control backlog consume an
			// otherwise-unknown message before that listener exists.
			for (const diagnostic of completedDivergenceDiagnostics.values()) {
				worker.postMessage({ type: 'state-divergence-diagnostic', diagnostic });
			}
		};

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
				console.log(`[svelte-adapter-uws] Worker thread ${worker.threadId} registered`);
				// Worker started successfully - mark this slot ready and stamp its
				// uptime clock. The backoff/attempt budget resets on the NEXT exit,
				// and only after the worker has stayed up past the stable window.
				if (meta.slot) restartSupervisor.noteReady(meta.slot);
				replayDivergenceDiagnostics();
				// Start (or resume) listening once a worker is ready to handle requests
				if (!listening) {
					listening = true;
					const portNum = port;
					acceptorApp.listen(host, portNum, (socket) => {
						if (socket) {
							listen_socket = socket;
							console.log(`[svelte-adapter-uws] Acceptor listening on ${is_tls ? 'https' : 'http'}://${host}:${portNum}`);
							sdReadyOnce();
						} else {
							emitOperationalDiagnostic(listenFailureDiagnostic(host, portNum));
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
				if (msg.role === 'compute') console.log(`[svelte-adapter-uws] Compute worker ${worker.threadId} ready`);
				else {
					console.log(`[svelte-adapter-uws] Worker thread ${worker.threadId} listening on :${port}`);
					// First listening worker = the service accepts traffic.
					sdReadyOnce();
				}
				if (meta.slot) restartSupervisor.noteReady(meta.slot);
				replayDivergenceDiagnostics();
			} else if (msg.type === 'heartbeat-ack') {
				if (meta) meta.lastHeartbeat = monotonicNow();
			} else if (msg.type === 'publish') {
				// Single relay (legacy / non-batched path). Like every relay
				// forward below, a quarantined peer is skipped: these postMessage
				// lanes stay live as the encode-failure fallback while the rings
				// run, and without the check they kept feeding relay traffic to a
				// worker already being torn down.
				for (const [w, m] of workers) {
					if (w !== worker && relayEligible(m)) w.postMessage(msg);
				}
			} else if (msg.type === 'publish-batch') {
				// Batched relay: one postMessage per microtask from the publishing worker.
				// Forward each message individually so receiving workers use the same
				// single-message 'publish' path in their relayPublish handler. The
				// stamped seq rides along so the receiver can advance its
				// delivered-seq tracker without re-parsing the envelope, and the
				// sender's origin/ordinal/birth so it can also tell whether the
				// stream it is being handed has a hole in it.
				for (const { topic, envelope, compress, seq, capability, event, data, origin, ord, birth } of msg.messages) {
					const relay = { type: 'publish', topic, envelope, compress, seq, capability, event, data, origin, ord, birth };
					for (const [w, m] of workers) {
						if (w !== worker && relayEligible(m)) w.postMessage(relay);
					}
				}
			} else if (msg.type === 'publish-batched') {
				// Wire-level batched relay (platform.publishBatched). Forward
				// the whole event list as one IPC frame so receiving workers
				// can re-detect the fast path locally and dispatch a single
				// batch envelope, instead of degrading to N individual relays.
				for (const [w, m] of workers) {
					if (w !== worker && relayEligible(m)) w.postMessage(msg);
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
				// The QUIET lane first: a disagreement over topics nobody is
				// publishing is expected worker lifecycle (a respawn holds none of
				// its siblings' quiet history and can never re-learn it), so it is
				// a deduplicated log-only diagnostic and NEVER a restart trigger -
				// the shape that once made the repair switch a kill loop on an
				// idle cluster. Only counts and an epoch cross into the record.
				if (typeof msg.quietHash === 'number') {
					const quietDivergence = stateHashDetector.recordQuiet(msg.threadId, msg.quietHash, liveThreadIds, epochMs);
					if (quietDivergence) {
						emitOperationalEvent({
							source: 'svelte-adapter-uws',
							component: 'runtime.divergence',
							event: 'divergence.quiet-state',
							severity: 'warn',
							dataClass: 'operational',
							message: 'Workers disagree about quiet-topic history; this is expected after a worker restart and never triggers a restart.',
							attributes: {
								epoch: quietDivergence.epoch,
								workers: liveThreadIds.length,
								minorityWorkers: quietDivergence.minorityThreadIds.length
							}
						});
					}
				}
				const divergence = stateHashDetector.record(msg.threadId, msg.hash, liveThreadIds, epochMs);
				if (divergence) {
					const minoritySet = new Set(divergence.minorityThreadIds);
					const diagnosticId = beginDivergenceCollection(divergence, liveThreadIds);
					// The production signal references ONLY an opaque diagnostic id.
					// Per-thread hashes, roles, and keyed sequence summaries are retained
					// behind the authenticated admin lookup, not copied into logs.
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.divergence',
						event: 'divergence.detected',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'Cross-worker state divergence was detected; evidence is retained behind the authenticated diagnostic lookup.',
						attributes: { diagnosticId }
					});
					// Notice each live worker so it increments its own registry
					// counter with its role (the primary holds no registry over the
					// thread boundary). Epoch-deduped at the detector, so one
					// increment per role per divergent epoch.
					for (const [w, workerMeta] of workers) {
						if (!liveThreadIds.includes(workerMeta.threadId)) continue;
						const role = minoritySet.has(workerMeta.threadId) ? 'minority' : 'majority';
						w.postMessage({
							type: 'state-divergence',
							epoch: divergence.epoch,
							role,
							diagnosticId,
							topicLimit: DIVERGENCE_TOPIC_LIMIT
						});
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
			} else if (msg.type === 'state-divergence-detail') {
				if (meta) meta.lastHeartbeat = monotonicNow();
				const entry = divergenceCollections.get(msg.diagnosticId);
				const reporter = meta?.threadId;
				if (entry && Number.isInteger(reporter) && entry.expectedThreadIds.includes(reporter)) {
					entry.reports.set(reporter, {
						threadId: reporter,
						summary: msg.summary
					});
					if (entry.reports.size === entry.expectedThreadIds.length) {
						finishDivergenceCollection(msg.diagnosticId);
					}
				}
			} else if (msg.type === 'metrics-request') {
				// A worker's scrape route wants the cluster-wide picture. Ask every
				// worker that has confirmed ready - an unbooted one has no registry
				// to report and would only burn the deadline - then hand the replies
				// back to the requester to merge.
				// Join a collection already in flight rather than starting a second.
				if (metricsCollections.join(worker, msg.id)) {
					// Nothing else to do: the open collection answers this id too.
				} else {
					// Every worker the cluster is CONFIGURED to run, not just those
					// currently ready. A worker that is down or restarting is exactly
					// the case an operator needs to see, and counting only the live
					// roster would report a shrunken cluster as complete.
					const targets = [];
					for (const [w, m] of workers) if (m.ready) targets.push({ worker: w, threadId: m.threadId });
					if (targets.length === 0) {
						// No worker is ready - a restart storm, which is exactly when
						// the carried counter totals matter most. Omitting them here
						// would make every counter family vanish from the document and
						// reappear later at its carried value, which Prometheus reads
						// as a new series rather than a continuing one.
						const only = metricsCollections.retiredReport();
						try {
							worker.postMessage({
								type: 'metrics-result', id: msg.id,
								reports: only === null ? [] : [only], expected: num, reporting: 0
							});
						} catch { /* requester already gone */ }
					} else {
						const entry = metricsCollections.begin(worker, msg.id, targets.map((t) => t.threadId));
						entry.expected = num;
						// The primary's own deadline is shorter than the requester's, so
						// the requester's timer is a backstop rather than the normal path
						// and a partial answer still reports which workers were missing.
						const budget = Math.max(25, Math.floor((typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 2000) * 0.8));
						entry.timer = setTimer(finishMetricsCollection, budget);
						if (typeof entry.timer?.unref === 'function') entry.timer.unref();
						let done = false;
						for (const t of targets) {
							try {
								t.worker.postMessage({ type: 'metrics-collect', id: msg.id });
							} catch {
								// Worker died between the ready check and the send. Counted off
								// by thread id so it cannot be double-counted, and its last
								// known counter totals still reach the document.
								done = metricsCollections.missed(t.threadId);
							}
						}
						if (done) finishMetricsCollection();
					}
				}
			} else if (msg.type === 'metrics-report') {
				if (metricsCollections.note(msg.id, msg.threadId, msg.samples)) finishMetricsCollection();
			} else if (msg.type === 'relay-gap') {
				// A worker found a hole in a relay stream that is dense by
				// construction, so it lost frames its siblings received - it has
				// already logged which ones and counted them on its own registry.
				// Nothing is compared here: unlike a divergent hash, the reporter
				// names ITSELF, so there is no majority to weigh and no way to act on
				// the wrong worker. Only a thread id and a frame count crossed the
				// boundary.
				if (meta) meta.lastHeartbeat = monotonicNow();
				console.error('[primary] relay-gap worker=%d frames=%d', msg.threadId, msg.count);
				// Same action gate as a divergence, for the same reason: the worker is
				// missing state its siblings have, and a restart is what re-syncs it.
				// Off by default - logged and counted, never auto-killed.
				if (restart_on_state_divergence) {
					console.error('[primary] asking worker %d to exit to re-sync after a relay gap (RESTART_ON_STATE_DIVERGENCE=1)', msg.threadId);
					requestWorkerExit(worker, 1);
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
			// The id stamped at spawn, NOT worker.threadId: Node nulls the handle
			// before emitting 'exit', so reading it here yields -1 and every
			// cleanup below would address a worker that never existed.
			const deadThreadId = meta?.threadId ?? -1;
			// Drop this worker's pending presence from any open state-hash bucket
			// so its absence never stalls a comparison and a stale report cannot
			// be judged a phantom divergence.
			stateHashDetector.forget(deadThreadId);
			// Carry this worker's final COUNTER totals forward. Its replacement
			// starts from zero, and without the carry the cluster sum would drop
			// by whatever it had accumulated - which Prometheus reads as a counter
			// reset, spiking every rate() on every routine worker restart.
			metricsCollections.retire(deadThreadId);
			// A dead worker will never answer an open collection. Counting it off
			// here - keyed, so a worker that already answered is not counted twice -
			// lets the collection finish now instead of waiting out its full
			// deadline, which every scrape overlapping a restart would otherwise pay.
			if (metricsCollections.missed(deadThreadId)) finishMetricsCollection();
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
						console.log('[svelte-adapter-uws] All workers down, acceptor paused until a replacement is ready');
					}
				}
				// Charge the attempt against THIS slot only and schedule ITS own
				// respawn after ITS own backoff. onExhausted (hard-exit) fires from
				// inside the supervisor when the slot passes its attempt cap.
				const slot = meta?.slot ?? { role, index: 0 };
				const outcome = restartSupervisor.noteExit(slot);
				if (outcome && !('exhausted' in outcome)) {
					console.log(
						`[svelte-adapter-uws] Worker thread ${deadThreadId} (${slot.role}#${slot.index}) exited with code ${code}, ` +
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
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.cluster',
				event: 'cluster.worker-error',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'A worker thread reported an error.',
				attributes: { error: diagnosticError(err) }
			});
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
	// app's SNI context in place (each worker validates + fingerprint-gates its
	// own apply; a bad cert keeps the previous one). The primary itself
	// terminates no TLS in either cluster mode - reuseport workers own their
	// listen sockets, and the acceptor only distributes accepted connections to
	// the child worker apps, whose contexts run the handshakes - so the primary
	// registers no server names; it only tracks the disk cert's identity for
	// observability. The listen socket is never re-bound and live connections
	// survive. Non-SNI / unmatched clients keep the boot cert until a restart
	// (the SSLApp default context is not swappable) - the documented caveat
	// covering the SNI-sending majority.
	let primaryCertWatcher = null;
	let primaryTlsState = { hosts: [], fingerprint: null, notAfter: null, notAfterText: null };

	// Reload-path health, mirroring the per-worker record (handler/lifecycle.js).
	// The primary is the only thing watching the cert directory in cluster mode,
	// so a primary whose watcher never started broadcasts nothing and NO worker
	// ever picks up a renewal - while every probe in the fleet stays green until
	// the served leaf expires and every handshake fails at once. Hourly sentinel,
	// armed only while degraded, silent until the leaf is inside the alert window.
	const TLS_DEGRADED_CHECK_MS = 3600000;
	const primaryTlsHealth = { degraded: null, notAfter: null, notAfterText: null };
	let primaryTlsSentinel = null;
	/** @param {string} reason */
	function primaryTlsDegraded(reason) {
		primaryTlsHealth.degraded = reason;
		const alert = certExpiryAlert(primaryTlsHealth, wallEpoch());
		if (alert !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, alert));
		if (primaryTlsSentinel !== null) return;
		primaryTlsSentinel = setIntervalTimer(() => {
			const line = certExpiryAlert(primaryTlsHealth, wallEpoch());
			if (line !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, line));
		}, TLS_DEGRADED_CHECK_MS);
		if (primaryTlsSentinel && primaryTlsSentinel.unref) primaryTlsSentinel.unref();
	}
	function primaryTlsRecovered() {
		if (primaryTlsHealth.degraded !== null) {
			console.log(`[tls] primary certificate read recovered (was: ${primaryTlsHealth.degraded})`);
			primaryTlsHealth.degraded = null;
		}
		if (primaryTlsSentinel !== null) {
			clearIntervalTimer(primaryTlsSentinel);
			primaryTlsSentinel = null;
		}
	}
	function onCertChange() {
		let failure = null;
		primaryTlsState = reloadClusterTls({
			workers: workers.keys(),
			source: { certPath: ssl_cert, hosts: ssl_sni_hosts },
			state: primaryTlsState,
			onError: (err) => { failure = err && err.message ? err.message : String(err); }
		});
		primaryTlsHealth.notAfter = primaryTlsState.notAfter ?? null;
		primaryTlsHealth.notAfterText = primaryTlsState.notAfterText ?? null;
		if (failure !== null) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_RELOAD_READ), failure);
			primaryTlsDegraded('the renewed certificate is unreadable on the primary');
		} else {
			primaryTlsRecovered();
		}
	}
	if (is_tls && ssl_watch) {
		// Record the boot cert's identity so the reload broadcast has a baseline to
		// report against, and its expiry so a later failure can be reported with the
		// number that says how urgent it is. A parse failure only degrades
		// primary-side observability - the workers gate on their own reads.
		try {
			primaryTlsState = readCertIdentity(ssl_cert, ssl_sni_hosts);
			primaryTlsHealth.notAfter = primaryTlsState.notAfter;
			primaryTlsHealth.notAfterText = primaryTlsState.notAfterText;
		} catch (err) {
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_BOOT_READ), err && err.message ? err.message : err);
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
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_PRIMARY_WATCH), err && err.message ? err.message : err);
			// Nothing retries this: with no watcher on the primary, no worker is ever
			// told to reload, so the whole cluster serves its current certificate
			// until it expires.
			primaryTlsDegraded('the primary certificate directory watch failed to start, so no worker will be told to reload');
		}
	}

	/** @param {'SIGINT' | 'SIGTERM'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		sdNotify.stopping();
		sdNotify.disarmWatchdog();
		console.log(`[svelte-adapter-uws] Primary received ${reason}, shutting down ${workers.size} workers...`);

		// Cancel all pending worker restarts so we don't spawn during shutdown.
		// (The supervisor also re-checks shutting_down when a timer fires, so a
		// respawn already in flight is a no-op even if it races this.)
		restartSupervisor.stopAll();

		// Stop the cert-directory watcher so it never holds the loop or fires a
		// broadcast at exiting workers.
		if (primaryCertWatcher) { primaryCertWatcher.stop(); primaryCertWatcher = null; }

		// Step 1: readiness OFF on every worker, BEFORE the delay below. The
		// workers own the readiness route, so this is what makes the delay do its
		// job: a load balancer polls readiness, and it can only deregister this
		// instance during the propagation window if the answer flips at the START
		// of that window. Draining is not closing - every worker keeps its listen
		// socket open and keeps serving, so the requests the balancer has not
		// stopped sending yet are still answered.
		for (const [worker] of workers) {
			try { worker.postMessage({ type: 'drain' }); } catch { /* worker already exiting */ }
		}
		console.log(`[primary] Readiness now reports NOT ready on ${workers.size} worker(s); still accepting.`);

		// Step 2: Keep accepting connections until the load balancer has
		// had time to remove this pod from rotation (Kubernetes rolling updates).
		// SHUTDOWN_DELAY_MS=0 (default) skips this and is correct for non-k8s deploys.
		if (shutdown_delay > 0) {
			console.log(`[primary] Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimer(resolve, shutdown_delay));
		}

		// Step 3: Stop accepting new connections (acceptor mode only)
		if (cluster_mode === 'acceptor' && listen_socket) {
			uWS.us_listen_socket_close(listen_socket);
			listen_socket = null;
		}

		// Tell workers to drain and exit (workers handle their own drain timeout)
		for (const [worker] of workers) {
			worker.postMessage({ type: 'shutdown' });
		}

		// Force-exit after the budget: ask any still-running worker to close its App
		// and exit itself (worker.terminate() would abort the process; a bare
		// primary process.exit(0) with live uWS workers would too). Each request
		// carries its own SIGKILL fallback for a genuinely wedged worker; the last
		// worker's exit handler (workers.size === 0) performs the clean primary
		// process.exit(0).
		//
		// SHUTDOWN_TIMEOUT=0 is the no-budget spelling, so there is no force-exit
		// to arm: each worker awaits its own hook, drain and cleanup listeners for
		// as long as they take, and cutting them off from here would be the same
		// deadline by another name.
		if (shutdown_timeout > 0) {
			setTimer(() => {
				for (const [worker] of workers) requestWorkerExit(worker, 0);
			}, shutdown_timeout * 1000).unref();
		} else {
			console.log('[primary] SHUTDOWN_TIMEOUT=0: no shutdown budget - workers exit when their own teardown finishes, however long that takes.');
		}
	}

	process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
	process.on('SIGINT', () => graceful_shutdown('SIGINT'));
} else {
	// ── Worker thread or single-process mode ─────────────────────────────

	const { start, shutdown, drain, getDescriptor, relayPublish, relayPublishBatched, forceCloseApp, reloadTls, setRelayRingWriter, setRelayFrameCeiling, markRelayAttached, collectLocalMetrics, resolveMetricsSnapshot, noteRelayFrameRefused } = await import('HANDLER');
	// The readiness/drain state machine lives in the lifecycle module, imported
	// here directly (the same instance the handler graph above loaded) because
	// entering the draining state and closing the sockets are two separate acts
	// at two separate moments - see the drain-before-delay ordering below.
	const { beginDrain } = await import('./handler/lifecycle.js');

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

	// Node stores a timer delay in a signed 32-bit int and silently rearms
	// anything larger to 1ms, so this is the longest "never" a timer can express.
	const MAX_TIMER_MS = 2147483647;

	/**
	 * Resolve when `signal` aborts, never otherwise. Every phase of the shutdown
	 * below bounds itself against the SAME signal, which is what makes
	 * SHUTDOWN_TIMEOUT a budget for the whole sequence instead of one timer that
	 * a step running before it can walk past. A null signal is the no-budget
	 * configuration: nothing ever aborts, so every phase is simply awaited.
	 * @param {AbortSignal | null} signal
	 * @returns {Promise<void>}
	 */
	function whenAborted(signal) {
		if (!signal) return new Promise(() => {});
		if (signal.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			signal.addEventListener('abort', () => resolve(), { once: true });
		});
	}

	/**
	 * Fire the process-level `sveltekit:shutdown` event and AWAIT what its
	 * listeners return.
	 *
	 * EventEmitter throws away a listener's return value, so an `async` listener -
	 * the documented shape for closing a database pool - never resumed past its
	 * first `await`: the process exited underneath it and the final writes were
	 * lost with nothing logged. The listeners are therefore invoked directly (what
	 * `emit` does, minus the discarded value) and anything thenable they return is
	 * awaited under the shared budget. A listener that throws, rejects or never
	 * settles is reported and cannot hold the exit.
	 *
	 * @param {string} reason
	 * @param {AbortSignal | null} signal null when no budget is configured
	 * @param {number | null} deadline wall-clock epoch ms the budget expires at,
	 *   null when no budget is configured
	 * @param {string} prefix
	 * @returns {Promise<boolean>} false when the budget expired first
	 */
	async function runShutdownCleanup(reason, signal, deadline, prefix) {
		const listeners = process.listeners('sveltekit:shutdown');
		if (listeners.length === 0) return true;
		/** @type {Promise<void>[]} */
		const pending = [];
		for (const listener of listeners) {
			try {
				const result = listener.call(process, reason, { reason, signal, deadline });
				if (result && typeof result.then === 'function') {
					pending.push(Promise.resolve(result).catch((err) => {
						// The worker tag trails the invariant text so the line stays
						// findable by its documented prefix on every thread.
						console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_LISTENER_REJECTED,
							prefix ? ' ' + prefix.trim() : ''), err);
					}));
				}
			} catch (err) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_LISTENER_THREW,
					prefix ? ' ' + prefix.trim() : ''), err);
			}
		}
		if (pending.length === 0) return true;
		return await Promise.race([
			Promise.all(pending).then(() => true),
			whenAborted(signal).then(() => false)
		]);
	}

	/** @param {'SIGINT' | 'SIGTERM' | 'shutdown'} reason */
	async function graceful_shutdown(reason) {
		if (shutting_down) return;
		shutting_down = true;
		if (isMainThread) {
			sdNotify.stopping();
			sdNotify.disarmWatchdog();
		}
		const prefix = isMainThread ? '' : `[worker ${threadId}] `;
		console.log(`[svelte-adapter-uws] ${prefix}Received ${reason}, shutting down gracefully...`);

		// Step 1: readiness OFF, BEFORE the delay below. The delay exists so a load
		// balancer can deregister this instance before its sockets close, and the
		// balancer polls readiness to decide - so flipping readiness together with
		// the socket close (which is what a single shutdown step does) means new
		// requests keep being routed here for the whole propagation window and then
		// meet a closed socket. Draining is not closing: the listen socket stays
		// open and in-flight and newly arriving requests are still served.
		if (beginDrain()) console.log(`[svelte-adapter-uws] ${prefix}Readiness now reports NOT ready (draining); still accepting.`);

		// Step 2: Load balancer drain delay (only for OS signals, not when the
		// primary tells us to shutdown  - the primary already waited its own delay).
		if (shutdown_delay > 0 && (reason === 'SIGTERM' || reason === 'SIGINT')) {
			console.log(`[svelte-adapter-uws] ${prefix}Waiting ${shutdown_delay}ms for load balancer drain...`);
			await new Promise((resolve) => setTimer(resolve, shutdown_delay));
		}

		// ONE budget for everything that follows. Application code runs in two of
		// the three phases below, and an app hook that never settles used to hold
		// the process indefinitely: the timeout only ever bounded the drain, which
		// is the one phase the adapter controls. Now every phase races the same
		// AbortSignal, so SHUTDOWN_TIMEOUT is what it claims to be - a bound on the
		// whole sequence - and the phase that ran out of it is named in the log.
		// The delay above is deliberately outside the budget: it is a wait the
		// operator asked for, not work that can overrun.
		//
		// SHUTDOWN_TIMEOUT=0 means NO budget: nothing aborts, and every phase is
		// awaited to completion the way an unbounded await always did. It is the
		// only way to say "never cut my cleanup off", so it has to exist - and it
		// must not be spelled by accident, which is why the line below says so.
		//
		// The timer is deliberately NOT unref'd, and is cleared the moment the
		// sequence finishes. It is what keeps the process alive across the awaited
		// teardown: a pending promise does not hold Node's event loop open, so an
		// unref'd budget would let the process exit out from under an app's cleanup
		// the instant the loop went idle - abandoning exactly the work these phases
		// exist to wait for, and doing it silently. With no budget the timer still
		// exists for exactly that reason, and only for it: it is armed as far out
		// as Node will take (a longer delay silently becomes 1ms), so it never
		// fires - it only holds the loop open while the awaits run.
		const budget_ms = shutdown_timeout * 1000;
		const bounded = budget_ms > 0;
		const expiry = new AbortController();
		const budget_timer = bounded
			? setTimer(() => expiry.abort(), budget_ms)
			: setTimer(() => {}, MAX_TIMER_MS);
		// Wall-clock, so an app hook can compare it against its own Date.now();
		// null with no budget, which is how a hook reads "nothing will cut me off"
		// rather than having to guess from a far-future number.
		const deadline = bounded ? wallEpoch() + budget_ms : null;
		// Handed to app code and raced by the phases below only when it can
		// actually fire. With no budget every phase simply awaits.
		const signal = bounded ? expiry.signal : null;
		if (!bounded) {
			console.log(
				`[svelte-adapter-uws] ${prefix}SHUTDOWN_TIMEOUT=0: no shutdown budget - the shutdown hook, the in-flight drain and the ` +
				'cleanup listeners are awaited for as long as they take, so a wedged one holds this process until it is killed.'
			);
		}
		const t_close = monotonicNow();

		// Steps 3 to 5 run under try/catch/finally. The budget timer is REF'D and
		// this path is invoked unawaited from the signal handler, so a throw that
		// escaped would both skip the clear and surface as an unhandled rejection:
		// the process would either die on that rejection with the clean teardown
		// never reached, or - if the app installs an unhandledRejection handler, as
		// plenty do - keep running on the ref'd timer with no exit path left at all.
		// Neither of those is an exit, which is what this function owes its caller.
		let drained = false;
		let cleaned = false;
		try {
			// Step 3: the hooks.ws `shutdown` hook flushes app state (last metrics,
			// cron drain, external bridge teardown), then the listen socket closes and
			// WebSocket clients get their 1001. The hook is bounded inside shutdown()
			// by the signal below, so a wedged hook no longer keeps the socket open.
			await shutdown({ reason, signal, deadline });

			// Step 4: in-flight requests finish.
			drained = await Promise.race([drain().then(() => true), whenAborted(signal).then(() => false)]);
			if (!drained) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_REQUESTS_DROPPED,
					`${budget_ms}ms)${prefix ? ' ' + prefix.trim() : ''}; closing anyway - the requests still open at this point are dropped.`));
			}

			// Step 5: process-level cleanup, after the drain so a listener closing a
			// pool or writing a final record sees no request still using it.
			cleaned = await runShutdownCleanup(reason, signal, deadline, prefix);
			if (!cleaned) {
				console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_LISTENERS_UNSETTLED,
					`${budget_ms}ms)${prefix ? ' ' + prefix.trim() : ''}; exiting anyway - their cleanup did NOT finish.`));
			}
		} catch (err) {
			// Nothing above is allowed to refuse the shutdown, and this path is
			// invoked unawaited from the signal handler - an escaping rejection would
			// surface as an unhandled rejection instead of an exit.
			console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.SHUTDOWN_FAILED,
				prefix ? ' ' + prefix.trim() : ''), err);
		} finally {
			clearTimer(budget_timer);
			const spent = (monotonicNow() - t_close).toFixed(0);
			if (drained && cleaned) console.log(`[svelte-adapter-uws] ${prefix}Shutdown complete in ${spent}ms.`);
			else console.error(`[svelte-adapter-uws] ${prefix}Shutdown finished in ${spent}ms but was NOT clean (see the lines above).`);
			exitWorkerClean(0);
		}
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

		/**
		 * Leave the ready rotation. Safe from the FIRST tick of this worker: it
		 * touches only the lifecycle state, which the handler graph imported above
		 * has already built, and never a route, a socket or the relay.
		 */
		function applyDrain() {
			if (beginDrain()) console.log(`[worker ${threadId}] Readiness now reports NOT ready (draining); still accepting.`);
		}

		// Control messages that need the handler graph. `drain` is deliberately NOT
		// one of them - it is handled ahead of this gate, see the message router.
		function dispatchControl(msg) {
			if (msg.type === 'shutdown') {
				graceful_shutdown('shutdown');
			} else if (msg.type === 'publish') {
				relayPublish(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data, msg.origin, msg.ord, msg.birth);
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
			if (msg.type === 'drain') {
				// Applied NOW, never buffered, even mid-boot. Buffering it would replay
				// it after `start()` has already committed this worker to `ready` and
				// logged that it is taking traffic - for an instance the primary put
				// into shutdown before it finished booting. Leaving the rotation is
				// exactly the kind of decision that must not wait for the boot it is
				// overtaking, and applying it here is what makes `start()`'s
				// commit-only-from-starting guard real on the cluster path: a worker
				// drained mid-boot never announces itself ready at all.
				applyDrain();
				return;
			}
			if (msg.type === 'metrics-collect') {
				// Answered NOW, never buffered. The mirror is a module-level
				// binding that exists before the handler graph does, so even a
				// still-booting worker can report (with nothing, which is the
				// truth); buffering would instead reply after the collection it
				// belongs to has already timed out. Reading the mirror touches no
				// app code and no registry, so this cannot run an app callback on
				// a worker that is still inside `init`.
				try {
					parentPort.postMessage({ type: 'metrics-report', id: msg.id, threadId, samples: collectLocalMetrics() });
				} catch { /* primary gone; its own deadline answers the requester */ }
				return;
			}
			if (msg.type === 'metrics-result') {
				resolveMetricsSnapshot(msg.id, msg.reports, msg.expected, msg.reporting);
				return;
			}
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
		// The sender-side frame ceiling is applied whether or not the rings are
		// enabled: `CLUSTER_RELAY_RING_KB=0` is a documented configuration and its
		// postMessage fan-out is no more able to absorb an arbitrarily large frame
		// than the ring is. Set BEFORE the ring block for that reason.
		if (typeof workerData?.relayMaxFrameBytes === 'number' && workerData.relayMaxFrameBytes > 0) {
			setRelayFrameCeiling(workerData.relayMaxFrameBytes, (lane, topic, bytes, limit) => {
				emitOperationalEvent({
					source: 'svelte-adapter-uws',
					component: 'runtime.cluster-relay',
					event: 'cluster-relay.frame-refused',
					severity: 'warn',
					dataClass: 'pseudonymous',
					message: 'A publish was too large for the cluster relay and was not sent to other workers. Local subscribers received it.',
					attributes: {
						lane,
						topic: privateValueMetadata(topic, 'topic'),
						bytes,
						limitBytes: limit
					}
				});
				// The refusal happened on THIS worker, so its own registry takes
				// the count directly - no cross-thread attribution needed.
				noteRelayFrameRefused(lane);
			});
		}
		if (workerData?.relayRing) {
			// The up writer carries the SAME ceilings as the primary's down
			// writers. Without them a stalled PRIMARY let every publishing worker
			// spill without bound in its own heap - the mirror image of the defect
			// the down-direction ceilings were added for, and the direction nobody
			// had bounded. The action differs: a worker cannot quarantine the
			// primary, so it reports and exits through the supervised path that
			// already replaces it.
			setRelayRingWriter(new RingWriter(workerData.relayRing.up, {
				maxPendingBytes: workerData.relayRing.maxPendingBytes,
				maxPendingAgeMs: workerData.relayRing.maxPendingAgeMs,
				onOverflow: (event) => {
					emitOperationalEvent({
						source: 'svelte-adapter-uws',
						component: 'runtime.cluster-relay',
						event: 'cluster-relay.up-spill-overflow',
						severity: 'error',
						dataClass: 'pseudonymous',
						message: 'This worker could not hand its relay backlog to the primary within its spill ceiling and is exiting to be replaced.',
						attributes: { reason: event.reason, droppedBytes: event.droppedBytes, pendingAgeMs: event.pendingAgeMs }
					});
					process.exit(1);
				}
			}));
			const relayReader = new RingReader(workerData.relayRing.down, (frame) => {
				const msg = decodeRelayFrame(frame);
				if (msg === null) return;
				if (msg.type === 'publish') {
					relayPublish(msg.topic, msg.envelope, msg.compress, msg.seq, msg.capability, msg.event, msg.data, msg.origin, msg.ord, msg.birth);
				} else if (msg.type === 'publish-batched') {
					relayPublishBatched(msg.events, msg.compress);
				}
			});
			relayReader.start();
		}

		// Both relay lanes are now live, so from here on a sibling's publish is owed
		// to this worker and a stream it never sees the start of is a lost frame
		// rather than a stream that predates it. Latched LAST on purpose: every
		// frame already taken from the boot backlog or sitting in the ring is thereby
		// treated as a stream we joined mid-flight, which at worst under-reports.
		// Over-reporting is the failure that matters - it would restart a healthy
		// worker - so every ambiguity here resolves toward silence.
		markRelayAttached();
	}

	if (isMainThread) {
		process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
		process.on('SIGINT', () => graceful_shutdown('SIGINT'));
	}
}

export { host, port };
