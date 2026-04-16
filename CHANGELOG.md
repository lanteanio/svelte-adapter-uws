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

## [0.4.12] - 2026-04-16

### Added

- **`authenticate` hook**: new optional export in `hooks.ws.js`/`hooks.ws.ts` that runs as a normal HTTP POST before the WebSocket upgrade. Refreshing session cookies via `cookies.set()` here rides on a standard response and works behind every proxy -- including Cloudflare Tunnel, which silently closes WebSocket connections whose 101 response carries `Set-Cookie` (symptom: `open` fires server-side, then close code 1006 before any frames). The hook receives the SvelteKit-shaped event `{ request, headers, cookies, url, remoteAddress, getClientAddress, platform }`. Return `undefined` for an implicit 204 (recommended), `false` for 401, or a `Response` for full control. Only mounted when exported -- zero runtime cost otherwise.
- **`connect({ auth })` client option**: opt-in preflight that POSTs to the adapter's `authenticate` endpoint (`/__ws/auth` by default) before opening every WebSocket, including reconnects. Concurrent connects share a single in-flight fetch. 4xx responses are terminal (user is not authenticated); 5xx and network errors fall back to normal reconnect backoff. Accepts `true` (default path) or a custom string. Off by default.
- **`websocket.authPath` adapter option**: override the default `/__ws/auth` endpoint path for deployments where the default collides (e.g. Cloudflare Access allowlisting). Must differ from `websocket.path`.
- **Build-time Cloudflare footgun warning**: the adapter now statically scans the bundled WS handler for `upgradeResponse(..., { 'set-cookie': ... })` usage and emits a loud `builder.log.warn` at build time pointing at the `authenticate` hook migration. No false positives for non-cookie headers. Safe to ignore if you do not deploy behind strict edge proxies.
- **Runtime warning**: the production handler also logs a one-shot `console.warn` the first time `upgradeResponse()` is invoked with a `Set-Cookie` header, covering cases where the header name is built dynamically and static analysis cannot see it.

### Changed

- `upgradeResponse()` JSDoc now documents the Cloudflare/proxy incompatibility and points at `authenticate`. The helper remains fully supported for non-cookie response headers on the 101.

### Compatibility

Fully backwards compatible. No existing user code changes behavior:

- The new `authenticate` export is opt-in and only mounts an endpoint when present.
- `connect({ auth })` defaults to `false`. Existing `connect()` calls are unchanged.
- `upgradeResponse(..., { 'set-cookie': ... })` keeps working on infrastructure that accepts it; users see a build log + one-time runtime log nudging them toward `authenticate`.

---

## [0.4.11] - 2026-04-16

### Fixed

- **WebSocket upgrade on Windows**: `res.cork()` wrapping `res.upgrade()` produced a malformed 101 Switching Protocols response on Windows, causing the browser to never receive the upgrade response (TCP FIN, close code 1006). The server-side `open` handler fired normally, but the 101 bytes were never flushed to the client. Removed the cork wrapper from both the synchronous (no upgrade handler) and asynchronous (user upgrade handler) paths in the production runtime and the test harness. No performance impact -- `res.writeHeader()` accumulates headers on the response object and `res.upgrade()` flushes them in a single syscall regardless of cork.

---

## [0.4.10] - 2026-04-11

### Added

- **Upgrade response headers**: the `upgrade()` hook can now return response headers on the 101 Switching Protocols response (e.g. `Set-Cookie` for session refresh) via the new `upgradeResponse()` helper from `svelte-adapter-uws/upgrade-response`. Fully backward-compatible with existing handlers. Dev mode logs a warning since the `ws` library does not support custom 101 headers.
- **Dynamic SSR compression**: single-chunk SSR responses are now compressed on the fly with brotli (quality 4) or gzip (level 6). Only applied to text content types above 1 KB when the client supports it. Static files continue to use build-time precompression. Multi-chunk streaming responses are uncompressed.
- **Test harness**: new `svelte-adapter-uws/testing` entry point with `createTestServer()` for integration-testing WebSocket handlers against a real uWS server on a random port. Supports the full subscribe/unsubscribe protocol, upgrade/open/message/close hooks, and Platform API. 17 tests included.
- **Startup timing**: the server now logs timing for static file indexing, SvelteKit server initialization, and total startup time.

---

## [0.4.9] - 2026-04-10

### Documentation

- **Clustering**: documented health monitoring behavior (10s heartbeat, 30s timeout, exponential backoff restart policy with 50-attempt cap) and the microtask-batched IPC relay used by `platform.publish()` across workers. Clarified that `platform.sendTo()` is local-only with no cross-worker relay.
- **WebSocket handler**: new "Message protocol" section explaining the byte-prefix discriminator that skips `JSON.parse` for user messages. New "Topic validation" section documenting enforcement rules (1-256 chars, no control characters, 256-topic batch cap) and the `__` prefix reservation for plugins.
- **WebSocket options**: new "Backpressure and connection limits" section explaining `maxPayloadLength` (connection closed on exceed), `maxBackpressure` (silent drop on overflow), and upgrade rate limiting (sliding window, 10K IP map cap with LRU eviction).
- **Performance**: new "Internal optimizations" section documenting request state object pooling (256 items) and the envelope prefix LRU cache (256 entries, 60s trim cycle).

---

## [0.4.7] - 2026-04-08

### Added

#### Client API

