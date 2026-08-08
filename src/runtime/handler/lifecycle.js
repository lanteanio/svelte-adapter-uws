// Substituted by the adapter's build step; a free identifier until then.
/* global WS_ENABLED */
import uWS from 'uWebSockets.js';
import { workerData } from 'node:worker_threads';
import { wsModule } from '../ws-handler-bridge.js';
import { WS_CAPS, WS_SUBSCRIPTIONS, assert, fatal, wrapBatchEnvelope } from '../utils.js';
import { monotonicNow, processMonotonicNow, wallEpoch, setTimer, setIntervalTimer, clearTimer, clearIntervalTimer } from '../runtime.js';
import { captureResumeFrame, counters, maxSeenSeq, originStreams, recordOriginStream, recordSeen, relayAttach, resumeBuffers, streamTracking, wsConnections } from './state.js';
import { app, is_tls, _t_app, WS_COMPRESSION_ON, reconnect_dispersal_ms, ssl_cert, ssl_key, ssl_watch, ssl_reload_debounce_ms, ssl_sni_hosts, boot_cert_fingerprint } from './config.js';
import { platform, relayPublishWire } from './platform.js';
import { stopPressureSampling } from './pressure-metrics.js';
import { applyServerNames, certExpiryAlert, createCertWatcher, readCertIdentity } from '../utils/tls-reload.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';
import { mirrorRoutes } from './route-registry.js';
import { parentPort } from 'node:worker_threads';
import { dirname } from 'node:path';
import { emitOperationalDiagnostic, listenFailureDiagnostic } from '../utils/operational-diagnostic.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

/** @type {Array<() => void>} */
let drainResolvers = [];

export function requestDone() {
	counters.inFlightCount--;
	if (counters.inFlightCount === 0 && drainResolvers.length > 0) {
		for (const resolve of drainResolvers) resolve();
		drainResolvers = [];
	}
}

// --- TLS certificate hot-reload (on by default; SSL_WATCH=0 opts out) ---
// Cert-identity state for this app ({ hosts, fingerprint }) and the directory
// watcher. The SNI overlay is LAZY: boot registers NOTHING - the boot cert is
// served by the SSLApp default context alone, byte-identical to SSL_WATCH=0 -
// and only a genuine cert change (fingerprint gate) activates the overlay.
// That laziness is load-bearing: a uWS server name carries its OWN empty HTTP
// router which force-closes every request it cannot route, so a server name may
// only ever exist together with a full route mirror (mirrorRoutes below), and
// registering none at boot means the hot-reload default cannot regress plain
// serving. In SINGLE-PROCESS mode this module both watches the cert directory
// and reloads. In CLUSTER mode the cert-directory watch lives on the primary
// (index.js); reloadTls() on a worker is driven by the primary's
// {type:'tls-reload'} broadcast. Either way a renewed cert is served without
// re-binding the listen socket.
/** @type {{ hosts: string[], fingerprint: string | null } | null} */
let tlsState = null;
let certWatcher = null;
let tlsRetryTimer = null;

// Health of the RELOAD PATH itself, which is a different question from which
// certificate is being served. Keeping the previous certificate when a reload
// fails is the right availability call and also the quiet one: renewal is dead
// while every probe stays green, and the first visible symptom is every
// handshake failing at once when the served leaf expires. So a failure is
// recorded here, and while the path stays degraded the sentinel below
// re-reports it as that leaf's expiry approaches. Identity, timestamps and
// counts only - no key material, no certificate bytes.
const tlsHealth = {
	/** This process watches the cert directory itself (single-process only). */
	watching: false,
	/** null while renewals would be picked up, else WHY they would not be. */
	degraded: null,
	/** Successful in-place swaps on this worker, so a fleet can be compared. */
	generation: 0,
	failures: 0,
	/** Wall-clock epoch ms, so an operator can read them against a cert's dates. */
	lastReloadAt: null,
	lastFailureAt: null,
	lastFailure: null,
	/** Expiry of the certificate currently being served. */
	notAfter: null,
	notAfterText: null
};

// How often the degraded sentinel re-checks the served leaf. Hourly: the alert
// window is days wide and a broken renewal is fixed by a human, not by a retry,
// so a tighter cadence would only add log noise.
const TLS_DEGRADED_CHECK_MS = 3600000;
let tlsExpirySentinel = null;

/**
 * Snapshot of this worker's certificate-reload path, for diagnostics: whether
 * the watcher is live, whether renewals are being picked up at all, how many
 * swaps this worker has done (a fleet-wide generation skew means one worker
 * missed a renewal), and when the certificate it is serving expires.
 * @returns {{ watching: boolean, degraded: string | null, generation: number, failures: number, lastReloadAt: number | null, lastFailureAt: number | null, lastFailure: string | null, notAfter: number | null, notAfterText: string | null }}
 */
export function tlsReloadState() {
	return { ...tlsHealth };
}

/**
 * Refresh the served leaf's expiry from the certificate on disk. One extra read
 * of a file the process already opens, taken only at arm time and after a
 * genuine swap - nothing else in the reload path carries the expiry, and the
 * expiry is what makes a broken renewal path reportable at all.
 */
function recordServedCertExpiry() {
	try {
		const identity = readCertIdentity(ssl_cert, ssl_sni_hosts);
		tlsHealth.notAfter = identity.notAfter;
		tlsHealth.notAfterText = identity.notAfterText;
	} catch {
		// Unreadable right after a successful swap is a race with the next write:
		// keep the previous value rather than blanking the only expiry we have.
	}
}

/**
 * Mark the reload path as unable to pick up a renewal, and arm the sentinel that
 * re-reports it as the served certificate's expiry approaches. The immediate
 * failure line is the caller's; this adds what the caller cannot know - how long
 * the certificate it kept serving is still valid for.
 * @param {string} reason
 */
function tlsDegraded(reason) {
	tlsHealth.degraded = reason;
	const alert = certExpiryAlert(tlsHealth, wallEpoch());
	if (alert !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, alert));
	if (tlsExpirySentinel !== null) return;
	tlsExpirySentinel = setIntervalTimer(() => {
		const line = certExpiryAlert(tlsHealth, wallEpoch());
		if (line !== null) console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.TLS_DEGRADED_EXPIRY, line));
	}, TLS_DEGRADED_CHECK_MS);
	if (tlsExpirySentinel && tlsExpirySentinel.unref) tlsExpirySentinel.unref();
}

/** Clear the degraded mark once a reload has succeeded again, and disarm the sentinel. */
function tlsRecovered() {
	if (tlsHealth.degraded !== null) {
		console.log(`[tls] certificate reload recovered (was: ${tlsHealth.degraded})`);
		tlsHealth.degraded = null;
	}
	if (tlsExpirySentinel !== null) {
		clearIntervalTimer(tlsExpirySentinel);
		tlsExpirySentinel = null;
	}
}

/**
 * Re-read the certificate on disk and - when it genuinely changed - swap the
 * SNI server name(s) in place so the renewed cert is served without re-binding
 * the listen socket, then replay the app's routes onto each host's fresh SNI
 * domain router (a swap replaces the router with an empty one that would
 * force-close every request). Fingerprint-gated: an unchanged cert (watcher
 * double-fire, unconditional cluster broadcast) is a no-op. Validates the cert
 * + key BEFORE touching the app, so a partial write keeps the previous
 * certificate (TLS never drops). No-op on a non-TLS server and when boot
 * disabled hot-reload (unreadable boot cert). Exported so the cluster
 * primary-broadcast handler (index.js) can drive a reload on this worker.
 */
export function reloadTls() {
	if (!is_tls || !ssl_watch || tlsState === null) return;
	let swappedHosts = null;
	try {
		const result = applyServerNames(app, { certPath: ssl_cert, keyPath: ssl_key, hosts: ssl_sni_hosts }, tlsState);
		if (!result.changed) return;
		swappedHosts = result.hosts;
		// The swap just replaced each host's SNI domain router with a fresh empty
		// one; mirror the app's full route set onto them before any handshake
		// resolves to a routeless router. Synchronous, so no request interleaves.
		mirrorRoutes(app, result.hosts);
		tlsState = { hosts: result.hosts, fingerprint: result.fingerprint };
		tlsHealth.generation++;
		tlsHealth.lastReloadAt = wallEpoch();
		recordServedCertExpiry();
		console.log(
			`[tls] renewed certificate now served (SNI: ${result.hosts.join(', ')}; expires ${tlsHealth.notAfterText ?? 'unknown'}; ` +
			`generation ${tlsHealth.generation})`
		);
		tlsRecovered();
	} catch (err) {
		const msg = err && err.message ? err.message : err;
		tlsHealth.failures++;
		tlsHealth.lastFailureAt = wallEpoch();
		tlsHealth.lastFailure = String(msg);
		if (swappedHosts !== null || (err && err.tlsAppTouched)) {
			// The app was already mutated (partial server-name swap, or a swap whose
			// route mirror failed) - SNI-matched clients may be unroutable on some
			// hosts. "Kept the previous cert" would be a lie here. Clear the
			// fingerprint so the next watcher/broadcast event bypasses the gate and
			// re-runs the full swap + mirror instead of no-opping until the next
			// genuine renewal months away.
			tlsState = { hosts: swappedHosts !== null ? swappedHosts : tlsState.hosts, fingerprint: null };
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.tls',
				event: 'tls.swap-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'A certificate swap failed mid-apply; some SNI hosts may be unroutable until the retry succeeds.',
				attributes: { error: diagnosticError(err) }
			});
			tlsDegraded('a certificate swap failed mid-apply');
			// Self-contained retry: the throw may have consumed the LAST fs event of
			// the renewal burst, so waiting for the next watcher/broadcast event could
			// mean waiting for the next renewal months away. One-shot, and each retry
			// re-arms only from its own failure path, so a persistent fault retries at
			// this cadence (loudly) instead of spinning.
			if (tlsRetryTimer === null) {
				tlsRetryTimer = setTimer(() => { tlsRetryTimer = null; reloadTls(); }, ssl_reload_debounce_ms > 0 ? ssl_reload_debounce_ms : 500);
			}
		} else {
			// Validation threw before the app was touched (half-written cert, key
			// mismatch): the previous cert is fully intact, and the file write that
			// completes the renewal fires the watcher again.
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.tls',
				event: 'tls.reload-skipped',
				severity: 'warn',
				dataClass: 'pseudonymous',
				message: 'A certificate reload was skipped and the previous certificate was kept; the renewal on disk is not being served.',
				attributes: { error: diagnosticError(err) }
			});
			// Degraded rather than benign: the renewal on disk is NOT being served,
			// and every probe stays green while the certificate that IS being served
			// runs down. Cleared by the next reload that succeeds.
			tlsDegraded('the certificate on disk did not validate, so the previous one is still being served');
		}
	}
}

