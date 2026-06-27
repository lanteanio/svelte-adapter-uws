// Multi-worker cluster model for the deterministic simulator. Production runs N
// worker threads behind a primary that (a) forwards each published frame between
// workers and (b) restarts a crashed worker under an exponential-backoff budget.
// That relay lives in handler.js (batchRelay -> publish-batch -> relayPublish) and
// the supervisor in index.js (the is_primary block) - NEITHER is drivable in-sim
// (handler.js imports uWS + build-virtual modules at module scope; index.js spawns
// real worker_threads). So this file MODELS both at the platform level, wiring N
// createTestServer instances (each over its own InMemoryApp, one shared virtual
// clock) into a fault-gated relay bus + a restart-budget supervisor.
//
// Simulation infrastructure, not framework runtime. It drives the cluster purely
// through the runtime seam (the SAME setTimer / setIntervalTimer / monotonicNow
// helpers index.js uses), so every timer is virtual and the seed fully determines
// the run. No raw event-loop primitives are touched here.

import { setTimer, setIntervalTimer, clearTimer, monotonicNow } from './runtime.js';
import { computeStateHash } from './invariants.js';

// The supervisor constants, verbatim from src/runtime/index.js so the modeled budget
// matches production exactly.
const RESTART_DELAY_MAX = 5000;
const RESTART_MAX_ATTEMPTS = 50;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 30000;

// - The per-worker relay sender adapter --------------------------------------

/**
 * The originating-side relay coalescer, one per worker. Wired into
 * createTestServer as `__onPublish`. It mirrors handler.js: single publishes
 * coalesce within one timers-phase tick (setTimer(0), unref'd like batchRelay's
 * relayTimer) into a single `publish-batch`; a fast-path publishBatched posts its
 * own `publish-batched` frame (no coalescing, matching the separate production IPC
 * type). The flush hands the frame to the bus, which models the primary forward.
 *
 * @param {{ workerId: number, bus: ReturnType<typeof createClusterBus> }} opts
 */
export function createClusterRelay(opts) {
	const { workerId, bus } = opts;
	/** @type {Array<{ topic: string, envelope: string, compress?: boolean }> | null} */
	let batch = null;
	/** @type {ReturnType<typeof setTimer> | null} */
	let batchTimer = null;

	function flushBatch() {
		batchTimer = null;
		if (batch && batch.length > 0) bus.post(workerId, { type: 'publish-batch', messages: batch });
		batch = null;
	}

	function onPublish(frame) {
		if (!frame) return;
		if (frame.kind === 'publishBatched') {
			// Wire-level batch: its own IPC frame, posted on a timers-phase tick so
			// it crosses the boundary in a later phase (never re-entrant), unref'd.
			const events = frame.events;
			if (!Array.isArray(events) || events.length === 0) return;
			const compress = frame.compress;
			const t = setTimer(() => bus.post(workerId, { type: 'publish-batched', events, compress }), 0);
			if (t.unref) t.unref();
			return;
		}
		// Single publish: coalesce the synchronous burst into one publish-batch.
		if (!batch) {
			batch = [];
			batchTimer = setTimer(flushBatch, 0);
			if (batchTimer.unref) batchTimer.unref();
		}
		// The fault sim models the relay at the JSON-envelope level only: it drops any
		// codec-aware re-encode fields (capability/event/data) a wire publish carries,
		// so a receiving worker delivers the envelope, not a re-encoded 0x03 frame.
		// This is deliberate and conservative - cross-worker convergence is checked on
		// the per-topic seq embedded in the envelope, which is identical whether a
		// subscriber receives binary or JSON, so binary re-encode cannot change the
		// state hash. The end-to-end carry + re-encode is covered by codec-relay.test.js.
		batch.push({ topic: frame.topic, envelope: frame.envelope, compress: frame.compress });
	}

	/** Drop a pending batch without flushing (a worker that dies mid-coalesce). */
	function abandon() {
		if (batchTimer) { clearTimer(batchTimer); batchTimer = null; }
		batch = null;
	}

	return { onPublish, abandon };
}

