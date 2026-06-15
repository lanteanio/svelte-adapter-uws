// - Bounded-by-default capacity caps ---------------------------------------
// Single source of truth for the per-connection and module-level Map / Set
// caps that handler.js, vite.js, and testing.js all enforce. The numbers
// are deliberately generous - far above any healthy single-connection use,
// even at uWS's million-connection scale - so they catch obvious bugs
// (subscribe-in-a-loop, request-without-await, coalesce-key-leak) without
// ever biting real apps. Aggregate memory is bounded separately by
// `upgradeAdmission.maxConcurrent`; per-conn caps are not the right place
// to defend against a 1M-connection DoS.

/** Max distinct topics one connection may be subscribed to before further subscribes are denied with `RATE_LIMITED`. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 1_000_000;

/** Max in-flight server-initiated `platform.request` calls per connection before further requests reject immediately. */
export const MAX_PENDING_REQUESTS_PER_CONNECTION = 1_000_000;

/** Max distinct keys in the per-connection sendCoalesced buffer before the oldest insertion-order entry is dropped on insert. */
export const MAX_COALESCED_KEYS_PER_CONNECTION = 1_000_000;

/**
 * Distinct topics in the server-side seq registry that triggers a single
 * structured warning. The registry cannot be evicted (the resume protocol
 * depends on each topic's monotonic counter persisting), so the limit is
 * warn-only - a high-cardinality publisher gets surfaced via console.warn
 * before it can OOM the worker, but publish() never throws on cap.
 */
export const TOPIC_SEQS_WARN_THRESHOLD = 1_000_000;

/** Max entries in the runaway-publisher warn-throttle dedup. FIFO-evicted - dropping oldest just resets the warn cooldown for that topic. */
export const PUBLISH_WARN_DEDUP_MAX = 1_000_000;
