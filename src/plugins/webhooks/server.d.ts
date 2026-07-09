/**
 * Generic outbound-webhook delivery primitive: SSRF-gated, DNS-pinned,
 * HMAC-signed HTTP POST with jittered-exponential retry. Transport-only and
 * framework-free - the realtime layer wraps it with event fan-out, failure
 * reporting, and dead-letter capture.
 *
 * @module svelte-adapter-uws/plugins/webhooks/server
 */

/** A resolved DNS address the SSRF pin will accept for a connection. */
export interface PinnedAddress {
	address: string;
	family: 4 | 6;
}

/** Per-webhook delivery configuration consumed by {@link deliverWebhook}. */
export interface WebhookDeliveryConfig<Event = string, Data = any> {
	/** The destination URL, or a function resolving it per event. */
	url: string | ((event: Event, data: Data) => string | Promise<string>);
	/** Map the event to the delivered JSON body; returning `null`/`undefined`
	 * skips delivery. Default body is `{ event, data }`. */
	transform?: (event: Event, data: Data) => any;
	/** HMAC-SHA256 secret; when set, signs the body (`x-webhook-signature`) and
	 * keys the idempotency header so it cannot be precomputed. */
	secret?: string;
	/** A second secret that ALSO signs (comma-appended) during a key rotation, so
	 * a receiver still verifying the old key keeps accepting deliveries. */
	previousSecret?: string;
	/** Retry policy for one delivery (5xx / 429 / network error / timeout). */
	retry?: {
		/** Max attempts (default 3). */
		attempts?: number;
		/** First backoff ceiling in ms (default 100). */
		initialDelayMs?: number;
		/** Backoff ceiling cap in ms (default 5000). */
		maxDelayMs?: number;
		/** Exponential multiplier (default 2). */
		backoffMultiplier?: number;
	};
	/** SSRF posture: 'strict' (default) / 'allowlist' enforce the private-range
	 * floor; 'off' relaxes ranges (scheme gate + rebinding pin still apply). */
	urlMode?: 'strict' | 'allowlist' | 'off';
	/** Extra allowlist entries passed through to `safe-url`'s `checkUrl`. */
	allow?: any;
	/** An ADDITIONAL restriction (logical AND): can only narrow the allowed set,
	 * never widen it. Return falsy to reject. */
	validateUrl?: (url: string) => boolean | Promise<boolean>;
	/** Custom DNS resolver for the SSRF pin (default `dns.lookup`, all addresses).
	 * Supplying one defaults the validated-pin cache OFF (the resolver owns its
	 * own rotation/caching semantics); an explicit `pinCacheMs` opts back in. */
	resolve?: (hostname: string) => Promise<Array<string | PinnedAddress> | string | PinnedAddress>;
	/** TTL in ms for the per-host validated-pin cache: a delivery burst (and
	 * every redirect hop back to an already-validated host) costs one DNS
	 * resolution per host per window. Only validated results are cached, so the
	 * rebinding pin and range check are unchanged. 0 disables. Default 30000
	 * with the built-in resolver, 0 with a custom `resolve`. */
	pinCacheMs?: number;
	/** Max redirect hops, each re-gated (default 5). */
	maxRedirects?: number;
	/** Per-attempt absolute deadline in ms covering DNS+connect+TTFB+body (default 10000). */
	timeoutMs?: number;
	/** Bound on each user callback (transform/url/validateUrl/resolve/idempotencyKey) in ms (default 10000). */
	callbackTimeoutMs?: number;
	/** Override the idempotency-key header value (default a stable content hash,
	 * HMAC-keyed when `secret` is set). Must be <=256 chars, no CR/LF/NUL. */
	idempotencyKey?: (event: Event, data: Data) => string | null | undefined | Promise<string | null | undefined>;
}

/** The terminal outcome of one delivery. The caller owns reporting + capture. */
export type WebhookDeliveryOutcome =
	| { ok: true }
	| { ok: false; err: Error; attempts: number };

/** A retry budget: `take` consumes one token, returning whether a retry may
 * proceed. In-process (sync) or cluster-shared (async); the key scopes the
 * budget per endpoint. */
