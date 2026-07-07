import uWS from 'uWebSockets.js';
import { workerData } from 'node:worker_threads';
import { wsModule } from '../ws-handler-bridge.js';
import { WS_CAPS, WS_SUBSCRIPTIONS, assert, fatal, wrapBatchEnvelope } from '../utils.js';
import { monotonicNow } from '../runtime.js';
import { counters, maxSeenSeq, recordSeen, wsConnections } from './state.js';
import { app, is_tls, _t_app, WS_COMPRESSION_ON, reconnect_dispersal_ms, ssl_cert, ssl_key, ssl_watch, ssl_reload_debounce_ms, ssl_sni_hosts } from './config.js';
import { platform, relayPublishWire } from './platform.js';
import { stopPressureSampling } from './pressure-metrics.js';
import { applyServerNames, createCertWatcher } from '../utils/tls-reload.js';
import { parentPort } from 'node:worker_threads';
import { dirname } from 'node:path';

/** @type {Array<() => void>} */
let drainResolvers = [];

export function requestDone() {
	counters.inFlightCount--;
	if (counters.inFlightCount === 0 && drainResolvers.length > 0) {
		for (const resolve of drainResolvers) resolve();
		drainResolvers = [];
	}
}

// --- TLS certificate hot-reload (opt-in via ssl_watch; see utils/tls-reload.js) ---
// Registered SNI hosts for this app, updated on each reload; and the directory
// watcher. AUTOMATIC reload is SINGLE-PROCESS only in this release: a cluster
// worker registers its SNI hosts but does not watch, and the cluster primary
// broadcast that would drive per-worker reloads is not yet wired (reloadTls is
// exported for that follow-up). A cluster deployment picks up a renewed cert on
// its next restart; run single-process for automatic reload.
let tlsHosts = [];
let certWatcher = null;

/**
 * Re-read the certificate on disk and swap the SNI server name(s) in place so a
 * renewed cert is served without re-binding the listen socket. Validates the
 * cert + key BEFORE touching the app, so a partial write keeps the previous
 * certificate (TLS never drops). No-op on a non-TLS server. Exported so a future
 * cluster primary-broadcast can drive a reload on this worker (not yet wired).
 */
export function reloadTls() {
	if (!is_tls || !ssl_watch) return;
	try {
		tlsHosts = applyServerNames(app, { certPath: ssl_cert, keyPath: ssl_key, hosts: ssl_sni_hosts }, tlsHosts);
	} catch (err) {
		console.error('[tls] certificate reload skipped, kept the previous cert:', err && err.message ? err.message : err);
	}
}

/**
 * Register the certificate's SNI host(s) so the served hosts become hot-reloadable
 * (the SSLApp default context is not), and - in single-process mode - start
 * watching the cert directory. Called from start() once the listen socket is
 * bound. In cluster mode every worker registers its hosts, but the automatic
 * cert-directory watch runs only single-process; the cluster primary-broadcast
 * reload is a follow-up, so a cluster deployment reloads on restart.
 */
function initTlsReload() {
	if (!is_tls || !ssl_watch) return;
	try {
		tlsHosts = applyServerNames(app, { certPath: ssl_cert, keyPath: ssl_key, hosts: ssl_sni_hosts }, []);
	} catch (err) {
		console.error('[tls] initial SNI registration failed, hot-reload disabled:', err && err.message ? err.message : err);
		return;
	}
	// Only a single-process server watches its own cert directory. A cluster worker
	// (parentPort set) does not watch; automatic reload is single-process only in
	// this release (the cluster primary-broadcast reload is a follow-up).
	if (!parentPort) {
		certWatcher = createCertWatcher({
			certPath: ssl_cert,
			debounceMs: ssl_reload_debounce_ms,
			onChange: reloadTls
		});
		certWatcher.start();
		console.log(`[tls] watching ${dirname(ssl_cert)} for certificate renewals (SNI: ${tlsHosts.join(', ')})`);
	}
}