/**
 * Arm the TLS hot-reload: record the boot cert's fingerprint (the gate that
 * keeps the SNI overlay inactive until the cert on disk genuinely changes) and
 * - in single-process mode - start watching the cert directory. Registers NO
 * server names: boot-time serving is exactly the SSLApp default context, so
 * SSL_WATCH=1 (the default) serves byte-identically to SSL_WATCH=0 until the
 * first real renewal. Called from start() once the listen socket is bound. In
 * cluster mode a worker does not watch - the primary (index.js) owns the watch
 * and drives each worker's reloadTls() via a {type:'tls-reload'} broadcast. An
 * unreadable / unparseable boot cert disables hot-reload loudly (the server
 * itself keeps serving - uWS already loaded the cert into its boot context).
 */
function initTlsReload() {
	if (!is_tls || !ssl_watch) return;
	// Baseline = the fingerprint captured in the same tick the SSLApp loaded the
	// cert (config.js), NOT a fresh read: module eval runs for seconds on a real
	// app, and a renewal completing in that window must read as "changed" here,
	// not get recorded as already-served and gated off until the cert expires.
	// A null capture (unreadable at app creation) bypasses the gate on the first
	// event, which converges on the disk cert - safe in both directions.
	tlsState = { hosts: [], fingerprint: boot_cert_fingerprint };
	// The expiry of what this instance serves right now, so a later failure can
	// be reported with the one number that says how urgent it is.
	recordServedCertExpiry();
	// Only a single-process server watches its own cert directory. A cluster worker
	// (parentPort set) does not watch - the primary owns the watch and drives this
	// worker's reload via a {type:'tls-reload'} broadcast (index.js). Not watching
	// is therefore NOT degraded on a worker: the primary is the one whose watcher
	// has to be alive.
	if (!parentPort) {
		try {
			certWatcher = createCertWatcher({
				certPath: ssl_cert,
				debounceMs: ssl_reload_debounce_ms,
				onChange: reloadTls
			});
			certWatcher.start();
			tlsHealth.watching = true;
			console.log(`[tls] watching ${dirname(ssl_cert)} for certificate renewals`);
		} catch (err) {
			certWatcher = null;
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.tls',
				event: 'tls.watch-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'The certificate directory watch failed to start; hot reload is disabled and no renewal will be seen.',
				attributes: { error: diagnosticError(err) }
			});
			// Nothing will ever retry this: without a watcher no renewal is seen, so
			// this instance will serve its current certificate until it expires.
			tlsDegraded('the certificate directory watch failed to start, so no renewal will be seen');
		}
	}
	// Arm-time catch-up: swap now if the cert on disk already differs from the
	// one the boot context serves (a renewal that landed during module eval, or
	// - single-process - an fs event that fired before the watcher existed).
	// Fingerprint-gated, so the common unchanged-cert boot costs one file read.
	reloadTls();
}

/** Stop the cert watcher, the expiry sentinel and any pending retry (idempotent; no-op when never started). */
export function stopTlsReload() {
	certWatcher?.stop();
	certWatcher = null;
	tlsHealth.watching = false;
	if (tlsRetryTimer !== null) {
		clearTimer(tlsRetryTimer);
		tlsRetryTimer = null;
	}
	if (tlsExpirySentinel !== null) {
		clearIntervalTimer(tlsExpirySentinel);
		tlsExpirySentinel = null;
	}
}