export interface RetryBudget {
	take(key?: string): boolean | Promise<boolean>;
}

/** An endpoint-ejection circuit breaker. `guard` throws when the key's circuit
 * is open; `success`/`failure` record the terminal delivery outcome. Matches the
 * shape of the extensions `createCircuitBreaker` so a cluster deployment can
 * inject a shared breaker. */
export interface WebhookBreaker {
	guard(key?: string): void;
	success(key?: string): void;
	failure(err: any, key?: string): void;
}

/** Optional delivery controls injected into {@link deliverWebhook}. `key` scopes
 * both collaborators to one endpoint (the realtime layer passes the webhook's
 * registration id). */
export interface WebhookDeliveryHooks {
	budget?: RetryBudget;
	breaker?: WebhookBreaker;
	key?: string;
}

/** Options for {@link createRetryBudget}. */
export interface RetryBudgetOptions {
	/** Max tokens per key (default 100). */
	capacity?: number;
	/** Continuous refill rate in tokens/second (default 10). */
	refillPerSec?: number;
	/** Distinct-key cap before the oldest keyed bucket is evicted (default 1024). */
	maxKeys?: number;
}

/** The in-process {@link RetryBudget} returned by {@link createRetryBudget}. */
export interface InProcessRetryBudget extends RetryBudget {
	take(key?: string): boolean;
	tokensFor(key?: string): number;
	reset(key?: string): void;
}

/** Options for {@link createWebhookBreaker}. */
export interface WebhookBreakerOptions {
	/** Consecutive failures before a key opens (default 5). */
	failureThreshold?: number;
	/** Ms an open key waits before allowing a half-open probe (default 30000). */
	resetMs?: number;
	/** Distinct-key cap before the oldest keyed slot is evicted (default 1024). */
	maxKeys?: number;
}

/** The in-process {@link WebhookBreaker} returned by {@link createWebhookBreaker}. */
export interface InProcessWebhookBreaker extends WebhookBreaker {
	stateOf(key?: string): 'healthy' | 'broken' | 'probing';
	reset(key?: string): void;
}

/** Thrown by {@link createWebhookBreaker}'s `guard` when a key's circuit is open. */
export declare class WebhookCircuitOpenError extends Error {
	readonly code: 'WEBHOOK_CIRCUIT_OPEN';
}

/**
 * Create the in-process retry budget - the single-instance default for
 * `deliverWebhook`'s `hooks.budget`. A per-key token bucket that caps retry
 * amplification; a cluster deployment injects a Redis-backed budget instead.
 */
export function createRetryBudget(options?: RetryBudgetOptions): InProcessRetryBudget;

/**
 * Create the in-process endpoint-ejection breaker - the single-instance default
 * for `deliverWebhook`'s `hooks.breaker`. Per-key, lazily reset off the
 * monotonic clock (no timers); a cluster deployment injects a shared breaker.
 */
export function createWebhookBreaker(options?: WebhookBreakerOptions): InProcessWebhookBreaker;

/**
 * Strip credentials and query from a URL for safe logging - keeps only origin +
 * pathname; returns `'[unparseable-url]'` when it does not parse.
 */
export function redactUrl(url: string): string;

/**
 * Deliver one outbound webhook for `(topic, event, data)` under `config` and
 * return its terminal outcome. SSRF-gates the initial URL and every redirect
 * hop, pins the connection to validated addresses, attaches a stable idempotency
 * key and optional HMAC signature, and retries 5xx/429/network/timeout with
 * jittered backoff. Never throws and reports nothing - the caller inspects the
 * outcome for reporting and dead-letter capture.
 *
 * Pass `hooks` to inject delivery controls: `hooks.breaker` fast-fails an
 * ejected endpoint and records the terminal result, `hooks.budget` rations retry
 * amplification, both scoped by `hooks.key`. Omit `hooks` for bare delivery.
 */
export function deliverWebhook<Event = string, Data = any>(
	config: WebhookDeliveryConfig<Event, Data>,
	topic: string,
	event: Event,
	data: Data,
	hooks?: WebhookDeliveryHooks
): Promise<WebhookDeliveryOutcome>;
