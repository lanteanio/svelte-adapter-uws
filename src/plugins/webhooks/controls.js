// @ts-check
import { monotonicNow } from '../../runtime/runtime.js';

/**
 * In-process delivery controls for the outbound-webhook plugin: a first-attempt
 * admission gate, a retry budget and an endpoint-ejection circuit breaker. All
 * three are the single-instance defaults that `deliverWebhook`'s `hooks` seam
 * consumes; a cluster deployment injects a shared (Redis-backed) implementation
 * with the same interface instead. State is per-key, so spending one endpoint's
 * allowance or tripping its circuit does not spend or trip another's; the
 * default key `''` is the single global slot for a caller that passes none.
 * Keys do contend for one thing - the `maxKeys` slots the instance tracks, which
 * is what bounds the whole instance rather than each key separately.
 *
 * Time is read only through the runtime seam (`runtime/runtime.js`), so a seeded
 * or fake-clock harness controls refill and reset deterministically and the
 * determinism gate stays green.
 *
 * @module svelte-adapter-uws/plugins/webhooks/controls
 */

/** Default per-instance cap on how many distinct keys hold state at once. */
const MAX_KEYS_DEFAULT = 1024;

/**
 * How long a reclaim pass that freed nothing waits before running again, when
 * the control has no faster lower bound of its own.
 */
const SWEEP_RETRY_MS = 1000;

/**
 * Reclaim slots in a capped map, taking ONLY entries that carry no enforcement
 * state - entries indistinguishable from one that was never created.
 *
 * This is the whole point of the helper. Evicting an entry that IS holding
 * something down hands that state back: the drained bucket or the open circuit
 * disappears and the next access recreates it full and healthy. Anything that
 * can push entries out of the map therefore clears its own enforcement record
 * just by naming keys nobody cares about, and a ceiling that a flood of junk
 * keys resets is not a ceiling. `holdsState` decides which entries are still
 * doing work; the rest are removed, and removing them is exactly equivalent to
 * keeping them.
 *
 * The pass is a full walk rather than a head sample, so reclamation is exact
 * instead of probabilistic - insertion order puts the longest-lived keys first,
 * which is the worst possible sample. It runs only when a new key arrives at
 * the cap, and the callers block a pass that freed nothing until enough time
 * has passed for one to be able to free something, so a flood of one-shot keys
 * cannot turn every insert into a walk of the whole map. The `''` global slot
 * is never reclaimed.
 *
 * @returns {number} how many slots were freed
 */
function sweepReclaimable(map, holdsState) {
	let freed = 0;
	for (const [key, entry] of map) {
		if (key === '') continue;
		if (!holdsState(entry)) { map.delete(key); freed++; }
	}
	return freed;
}

/**
 * The per-key token bucket both rate controls are built from: continuous refill
 * at `refillPerSec` up to `capacity`, bounded key count, `label` naming the
 * control in the option-validation errors. Kept in one place so the admission
 * gate and the retry budget cannot drift in refill or reclamation behaviour.
 *
 * `maxKeys` is a hard cap on how many keys hold an allowance down at once, and
 * that is what makes the aggregate bound real: a bucket is dropped only once it
 * has refilled to full, so no key ever gets its spent tokens back by being
 * pushed out of the map. Across the whole instance, admissions over a window of
 * `T` seconds are therefore at most `maxKeys * capacity + maxKeys *
 * refillPerSec * T`. When every tracked key is mid-spend, a key with no slot is
 * refused rather than granted an untracked allowance - refusing is what keeps
 * that sum an upper bound.
 */