- `url` option in `ConnectOptions` -- connect to a remote WebSocket server by full URL instead of deriving from `window.location`. Enables cross-origin usage from mobile apps (Svelte Native, React Native), standalone clients, and any environment where the backend lives on a different origin. When `url` is set, `path` is ignored and the `window` guard is bypassed.

#### Testing

- Playwright e2e test suite (`npm run test:e2e`) -- 25 tests against a real SvelteKit fixture app. Covers SSR, static files, WebSocket pub/sub, upgrade authentication, subscribe-batch, platform API (sendTo, subscribers, topic helpers, cork), and the browser client with V8 coverage collection in both dev and production modes.
- Coverage pipeline (`npm run test:coverage`) -- collects V8 coverage from vitest unit tests, Playwright server processes, and the browser via Chrome DevTools Protocol.
- 62 new unit tests bringing client.js to 96% lines. Covers: once() with timeout, onDerived() lifecycle, debug mode logging, visibility reconnect, zombie detection, sendQueued overflow, maxReconnectAttempts exhaustion, throttle close codes, oversized message rejection, crud/lookup maxAge with initial data and stop/restart, cursor bulk/remove/maxAge/snapshot, groups join/leave/close lifecycle, presence join/leave/heartbeat/maxAge sweep, replay scan() lifecycle, ratelimit unban/keyBy fallbacks, throttle cancel/debounce timer paths, presence deepEqual for Set/Map/Array/circular references, cursor throttle leading-edge timer clearing.

### Fixed

- **Security**: esbuild fallback for `$env/dynamic/public` no longer leaks private environment variables. Previously the fallback mapped all dynamic `$env` imports to `process.env` regardless of public/private distinction. Now `$env/dynamic/public` is filtered to only include variables matching the configured `publicPrefix`.
- **Vite plugin**: `unsubscribe` hook is now wired into the dev WebSocket handler and HMR comparison. Previously, changing or adding an `unsubscribe` export in `hooks.ws` had no effect in dev mode.
- **Client**: `ready()` resolves immediately during SSR regardless of singleton state. Previously it could hang forever if `on()` or `connect()` had already created a singleton on the server. In native app environments (no `window` but an explicit `url`), `ready()` correctly waits for the connection to open instead of short-circuiting.
- **Adapter**: esbuild fallback now passes the full `kit.alias` map (not just `$lib`) so custom alias imports in `hooks.ws` resolve correctly.
- **Handler**: WebSocket upgrade rate limiter resets both windows after a long idle gap (>= 2x window duration), preventing stale counts from producing false 429 rejections.
- **Presence plugin**: `select()` return value is validated -- throws a clear `TypeError` if it returns a non-object (string, number, null, undefined) instead of crashing later with an unhelpful `in` operator error.
- **Security**: same-origin WebSocket check now rejects when no host header is present. Previously a missing host header was treated as "allowed", which meant a misconfigured reverse proxy that strips Host would silently bypass origin validation.
- **Handler**: `publish()`, `send()`, and `sendTo()` now normalize `undefined` data to `null` in the JSON envelope. Previously omitting data produced invalid JSON that the client silently dropped.
- **Adapter**: esbuild fallback for `$env/dynamic/public` now uses a runtime proxy over `process.env` instead of a build-time snapshot. Environment variables set after build are visible to `hooks.ws` code.
- **Replay plugin**: buffered payloads are now snapshot on publish via `structuredClone`. Previously payloads were stored by reference, so mutating the original object after publish would corrupt replayed messages.
- **Startup**: `PORT`, `SHUTDOWN_TIMEOUT`, and `SHUTDOWN_DELAY_MS` are validated at startup. Invalid values (non-numeric strings, negative numbers) now fail fast with a clear error instead of silently degrading to `NaN` or `0`.
- **Vite plugin**: `getRemoteAddress()` now returns correct 16-byte binary format for IPv6 addresses in dev mode, matching uWS production behavior.

---

## [0.4.6] - 2026-04-03

### Added

- Re-export `WebSocket` type from `index.d.ts` so downstream libraries can reference it without importing `uWebSockets.js` directly.

---

## [0.4.5] - 2026-04-01

### Fixed

- Vite plugin no longer crashes when the `ws` package is not installed. The top-level `import { WebSocketServer } from 'ws'` is replaced with a lazy `await import('ws')` inside `configureServer()`. When `ws` is missing, a warning is logged and WebSocket features are disabled in dev mode.

---

## [0.4.4] - 2026-03-20

### Removed

- Cursor client interpolation (added in 0.4.2, fixed in 0.4.3) -- removed entirely because lerp-based smoothing adds visible latency without benefit when cursor updates already arrive near display refresh rate.

---

## [0.4.3] - 2026-03-20

### Fixed

- Cursor interpolation freeze during rapid movement. Each server update now immediately moves the cursor 50% toward the target instead of deferring all movement to the rAF loop. Lerp factor bumped from 0.3 to 0.5.

---

## [0.4.2] - 2026-03-20

### Added

#### Cursor Plugin

- `interpolate` option in `cursor()` -- enables smooth rAF-driven lerp rendering (30% per frame). Numeric `x`/`y` data is interpolated; non-numeric data falls back to direct assignment. Snapshot, bulk, and remove events snap immediately.

---

## [0.4.1] - 2026-03-20

### Fixed

- `unsubscribe` added to `knownWsExports` in the server handler, suppressing a false "unknown export" warning when WebSocket hooks include an `unsubscribe` function.

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