// - The relay bus (models the primary forward + the IPC channel) -------------

/**
 * The inter-worker message bus. Models index.js's primary forward loop: a frame
 * posted by one worker is delivered to every OTHER registered worker (never echoed
 * to the sender). `publish-batch` is expanded into per-message `publish` frames
 * before forwarding (exactly index.js), so the seeded fault engine draws
 * drop/delay/reorder/duplicate/corrupt PER forwarded message. Every delivery is a
 * refed virtual timer (the in-flight IPC will land before quiescence); a worker
 * that dies has its inbound deliveries cancelled (the restart-window loss).
 *
 * @param {{
 *   faultEngine: { plan: (p: string) => Array<{ delayMs: number, payload: string }>, active?: boolean },
 *   metrics?: { forwarded: number, delivered: number, dropped: number }
 * }} opts
 */
export function createClusterBus(opts) {
	const faults = opts.faultEngine;
	const metrics = opts.metrics || { forwarded: 0, delivered: 0, dropped: 0 };
	/** @type {Map<number, (frame: any) => void>} workerId -> __relayReceive */
	const sinks = new Map();
	/** @type {Map<number, Set<ReturnType<typeof setTimer>>>} pending inbound delivery timers per target */
	const pending = new Map();

	function register(workerId, deliver) {
		sinks.set(workerId, deliver);
		if (!pending.has(workerId)) pending.set(workerId, new Set());
	}
	function unregister(workerId) {
		sinks.delete(workerId);
	}
	/** Cancel every in-flight delivery targeting a now-dead worker. */
	function cancelFor(workerId) {
		const set = pending.get(workerId);
		if (set) { for (const t of set) clearTimer(t); set.clear(); }
	}

	/**
	 * Schedule one fault-gated delivery of `frame` to `targetId`. The fault engine
	 * draws against `key` (the envelope, or a batch's first event envelope), so a
	 * drop skips it, a delay/reorder defers it, a duplicate lands it twice, and a
	 * corrupt flips a byte of the carried envelope.
	 */
	function deliverTo(targetId, frame, key) {
		const set = pending.get(targetId);
		const plan = faults.plan(key);
		if (plan.length === 0) { metrics.dropped++; return; }
		for (const d of plan) {
			const out = withPayload(frame, d.payload);
			const timer = setTimer(() => {
				if (set) set.delete(timer);
				const sink = sinks.get(targetId);
				if (!sink) return; // target died after the frame was scheduled
				metrics.delivered++;
				sink(out);
			}, d.delayMs);
			if (set) set.add(timer);
		}
	}

	function post(fromId, msg) {
		if (msg.type === 'publish-batch') {
			for (const m of msg.messages) {
				const single = { kind: 'publish', topic: m.topic, envelope: m.envelope, compress: m.compress };
				for (const [id] of sinks) {
					if (id === fromId) continue;
					metrics.forwarded++;
					deliverTo(id, single, m.envelope);
				}
			}
			return;
		}
		if (msg.type === 'publish-batched') {
			const frame = { kind: 'publishBatched', events: msg.events, compress: msg.compress };
			const key = msg.events[0] ? msg.events[0].env : '';
			for (const [id] of sinks) {
				if (id === fromId) continue;
				metrics.forwarded++;
				deliverTo(id, frame, key);
			}
			return;
		}
		if (msg.type === 'publish') {
			const single = { kind: 'publish', topic: msg.topic, envelope: msg.envelope, compress: msg.compress };
			for (const [id] of sinks) {
				if (id === fromId) continue;
				metrics.forwarded++;
				deliverTo(id, single, msg.envelope);
			}
		}
	}

	return { register, unregister, cancelFor, post, metrics };
}

