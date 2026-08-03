// - Bounded-by-default capacity caps ---------------------------------------
// Single source of truth for the per-connection and module-level Map / Set
// caps that handler.js, vite.js, and testing.js all enforce. The numbers
// are deliberately generous - far above any healthy single-connection use,
// even at uWS's million-connection scale - so they catch obvious bugs
// (subscribe-in-a-loop, request-without-await, coalesce-key-leak) without
// ever biting real apps. Aggregate memory is bounded separately by
// `upgradeAdmission.maxConnections`; per-conn caps are not the right place
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

/**
 * Max ingress bindings (client->server `0x03` id -> destination, see
 * handler/ingress.js) one connection may hold before further `ingress-bind`
 * frames get no ack and the client keeps those destinations on its JSON
 * fallback. Deliberately much smaller than the siblings above: a binding is
 * pure per-connection retained state, and the stock client binds exactly one
 * id per binary command channel (the smooth command channel), so 32 is
 * already generous headroom - while an unbounded map let a client pin one
 * retained entry per control frame for the connection's whole lifetime.
 */
export const MAX_INGRESS_BINDINGS_PER_CONNECTION = 32;

/**
 * Max serialized (JSON) size of an ingress binding's retained `target` before
 * the bind is refused (no ack, JSON fallback). The smooth command target is
 * `{ path, room }` - a volatile-RPC path string plus room args, tens of bytes
 * in practice - so 1 KiB is generous while stopping multi-KB attacker blobs
 * from being pinned for the connection's lifetime. Kinds whose route never
 * reads the target retain nothing at all (see handler/ingress.js), so the
 * bound only applies to kinds that actually use it.
 */
export const MAX_INGRESS_TARGET_BYTES = 1024;
