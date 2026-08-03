/**
 * Generic outbound-webhook delivery primitive: SSRF-gated, DNS-pinned,
 * HMAC-signed HTTP POST with jittered-exponential retry. Transport-only and
 * framework-free - the realtime layer wraps it with event fan-out, failure
 * reporting, and dead-letter capture.
 *
 * @module svelte-adapter-uws/plugins/webhooks/server
 */

import type { TraceContext } from '../../observability.js';

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
	/**
	 * HMAC-SHA256 secret. When set, signs the delivery and keys the
	 * idempotency header so it cannot be precomputed.
	 *
	 * THE RECEIVER CONTRACT, in full - the signature is worth nothing if the
	 * far side verifies it loosely:
	 *
	 * 1. Read `x-webhook-timestamp`. Reject unless it matches `/^\d+$/`. This
	 *    check is load-bearing, not hygiene: it is what makes the `.`
	 *    delimiter unambiguous, so a body containing a dot cannot be re-split
	 *    into a different timestamp/body pair that signs identically.
	 * 2. Reject if it is more than 300 seconds (5 minutes) from your own
	 *    clock, in either direction. Without this the signature never expires
	 *    and a captured delivery replays forever - which is the entire point
	 *    of signing the timestamp.
	 * 3. Recompute `HMAC_SHA256(secret, timestamp + '.' + rawBody)` over the
	 *    RAW body bytes, before any JSON parse and re-serialize.
	 * 4. Split `x-webhook-signature` on commas and accept if ANY entry matches,
	 *    comparing with a constant-time function (`crypto.timingSafeEqual`),
	 *    never `===`. Several entries appear only during a `previousSecret`
	 *    rotation, and both sign the same timestamped material.
	 *
	 * Freshness bounds replay; it does not make a request single-use inside the
	 * five-minute window. After successful verification, deduplicate on the
	 * authenticated signature header (or a unique event id inside the signed
	 * body). Do not use the mutable `idempotency-key` header by itself as a
	 * security replay token: that header is not part of the signed material.
	 *
	 * BREAKING vs the pre-timestamp contract: a receiver verifying
	 * `HMAC(secret, body)` rejects every delivery from a sender on this
	 * version. Update receivers BEFORE upgrading senders. A legacy body-only
	 * signature is deliberately not emitted alongside the new one - a receiver
	 * accepting either is still replayable through the legacy entry, which
	 * would leave the hole open while looking closed.
	 */
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

/** A first-attempt admission gate: `take` consumes one unit of a DESTINATION's
 * allowance, returning whether a delivery may start. In-process (sync) or
 * cluster-shared (async).
 *
 * A destination is `<address>:<port>` (IPv6 bracketed) - an address
 * `deliverWebhook`'s SSRF gate resolved and pinned the socket to, not
 * `WebhookDeliveryHooks.key` and not the URL. Callers name endpoints, so a key
 * or a URL origin can be multiplied by inventing names; a pinned address cannot
 * be renamed. `take` is called once for EVERY address in the pin, because which
 * of them the socket lands on is decided by the connect logic and the caller
 * orders its own DNS answer - so whichever address the request goes to has paid
 * for it. Registrations, aliases and per-event `url` callbacks that land on one
 * address therefore share that address's allowance.
 *
 * What that costs, stated here rather than left to be discovered:
 *
 * - A delivery to a host answering with several addresses spends one unit at
 *   EACH of them, so such an endpoint holds several allowances.
 * - A caller controlling its own DNS answer can pad it and spend UNRELATED
 *   addresses' allowances without sending them any traffic. The answer is capped
 *   at 32 addresses, so one admitted delivery can charge up to 32 buckets while
 *   one request goes out. Those addresses need not belong to the caller, so this
 *   is usable to exhaust a co-tenant's admission bucket; lower the cap or key
 *   deliveries per tenant if that matters to your deployment.
 * - A REDIRECT hop is not charged. The gate is consulted once, at hop zero,
 *   because charging a hop chosen by the endpoint being delivered to would let
 *   any registration drain a bystander. That leaves up to `maxRedirects`
 *   requests per admitted delivery unmetered by this gate (the address checks
 *   still run on every hop).
 * - A refusal part-way through a set keeps the units already taken, since the
 *   interface only takes, so a refused delivery can cost more than it sent,
 *   never less.
 *
 * What holds without qualification is narrower than any of the above: a request
 * cannot be put on an address at hop zero without spending that address's unit.
 *
 * Only a definite `false` (or the `0` a Lua-scripted shared backend replies
 * with) refuses a delivery. Throwing, or answering with nothing, admits: a
 * shared gate having a bad minute must not become an outbound outage. */
export interface WebhookAdmission {
	take(destination: string): boolean | Promise<boolean>;
}

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
 * the budget and the breaker to one endpoint (the realtime layer passes the
 * webhook's registration id); `admission` ignores it and is keyed by the pinned
 * destination addresses, so registering one endpoint several times, or under
 * several names, does not multiply its first-attempt allowance. */
export interface WebhookDeliveryHooks {
	admission?: WebhookAdmission;
	budget?: RetryBudget;
	breaker?: WebhookBreaker;
	key?: string;
	/** Validated W3C context injected as traceparent/tracestate headers. */
	traceContext?: TraceContext | null;
}

/** Options for {@link createWebhookAdmission}. Together they set the aggregate
 * ceiling as well as the per-destination one: see {@link createWebhookAdmission}. */
export interface WebhookAdmissionOptions {
	/** Max tokens per destination (default 100). */
	capacity?: number;
	/** Continuous refill rate in tokens/second (default 10). */
	refillPerSec?: number;
	/** How many destinations hold an allowance at once (default 1024). At the
	 * cap, a destination whose bucket has refilled to full is dropped (dropping
	 * it changes nothing - it would be recreated full); if none has, a further
	 * destination is REFUSED rather than admitted untracked. That is what makes
	 * `maxKeys * capacity` an actual aggregate bound, and lowering `maxKeys` is
	 * how the aggregate is lowered. */
	maxKeys?: number;
}

/** The in-process {@link WebhookAdmission} returned by {@link createWebhookAdmission}. */
export interface InProcessWebhookAdmission extends WebhookAdmission {
	take(destination?: string): boolean;
	/** Remaining allowance for a destination. Read-only: a destination with no
	 * live bucket has spent nothing and reports `capacity`. It answers that
	 * destination's allowance only and says nothing about slot availability, so
	 * the two disagree at the cap: with `maxKeys` destinations tracked and none
	 * reclaimable, an untracked destination reports `capacity` while `take`
	 * refuses it for want of a slot. */
	tokensFor(destination?: string): number;
	reset(destination?: string): void;
}

/** Options for {@link createRetryBudget}. */
export interface RetryBudgetOptions {
	/** Max tokens per key (default 100). */
	capacity?: number;
	/** Continuous refill rate in tokens/second (default 10). */
	refillPerSec?: number;
	/** How many keys hold a budget at once (default 1024). At the cap, only a
	 * bucket that has refilled to full is dropped; a further key whose budget
	 * cannot be tracked is refused rather than granted an untracked one, so
	 * churning keys cannot hand a drained key its tokens back. */
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
	/** How many keys hold breaker state at once (default 1024). At the cap, only
	 * a key that is healthy with no failures recorded is dropped; when every
	 * tracked key carries a failure record, a further key goes UNTRACKED (it can
	 * never be ejected) rather than an ejected endpoint being forgotten and let
	 * back in. */
	maxKeys?: number;
}

/** The in-process {@link WebhookBreaker} returned by {@link createWebhookBreaker}. */
export interface InProcessWebhookBreaker extends WebhookBreaker {
	/** A key's circuit state. Read-only: a key with no tracked state has recorded
	 * no failure and reports `'healthy'`, rather than being created and spending
	 * one of the `maxKeys` slots because something asked. */
	stateOf(key?: string): 'healthy' | 'broken' | 'probing';
	reset(key?: string): void;
}

/** Thrown by {@link createWebhookBreaker}'s `guard` when a key's circuit is open. */
export declare class WebhookCircuitOpenError extends Error {
	readonly code: 'WEBHOOK_CIRCUIT_OPEN';
}

/**
 * Carried by the outcome of a delivery {@link WebhookDeliveryHooks.admission}
 * refused. Nothing was sent and the endpoint said nothing, so requeue the event
 * rather than dead-lettering it as a rejected delivery.
 */
export declare class WebhookAdmissionDeniedError extends Error {
	readonly code: 'WEBHOOK_ADMISSION_DENIED';
}

/**
 * Create the in-process first-attempt admission gate - the single-instance
 * default for `deliverWebhook`'s `hooks.admission`. A token bucket per PINNED
 * DESTINATION ADDRESS, so the ceiling belongs to the thing being protected:
 * extra registrations, extra hostnames for one address and per-event `url`
 * callbacks all draw on the same bucket.
 *
 * Stated exactly, because the difference matters when sizing an outbound path:
 * - Per destination: `capacity` deliveries in a burst, `refillPerSec` per second
 *   sustained, for deliveries that reach that address.
 * - Aggregate per instance: `maxKeys * capacity` admitted deliveries in a burst
 *   and `maxKeys * refillPerSec` per second - 102,400 and 10,240 on the
 *   defaults. This is a bound, not an estimate: a bucket is dropped only once
 *   refilled to full, so no allowance is ever handed back by churning
 *   destinations.
 * - In REQUESTS rather than deliveries, which is what an outbound path carries:
 *   one admitted delivery may issue up to `retry.attempts` x (`maxRedirects` +
 *   1) HTTP requests - 18 on the delivery defaults - so size the path off that
 *   multiple of the figures above, or lower `retry.attempts` / `maxRedirects`.
 * - NOT covered: one endpoint published on several addresses (separate IPv4 and
 *   IPv6 literals, or DNS answers with differing address sets) is several
 *   destinations and gets one allowance each, and a delivery to it spends one
 *   unit at each of its addresses. And the gate is per process, so a cluster
 *   multiplies by replica count until a shared gate is injected through the same
 *   seam.
 */
export function createWebhookAdmission(options?: WebhookAdmissionOptions): InProcessWebhookAdmission;

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
 * Strip a URL down to its origin for safe logging - userinfo, query, hash AND
 * the path are all dropped (webhook endpoints commonly embed their credential
 * in the path); returns `'[unparseable-url]'` when it does not parse.
 */
export function redactUrl(url: string): string;

/**
 * Verify a received delivery against the contract documented on
 * {@link WebhookDeliveryConfig.secret}: numeric timestamp, freshness window,
 * HMAC over `<timestamp>.<rawBody>`, constant-time compare, any comma entry
 * may match (several appear only during a `previousSecret` rotation).
 *
 * Use this in your receiver rather than re-implementing it - each of those
 * four steps has a quiet failure mode, and a signature verified loosely is
 * worth nothing.
 *
 * @param headers Received headers, lowercase keys.
 * @param rawBody The body exactly as received, before any JSON round-trip.
 */
export function verifyWebhookSignature(
	headers: Record<string, string | string[] | undefined>,
	/**
	 * The body EXACTLY as received. Any byte container works: a Node `Buffer`,
	 * the `ArrayBuffer` from `await request.arrayBuffer()`, a typed-array view
	 * over one, or the raw string. A parsed object is refused, because
	 * re-serializing it does not reproduce the bytes the sender signed.
	 */
	rawBody: string | Buffer | ArrayBuffer | ArrayBufferView,
	options?: {
		/** The current signing secret. */
		secret?: string;
		/** Several accepted secrets (use during a rotation). */
		secrets?: string[];
		/** Finite, non-negative freshness window either side of the receiver clock. Default 300. */
		toleranceSeconds?: number;
		/** Finite override for the receiver clock, in ms. Defaults to the exact wall clock. */
		nowMs?: number;
	}
): boolean;

/**
 * Deliver one outbound webhook for `(topic, event, data)` under `config` and
 * return its terminal outcome. SSRF-gates the initial URL and every redirect
 * hop, pins the connection to validated addresses, attaches a stable idempotency
 * key and optional timestamped HMAC signature (neither is forwarded to a
 * cross-origin redirect target), and retries 5xx/429/network/timeout with
 * jittered backoff. Never throws and reports nothing - the caller inspects the
 * outcome for reporting and dead-letter capture.
 *
 * Pass `hooks` to inject delivery controls: `hooks.breaker` fast-fails an
 * ejected endpoint and records the terminal result, `hooks.budget` rations retry
 * amplification, both scoped by `hooks.key`; `hooks.admission` rations first
 * attempts per pinned destination address and refuses over-allowance deliveries
 * with a terminal `attempts: 0` outcome carrying
 * {@link WebhookAdmissionDeniedError}.
 * Omit `hooks` for bare delivery.
 */
export function deliverWebhook<Event = string, Data = any>(
	config: WebhookDeliveryConfig<Event, Data>,
	topic: string,
	event: Event,
	data: Data,
	hooks?: WebhookDeliveryHooks
): Promise<WebhookDeliveryOutcome>;