/**
 * Rebuild a relay frame carrying a possibly-corrupted envelope. For a single
 * publish the corrupted bytes replace the envelope; for a batch they replace the
 * first event's envelope (the fault engine's representative draw), leaving the rest
 * intact - a frame-level corruption model for the atomic IPC clone.
 * @param {any} frame @param {string} payload
 */
function withPayload(frame, payload) {
	if (frame.kind === 'publishBatched') {
		if (payload === (frame.events[0] && frame.events[0].env)) return frame;
		const events = frame.events.map((e, i) => (i === 0 ? { topic: e.topic, env: payload } : e));
		return { kind: 'publishBatched', events, compress: frame.compress };
	}
	if (payload === frame.envelope) return frame;
	return { kind: 'publish', topic: frame.topic, envelope: payload, compress: frame.compress };
}

// - The restart-budget supervisor --------------------------------------------

/**
 * Models src/runtime/index.js's is_primary block: worker liveness via heartbeat, the
 * exponential-backoff restart budget, and (acceptor mode) the all-workers-down
 * listen pause. The real index.js calls process.exit on budget exhaustion / clean
 * shutdown; here those edges become a `fatals[]` entry + halting that worker's
 * model - a literal port would kill the test runner. Every timer is virtual:
 * the heartbeat interval is unref'd (mirror index.js's heartbeat interval) so it
 * never alone keeps the sim alive; each restart backoff timer is refed (mirror the
 * restart timer in index.js's worker-exit handler) so a pending restart holds the
 * run open until the worker respawns.
 *
 * @param {{
 *   mode: 'reuseport' | 'acceptor',
 *   maxAttempts?: number,
 *   hooks: {
 *     terminate: (id: number) => void,      // close the worker's conns + bus.unregister + bus.cancelFor
 *     spawn: (id: number) => Promise<void>, // build a fresh worker, register with the bus, then markReady
 *     onFatal: (entry: { worker: number, reason: string, attempts: number, schedule: number[] }) => void,
 *     onListenPause?: (paused: boolean) => void
 *   }
 * }} opts
 */