/**
 * Returns a promise that resolves when all in-flight SSR requests have completed.
 * @returns {Promise<void>}
 */
export function drain() {
	if (counters.inFlightCount === 0) return Promise.resolve();
	return new Promise((resolve) => { drainResolvers.push(resolve); });
}

let listenSocket = null;

// --- Lifecycle state ---------------------------------------------------
// LIVE, READY and ACCEPTING are three different things, and every one of the
// shutdown/boot defects this state machine replaces came from collapsing two of
// them into one flag:
//
//   'starting'  the process is up and the listen socket may already be bound,
//               but the app's `init` hook has not finished. LIVE and ACCEPTING
//               (the kernel queues connections against the bound socket, which
//               is what makes a restart lossless) but NOT READY - the readiness
//               route answers 503 so a load balancer does not route here until
//               the app's own boot work has committed.
//   'ready'     `init` resolved. The only state in which readiness answers 200.
//   'draining'  graceful shutdown has begun. NOT READY, so the balancer
//               deregisters this instance - while the listen socket stays OPEN
//               and in-flight work continues, which is exactly what the
//               SHUTDOWN_DELAY_MS window is for.
//   'closed'    the listen socket is closed; nothing new is accepted.
//
// Liveness (`healthCheckPath`) is none of these: it answers 200 for as long as
// the process runs, so a readiness 503 can never trip a liveness probe into
// restarting an instance that is deliberately draining.
/** @type {'starting' | 'ready' | 'draining' | 'closed'} */
let lifecycle_state = 'starting';

/**
 * The single writer of `lifecycle_state`, so the readiness flag on the shared
 * counters cannot drift away from it. That flag is a mirror and nothing else -
 * two places answering "is this instance taking traffic" with different values
 * is the exact collapse this state machine exists to end, and it happens the
 * moment one of them is written by hand at one transition only.
 * @param {'starting' | 'ready' | 'draining' | 'closed'} next
 */
function setLifecycleState(next) {
	lifecycle_state = next;
	counters.draining = next !== 'ready';
}
// Boot state, mirrored from the first tick: a diagnostics surface that reads the
// counter during startup has to see the same NOT-ready the readiness route does.
setLifecycleState('starting');

/**
 * This instance's lifecycle state. Exported for diagnostics and for the boot /
 * shutdown driver, which reports the transitions an operator has to reason
 * from. This is also the value the readiness route should REPORT when it answers
 * 503: `starting` and `draining` are both not-ready, but they mean opposite
 * things to an operator watching a rolling deploy.
 * @returns {'starting' | 'ready' | 'draining' | 'closed'}
 */
export function lifecycleState() {
	return lifecycle_state;
}

/**
 * The readiness gate the `/readyz` route reads: true whenever this instance
 * must NOT be sent new traffic. That covers `starting` (bound but the app's
 * `init` has not committed) as well as `draining` and `closed` - readiness is
 * the balancer's routing signal, and the instance is unfit for new work in all
 * three. Liveness and accepting-new-connections are deliberately NOT derived
 * from it (see the state machine above).
 * @returns {boolean}
 */
export function isDraining() {
	return lifecycle_state !== 'ready';
}

/**
 * Enter the draining state: readiness starts answering 503 so a fronting load
 * balancer stops routing NEW traffic here, while the listen socket stays open
 * and in-flight requests keep being served.
 *
 * Split from `shutdown()` on purpose. The SHUTDOWN_DELAY_MS wait exists so the
 * balancer can deregister this instance BEFORE its sockets close, and that only
 * works if the signal the balancer polls flips FIRST - flipping it together
 * with the socket close (which is what a single shutdown step does) means new
 * requests keep arriving for the whole propagation window and then meet a
 * closed socket.
 *
 * Idempotent: returns false when draining had already begun.
 * @returns {boolean}
 */
export function beginDrain() {
	if (lifecycle_state === 'draining' || lifecycle_state === 'closed') return false;
	setLifecycleState('draining');
	return true;
}