/** Stop the cert watcher (idempotent; no-op when never started). */
export function stopTlsReload() {
	certWatcher?.stop();
	certWatcher = null;
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

/**
 * Start the uWS server. Returns a promise that resolves once the listen
 * socket is bound AND the user's `hooks.ws.init` hook (if any) has
 * completed. Awaiting `start()` gives callers a "server is fully ready"
 * signal that includes app-level boot work (cron registration, warmup
 * tasks, external pubsub bridges).
 *
 * Listen failure logs and exits the process (preserves prior behavior).
 * Init-hook failure rejects the promise - boot is loud or nothing; the
 * caller decides whether to abort or recover.
 *
 * @param {string} host
 * @param {number} port
 * @param {{ listen?: boolean }} [opts] - `listen: false` fires the `init` hook
 *   without binding a listen socket. Used by a compute worker (worker roles): it
 *   runs app boot work over the shared memory from primaryInit but never accepts
 *   connections. Omitted / `listen: true` is the normal listen-and-init path.
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
					console.log(`Listening on ${is_tls ? 'https' : 'http'}://${host}:${port} (ready in ${startup}ms)`);
					resolve();
				} else {
					console.error(`Failed to listen on ${host}:${port}`);
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
}

/**
 * Stop the server gracefully.
 *
 * Order of operations:
 *   1. Fire the user's `hooks.ws.shutdown` hook (if any) so app-level code
 *      can flush cron state, last metrics, external bridge teardown, etc.
 *      Async hooks are awaited; throws are logged and ignored (we cannot
 *      refuse to shut down).
 *   2. Close the listen socket - stops accepting new connections.
 *   3. Gracefully `end()` every WebSocket with `code 1001 (Going Away)` so any
 *      buffered outbound frames flush before the socket closes and the client
 *      gets a clean close frame, then reconnects to the new instance. (Forceful
 *      `close()` would drop the send buffer and, taking no args, send no code.)
 *
 * In-flight HTTP requests continue until `drain()` resolves - the caller
 * (index.js) typically races `drain()` against a shutdown timeout.
 *
 * @returns {Promise<void>}
 */
/**
 * True once graceful shutdown has begun. The readiness route reports a 503
 * while draining so a fronting load balancer stops routing NEW traffic to this
 * instance (it stays live - the process is up - but is no longer ready) while
 * in-flight requests finish. Liveness (`healthCheckPath`) is unaffected.
 * @returns {boolean}
 */
export function isDraining() {
	return counters.draining;
}

export async function shutdown() {
	// Flip readiness to NOT-ready at the very start of shutdown so the readiness
	// route reports 503 and a fronting load balancer drains this instance before
	// its connections are closed below. Idempotent (a second shutdown is a no-op
	// on this flag). Liveness stays 200 - the process is still up.
	counters.draining = true;
	if (WS_ENABLED && typeof wsModule.shutdown === 'function') {
		try {
			await wsModule.shutdown({ platform });
		} catch (err) {
			// Log-and-continue: shutdown is best-effort, we cannot refuse.
			console.error('[ws] shutdown hook threw:', err);
		}
	}
	if (listenSocket) {
		uWS.us_listen_socket_close(listenSocket);
		listenSocket = null;
	}
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
 */
export function relayPublish(topic, envelope, compress, seq, capability, event, data) {
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
	app.publish(topic, envelope, false, WS_COMPRESSION_ON && compress === true);
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
 * @param {Array<{ topic: string, env: string, seq?: number | null }>} events
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
	for (let i = 0; i < events.length; i++) recordSeen(maxSeenSeq, events[i].topic, events[i].seq);

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
			app.publish(events[i].topic, events[i].env, false, WS_COMPRESSION_ON && compress === true);
		}
		return;
	}

	// Fast path: wrap and dispatch on the C++ TopicTree.
	const slice = new Array(events.length);
	for (let i = 0; i < events.length; i++) slice[i] = events[i].env;
	const sharedBatchEnv = wrapBatchEnvelope(slice);
	const fanoutTopic = allSameTopic ? firstTopic : events[0].topic;
	app.publish(fanoutTopic, sharedBatchEnv, false, WS_COMPRESSION_ON && compress === true);
}