export function createSupervisor(opts) {
	const mode = opts.mode === 'acceptor' ? 'acceptor' : 'reuseport';
	const maxAttempts = opts.maxAttempts ?? RESTART_MAX_ATTEMPTS;
	const hooks = opts.hooks;

	/** @type {Map<number, { id: number, state: 'starting'|'ready'|'dead', lastHeartbeat: number, wedged: boolean }>} */
	const metas = new Map();
	let restart_delay = 0;
	let restart_attempts = 0;
	// The cohort-shared backoff delays actually used (production keeps one restart_delay
	// for the whole primary, so this sequence is cohort-wide, not per-worker), surfaced
	// on each fatal record for the deterministic "died after N restarts" report.
	/** @type {number[]} */
	let backoffSchedule = [];
	/** @type {Set<ReturnType<typeof setTimer>>} */
	const restartTimers = new Set();
	let shuttingDown = false;
	let listenPaused = false;
	const metrics = { restarts: 0, flaps: 0, wedges: 0 };

	function liveReady() {
		let n = 0;
		for (const m of metas.values()) if (m.state === 'ready') n++;
		return n;
	}

	function addWorker(id) {
		metas.set(id, { id, state: 'starting', lastHeartbeat: 0, wedged: false });
	}
	/** Mark a (freshly spawned) worker ready - the budget-reset edge (index.js resets the
	 *  restart counters when a worker posts 'ready' / 'descriptor'). */
	function markReady(id) {
		const m = metas.get(id);
		if (!m) return;
		m.state = 'ready';
		m.wedged = false;
		m.lastHeartbeat = monotonicNow();
		restart_delay = 0;
		restart_attempts = 0;
		backoffSchedule = [];
		for (const t of restartTimers) clearTimer(t);
		restartTimers.clear();
		if (listenPaused && liveReady() > 0) {
			listenPaused = false;
			hooks.onListenPause?.(false);
		}
	}

	/** The on('exit') edge: account a death, then (budget permitting) schedule a respawn. */
	function workerExit(id) {
		if (shuttingDown) return;
		const m = metas.get(id);
		if (m) m.state = 'dead';
		if (mode === 'acceptor' && liveReady() === 0 && !listenPaused) {
			listenPaused = true;
			hooks.onListenPause?.(true);
		}
		restart_attempts++;
		if (restart_attempts > maxAttempts) {
			hooks.onFatal({
				worker: id,
				reason: 'restart-budget-exhausted',
				attempts: maxAttempts,
				schedule: backoffSchedule.slice()
			});
			return; // halt this worker's model; do NOT respawn (production process.exit(1))
		}
		restart_delay = restart_delay ? Math.min(restart_delay * 2, RESTART_DELAY_MAX) : 100;
		backoffSchedule.push(restart_delay);
		const timer = setTimer(() => {
			restartTimers.delete(timer);
			if (shuttingDown) return;
			metrics.restarts++;
			// Respawn re-registers and (on listen/ready) resets the budget. Async:
			// createTestServer settles in microtasks the scheduler drains after this
			// callback, so registration lands before the next timers phase. A respawn
			// that fails to come up (a worker that crashes on init) re-enters the exit
			// path, so a persistent crash-loop marches the budget to exhaustion -
			// exactly the production "died after N restarts".
			Promise.resolve(hooks.spawn(id))
				.then(() => { if (!shuttingDown) markReady(id); })
				.catch(() => { if (!shuttingDown) workerExit(id); });
		}, restart_delay);
		restartTimers.add(timer);
	}

	/** Operator/fault action: flap a worker (a clean restart - close conns then exit). */
	function flap(id) {
		const m = metas.get(id);
		if (!m || m.state === 'dead') return;
		metrics.flaps++;
		hooks.terminate(id);
		workerExit(id);
	}

	/** Fault action: wedge a worker (stop acking heartbeats) so the heartbeat scan terminates it. */
	function wedge(id) {
		const m = metas.get(id);
		if (!m || m.state !== 'ready') return;
		m.wedged = true;
		metrics.wedges++;
	}

	// The heartbeat scan (unref'd interval, mirror index.js's heartbeat monitor). Each tick:
	// a healthy ready worker refreshes its stamp (models the immediate ack); a
	// wedged worker does not, so once it crosses HEARTBEAT_TIMEOUT_MS it is
	// terminated and routed through the exit/restart path.
	const heartbeat = setIntervalTimer(() => {
		if (shuttingDown) return;
		const t = monotonicNow();
		for (const m of metas.values()) {
			if (m.state !== 'ready') continue;
			if (m.wedged) {
				if (m.lastHeartbeat > 0 && t - m.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
					hooks.terminate(m.id);
					workerExit(m.id);
				}
			} else {
				m.lastHeartbeat = t;
			}
		}
	}, HEARTBEAT_INTERVAL_MS);
	if (heartbeat.unref) heartbeat.unref();

	function shutdown() {
		shuttingDown = true;
		for (const t of restartTimers) clearTimer(t);
		restartTimers.clear();
		clearTimer(heartbeat);
	}

	return {
		mode,
		addWorker,
		markReady,
		flap,
		wedge,
		shutdown,
		get listenPaused() { return listenPaused; },
		metrics,
		liveReady
	};
}

// - Convergence / cluster snapshot -------------------------------------------

/**
 * A deterministic, sorted per-worker structural snapshot of the cohort, plus the
 * per-(worker) count of data frames delivered to that worker's clients. Sorted at
 * every level so JSON.stringify is byte-stable for the replay self-gate. The
 * cross-worker convergence guarantee is delivery DETERMINISM (this aggregate +
 * clusterFrames are compared by replaySim) plus the per-worker subs.bookkeeping
 * invariant and the no-misdelivery check below; it is NOT a cross-worker structural
 * equality (per-worker subscriber counts and seq spaces are legitimately distinct).
 *
 * @param {Array<{ id: number, snapshot: any, framesDelivered: number }>} workers
 */