/**
 * Resolve when `signal` aborts, never otherwise. The shutdown budget is one
 * AbortSignal shared by every phase, and a phase bounds itself by racing this
 * against its own work rather than arming a timer of its own: per-phase timers
 * would make the real bound the SUM of the phases, not the budget.
 * A missing signal means the caller set no budget, so nothing ever aborts.
 * @param {AbortSignal | null | undefined} signal
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
 * Start the uWS server. Returns a promise that resolves once the listen
 * socket is bound AND the user's `hooks.ws.init` hook (if any) has
 * completed. Awaiting `start()` gives callers a "server is fully ready"
 * signal that includes app-level boot work (cron registration, warmup
 * tasks, external pubsub bridges).
 *
 * Readiness follows that same boundary rather than the socket bind: the
 * instance stays `starting` (readiness 503) from the bind until the init hook
 * resolves, so a load balancer cannot route to a server whose DB pools, warmup
 * or cron registration are still in flight. The socket is deliberately bound
 * BEFORE init anyway - the kernel queues arriving connections instead of
 * refusing them, which is what makes a rolling restart lossless.
 *
 * Listen failure logs and exits the process (preserves prior behavior).
 * Init-hook failure rejects the promise - boot is loud or nothing; the
 * caller decides whether to abort or recover. A rejected init leaves the
 * instance `starting`, so readiness never turns green for it.
 *
 * @param {string} host
 * @param {number} port
 * @param {{ listen?: boolean }} [opts] - `listen: false` fires the `init` hook
 *   without binding a listen socket, for workers that must boot fully but never
 *   own the socket: a compute worker (runs app boot work over the shared memory
 *   from primaryInit but never accepts connections) and an acceptor-mode io
 *   worker (the primary's acceptor owns the socket and routes connections to
 *   this child app by descriptor). Omitted / `listen: true` is the normal
 *   listen-and-init path.
 * @returns {Promise<void>}
 */
export async function start(host, port, opts) {
	const doListen = !opts || opts.listen !== false;
	if (doListen) {
		await new Promise((resolve) => {
			app.listen(host, port, (socket) => {
				if (socket) {
					listenSocket = socket;
					const startup = (monotonicNow() - _t_app).toFixed(0);
					// Bound, not ready: readiness stays 503 until the init hook commits
					// below, and saying "ready" here is what let a balancer route into
					// an instance whose app boot work had not run.
					console.log(`[svelte-adapter-uws] Listening on ${is_tls ? 'https' : 'http'}://${host}:${port} (bound in ${startup}ms)`);
					resolve();
				} else {
					emitOperationalDiagnostic(listenFailureDiagnostic(host, port));
					process.exit(1);
				}
			});
		});
	}

	// Make the served TLS host(s) hot-reloadable and (single-process) start
	// watching the cert directory, now that the listen socket is bound.
	initTlsReload();

	// Fire the user's `init` hook (if exported) once per worker, after the
	// listen socket is bound (when listening) and before this function resolves.
	// Async hooks are awaited so callers that `await start(...)` get a fully-ready
	// signal that includes app-level boot work. A throwing hook re-throws to the
	// caller - boot failure should be loud. `workerData.app` is the value the app
	// returned from primaryInit (the cross-worker shared memory), replayed
	// identically to every worker; null in single-process mode and when no
	// primaryInit is configured.
	if (WS_ENABLED && typeof wsModule.init === 'function') {
		await wsModule.init({ platform, workerData: workerData?.app ?? null });
	}

	// Readiness commits here, and only from `starting`: a shutdown that raced
	// boot (a SIGTERM during a slow init) already moved this instance on, and
	// must not be pulled back into rotation by its own init finishing.
	if (lifecycle_state === 'starting') {
		setLifecycleState('ready');
		if (doListen) console.log(`[svelte-adapter-uws] Ready for traffic (${(monotonicNow() - _t_app).toFixed(0)}ms since boot)`);
	}
}

/**
 * Stop the server gracefully.
 *
 * Order of operations:
 *   1. Enter the draining state (readiness 503) if the caller has not already
 *      done so before its load-balancer delay.
 *   2. Fire the user's `hooks.ws.shutdown` hook (if any) so app-level code
 *      can flush cron state, last metrics, external bridge teardown, etc.
 *      Async hooks are awaited, but only until `ctx.signal` aborts - with no
 *      budget configured there is no signal and the await is unbounded. A hook that
 *      never settles (an await on a dependency that is already gone) used to
 *      hold the listen socket open, the drain race unarmed and the process
 *      alive until the supervisor's SIGKILL - the shutdown timeout bounded
 *      everything except the one step an application controls. Throws are
 *      logged and ignored (we cannot refuse to shut down).
 *   3. Close the listen socket - stops accepting new connections.
 *   4. Gracefully `end()` every WebSocket with `code 1001 (Going Away)` so any
 *      buffered outbound frames flush before the socket closes and the client
 *      gets a clean close frame, then reconnects to the new instance. (Forceful
 *      `close()` would drop the send buffer and, taking no args, send no code.)
 *
 * In-flight HTTP requests continue until `drain()` resolves - the caller
 * (index.js) races `drain()` against the same budget.
 *
 * @param {{ reason?: string, signal?: AbortSignal | null, deadline?: number | null }} [ctx]
 *   The shutdown budget, forwarded to the app's hook: `reason` is the signal or
 *   message that started it, `signal` aborts when the budget is spent, and
 *   `deadline` is the wall-clock epoch ms it expires at. Both are null when the
 *   caller set no budget - SHUTDOWN_TIMEOUT=0, or a test harness closing a
 *   server - and then the hook is awaited for as long as it takes, exactly as an
 *   unbounded await did.
 * @returns {Promise<void>}
 */
