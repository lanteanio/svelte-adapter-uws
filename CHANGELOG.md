# Changelog

All notable changes to `svelte-adapter-uws` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 0.5.0 Roadmap

### Reliability & Correctness

- [ ] **Subscribe acknowledgement** - server confirms or denies topic subscriptions so the client knows if a sub succeeded
- [ ] **Session ID for stale message filtering** - prevent duplicate events from a previous session leaking into a reconnected session

### Client DX

- [ ] **Richer connection state machine** - `disconnected` / `suspended` / `failed` states instead of just `connecting` / `open` / `closed`
- [ ] **Push-with-reply (request-response over WS)** - correlated request/response pairs over WebSocket, enabling RPC-style patterns

### Scalability

- [ ] **WebSocket upgrade admission control** - per-tick budget limiting concurrent upgrades to prevent event loop starvation under connection storms
- [ ] **Presence diff protocol** - broadcast joins/leaves instead of full state snapshots for bandwidth savings at scale
- [ ] **Batch subscribe hook** - server validates all topics at once instead of per-topic callback
- [ ] **Publish rate monitoring** - warn at >10MB/s per topic to catch runaway publishers

### Performance

- [ ] **Split writeResponse into specialized sync/async** - separate fast-path for known-length bodies vs streaming for better V8 optimization
- [ ] **Known header extraction** - extract a fixed set of headers in consistent order for better JIT optimization
- [ ] **WS control message manual parse** - skip `JSON.parse` for subscribe/unsubscribe (known fixed shapes)

### Plugins

- [ ] **Lock / Mutex** - `withLock(key, fn)` serializes access per key using in-memory `Map<string, Promise>`. Prevents concurrent upgrades on the same resource and atomic read-modify-write on user state. API contract designed for drop-in Redis `SET NX PX` swap via extensions.
- [ ] **Session** - `Map<token, data>` with sliding TTL. Hooks into `upgrade` to load and `close` to persist. Survives reconnects within the same instance. API contract designed for Redis hash swap via extensions.
- [ ] **Dedup** - `Set<messageId>` with TTL eviction for idempotent message delivery. Client retries after disconnect don't trigger side effects twice. API contract designed for Redis `SET NX EX` swap via extensions.

### Future / Optional

- [ ] **Stale-while-revalidate SSR cache** - serve cached SSR while re-rendering in background
- [ ] **Client transport abstraction** - pluggable transports (WS / SSE / MessagePort)

---

## [0.4.0] - 2025-03-18

### Breaking Changes

#### Client

- **`ready()` now rejects on permanent close.** Previously returned a `Promise<void>` that only resolved (could hang forever). Now rejects with an error on terminal close codes (1008, 4401, 4403), retries exhausted, or `close()` called. Resolves immediately during SSR. **Action:** add try/catch around any `await ready()` call.
- **Resubscription on reconnect uses `subscribe-batch`.** Previously sent individual `{ type: 'subscribe', topic }` messages per topic. Now sends `{ type: 'subscribe-batch', topics: [...] }` batched to <8KB / 256 topics. **Action:** server must be updated to 0.4.0+ to handle batch resubscribes.
- **Reconnect jitter algorithm changed.** Old: additive `base + random(0-1000ms)`. New: proportional `base +/- 25%`. Observable timing difference but not an API change.

#### Server Runtime

- **`remoteAddress` auto-injected into `userData`.** Previously `userData` was exactly what `upgrade()` returned (or `{}`). Now `remoteAddress` is always present. Code iterating `userData` keys or checking for emptiness will see this.
- **`__subscriptions` Set injected into `userData`.** Used internally to track per-connection subscriptions. If your code uses a `__subscriptions` key in userData, it will be overwritten.
- **`publish()` return value changed in clustered mode.** Returns `true` when the cross-worker relay fires, even if the local worker has no subscribers.
- **Upgrade rate limiter changed.** Fixed-window -> sliding-window estimator. Threshold comparison changed from `> limit` to `>= limit` (triggers one request sooner). Now keyed on resolved client IP instead of raw socket IP.
- **ETag generation changed.** From `W/"<sha256>"` (crypto-based) to `W/"<mtimeMs>-<size>"` (filesystem metadata). All client-cached ETags are invalidated on upgrade.
- **Graceful shutdown sends close code 1001** to WebSocket connections so clients know to reconnect.

#### Replay Plugin

- **`replay()` wire format changed.** The `end` event data changed from `null` to `{ reqId }` or `{ reqId, truncated: true }`.
- **`onReplay()` return type changed.** Now `TopicStore<WSEvent<T> | TruncatedEvent>`. Store can emit `{ event: 'truncated', data: null }`.

### Added

#### Client API

- `onDerived(topicFn, store)` - reactive derived topic subscription that auto-switches when the source store changes.
- Terminal close code handling - codes 1008, 4401, 4403 stop reconnection. Code 4429 jumps ahead in backoff.
- Page visibility reconnect - instant reconnect when a tab resumes from background.
- Zombie connection detection - 30s interval force-closes connections silent for 150s.
- `crud()` / `lookup()` data validation - guards against `null`/non-object payloads.

#### Platform API

- `platform.batch(messages)` - publish multiple messages in one call, returns `boolean[]`.
- `unsubscribe` hook - called when a client's topic ref count reaches zero.
- `subscribe-batch` server support - handles batched subscriptions (up to 256 topics).

#### Static File Serving

- HTTP Range requests - `Accept-Ranges: bytes`, 206 Partial Content, 416 Range Not Satisfiable.
- `Content-Disposition: attachment` for binary download types (.zip, .exe, .dmg, .iso, etc.).
- `x-content-type-options: nosniff` header on all static files.
- `Date` header on all static file responses (cached, refreshed every 1s).
- `Vary: Accept-Encoding` on all static files.
- Precompressed variants (.br/.gz) only served if actually smaller than the original.

#### SSR

- Request deduplication - concurrent anonymous GET/HEAD requests for the same URL share one SvelteKit render. Skipped for authenticated requests, mutations, and `x-no-dedup: 1`.

#### Server Entry

- `SHUTDOWN_DELAY_MS` env var - configurable delay before stopping new connections during shutdown (for Kubernetes rolling updates).
- Worker heartbeat monitoring - primary sends heartbeat every 10s, terminates unresponsive workers after 30s.
- `WS_DEBUG` env var - set to `1` for per-event WebSocket logging.
- Windows path safety - rejects paths containing `:` (ADS) or `~` (8.3 short names) with 400.

#### Vite Dev Plugin

- Middleware mode warning when `server.httpServer` is null.
- HMR path collision warning when WS path collides with Vite's HMR WebSocket.
- `unsubscribe` hook now called in dev mode.

#### Plugins

- **Cursor:** `snapshot()` method, `hooks` helper (ready-made `message` + `close`), client handles bulk snapshot events.
- **Groups:** `hooks` helper (ready-made `subscribe` + `unsubscribe` + `close`).
- **Presence:** `unsubscribe` hook for single-topic leave, `updated` event with deep equality check, client handles `updated`.
- **Replay:** `reqId` support for correlating responses, `TruncatedEvent` when ring buffer was overwritten, true LRU eviction (FIFO -> LRU).
- **Queue:** proper `drain()` implementation using dedicated callback array.

### Changed (Under the Hood)

#### Performance

- Object pool for per-request `{ aborted }` state (256 slots).
- Envelope prefix cache for topic+event strings (256 entries).
- Method lookup table replaces `toUpperCase()` per request.
- Removed `node:crypto` dependency (no longer used for ETags).
- Pre-allocated body buffer for small bodies (<64KB) with known Content-Length.
- `Buffer.from(new Uint8Array(chunk))` replaces `Buffer.from(chunk.slice(0))`.
- Cached `Date.now()` and Date header (shared 1s timer).
- `decodePath()` LRU cache (256 entries).
- AbortController eliminated - replaced with `{ aborted }` flag (saves ~4-5 allocs/request).
- Conditional `getClientAddress` closure for simpler V8 inlining without proxy headers.
- Consolidated error response helpers (`send400`, `send413`, `send500`).
- Unified 60s maintenance interval (rate limiter + decode cache + envelope cache).
- Backpressure timeout calls `res.close()` instead of `res.end()`.
- Cross-worker relay batching via microtask.
- Removed duplicate `Content-Length` headers. uWS internally sets `Content-Length` on `res.end(body)`; the adapter no longer writes it manually, eliminating doubled values (e.g. `Content-Length: 11111, 11111`). HEAD responses use `endWithoutBody(size)` to report the correct entity size. SSR responses also filter `content-length` from SvelteKit headers for the same reason.

#### Client Internals

- Store entries deleted after last subscriber leaves (memory leak fix).
- Microtask cleanup for stores created but never subscribed to.
- `close()` clears activity timer, removes visibility listener.

#### Plugin Internals

- Singleton store caching with microtask cleanup across cursor, groups, presence clients.
- Groups server wraps `ws.unsubscribe()` in try/catch for already-closed connections.
- Presence server extracts `leaveTopic()` for single-topic removal, adds `deepEqual()`.
- Replay client adds `cancelled` flag, swallows `ready()` rejection.
- Queue server uses dedicated `drains` array instead of sentinel tasks.
- JSDoc fixes across middleware, queue, and ratelimit plugins.

---

## [0.3.9] and earlier

See [git history](../../commits/master) for changes prior to 0.4.0.
