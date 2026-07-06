// @ts-check
import { monotonicNow } from '../../runtime/runtime.js';

/**
 * In-process delivery controls for the outbound-webhook plugin: a retry budget
 * and an endpoint-ejection circuit breaker. Both are the single-instance
 * defaults that `deliverWebhook`'s `hooks` seam consumes; a cluster deployment
 * injects a shared (Redis-backed) implementation with the same interface
 * instead. State is per-key so one endpoint cannot starve or trip another; the
 * default key `''` is the single global slot for a caller that passes none.
 *
 * Time is read only through the runtime seam (`runtime/runtime.js`), so a seeded
 * or fake-clock harness controls refill and reset deterministically and the
 * determinism gate stays green.
 *
 * @module svelte-adapter-uws/plugins/webhooks/controls
 */

/** Default per-instance cap on distinct keys before the oldest keyed slot is evicted. */
const MAX_KEYS_DEFAULT = 1024;

/**
 * Evict the oldest non-default keyed slot when a map hits the cap. The `''`
 * global slot is never evicted; an evicted key simply recreates fresh on next
 * access - bounded graceful degradation, the same trade-off the rate limiter's
 * `maxBuckets` makes.
 */
function evictOldest(map) {
	for (const existing of map.keys()) {
		if (existing !== '') { map.delete(existing); return; }
	}
}

/**
 * Thrown by {@link createWebhookBreaker}'s `guard` when an endpoint's circuit is
 * open. `deliverWebhook` catches it and returns a terminal `attempts:0` outcome,
 * so the caller dead-letters the event without touching the network.
 */
export class WebhookCircuitOpenError extends Error {
	constructor(key) {
		super('outbound webhook: endpoint circuit open' + (key ? ' (' + key + ')' : ''));
		this.name = 'WebhookCircuitOpenError';
		/** @type {'WEBHOOK_CIRCUIT_OPEN'} */
		this.code = 'WEBHOOK_CIRCUIT_OPEN';
	}
}

/**
 * A per-key token-bucket retry budget. `take(key)` consumes one token, returning
 * `true` when a retry may proceed and `false` when the bucket is dry. Tokens
 * refill continuously at `refillPerSec` up to `capacity`. This caps the RETRY
 * amplification (it is consulted before each backoff, distinct from the
 * per-delivery `attempts` cap): a storm of failing deliveries to one endpoint
 * cannot launch unbounded retry work, while the first attempt of every delivery
 * always proceeds unrationed.
 *
 * @param {{ capacity?: number, refillPerSec?: number, maxKeys?: number }} [options]
 */
export function createRetryBudget(options = {}) {
	const capacity = options.capacity ?? 100;
	const refillPerSec = options.refillPerSec ?? 10;
	const maxKeys = options.maxKeys ?? MAX_KEYS_DEFAULT;
	if (!Number.isFinite(capacity) || capacity <= 0) {
		throw new Error('retry budget: capacity must be a positive number');
	}
	if (!Number.isFinite(refillPerSec) || refillPerSec < 0) {
		throw new Error('retry budget: refillPerSec must be a non-negative number');
	}
	if (!Number.isInteger(maxKeys) || maxKeys < 1) {
		throw new Error('retry budget: maxKeys must be a positive integer');
	}

	/** @type {Map<string, { tokens: number, ts: number }>} */
	const buckets = new Map();
	function bucketFor(key) {
		const k = key || '';
		let b = buckets.get(k);
		if (!b) {
			if (buckets.size >= maxKeys) evictOldest(buckets);
			b = { tokens: capacity, ts: monotonicNow() };
			buckets.set(k, b);
		}
		return b;
	}

	function refill(b) {
		const nowMs = monotonicNow();
		const elapsed = nowMs - b.ts;
		if (elapsed > 0) {
			b.tokens = Math.min(capacity, b.tokens + (elapsed / 1000) * refillPerSec);
			b.ts = nowMs;
		}
	}

	return {
		take(key) {
			const b = bucketFor(key);
			refill(b);
			if (b.tokens >= 1) { b.tokens -= 1; return true; }
			return false;
		},
		/** Current token count for a key (refilled), for tests / observability. */
		tokensFor(key) {
			const b = bucketFor(key);
			refill(b);
			return b.tokens;
		},
		/** Refill a key to full (or every key when called with no argument). */
		reset(key) {
			if (key === undefined) { buckets.clear(); return; }
			const b = buckets.get(key || '');
			if (b) { b.tokens = capacity; b.ts = monotonicNow(); }
		}
	};
}

/**
 * A per-key endpoint-ejection circuit breaker. After `failureThreshold`
 * consecutive delivery failures a key opens (`guard` throws
 * {@link WebhookCircuitOpenError}); after `resetMs` the next `guard` allows a
 * single half-open probe, which `success` closes or `failure` re-opens. State
 * resets lazily off the monotonic clock (no timers to leak), so it is fully
 * deterministic under a fake-clock harness.
 *
 * @param {{ failureThreshold?: number, resetMs?: number, maxKeys?: number }} [options]
 */
export function createWebhookBreaker(options = {}) {
	const failureThreshold = options.failureThreshold ?? 5;
	const resetMs = options.resetMs ?? 30000;
	const maxKeys = options.maxKeys ?? MAX_KEYS_DEFAULT;
	if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
		throw new Error('webhook breaker: failureThreshold must be a positive integer');
	}
	if (!Number.isFinite(resetMs) || resetMs < 0) {
		throw new Error('webhook breaker: resetMs must be a non-negative number');
	}
	if (!Number.isInteger(maxKeys) || maxKeys < 1) {
		throw new Error('webhook breaker: maxKeys must be a positive integer');
	}

	/** @type {Map<string, { state: 'healthy' | 'broken' | 'probing', failures: number, openedAt: number }>} */
	const states = new Map();
	function stateFor(key) {
		const k = key || '';
		let s = states.get(k);
		if (!s) {
			if (states.size >= maxKeys) evictOldest(states);
			s = { state: 'healthy', failures: 0, openedAt: 0 };
			states.set(k, s);
		}
		return s;
	}

	return {
		stateOf(key) { return stateFor(key).state; },

		guard(key) {
			const s = stateFor(key);
			if (s.state === 'healthy') return;
			if (s.state === 'broken') {
				if (monotonicNow() - s.openedAt >= resetMs) {
					// The reset window elapsed: let exactly one probe through and
					// hold the circuit half-open until it succeeds or fails.
					s.state = 'probing';
					return;
				}
				throw new WebhookCircuitOpenError(key);
			}
			// Already probing: a probe is in flight, reject the rest.
			throw new WebhookCircuitOpenError(key);
		},

		success(key) {
			const s = stateFor(key);
			s.failures = 0;
			s.state = 'healthy';
		},

		failure(_err, key) {
			const s = stateFor(key);
			if (s.state === 'probing') {
				// The half-open probe failed: re-open and restart the reset window.
				s.state = 'broken';
				s.openedAt = monotonicNow();
				return;
			}
			if (s.failures < failureThreshold) s.failures++;
			if (s.state === 'healthy' && s.failures >= failureThreshold) {
				s.state = 'broken';
				s.openedAt = monotonicNow();
			}
		},

		/** Force a key back to healthy (or every key when called with no argument). */
		reset(key) {
			if (key === undefined) { states.clear(); return; }
			const s = states.get(key || '');
			if (s) { s.state = 'healthy'; s.failures = 0; s.openedAt = 0; }
		}
	};
}