export async function shutdown(ctx) {
	// Readiness first, and idempotent: the signal handler normally flips it
	// before its load-balancer delay, so this only fires for callers that close
	// the server directly.
	beginDrain();
	const signal = ctx?.signal ?? null;
	const hookContext = {
		platform,
		reason: ctx?.reason ?? null,
		signal,
		deadline: ctx?.deadline ?? null
	};
	if (WS_ENABLED && typeof wsModule.shutdown === 'function') {
		const started = monotonicNow();
		try {
			// The failure handler is attached before the race, not after it: once the
			// race is lost nothing awaits the hook any more, and a late rejection
			// would surface as an unhandled rejection in the middle of the exit.
			const hook = Promise.resolve(wsModule.shutdown(hookContext)).then(
				() => true,
				(err) => { console.error('[ws] shutdown hook threw:', err); return true; }
			);
			// The hook keeps running after the budget expires - user code cannot be
			// interrupted - but it no longer holds the close path. Its `signal` is
			// how a hook that wants to give up cleanly can.
			const settled = await Promise.race([hook, whenAborted(signal).then(() => false)]);
			if (!settled) {
				console.error(
					`[ws] shutdown hook has not settled after ${(monotonicNow() - started).toFixed(0)}ms and the shutdown budget is spent; ` +
					'closing the listen socket anyway - whatever the hook was flushing did NOT finish.'
				);
			}
		} catch (err) {
			// A hook that throws synchronously, before it ever returned a promise.
			// Log-and-continue: shutdown is best-effort, we cannot refuse.
			console.error('[ws] shutdown hook threw:', err);
		}
	}
	if (listenSocket) {
		uWS.us_listen_socket_close(listenSocket);
		listenSocket = null;
	}
	// Accepting stops here, not when readiness flipped - the two are separate
	// states and the window between them is the whole point of the drain delay.
	setLifecycleState('closed');
	stopPressureSampling();
	// Close the posture export socket (no-op when never configured) so the
	// socket file does not outlive the process and consumers see a clean EOF.
	counters.postureExporter?.close();
	counters.postureExporter = null;
	counters.postureExportHook = null;
	// Stop the per-worker consistency auditor timer (no-op when it was never
	// installed - the interval-0 / not-yet-started case).
	counters.consistencyAuditor?.stop();
	// Stop the optional resource-growth trend auditor timer (no-op when never
	// installed - the default interval-0 case).
	counters.resourceGrowthAuditor?.stop();
	// Stop the TLS cert watcher (no-op when never started).
	stopTlsReload();
	// Snapshot first: end() synchronously fires the close handler, which removes
	// the entry from wsConnections as we iterate. Use end() (graceful) not
	// close() (forceful) - end() flushes buffered outbound frames and sends a
	// clean 1001 close frame, while close() drops the send buffer and (taking no
	// args) sends no close code at all.
	// Advise clients to reconnect on a jittered schedule before closing, so a
	// draining node's clients disperse across the window instead of all
	// reconnecting in one backoff burst and stampeding the replacement. Gated:
	// 0 = legacy (no advisory). The advisory is a buffered send that the end()
	// loop below flushes before the 1001 close frame, so the close code AND reason
	// stay 'Server shutting down' (existing close-code assertions still hold).
	if (reconnect_dispersal_ms > 0) {
		platform.adviseReconnect({ windowMs: reconnect_dispersal_ms, close: false });
	}
	for (const ws of [...wsConnections]) {
		ws.end(1001, 'Server shutting down');
	}
}

let appClosed = false;

/**
 * Forcefully close the uWS App - all sockets INCLUDING the listen socket. A
 * worker thread holds uWS's raw libuv socket-poll handles, which Node does not
 * track and therefore does not close during worker teardown; a bare
 * `process.exit()` (or `worker.terminate()`) in a worker that still holds those
 * handles aborts the whole process with `uv_loop_close() while having open
 * handles`. Closing the App drops the handles so the exit is clean. Idempotent.
 *
 * This is FORCEFUL (drops send buffers) - the graceful path (`shutdown()` above)
 * still runs first and sends every client a clean 1001; this only mops up
 * stragglers after the drain race, immediately before the worker exits.
 */
