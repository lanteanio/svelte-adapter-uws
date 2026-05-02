/**
 * Rate limit plugin for svelte-adapter-uws.
 *
 * Token-bucket rate limiter for inbound WebSocket messages.
 * Supports per-IP, per-connection, or custom key extraction,
 * with optional auto-ban when a bucket is exhausted.
 *
 * Zero impact on the adapter core - this is a standalone module
 * that you call from your `message` hook to decide whether to
 * process or drop a message.
 *
 * @module svelte-adapter-uws/plugins/ratelimit
 */

/**
 * @typedef {Object} RateLimitOptions
 * @property {number} points - Tokens available per interval. Must be a positive integer.
 * @property {number} interval - Refill interval in milliseconds. Must be positive.
 * @property {number} [blockDuration=0] - If > 0, automatically ban the key for this many
 *   milliseconds when all tokens are consumed. Subsequent `consume()` calls return
 *   `{ allowed: false }` until the ban expires.
 * @property {'ip' | 'connection' | ((ws: any) => string)} [keyBy='ip'] - How to derive the
 *   rate-limit key from a WebSocket connection.
 *   - `'ip'` (default): uses `userData.remoteAddress`, `userData.ip`, or `'unknown'`
 *   - `'connection'`: each WebSocket object gets its own independent bucket
 *   - `function`: custom extractor, receives the ws and returns a string key
 * @property {number} [maxBuckets=1_000_000] - Hard cap on retained buckets. When the
 *   map crosses this size on a new insert, the oldest insertion-order entry is
 *   evicted. The lazy expired-entry sweep at 1000+ entries still runs first; the
 *   hard cap protects against sustained DDoS where every entry is unexpired.
 */

/**
 * @typedef {Object} ConsumeResult
 * @property {boolean} allowed - Whether the request was permitted.
 * @property {number} remaining - Tokens left in the bucket (0 if banned or exhausted).
 * @property {number} resetMs - Milliseconds until the bucket refills or the ban expires.
 */

/**
 * @typedef {Object} RateLimiter
 * @property {(ws: any, cost?: number) => ConsumeResult} consume -
 *   Attempt to consume tokens. Returns the result synchronously.
 * @property {(key: string) => void} reset - Clear the bucket for a key.
 * @property {(key: string, duration?: number) => void} ban -
 *   Manually ban a key. Uses `duration` or `blockDuration` or 60 000 ms.
 * @property {(key: string) => void} unban - Remove a ban (bucket stays, tokens unchanged).
 * @property {() => void} clear - Reset all state.
 */

/**
 * Create a rate limiter.
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

	const { points, interval, blockDuration = 0, keyBy = 'ip', maxBuckets = 1_000_000 } = options;

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

	/** Lazy cleanup when the map grows large. */
	function cleanup(now) {
		if (buckets.size <= 1000) return;
		for (const [key, bucket] of buckets) {
			if (bucket.resetAt <= now && bucket.bannedUntil <= now) {
				buckets.delete(key);
			}
		}
	}

	return {
		consume(ws, cost = 1) {
			if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
				throw new Error('ratelimit: cost must be a non-negative finite number');
			}
			const key = resolveKey(ws);
			const now = Date.now();

			cleanup(now);

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
				bucket = { points, resetAt: now + interval, bannedUntil: 0 };
				buckets.set(key, bucket);
			}

			// Check ban
			if (bucket.bannedUntil > now) {
				return { allowed: false, remaining: 0, resetMs: bucket.bannedUntil - now };
			}

			// Refill if interval elapsed
			if (bucket.resetAt <= now) {
				bucket.points = points;
				bucket.resetAt = now + interval;
			}

			// Try to consume
			if (bucket.points >= cost) {
				bucket.points -= cost;
				return {
					allowed: true,
					remaining: bucket.points,
					resetMs: bucket.resetAt - now
				};
			}

			// Exhausted - auto-ban if configured
			if (blockDuration > 0) {
				bucket.bannedUntil = now + blockDuration;
				return { allowed: false, remaining: 0, resetMs: blockDuration };
			}

			return {
				allowed: false,
				remaining: Math.max(0, bucket.points),
				resetMs: bucket.resetAt - now
			};
		},

		reset(key) {
			buckets.delete(key);
		},

		ban(key, duration) {
			const dur = duration ?? (blockDuration || 60000);
			const now = Date.now();
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { points: 0, resetAt: now + interval, bannedUntil: 0 };
				buckets.set(key, bucket);
			}
			bucket.bannedUntil = now + dur;
		},

		unban(key) {
			const bucket = buckets.get(key);
			if (bucket) bucket.bannedUntil = 0;
		},

		clear() {
			buckets.clear();
			connCounter = 0;
		}
	};
}
