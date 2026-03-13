export interface RateLimitOptions<UserData = unknown> {
	/**
	 * Tokens available per interval. Must be a positive integer.
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
	 * when all tokens are consumed. Subsequent `consume()` calls
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
	 * Attempt to consume `cost` tokens from the bucket for this connection.
	 * Returns synchronously.
	 *
	 * @example
	 * ```js
	 * const { allowed } = limiter.consume(ws);
	 * if (!allowed) return; // drop message
	 * ```
	 */
	consume(ws: import('uWebSockets.js').WebSocket<any>, cost?: number): ConsumeResult;

	/** Clear the bucket for a key, allowing fresh requests. */
	reset(key: string): void;

	/**
	 * Manually ban a key. Uses `duration`, or falls back to `blockDuration`,
	 * or defaults to 60 000 ms.
	 */
	ban(key: string, duration?: number): void;

	/** Remove a ban. The bucket stays with its current token count. */
	unban(key: string): void;

	/** Reset all state (buckets, bans, counters). */
	clear(): void;
}

/**
 * Create a token-bucket rate limiter for WebSocket messages.
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