export function forceCloseApp() {
	if (appClosed) return;
	appClosed = true;
	try {
		app.close();
	} catch {
		/* already closed / never listened - nothing to mop up */
	}
}

/**
 * Get the app descriptor for worker thread distribution.
 * The main thread's acceptor app uses this to route connections to this worker.
 * @returns {any}
 */
export function getDescriptor() {
	return app.getDescriptor();
}

/**
 * Publish a relayed message from another worker thread.
 * Called by the main thread's relay when another worker publishes.
 * @param {string} topic
 * @param {string} envelope - Pre-serialized JSON envelope
 * @param {boolean} [compress] - Compress intent carried from the originating
 *   worker; re-gated by this worker's WS_COMPRESSION_ON. Absent -> uncompressed.
 * @param {number | null} [seq] - The originator's stamped per-topic seq, carried
 *   as explicit metadata. Recorded as this worker's highest observed seq for the
 *   topic (ungated by whether this worker has a local subscriber), so every
 *   worker that receives the frame converges to the same value. The monotone-max
 *   guard in recordSeen handles frames that reorder across the postMessage
 *   boundary; a non-number (a {seq:false} publish) is ignored.
 * @param {string} [capability] - When the origin worker published through a wire
 *   codec registered in its codec registry, the codec's capability + raw payload
 *   ride along so this worker can re-encode binary locally for its binary-capable
 *   subscribers. A set `capability` is the sole signal that a re-encode was
 *   intended. Absent (plain publish, unregistered codec, declined wire frame) ->
 *   the JSON envelope is used, exactly as before.
 * @param {string} [event] - The publish event name, for the codec-aware re-encode.
 * @param {any} [data] - The raw publish payload, for the codec-aware re-encode. May
 *   be undefined for a codec whose frame carries no payload; carried alongside
 *   `capability` regardless.
 * @param {number} [origin] - The sending worker's thread id.
 * @param {number} [ord] - That worker's per-topic relay ordinal for this frame.
 * @param {number} [birth] - When that worker opened this topic's relay stream.
 *   The three travel together and identify the frame's place in a dense
 *   per-origin stream, which is what makes a DROPPED frame observable: `seq`
 *   alone only reveals a lost tail, since a lost interior frame leaves the max
 *   untouched. Absent from a frame relayed by a worker predating this carry, in
 *   which case the topic is simply not contiguity-checked.
 */
export function relayPublish(topic, envelope, compress, seq, capability, event, data, origin, ord, birth) {
	// Hard tier: a non-string topic or an empty/non-string envelope arriving
	// from a sibling worker (trusted, same codebase) means our own cross-worker
	// relay serialization is structurally broken - publishing it would misroute
	// or send garbage to every local subscriber and, transitively, cluster-wide.
	// That is not recoverable by dropping one frame, so it escalates to a
	// deferred worker restart rather than a soft log.
	fatal(typeof topic === 'string', 'relay.topic-type', { topic: typeof topic });
	fatal(typeof envelope === 'string' && envelope.length > 0, 'relay.envelope-type', {
		envelopeType: typeof envelope,
		envelopeLen: typeof envelope === 'string' ? envelope.length : null
	});
	recordSeen(maxSeenSeq, topic, seq);
	if (streamTracking.enabled) {
		recordOriginStream(originStreams, topic, origin, ord, birth, relayAttach.at, processMonotonicNow);
	}
	// Codec-aware relay: when the origin worker carried a registered wire codec's
	// capability alongside the JSON envelope, re-encode binary locally for this
	// worker's binary-capable subscribers - the (N-1)/N of them that would otherwise
	// receive the relayed JSON. The carry is registry-gated at the origin, so a set
	// `capability` always travels with its payload (and only for a codec the origin
	// found in its registry); the gate keys on `capability` alone, not on `data`,
	// because a codec may legitimately encode an undefined payload (an event-only or
	// tick frame) and gating on `data !== undefined` would silently degrade those to
	// JSON cross-worker. An origin that carries no `capability` (e.g. an older
	// worker that predates the capability carry) falls through to the envelope.
	// relayPublishWire itself returns false (envelope
	// fallback) when no codec is registered for the capability or this worker has no
	// binary subscriber for it; the local re-encode passes relay:false, so it never
	// re-relays and cannot loop.
	if (capability !== undefined &&
		relayPublishWire(topic, event, data, capability, seq, compress)) {
		return;
	}
	// Resume cutover in flight on this worker: hold the JSON envelope a caps-less
	// resuming subscriber would receive from this cross-worker frame. The codec
	// re-encode path above delivers through publishWire, which captures there.
	if (resumeBuffers.size > 0) captureResumeFrame(topic, seq, envelope, compress === true);
	const result = app.publish(topic, envelope, false, WS_COMPRESSION_ON && compress === true);
	counters.publishOutcomeHook?.(result);
}

/**
 * Re-dispatch a relayed publishBatched call from another worker. The
 * detection (allSeeAll + everyoneCapable) is re-run against THIS
 * worker's local subscriber set: a worker with a different cap profile
 * or different subscription overlap may take the slow path even when
 * the originating worker took the fast path. Seqs were stamped by the
 * originator and ride along in each per-event envelope; we never
 * re-stamp and never re-relay.
 *
 * @param {Array<import('./relay.js').RelayBatchedEntry>} events
 *   The batched-lane entry contract, declared once at the sender boundary
 *   (relay.js) and asserted below. Each event also carries the sending worker's
 *   identity and that worker's per-topic relay ordinal + stream birth: the
 *   batch is one frame but N logical publishes, so losing it is a hole in each
 *   topic's stream (see relayPublish).
 * @param {boolean} [compress] - Batch-level compress intent from the originating
 *   worker; re-gated by this worker's WS_COMPRESSION_ON. Absent -> uncompressed.
 */
export function relayPublishBatched(events, compress) {
	if (!Array.isArray(events) || events.length === 0) return;
	assert(typeof events[0].topic === 'string', 'relay.batched-topic-type', {
		first: typeof events[0].topic
	});
	assert(typeof events[0].env === 'string', 'relay.batched-env-type', {
		first: typeof events[0].env
	});

	// Advance this worker's highest observed seq per topic from the carried
	// metadata, ungated by the fast/slow fan-out decision below and by whether
	// this worker has a local subscriber, so every worker that receives the
	// batch converges. recordSeen ignores a non-number seq ({seq:false} events).
	// The batch arrived as ONE frame but carries a publish per event, so each
	// event also advances its own topic's per-origin stream.
	for (let i = 0; i < events.length; i++) {
		recordSeen(maxSeenSeq, events[i].topic, events[i].seq);
		if (streamTracking.enabled) {
			recordOriginStream(originStreams, events[i].topic, events[i].origin, events[i].ord, events[i].birth,
				relayAttach.at, processMonotonicNow);
		}
	}

	const firstTopic = events[0].topic;
	let allSameTopic = true;
	for (let i = 1; i < events.length; i++) {
		if (events[i].topic !== firstTopic) { allSameTopic = false; break; }
	}

	let allSeeAll = true;
	let everyoneCapable = true;
	let batchTopics = null;
	if (!allSameTopic) {
		batchTopics = new Set();
		for (let i = 0; i < events.length; i++) batchTopics.add(events[i].topic);
	}
	for (const ws of wsConnections) {
		const ud = ws.getUserData();
		const subs = ud[WS_SUBSCRIPTIONS];
		if (!subs || subs.size === 0) continue;
		let touchesAny = false;
		if (allSameTopic) {
			touchesAny = subs.has(firstTopic);
		} else {
			let touchesAll = true;
			for (const t of /** @type {Set<string>} */ (batchTopics)) {
				if (subs.has(t)) touchesAny = true;
				else touchesAll = false;
			}
			if (touchesAny && !touchesAll) { allSeeAll = false; break; }
		}
		if (!touchesAny) continue;
		const caps = ud[WS_CAPS];
		if (!caps || !caps.has('batch')) { everyoneCapable = false; break; }
	}

	if ((!allSameTopic && !allSeeAll) || !everyoneCapable) {
		// Slow path: per-event app.publish, mirroring the local
		// fallback and matching the receive-side semantics that
		// cap-able subs on this worker would have seen if the
		// originator had taken its slow path too.
		for (let i = 0; i < events.length; i++) {
			if (resumeBuffers.size > 0) captureResumeFrame(events[i].topic, events[i].seq, events[i].env, compress === true);
			const result = app.publish(events[i].topic, events[i].env, false, WS_COMPRESSION_ON && compress === true);
			counters.publishOutcomeHook?.(result);
		}
		return;
	}

	// Resume cutover in flight: hold each per-event envelope a caps-less resuming
	// connection would receive (the slow path this fast path stands in for), not the
	// wrapped batch frame it never decodes.
	if (resumeBuffers.size > 0) {
		for (let i = 0; i < events.length; i++) captureResumeFrame(events[i].topic, events[i].seq, events[i].env, compress === true);
	}
	// Fast path: wrap and dispatch on the C++ TopicTree.
	const slice = new Array(events.length);
	for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
	const sharedBatchEnv = wrapBatchEnvelope(slice);
	const fanoutTopic = allSameTopic ? firstTopic : events[0].topic;
	const result = app.publish(fanoutTopic, sharedBatchEnv, false, WS_COMPRESSION_ON && compress === true);
	counters.publishOutcomeHook?.(result);
}