export function clusterFinalState(workers) {
	const sorted = workers.slice().sort((a, b) => a.id - b.id);
	return {
		workers: sorted.map((w) => ({ id: w.id, ...w.snapshot })),
		framesDelivered: sorted.map((w) => ({ worker: w.id, frames: w.framesDelivered }))
	};
}

/**
 * No-misdelivery invariant: every frame a client received was routed on a topic
 * that client is subscribed to. Catches a relay that fans a topic out to the wrong
 * subscribers on a receiving worker. It checks the UNcorrupted routing key the app
 * fanned out on (carried on each delivered frame as `routingTopic`), NOT the
 * decodable envelope body, so it is immune to the `corrupt` fault, which mangles the
 * body but never the routing. Direct / control sends carry no routing topic and are
 * ignored. Returns the first violation or null.
 *
 * @param {Array<{ id: number, clients: Array<{ subscribed: Set<string>, frames: Array<{ routingTopic?: string | null }> }> }>} workers
 */
export function checkNoMisdelivery(workers) {
	for (const w of workers) {
		for (let ci = 0; ci < w.clients.length; ci++) {
			const c = w.clients[ci];
			for (const f of c.frames) {
				if (!f || f.routingTopic == null) continue; // only a topic publish carries a routing key
				if (!c.subscribed.has(f.routingTopic)) {
					return { category: 'cluster.misdelivery', context: { worker: w.id, client: ci, topic: f.routingTopic } };
				}
			}
		}
	}
	return null;
}

/**
 * Cross-worker state-convergence invariant. The relay replicates each originating
 * publish to every subscribing worker carrying the SAME per-topic sequence number
 * stamped INSIDE the envelope body by the originator. So every worker that has a
 * subscriber to a topic should end with the same delivered-seq run for it, and a
 * compact per-topic max-seq projection of two such workers should hash identically.
 * A worker whose projection hash differs received a different seq run - a relay
 * that dropped, duplicated, or misordered one worker's stream below the others.
 *
 * It reads the seq from the DELIVERED frame bodies, not any server-side seq map:
 * the originator stamps the seq once and the relay replicates it by delivery, so a
 * receiving worker's own seq map never advances (it re-publishes the pre-stamped
 * envelope). Reading delivered frames is what makes the cross-worker comparison
 * meaningful. Each worker projects `topicSeqs[routingTopic] = max(seq)` over its
 * clients' decoded frames, grouped on the UNcorrupted routing key (so the corrupt
 * fault, which mangles the body but never the routing, cannot move the projection;
 * a frame whose body fails to decode or carries no numeric seq simply does not
 * advance its topic's max). Only workers with a non-empty projection participate,
 * and they are bucketed by their exact topic set, so a publisher-only worker with
 * no subscriber to the projected topics is never compared against subscribers.
 *
 * Within a bucket of workers sharing the same topic set, the per-worker hashes are
 * grouped by value; a bucket with more than one distinct hash is a divergence. The
 * minority group (fewest workers; on a tie, the group holding the numerically
 * largest worker id, so the pick is deterministic) is reported as the offender.
 * The violation context lists the bucket topic set verbatim for diagnosability -
 * the same structured-log posture as the no-misdelivery check above and the
 * cluster snapshot, since the context is diagnostic data, not the privacy-bearing
 * hash. Returns the first divergence or null.
 *
 * @param {Array<{ id: number, clients: Array<{ frames?: Array<{ routingTopic?: string | null, payload?: string | Uint8Array }>, json?: () => any[] }> }>} workers
 * @returns {{ category: string, context: any } | null}
 */