function createTokenBuckets(label, options, defaults) {
	const capacity = options.capacity ?? defaults.capacity;
	const refillPerSec = options.refillPerSec ?? defaults.refillPerSec;
	const maxKeys = options.maxKeys ?? MAX_KEYS_DEFAULT;
	if (!Number.isFinite(capacity) || capacity <= 0) {
		throw new Error(label + ': capacity must be a positive number');
	}
	if (!Number.isFinite(refillPerSec) || refillPerSec < 0) {
		throw new Error(label + ': refillPerSec must be a non-negative number');
	}
	if (!Number.isInteger(maxKeys) || maxKeys < 1) {
		throw new Error(label + ': maxKeys must be a positive integer');
	}

	/** @type {Map<string, { tokens: number, ts: number }>} */
	const buckets = new Map();
	// A bucket becomes reclaimable only by refilling, so a pass that freed
	// nothing cannot find more until at least one token's worth of time has
	// gone by. With no refill at all nothing ever becomes reclaimable on its
	// own, and the pass just idles at the same rate until a `reset`.
	const sweepRetryMs = refillPerSec > 0 ? Math.min(SWEEP_RETRY_MS, 1000 / refillPerSec) : SWEEP_RETRY_MS;
	let sweepBlockedUntil = 0;

	function refill(b) {
		const nowMs = monotonicNow();
		const elapsed = nowMs - b.ts;
		if (elapsed > 0) {
			b.tokens = Math.min(capacity, b.tokens + (elapsed / 1000) * refillPerSec);
			b.ts = nowMs;
		}
	}

	/**
	 * A bucket back at full capacity is holding nothing down: dropping it and
	 * recreating it on the next access yields the identical bucket, so it is the
	 * one entry that can be reclaimed without handing an allowance back.
	 */
	function holdsAllowance(b) {
		refill(b);
		return b.tokens < capacity;
	}

	/**
	 * The bucket for a key, or null when the instance is already tracking
	 * `maxKeys` keys and every one of them is mid-spend. Null is a real answer,
	 * not a failure: it is the aggregate ceiling refusing to open a slot it
	 * cannot account for.
	 */
	function bucketFor(key) {
		const k = key || '';
		let b = buckets.get(k);
		if (b) return b;
		if (k !== '' && buckets.size >= maxKeys) {
			const nowMs = monotonicNow();
			if (nowMs < sweepBlockedUntil) return null;
			if (sweepReclaimable(buckets, holdsAllowance) === 0) {
				sweepBlockedUntil = nowMs + sweepRetryMs;
				return null;
			}
		}
		b = { tokens: capacity, ts: monotonicNow() };
		buckets.set(k, b);
		return b;
	}

	return {
		take(key) {
			const b = bucketFor(key);
			if (b === null) return false;
			refill(b);
			if (b.tokens >= 1) { b.tokens -= 1; return true; }
			return false;
		},
		/**
		 * Current token count for a key (refilled), for tests / observability.
		 * Reads only: a key with no live bucket has spent nothing and reports
		 * `capacity`, rather than being created (and possibly reclaiming another
		 * key's slot) just because something asked about it.
		 *
		 * It answers that key's allowance and nothing about slot availability, so
		 * the two can disagree at the cap: with `maxKeys` keys tracked and none
		 * reclaimable, an untracked key reports `capacity` while `take` refuses it
		 * for want of a slot.
		 */
		tokensFor(key) {
			const b = buckets.get(key || '');
			if (b === undefined) return capacity;
			refill(b);
			return b.tokens;
		},
		/** Refill a key to full (or every key when called with no argument). */
		reset(key) {
			// Slots just became reclaimable, so let the next miss look again.
			sweepBlockedUntil = 0;
			if (key === undefined) { buckets.clear(); return; }
			const b = buckets.get(key || '');
			if (b) { b.tokens = capacity; b.ts = monotonicNow(); }
		}
	};
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
 * Thrown into the delivery outcome by `deliverWebhook` when a destination is
 * over its first-attempt allowance. Distinct from a delivery failure on purpose:
 * nothing was sent and the endpoint said nothing, so the caller should requeue
 * the event rather than dead-letter it as a rejected delivery.
 */
export class WebhookAdmissionDeniedError extends Error {
	constructor(destination) {
		super('outbound webhook: destination over its first-attempt allowance' + (destination ? ' (' + destination + ')' : ''));
		this.name = 'WebhookAdmissionDeniedError';
		/** @type {'WEBHOOK_ADMISSION_DENIED'} */
		this.code = 'WEBHOOK_ADMISSION_DENIED';
	}
}

/**
 * A per-DESTINATION token-bucket admission gate for FIRST attempts.
 * `take(destination)` consumes one token, returning `true` when a delivery may
 * start and `false` when the destination is over its allowance; tokens refill
 * continuously at `refillPerSec` up to `capacity`.
 *
 * The key is not a caller-chosen name and not the URL: `deliverWebhook` passes
 * `<address>:<port>` for an address its SSRF gate resolved and pinned the socket
 * to, and calls `take` once for EVERY address in that pin. A per-registration
 * key would hand every extra registration, alias or per-event `url` callback
 * aimed at one endpoint its own full allowance, and keying by URL origin only
 * narrows that, because the caller picks the hostname too: `127.0.0.1:8080`,
 * `localhost:8080`, `localhost.:8080` and any number of wildcard-DNS names are
 * distinct origins that reach one listener. Keying by pinned address collapses
 * all of those onto one bucket, and charging the whole pinned set is what makes
 * the address the socket actually lands on always one of the addresses charged.
 *
 * What that does NOT cover, precisely:
 * - One logical endpoint published on several addresses (separate IPv4 and IPv6
 *   literals, or DNS answers whose address sets differ) is several destinations,
 *   holds one allowance each, and a delivery to it spends one unit at each.
 * - Because the whole set is charged, a caller who controls its own DNS answer
 *   can spend unrelated addresses' allowances without sending them any traffic.
 *   The answer is capped at 32 addresses, so one admitted delivery charges up to
 *   32 buckets while one request goes out. The padded addresses need not be the
 *   caller's own, so this can exhaust a co-tenant's bucket rather than only the
 *   caller's; the cap is the multiplier, and lowering it lowers the exposure.
 * - A redirect hop is NOT charged: the gate is consulted once, at hop zero,
 *   because charging a hop the destination chooses would let any registration
 *   drain a bystander. Up to `maxRedirects` requests per admitted delivery are
 *   therefore unmetered here, though the address checks still run on each hop.
 *
 * What holds without qualification is only this: a request cannot be put on an
 * address at hop zero without spending that address's unit.
 * - A refusal part-way through a multi-address set keeps the units already
 *   spent, so a refused delivery can cost more than it sent, never less.
 * - The gate is per-process, so a cluster multiplies by replica count until a
 *   shared implementation with this interface is injected through the same seam.
 *
 * The aggregate ceiling for the whole instance is `maxKeys * capacity` admitted
 * deliveries in a burst and `maxKeys * refillPerSec` per second sustained -
 * 102,400 and 10,240 on the defaults (a delivery charging several addresses
 * consumes more than one unit, so it can only come out under those). That
 * product is a real bound rather than an estimate, because a destination's
 * bucket is dropped only after it has refilled to full and a key that cannot be
 * given a slot is refused; lower `maxKeys` to lower the aggregate. It bounds
 * admitted DELIVERIES, not HTTP requests: one admitted delivery may issue up to
 * `retry.attempts` x (`maxRedirects` + 1) requests (18 on the delivery
 * defaults), so an outbound path carries that multiple of the figure.
 *
 * @param {{ capacity?: number, refillPerSec?: number, maxKeys?: number }} [options]
 */
export function createWebhookAdmission(options = {}) {
	return createTokenBuckets('webhook admission', options, { capacity: 100, refillPerSec: 10 });
}

/**
 * A per-key token-bucket retry budget. `take(key)` consumes one token, returning
 * `true` when a retry may proceed and `false` when the bucket is dry. Tokens
 * refill continuously at `refillPerSec` up to `capacity`. This caps the RETRY
 * amplification (it is consulted before each backoff, distinct from the
 * per-delivery `attempts` cap): a storm of failing deliveries to one endpoint
 * cannot launch unbounded retry work. First attempts are rationed separately by
 * {@link createWebhookAdmission}; without one they proceed unrationed.
 *
 * @param {{ capacity?: number, refillPerSec?: number, maxKeys?: number }} [options]
 */
export function createRetryBudget(options = {}) {
	return createTokenBuckets('retry budget', options, { capacity: 100, refillPerSec: 10 });
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
	let sweepBlockedUntil = 0;

	/**
	 * A key that is healthy with no failures recorded is in the state a fresh
	 * key starts in, so its slot can be reclaimed without forgetting anything.
	 * An ejected (or part-way-to-ejected) endpoint is not reclaimable: dropping
	 * it would close its circuit, which is the same bypass a token bucket has
	 * when a drained key is evicted.
	 */
	function holdsFailureRecord(s) {
		return s.state !== 'healthy' || s.failures > 0;
	}

	function stateFor(key) {
		const k = key || '';
		let s = states.get(k);
		if (s) return s;
		s = { state: 'healthy', failures: 0, openedAt: 0 };
		if (k !== '' && states.size >= maxKeys) {
			const nowMs = monotonicNow();
			let freed = 0;
			if (nowMs >= sweepBlockedUntil) {
				freed = sweepReclaimable(states, holdsFailureRecord);
				if (freed === 0) sweepBlockedUntil = nowMs + SWEEP_RETRY_MS;
			}
			// Every tracked key is carrying a failure record and there is no room
			// for another. Hand back a DETACHED healthy state: the new key goes
			// untracked (its failures are not counted, so it is never ejected)
			// instead of an already-ejected endpoint being let back in. A breaker
			// is a health signal, so failing to track one endpoint is a small loss
			// where forgetting an ejection is a loud one.
			if (freed === 0) return s;
		}
		states.set(k, s);
		return s;
	}

	return {
		/**
		 * The key's circuit state, for tests / observability. Reads only, like the
		 * token buckets' `tokensFor`: a key with no tracked state has recorded no
		 * failure and is healthy, so asking about it must not create an entry and
		 * spend one of the `maxKeys` slots (nor set off a reclaim pass) just
		 * because something looked.
		 */
		stateOf(key) {
			const s = states.get(key || '');
			return s === undefined ? 'healthy' : s.state;
		},

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
			// Slots just became reclaimable, so let the next miss look again.
			sweepBlockedUntil = 0;
			if (key === undefined) { states.clear(); return; }
			const s = states.get(key || '');
			if (s) { s.state = 'healthy'; s.failures = 0; s.openedAt = 0; }
		}
	};
}
