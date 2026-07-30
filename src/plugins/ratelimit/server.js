/**
 * Rate limit plugin for svelte-adapter-uws.
 *
 * Fixed-window rate limiter for inbound WebSocket messages.
 * Supports per-IP, per-connection, or custom key extraction,
 * with optional auto-ban when a bucket is exhausted.
 *
 * Fixed-window semantics: the allowance refills in full at each
 * interval boundary, so a client can fire a full window of messages
 * at the end of one interval and another full window at the start of
 * the next - up to 2x `points` inside a short seam. The adapter
 * core's upgrade limiter uses a sliding window to avoid exactly this.
 * If burst smoothness matters, prefer a smaller `points` / `interval`
 * pair with the same average rate.
 *
 * Zero impact on the adapter core - this is a standalone module
 * that you call from your `message` hook to decide whether to
 * process or drop a message.
 *
 * @module svelte-adapter-uws/plugins/ratelimit
 */

import { now } from '../../runtime/runtime.js';

/**
 * @typedef {Object} RateLimitOptions
 * @property {number} points - Allowance per interval. Must be a positive integer.
 * @property {number} interval - Refill interval in milliseconds. Must be positive.
 * @property {number} [blockDuration=0] - If > 0, automatically ban the key for this many
 *   milliseconds when the allowance is exhausted. Subsequent `consume()` calls return
 *   `{ allowed: false }` until the ban expires.
 * @property {'ip' | 'connection' | ((ws: any) => string)} [keyBy='ip'] - How to derive the
 *   rate-limit key from a WebSocket connection.
 *   - `'ip'` (default): uses `userData.remoteAddress`, `userData.ip`, or `'unknown'`
 *   - `'connection'`: each WebSocket object gets its own independent bucket
 *   - `function`: custom extractor, receives the ws and returns a string key
 * @property {(ws: any) => (string | null | undefined)} [tenant] - Optional per-connection
 *   tenant resolver. When set, the bucket key is scoped by the returned tenant id so two
 *   tenants sharing an IP / connection / custom key get independent buckets and a tenant's
 *   `reset` / `ban` / `unban` / `clear` touch only that tenant. Mirrors the `redis/ratelimit`
 *   extension. Return null/undefined for an unscoped connection; omit for a single-tenant
 *   deploy (byte-identical). The id is joined to the key with a NUL, so it stays unambiguous
 *   even when the key is an IPv6 address.
 * @property {number} [maxBuckets=1_000_000] - Hard cap on retained buckets. When the
 *   map crosses this size on a new insert, the oldest insertion-order entry is
 *   evicted. The lazy expired-entry sweep at 1000+ entries still runs first; the
 *   hard cap protects against sustained DDoS where every entry is unexpired.
 */

/**
 * @typedef {Object} ConsumeResult
 * @property {boolean} allowed - Whether the request was permitted.
 * @property {number} remaining - Allowance left in the current window (0 if banned or exhausted).
 * @property {number} resetMs - Milliseconds until the bucket refills or the ban expires.
 */

/**
 * @typedef {Object} RateLimiter
 * @property {(ws: any, cost?: number) => ConsumeResult} consume -
 *   Attempt to consume from the current window's allowance. Returns the result synchronously.
 * @property {(key: string, tenant?: string | null) => void} reset - Clear the bucket for a key.
 * @property {(key: string, duration?: number, tenant?: string | null) => void} ban -
 *   Manually ban a key. Uses `duration` or `blockDuration` or 60 000 ms.
 * @property {(key: string, tenant?: string | null) => void} unban - Remove a ban (the window counter is untouched).
 * @property {(tenant?: string | null) => void} clear - Reset all state, or only one tenant's buckets when a tenant id is given.
 */

/**
 * Create a fixed-window rate limiter.
 *
 * The allowance refills in full at each interval boundary (fixed
 * window, not token bucket): up to 2x `points` can pass inside a
 * short seam across a boundary. See the module header for the sizing
 * guidance.
 *
 * @param {RateLimitOptions} options
 * @returns {RateLimiter}
 *
 * @example
 * ```js
 * // src/lib/server/ratelimit.js
 * import { createRateLimit } from 'svelte-adapter-uws/plugins/ratelimit';
 *
 * export const limiter = createRateLimit({
 *   points: 10,
 *   interval: 1000,
 *   blockDuration: 30000
 * });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js
 * import { limiter } from '$lib/server/ratelimit';
 *
 * export function message(ws, { data, platform }) {
 *   const { allowed } = limiter.consume(ws);
 *   if (!allowed) return; // drop the message
 *   // ... handle message
 * }
 * ```
 */