export function checkStateConvergence(workers) {
	// Per worker: project the delivered per-topic max seq and hash it.
	/** @type {Array<{ id: number, topics: string[], hash: number }>} */
	const projected = [];
	for (const w of workers) {
		/** @type {Record<string, number>} */
		const topicSeqs = {};
		for (const c of w.clients) {
			const frames = c.frames || [];
			const decoded = typeof c.json === 'function' ? c.json() : null;
			for (let fi = 0; fi < frames.length; fi++) {
				const f = frames[fi];
				if (!f || f.routingTopic == null) continue; // only a topic publish carries a routing key
				const body = decoded ? decoded[fi] : decodeFrameBody(f);
				if (!body || typeof body.seq !== 'number') continue; // corrupt body or no seq: no advance
				const t = f.routingTopic;
				if (!(t in topicSeqs) || body.seq > topicSeqs[t]) topicSeqs[t] = body.seq;
			}
		}
		const topics = Object.keys(topicSeqs).sort();
		if (topics.length === 0) continue; // no delivered seq run: this worker does not participate
		projected.push({ id: w.id, topics, hash: computeStateHash({ topicSeqs }) });
	}

	// Bucket participating workers by their exact topic set, then look for a bucket
	// carrying more than one distinct hash. The bucket key is the JSON of the sorted
	// topic list (unambiguous - no delimiter a topic could itself contain), and the
	// list is carried alongside so the violation context uses it directly.
	/** @type {Map<string, { topics: string[], members: Array<{ id: number, hash: number }> }>} */
	const buckets = new Map();
	for (const p of projected) {
		const key = JSON.stringify(p.topics);
		let bucket = buckets.get(key);
		if (!bucket) { bucket = { topics: p.topics, members: [] }; buckets.set(key, bucket); }
		bucket.members.push({ id: p.id, hash: p.hash });
	}
	for (const { topics, members } of buckets.values()) {
		/** @type {Map<number, number[]>} hash -> worker ids */
		const byHash = new Map();
		for (const m of members) {
			let ids = byHash.get(m.hash);
			if (!ids) { ids = []; byHash.set(m.hash, ids); }
			ids.push(m.id);
		}
		if (byHash.size <= 1) continue; // converged within this bucket

		// Canonical group order: largest group first (the convergent majority), and
		// on a group-size tie the group holding the numerically-largest worker id
		// sorts LAST. So `majority` (the expected reference) is the first group and
		// `minority` (the reported offender) is the last; they are always distinct
		// groups because byHash carries more than one. A perfect even split has no
		// true majority, but this still names one deterministic offender group.
		const groups = [...byHash].map(([hash, ids]) => {
			const sorted = ids.slice().sort((a, b) => a - b);
			return { hash, ids: sorted, max: sorted[sorted.length - 1] };
		});
		groups.sort((a, b) => (b.ids.length - a.ids.length) || (a.max - b.max));
		const majority = groups[0];
		const minority = groups[groups.length - 1];
		return {
			category: 'cluster.state-divergence',
			context: {
				topics,
				expectedHash: majority.hash,
				divergentHash: minority.hash,
				workers: minority.ids
			}
		};
	}
	return null;
}

/**
 * Decode a delivered frame's JSON envelope body, mirroring the in-memory client
 * facade's `json()` (a non-JSON / corrupt frame becomes null). Used only when a
 * caller passes raw frames without a paired decoder. Pure - no clock/RNG.
 * @param {{ payload?: string | Uint8Array }} f
 * @returns {any}
 */
function decodeFrameBody(f) {
	const p = f && f.payload;
	if (p == null) return null;
	let text;
	if (typeof p === 'string') text = p;
	else { try { text = new TextDecoder().decode(p); } catch { return null; } }
	try { return JSON.parse(text); } catch { return null; }
}

export { RESTART_MAX_ATTEMPTS, RESTART_DELAY_MAX, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS };
