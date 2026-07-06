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
	/** Custom DNS resolver for the SSRF pin (default `dns.lookup`, all addresses). */
	resolve?: (hostname: string) => Promise<Array<string | PinnedAddress> | string | PinnedAddress>;
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
 */
export function deliverWebhook<Event = string, Data = any>(
	config: WebhookDeliveryConfig<Event, Data>,
	topic: string,
	event: Event,
	data: Data
): Promise<WebhookDeliveryOutcome>;
