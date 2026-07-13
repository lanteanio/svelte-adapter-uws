// Pure decision helpers for the worker-supervision protocol, factored out of the
// is_primary / worker branches of index.js so they are drivable in a unit test
// without spawning worker threads (index.js spawns real ones) and so the
// deterministic cluster sim judges liveness through the SAME decisions it ships -
// one source of truth, no parallel model to drift. Three functions:
//   - classifyWorkerHealth: the primary's per-worker escalate/keep verdict.
//   - resolveBootTimeout:   clamps the WORKER_BOOT_TIMEOUT_MS knob to a safe floor.
//   - routeWorkerMessage:   the worker's boot-time inbound-control-message gate.
//
// Two regimes, flipped at the ready/descriptor moment (NOT at the first heartbeat
// ack):
//
//   - steady-state: a worker that has confirmed ready but then went silent past
//     the steady timeout is wedged (deadlock / infinite loop). lastHeartbeat is
//     always > 0 once a worker has reported ready.
//
//   - boot: a worker still running its `init` hook. A healthy async init answers
//     the primary's heartbeats (its pre-start liveness responder is live before
//     `await start()`), so its clock keeps advancing and it is NEVER boot-killed
//     however slow it is; an init that wedges the event loop (a sync loop / native
//     hang) never acks, so its clock - lastHeartbeat once it has acked at least
//     once, else spawnedAt - goes stale past the (separate, generous) boot deadline
//     and the slot is escalated. The boot deadline is kept distinct from the steady
//     timeout so a slow-but-healthy warmup whose sync stretches exceed the tight
//     steady timeout is not false-killed; `bootTimeoutMs <= 0` disables it (a wedged
//     boot then stays stranded, the pre-fix behavior).

/**
 * @typedef {{ ready: boolean, lastHeartbeat: number, spawnedAt: number }} HealthMeta
 * @typedef {{ escalate: false } | { escalate: true, regime: 'steady' | 'boot', reason: string }} HealthVerdict
 */

/**
 * @param {HealthMeta} meta
 * @param {number} now  monotonic clock reading for this scan
 * @param {{ steadyTimeoutMs: number, bootTimeoutMs: number }} opts
 * @returns {HealthVerdict}
 */
export function classifyWorkerHealth(meta, now, { steadyTimeoutMs, bootTimeoutMs }) {
	if (meta.ready) {
		if (now - meta.lastHeartbeat > steadyTimeoutMs) {
			return { escalate: true, regime: 'steady', reason: `unresponsive (no heartbeat ack in ${steadyTimeoutMs}ms)` };
		}
	} else if (bootTimeoutMs > 0) {
		const reference = meta.lastHeartbeat > 0 ? meta.lastHeartbeat : meta.spawnedAt;
		if (now - reference > bootTimeoutMs) {
			return {
				escalate: true,
				regime: 'boot',
				reason: `wedged during init (no liveness ack within the ${bootTimeoutMs}ms WORKER_BOOT_TIMEOUT_MS boot deadline)`
			};
		}
	}
	return { escalate: false };
}

/**
 * Resolve the configured boot deadline against a safe floor. A worker can only prove
 * liveness by ANSWERING a heartbeat: the primary sends its first heartbeat one
 * interval after spawn, and a healthy worker's liveness clock then trails by up to
 * one interval between pings. So a deadline below TWO heartbeat intervals could still
 * escalate a healthy worker at a sweep boundary - at the first sweep it is judged on
 * `spawnedAt` (no ack was possible yet), and a boot that outlasts a single interval
 * would be killed with near-zero margin, crash-looping a slow-but-healthy boot. The
 * floor (the caller passes two intervals) gives a full interval of headroom, so only
 * a genuine no-ack wedge is ever escalated. A positive value below the floor is
 * raised to it; 0 stays 0 and disables the deadline. `clamped` lets the caller warn
 * once that it adjusted the operator's value.
 *
 * @param {number} raw  the parsed WORKER_BOOT_TIMEOUT_MS (>= 0)
 * @param {number} floorMs  the minimum safe deadline (two heartbeat intervals)
 * @returns {{ bootTimeoutMs: number, clamped: boolean }}
 */
export function resolveBootTimeout(raw, floorMs) {
	if (raw <= 0) return { bootTimeoutMs: 0, clamped: false };
	if (raw < floorMs) return { bootTimeoutMs: floorMs, clamped: true };
	return { bootTimeoutMs: raw, clamped: false };
}

/**
 * The worker's boot-time gate for an inbound primary control message. The worker
 * registers its message handler BEFORE `await start()` so it answers liveness
 * heartbeats while its `init` hook runs (or wedges); until the handler graph is live
 * (`booted`), only liveness and terminate may act - relay / shutdown / tls-reload
 * must be buffered and replayed in arrival order, never dispatched into a half-built
 * graph. This returns which of those four actions a message maps to.
 *
 * @param {string} type  the message `type`
 * @param {boolean} booted  has `start()` resolved and the handler graph gone live
 * @returns {'ack' | 'terminate' | 'dispatch' | 'buffer'}
 */
export function routeWorkerMessage(type, booted) {
	if (type === 'heartbeat') return 'ack';
	if (type === 'terminate') return 'terminate';
	return booted ? 'dispatch' : 'buffer';
}
