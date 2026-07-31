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
	 * new insert, one entry is evicted to make room. The lazy expired-entry
	 * sweep at 1000+ entries still runs first; the hard cap protects against
	 * sustained DDoS where every entry is unexpired.
	 *
	 * The victim is the least active entry of a sample, where activity is the
	 * allowance drawn across the current window and the one before it - so a
	 * flood of one-shot identities is evicted in preference to a client that
	 * has been messaging. A key still serving a ban is not a candidate at all
	 * while any unbanned entry is in the sample; when every SAMPLED candidate
	 * is banned, the one dropped is the most recently placed ban OF THAT
	 * SAMPLE. That rule is sample-local, not map-wide: an eviction inspects
	 * `evictionSample` entries, so it can drop a ban while newer bans sit
	 * elsewhere in the map.
	 *
	 * What holds map-wide is the far end of the same rule: the ban placed
	 * longest ago is never the victim, because any other sampled ban outranks
	 * it and any sampled unbanned entry is preferred to it - so identity
	 * churn, which can only add newer bans, cannot clear the OLDEST ban in
	 * the map. That needs an eviction able to see two entries at once -
	 * `evictionSample >= 2` (the default is 16) and a cap above one bucket;
	 * a sample that lands on a single entry takes it, ban and all.
	 *
	 * It is not a promise that a ban always survives. A map saturated with
	 * bans must drop one to admit any new key, and past the oldest one any
	 * ban can be the one that goes - including a chosen one, if the traffic
	 * first fills the map with bans placed BEFORE the ban it wants gone.
	 * Every such drop is reported through `onEvict` with `banned: true`, and
	 * sizing `maxBuckets` above the number of bans you expect in flight is
	 * what actually keeps enforcement intact.
	 *
	 * @default 1_000_000
	 */
	maxBuckets?: number;

	/**
	 * How many entries an eviction inspects before choosing its victim.
	 * Larger samples choose better and cost more; the whole map is inspected
	 * when it holds fewer entries than this.
	 *
	 * @default 16
	 */
	evictionSample?: number;

	/**
	 * Called once per eviction with the bucket key that was dropped
	 * (tenant-scoped, so it is `tenantId + '\0' + key` when a `tenant`
	 * resolver is set).
	 *
	 * `banned` is true when every sampled candidate was still serving a ban
	 * and enforcement state had to be dropped anyway - the case worth
	 * alerting on, since it means the cap is too small for the number of
	 * bans in flight.
	 *
	 * Called after the triggering call has finished deciding, so a listener
	 * that throws cannot change what that call charged, refused or banned -
	 * it only robs the caller of the return value.
	 *
	 * @example
	 * ```js
	 * createRateLimit({
	 *   points: 10,
	 *   interval: 1000,
	 *   onEvict: ({ key, banned }) => { if (banned) log.warn('ban lost', key); }
	 * })
	 * ```
	 */
	onEvict?: (evicted: { key: string; banned: boolean }) => void;
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
	 *
	 * Banning a key the limiter has not seen inserts a bucket, so at `maxBuckets` it
	 * evicts another key's bucket to make room. An app that bans ids supplied by the
	 * traffic it is defending against therefore hands the attacker one eviction of
	 * somebody else's rate-limit state per ban.
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
