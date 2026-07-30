export interface RateLimitOptions<UserData = unknown> {
	/**
	 * Allowance per interval. Must be a positive integer.
	 *
	 * @example
	 * ```js
	 * createRateLimit({ points: 10, interval: 1000 })
	 * // 10 messages per second
	 * ```
	 */
	points: number;

	/**
	 * Refill interval in milliseconds. Must be positive.
	 * When the interval elapses, the bucket refills to `points`.
	 */
	interval: number;

	/**
	 * If > 0, automatically ban the key for this many milliseconds
	 * when the allowance is exhausted. Subsequent `consume()` calls
	 * return `{ allowed: false }` until the ban expires.
	 *
	 * @default 0
	 */
	blockDuration?: number;

	/**
	 * How to derive the rate-limit key from a WebSocket connection.
	 *
	 * - `'ip'` (default): reads `userData.remoteAddress`, `.ip`, or `.address`
	 * - `'connection'`: each WebSocket object gets its own independent bucket
	 * - `function`: custom extractor, receives the ws and returns a string key
	 *
	 * @default 'ip'
	 */
	keyBy?: 'ip' | 'connection' | ((ws: import('uWebSockets.js').WebSocket<UserData>) => string);

	/**
	 * Optional per-connection tenant resolver. When set, the bucket key is scoped by the
	 * returned tenant id (joined to the key with a NUL, so it stays unambiguous even for
	 * IPv6 keys), so two tenants sharing an IP / connection / custom key get independent
	 * buckets and a tenant's `reset` / `ban` / `unban` / `clear` touch only that tenant.
	 * Mirrors the `redis/ratelimit` extension. Return null/undefined for an unscoped
	 * connection; omit for a single-tenant deploy (byte-identical).
	 */
	tenant?: (ws: import('uWebSockets.js').WebSocket<UserData>) => string | null | undefined;

	/**
	 * Hard cap on retained buckets. When the map crosses this size on a
	 * new insert, the oldest insertion-order entry is evicted. The lazy
	 * expired-entry sweep at 1000+ entries still runs first; the hard cap
	 * protects against sustained DDoS where every entry is unexpired.
	 *
	 * @default 1_000_000
	 */
	maxBuckets?: number;
}

export interface ConsumeResult {
	/** Whether the request was permitted. */
	allowed: boolean;
	/** Tokens remaining in the bucket (0 if banned or exhausted). */
	remaining: number;
	/** Milliseconds until the bucket refills or the ban expires. */
	resetMs: number;
}

export interface RateLimiter {
	/**
	 * Attempt to consume `cost` from this connection's allowance for the current window.
	 * Returns synchronously.
	 *
	 * @example
	 * ```js
	 * const { allowed } = limiter.consume(ws);
	 * if (!allowed) return; // drop message
	 * ```
	 */
	consume(ws: import('uWebSockets.js').WebSocket<any>, cost?: number): ConsumeResult;

	/** Clear the bucket for a key (optionally scoped to a tenant), allowing fresh requests. */
	reset(key: string, tenant?: string | null): void;

	/**
	 * Manually ban a key (optionally scoped to a tenant). Uses `duration`, or falls back
	 * to `blockDuration`, or defaults to 60 000 ms.
	 */
	ban(key: string, duration?: number, tenant?: string | null): void;

	/** Remove a ban (optionally scoped to a tenant). The bucket stays with its current token count. */
	unban(key: string, tenant?: string | null): void;

	/** Reset all state (buckets, bans, counters), or only one tenant's buckets when a tenant id is given. */
	clear(tenant?: string | null): void;
}

/**
 * Create a fixed-window rate limiter for WebSocket messages. Refills the
 * bucket wholesale when the window elapses, so a client can fire a full
 * bucket at the end of one window and another at the start of the next
 * (up to ~2x `points` inside a small seam); sustained rate is unaffected.
 *
 * @example
 * ```js
 * import { createRateLimit } from 'svelte-adapter-uws/plugins/ratelimit';
 *
 * export const limiter = createRateLimit({
 *   points: 10,
 *   interval: 1000,
 *   blockDuration: 30000
 * });
 * ```
 */
export function createRateLimit<UserData = unknown>(
	options: RateLimitOptions<UserData>
): RateLimiter;
