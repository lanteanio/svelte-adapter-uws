// - Chaos / fault-injection state ------------------------------------------
// State machine consulted by the test harness to simulate broken-network
// conditions while exercising protocol code (subscribe acks, session resume,
// per-topic seq, sendCoalesced, request/reply, etc). Pure helper - no I/O,
// no module-state capture; one instance per server / per harness so parallel
// tests do not stomp on each other.
//
// Three continuous scenarios in this state machine:
//   - 'drop-outbound': probabilistically discard outbound frames before they
//     reach the wire. dropRate is a number in [0, 1].
//   - 'slow-drain': defer outbound frames by delayMs via setTimeout. Order
//     is preserved per call site (every frame waits the same delay).
//   - 'ipc-reorder': defer each outbound frame by an independently-random
//     delay in [0, maxJitterMs]. Adjacent frames can arrive out of order,
//     simulating cross-worker relay reordering or queue jitter.
//
// One scenario lives outside this state machine because it is a one-shot
// trigger rather than continuous state:
//   - 'worker-flap': close all live WebSocket connections with a configurable
//     code/reason, simulating a worker process restart in cluster mode. The
//     test harness handles this directly inside its `__chaos` setter; the
//     chaos state machine does NOT track it.

/** Cap on the jitter window for `ipc-reorder` to keep the delay bounded. */
const CHAOS_MAX_JITTER_MS = 60_000;

/**
 * Build a chaos state machine. Inactive by default; callers gate their
 * interception logic on `state.scenario !== null`.
 *
 * @param {{ random?: () => number }} [opts] Optional injection point for
 *   tests that need a deterministic RNG (default `Math.random`).
 */
export function createChaosState(opts) {
	const random = (opts && opts.random) || Math.random;
	/** @type {{ scenario: string | null, dropRate: number, delayMs: number, maxJitterMs: number }} */
	const state = { scenario: null, dropRate: 0, delayMs: 0, maxJitterMs: 0 };

	return {
		get scenario() { return state.scenario; },
		get dropRate() { return state.dropRate; },
		get delayMs() { return state.delayMs; },
		get maxJitterMs() { return state.maxJitterMs; },

		/**
		 * Activate a scenario. Pass `null` (or call `reset()`) to clear.
		 *
		 * @param {{
		 *   scenario: 'drop-outbound' | 'slow-drain' | 'ipc-reorder',
		 *   dropRate?: number,
		 *   delayMs?: number,
		 *   maxJitterMs?: number
		 * } | null} cfg
		 */
		set(cfg) {
			if (cfg === null || cfg === undefined) {
				state.scenario = null;
				state.dropRate = 0;
				state.delayMs = 0;
				state.maxJitterMs = 0;
				return;
			}
			if (cfg.scenario === 'drop-outbound') {
				const r = typeof cfg.dropRate === 'number' ? cfg.dropRate : 0;
				if (r < 0 || r > 1 || Number.isNaN(r)) {
					throw new Error('chaos: dropRate must be a number in [0, 1]');
				}
				state.scenario = 'drop-outbound';
				state.dropRate = r;
				state.delayMs = 0;
				state.maxJitterMs = 0;
				return;
			}
			if (cfg.scenario === 'slow-drain') {
				const d = typeof cfg.delayMs === 'number' ? cfg.delayMs : 0;
				if (d < 0 || !Number.isFinite(d)) {
					throw new Error('chaos: delayMs must be a non-negative finite number');
				}
				state.scenario = 'slow-drain';
				state.delayMs = d;
				state.dropRate = 0;
				state.maxJitterMs = 0;
				return;
			}
			if (cfg.scenario === 'ipc-reorder') {
				const j = typeof cfg.maxJitterMs === 'number' ? cfg.maxJitterMs : 0;
				if (j < 0 || !Number.isFinite(j)) {
					throw new Error('chaos: maxJitterMs must be a non-negative finite number');
				}
				if (j > CHAOS_MAX_JITTER_MS) {
					throw new Error('chaos: maxJitterMs must be <= ' + CHAOS_MAX_JITTER_MS);
				}
				state.scenario = 'ipc-reorder';
				state.maxJitterMs = j;
				state.dropRate = 0;
				state.delayMs = 0;
				return;
			}
			throw new Error(
				`chaos: unknown scenario '${cfg.scenario}'. Supported: 'drop-outbound', 'slow-drain', 'ipc-reorder'.`
			);
		},

		reset() {
			state.scenario = null;
			state.dropRate = 0;
			state.delayMs = 0;
			state.maxJitterMs = 0;
		},

		/**
		 * Returns true if the caller should drop the outbound frame. Always
		 * false when the active scenario is not 'drop-outbound'. dropRate of
		 * 0 never drops; dropRate of 1 always drops; values in between drop
		 * with the configured probability.
		 */
		shouldDropOutbound() {
			if (state.scenario !== 'drop-outbound') return false;
			if (state.dropRate <= 0) return false;
			if (state.dropRate >= 1) return true;
			return random() < state.dropRate;
		},

		/**
		 * Returns the delay in ms the caller should defer an outbound frame
		 * by. Three cases:
		 * - `slow-drain`: returns the configured `delayMs` (constant, order
		 *   preserved across frames).
		 * - `ipc-reorder`: returns an independently-random delay in
		 *   `[0, maxJitterMs)`, so adjacent frames can arrive out of order.
		 * - any other scenario (or `null`): returns 0.
		 */
		getDelayMs() {
			if (state.scenario === 'slow-drain') return state.delayMs;
			if (state.scenario === 'ipc-reorder') return random() * state.maxJitterMs;
			return 0;
		}
	};
}