export function createRateLimit(options) {
	if (!options || typeof options !== 'object') {
		throw new Error('ratelimit: options object is required');
	}

	const { points, interval, blockDuration = 0, keyBy = 'ip', tenant, maxBuckets = 1_000_000 } = options;

	if (!Number.isInteger(points) || points <= 0) {
		throw new Error('ratelimit: points must be a positive integer');
	}
	if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
		throw new Error('ratelimit: interval must be a positive number');
	}
	if (typeof blockDuration !== 'number' || !Number.isFinite(blockDuration) || blockDuration < 0) {
		throw new Error('ratelimit: blockDuration must be a non-negative number');
	}
	if (keyBy !== 'ip' && keyBy !== 'connection' && typeof keyBy !== 'function') {
		throw new Error("ratelimit: keyBy must be 'ip', 'connection', or a function");
	}
	if (tenant !== undefined && typeof tenant !== 'function') {
		throw new Error('ratelimit: tenant must be a function (ws) => id | null');
	}
	if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
		throw new Error('ratelimit: maxBuckets must be a positive integer');
	}

	/**
	 * Per-key bucket state.
	 * @type {Map<string, { points: number, resetAt: number, bannedUntil: number }>}
	 */
	const buckets = new Map();

	/** WeakMap for per-connection keying (avoids leaks). */
	const wsKeys = new WeakMap();
	let connCounter = 0;

	/**
	 * Derive the rate-limit key from a ws.
	 * @param {any} ws
	 * @returns {string}
	 */
	function resolveKey(ws) {
		if (typeof keyBy === 'function') return keyBy(ws);
		if (keyBy === 'connection') {
			let k = wsKeys.get(ws);
			if (!k) {
				k = '__conn:' + (++connCounter);
				wsKeys.set(ws, k);
			}
			return k;
		}
		// 'ip' - try common userData fields
		const ud = typeof ws.getUserData === 'function' ? ws.getUserData() : null;
		if (ud) {
			return String(ud.remoteAddress || ud.ip || ud.address || 'unknown');
		}
		return 'unknown';
	}

	// Scope the bucket key by the connection's tenant (when a `tenant` resolver is set),
	// FIRST and NUL-delimited so it stays unambiguous even for IPv6 keys. Null -> raw key
	// (byte-identical single-tenant key space). Mirrors redis/ratelimit's bucketKey. The id
	// is rejected if it contains the NUL delimiter (the one char that would let two distinct
	// tenants collide on one bucket); the check short-circuits on the null (default) path.
	function bucketKey(rawKey, tenantId) {
		if (tenantId && tenantId.indexOf('\0') !== -1) {
			throw new Error('ratelimit: tenant id must not contain a NUL byte (it is the bucket-key delimiter)');
		}
		return tenantId ? tenantId + '\0' + rawKey : rawKey;
	}

	/** Lazy cleanup when the map grows large. */
	function cleanup(t) {
		if (buckets.size <= 1000) return;
		for (const [key, bucket] of buckets) {
			if (bucket.resetAt <= t && bucket.bannedUntil <= t) {
				buckets.delete(key);
			}
		}
	}

	return {
		consume(ws, cost = 1) {
			if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
				throw new Error('ratelimit: cost must be a non-negative finite number');
			}
			const key = bucketKey(resolveKey(ws), tenant ? tenant(ws) : null);
			const t = now();

			cleanup(t);

			let bucket = buckets.get(key);
			if (!bucket) {
				// Hard cap: evict the oldest insertion-order entry if the
				// lazy expired-entry sweep above did not free a slot. The
				// dropped entry's worst-case cost to the system is one
				// extra "free" bucket for that key (the next consume()
				// recreates it with full points), which under sustained
				// DDoS is preferable to unbounded memory growth.
				if (buckets.size >= maxBuckets) {
					const oldest = buckets.keys().next().value;
					if (oldest !== undefined) buckets.delete(oldest);
				}
				bucket = { points, resetAt: t + interval, bannedUntil: 0 };
				buckets.set(key, bucket);
			}

			// Check ban
			if (bucket.bannedUntil > t) {
				return { allowed: false, remaining: 0, resetMs: bucket.bannedUntil - t };
			}

			// Refill if interval elapsed
			if (bucket.resetAt <= t) {
				bucket.points = points;
				bucket.resetAt = t + interval;
			}

			// Try to consume
			if (bucket.points >= cost) {
				bucket.points -= cost;
				return {
					allowed: true,
					remaining: bucket.points,
					resetMs: bucket.resetAt - t
				};
			}

			// Exhausted - auto-ban if configured
			if (blockDuration > 0) {
				bucket.bannedUntil = t + blockDuration;
				return { allowed: false, remaining: 0, resetMs: blockDuration };
			}

			return {
				allowed: false,
				remaining: Math.max(0, bucket.points),
				resetMs: bucket.resetAt - t
			};
		},

		reset(key, tenantId) {
			buckets.delete(bucketKey(key, tenantId));
		},

		ban(key, duration, tenantId) {
			const dur = duration ?? (blockDuration || 60000);
			const t = now();
			const bk = bucketKey(key, tenantId);
			let bucket = buckets.get(bk);
			if (!bucket) {
				bucket = { points: 0, resetAt: t + interval, bannedUntil: 0 };
				buckets.set(bk, bucket);
			}
			bucket.bannedUntil = t + dur;
		},

		unban(key, tenantId) {
			const bucket = buckets.get(bucketKey(key, tenantId));
			if (bucket) bucket.bannedUntil = 0;
		},

		// No tenant -> resets all state. Pass a tenant id to drop only that tenant's buckets.
		clear(tenantId) {
			if (tenantId) {
				const prefix = tenantId + '\0';
				for (const k of buckets.keys()) {
					if (k.startsWith(prefix)) buckets.delete(k);
				}
				return;
			}
			buckets.clear();
			connCounter = 0;
		}
	};
}
