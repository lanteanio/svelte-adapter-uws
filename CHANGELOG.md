# Changelog

All notable changes to `svelte-adapter-uws` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0-next.7] - 2026-05-02

### Changed

- **Initial-mount subscribe frames are now microtask-batched.** Multiple `subscribe(topic)` calls landing in the same microtask coalesce into one `{type:'subscribe-batch', topics, ref}` wire frame instead of N individual `{type:'subscribe', topic, ref}` frames. A page mounting many topic stores (a typical multi-stream dashboard, an `svelte-realtime` page that initializes 5 stream RPCs in a tight loop, etc.) now triggers the server's `subscribeBatch` hook ONCE instead of the per-topic `subscribe` hook N times - which is the whole reason `subscribeBatch` exists. Single-topic case stays as a plain `subscribe` frame for the minimal-change wire shape. Same chunking limits the reconnect path uses (8000 byte / 200 topic per batch); the limits live in a shared `chunkTopicsForBatch` helper so the two call sites cannot drift. Topics are still added to `subscribedTopics` synchronously, so a disconnect between the call and the microtask flush loses nothing - the reopen's resubscribe-batch path picks them up. **Behaviour change**: any test code asserting on the exact wire shape of two same-microtask subscribes seeing two `subscribe` frames now sees one `subscribe-batch` frame. Use `.find(m => m.type === 'subscribe-batch' && m.topics.includes(...))` instead.

### Documentation

- **Chaos harness scope explicitly documented** in the `ChaosScenario` JSDoc (`testing.d.ts`) and the README chaos section. `__chaos` is a WebSocket-frame outbound chokepoint inside the test harness; it covers what the bundled WS protocol does (subscribe acks, session resume, sendCoalesced under backpressure, request/reply timeouts) and does NOT cover transport-level traffic outside the harness (ioredis, pg, NATS, custom HTTP backends). Prevents the misunderstanding that chaos covers cross-wire testing for distributed primitives - that responsibility lives in the layer that owns each wire.
- **README "Wrap your own transport for cross-wire chaos" pattern.** Shows downstream extension authors and app-side test code how to compose the `createChaosState` factory (already re-exported from `svelte-adapter-uws/testing`) with any transport client (ioredis, pg, NATS, fetch) to get the same `__chaos({ scenario, dropRate, delayMs })` ergonomic scoped to that client. Zero new adapter surface; the pattern transfers across transports without anyone needing to invent a new API. ~30 LOC sketch in the README, anchor-stable for downstream docs to link to.

## [0.5.0-next.6] - 2026-05-02

### Added

- **`upgradeAdmission` option on `createTestServer`.** Mirror of the production handler's `wsOptions.upgradeAdmission` setting (`maxConcurrent`, `perTickBudget`). Lets adapter-side and downstream test code drive a real connection storm against the harness and assert the admission shed-shape (503 with the documented status text) without booting a full SvelteKit app. Off by default; production users continue to configure the same thing via `adapter({ websocket: { upgradeAdmission: { ... } } })`. New `test/upgrade-admission-wiring.test.js` covers the wiring end-to-end (default-disabled accepts everyone, in-flight cap sheds the surplus with 503, slow user upgrade hooks hold the slot, in-flight slots are released after the upgrade completes). Closes the coverage gap between "the `createUpgradeAdmission` factory works in isolation" and "the wiring inside the upgrade hook actually triggers the shed."
- **README "Layered admission" section** under Backpressure & connection limits. Documents that `upgradeAdmission` sheds at the handshake layer (before TLS work), and points readers at the extensions package's `createAdmissionControl` for the message-dispatch layer that sheds RPC traffic on already-accepted connections. Includes a wiring snippet showing both factories side-by-side. Covers the structural ordering (uWS lifecycle enforces "no message handler dispatch before upgrade", so the two layers cannot drift apart).

## [0.5.0-next.5] - 2026-05-02

### Added

- **Curated pure helpers and userData slot constants re-exported from `svelte-adapter-uws/testing`.** Downstream test code (extensions, app-side integration tests, custom transport bridges) can now `import { wrapBatchEnvelope, completeEnvelope, WS_CAPS, ... } from 'svelte-adapter-uws/testing'` to assert on the same wire shapes and userData state the production runtime produces, without redeclaring helpers that would drift over time. Curated set: five wire-protocol helpers (`esc`, `completeEnvelope`, `wrapBatchEnvelope`, `isValidWireTopic`, `createScopedTopic`), three behavior helpers (`collapseByCoalesceKey`, `resolveRequestId`, `createChaosState`), and all eight per-connection userData slot constants (`WS_SUBSCRIPTIONS`, `WS_COALESCED`, `WS_SESSION_ID`, `WS_PENDING_REQUESTS`, `WS_STATS`, `WS_PLATFORM`, `WS_CAPS`, `WS_REQUEST_ID_KEY`). Production-internal plumbing (mime lookup, byte parsing, cookie split, write-chunk backpressure, sampler internals, upgrade admission factory, origin allowlist matcher) is deliberately NOT re-exported so the test surface can stay semver-stable while production hot paths remain free to refactor. Type declarations land alongside the re-exports in `testing.d.ts`. The same names continue to live in `files/utils.js`; the re-export is purely an additive public surface, not a relocation.
- **`failure` Readable on the client store, sibling to `status`.** Carries the cause of the most recent non-open status transition so consumers can render targeted UI per failure type: `'TERMINAL'` (server permanently rejected: 1008/4401/4403), `'EXHAUSTED'` (`maxReconnectAttempts` hit), `'THROTTLE'` (server signalled rate-limit via 4429), `'RETRY'` (normal transient drop), `'AUTH'` (auth preflight failed before the WebSocket was opened). Discriminated union by `kind` (`'ws-close'` carries `code`, `'auth-preflight'` carries `status`) plus a `reason` string label. Stays `null` while connected, set on the failing transition, cleared on the next successful `'open'`. NOT set on an intentional `close()` call; `status === 'failed'` paired with `failure === null` is the deliberately-ended state. Available as a top-level `failure` export and on the `WSConnection` returned by `connect()`. The information was previously computed (`classifyCloseCode` + auth-preflight outcome) and discarded immediately into a less-specific `status` value; this surface preserves it for app-layer rendering without forcing apps to re-derive close-code semantics.

## [0.5.0-next.4] - 2026-05-02

### Added

- **`platform.publishBatched(messages)` for wire-level batched fan-out.** Publish a list of `{topic, event, data}` events as a single `{type:'batch', events:[...]}` WebSocket frame per affected subscriber, instead of one frame per event. The bundled `svelte-adapter-uws/client` decodes the batch frame and dispatches each contained event through the same per-topic store ladder a single-event frame would take. Capability gating: clients opt in via a `{type:'hello', caps:['batch']}` frame after open (the bundled client does this automatically); the server only emits batch frames when every interested subscriber has advertised the capability. When the fast path does not apply (mixed subscriber views, mixed-cap subs, or disjoint single-topic-per-event shapes), `publishBatched` falls back to a per-event `publish()` loop so the call is at least as fast as the loop the user would have written by hand. Bench-gated at land time: 50x500 same-topic bulk-fan-out 3.8x faster than a `publish()` loop (`+285%`), 5x500 overlapping topics `+22%` faster, 3x50 disjoint topics within noise. Per-event seq stamping preserved, per-event `{relay: false}` / `{seq: false}` options supported. **Cross-worker relay carries the batch as a single IPC frame**; each receiving worker re-runs the fast-path detection against its local subscriber set and dispatches via batch or per-event according to its own profile, so wire batching is preserved cluster-wide. **Per-event `coalesceKey?: string`** collapses same-key duplicates before framing - latest value wins at the latest occurrence's position - for streams of cursor / presence / price-tick events where intermediate values are noise. Frame-size soft cap at 256 KB triggers a throttled `console.warn` (uWS per-message-deflate may kick in over large frames). The existing `platform.batch(messages)` is unchanged but now documents that it is NOT wire-level batching; the JSDoc points users at `publishBatched` for that.
- **Chaos / fault-injection harness on `createTestServer`.** The test platform now carries `__chaos(cfg)` for simulating broken-network conditions while exercising protocol code (subscribe acks, session resume, `sendCoalesced` under backpressure, request/reply timeouts, etc). Two scenarios in this revision: `'drop-outbound'` discards outbound frames before they reach the wire with the configured `dropRate` (a probability in `[0, 1]`), and `'slow-drain'` defers each outbound frame by `delayMs` milliseconds via `setTimeout`. Affects every server-to-client frame the harness emits: `platform.publish`, `platform.send`, `platform.sendTo`, `platform.request`, the welcome envelope, subscribe acks, and the resumed ack. While a scenario is active, `platform.publish` switches from uWS's C++ TopicTree fan-out to a JS-side fanout so the chaos state can intercept per recipient; reset with `platform.__chaos(null)` to return to the zero-overhead fast path. The harness lives only on the test platform - production does not ship `__chaos`. Tests under `test/chaos.test.js` cover drop, delay, reset, and unknown-scenario rejection; the underlying `createChaosState()` pure helper (in `files/utils.js`) is unit-tested with deterministic RNG injection.
- **`platform.requestId` for cross-layer log correlation.** Every HTTP request and every WebSocket connection now carries a string `requestId` on `event.platform`. HTTP requests get a fresh UUID per request; WebSocket connections stamp once at upgrade time and the same id flows through every hook on that connection (`open`, `subscribe`, `subscribeBatch`, `unsubscribe`, `message`, `drain`, `resume`, `close`). Inbound `X-Request-ID` overrides the generated value when present (sanitized: printable ASCII, max 128 chars; whitespace / control / non-ASCII values are rejected and the adapter falls back to a UUID). The adapter never emits `X-Request-ID` on the response automatically - returning it is an app-layer concern (`new Response(body, { headers: { 'x-request-id': platform.requestId } })`). The upgrade hook also receives `requestId` directly on its context so auth-decision logging can include it before the connection opens. Per-connection cost: one `Object.create` clone allocated in `open` (gives every hook a live-getter view of the shared platform plus a stable `requestId` field); per-HTTP-request cost: one clone per `server.respond` call. Caveat: dev mode (`vite dev`) generates a fresh UUID per HTTP request but does not honour `X-Request-ID` for HTTP - SvelteKit's `emulate.platform()` runs without access to request headers. WebSocket upgrades in dev honour the header normally, matching production. Caveat: the SSR dedup path (anonymous GET / HEAD coalescing) means waiters reuse the leader's response body - their own `X-Request-ID` reaches the adapter but never enters `server.respond`; for strictly per-request tracing on those routes opt out with `x-no-dedup: 1`.
- **Per-topic publish-rate detection on the pressure sampler.** Every `platform.publish()` call bumps two integer counters on a per-topic stats slot (one Map entry allocated the first time a topic is published to, then zero allocations on the steady state). The 1 Hz sampler reads the counters into per-second message-rate and byte-rate per topic, surfaces the top 5 by message rate on `platform.pressure.topPublishers`, and flags any topic that crossed the configurable `topicPublishRatePerSec` (default 5000) or `topicPublishBytesPerSec` (default 10 MB/s) thresholds. Default response is a throttled `console.warn` once per topic per minute. Register `platform.onPublishRate(cb)` to take ownership of the surface (suppresses the default warning); the callback receives an array of `{ topic, messagesPerSec, bytesPerSec }` for any topics over threshold in the last window. Set either threshold to `false` to disable that signal. Aggregate `publishRatePerSec` is unchanged - this layer names the offender, the aggregate signal flags overall load.
- **Per-connection traffic stats on the `close` hook.** When you export `close` from `hooks.ws`, the context now carries `id` (the session id from the welcome envelope), `duration` (lifetime in ms), `messagesIn`, `messagesOut`, `bytesIn`, and `bytesOut` alongside the existing `code` / `message` / `subscriptions`. Useful for per-session logging, quota accounting, and connection-quality dashboards. Counters are only populated when the close hook is registered - the adapter skips the bookkeeping otherwise to keep the hot path zero-cost for stats-uninterested apps. Caveat: `messagesOut` / `bytesOut` count direct sends to the specific connection (welcome, subscribe acks, replies, `platform.send`, `platform.sendCoalesced`, matched `platform.sendTo`). Topic-broadcast `platform.publish()` fan-out is **not** counted because uWS does the dispatch in C++ and per-recipient byte accounting would defeat the fast path - use `platform.pressure.publishRate` for aggregate publish-rate signals instead.

### Changed

- **Client `status` store expanded to a five-state machine.** Was `'connecting' | 'open' | 'closed'`; now `'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'`. The previous catch-all `'closed'` is split into three distinct states so apps can drive different UI affordances:
  - `'disconnected'` - lost connection, will retry automatically (show "Reconnecting...").
  - `'failed'` - terminal: auth denied (close codes 1008 / 4401 / 4403), max reconnect attempts exhausted, or `close()` was called. Stays in this state; user action required to recover.
  - `'suspended'` - WS is technically open but the tab is in the background. Driven by `visibilitychange`; flips back to `'open'` automatically when the tab returns. Browsers may kill idle backgrounded sockets, so live data is best-effort while suspended.

  `ready()` now resolves on either `'open'` or `'suspended'` (both indicate an established WS). Apps that previously matched `$status === 'closed'` need to map to `'disconnected'` (transient) or `'failed'` (terminal) - or use `_permaClosed` if the only thing they cared about was the terminal case. Tests in `client-real.test.js` cover all five transitions.
- **Presence plugin wire format switched to a compact diff protocol.** The five-event format (`list` / `join` / `updated` / `leave` / `heartbeat`) collapses to two diff-shaped events plus the existing heartbeat:
  - `{event: 'presence_state', data: {[key]: meta}}` - full snapshot, sent to a single connection on join or sync. Replaces the array-shaped `list`.
  - `{event: 'presence_diff', data: {joins: {[key]: meta}, leaves: {[key]: meta}}}` - changes, broadcast to topic subscribers. Replaces individual `join` / `updated` / `leave` frames.

  Diffs are now microtask-batched: multiple joins / leaves in the same tick collapse into one frame. Within a diff, leaves apply first then joins, so an update (same key in both) ends with the user present using the new data; if a key cycles join then leave in the same tick, the diff carries only the latest op (leave wins). `heartbeat` is unchanged. The `presence()` Svelte store API on the client is unchanged - the wire change is internal to the plugin's server <-> client round-trip. Hand-rolled clients that consume the wire directly need to switch decoders. Bundle ships server + client together so single-package upgrades are seamless; stale browser tabs from a previous deploy will see a blank presence list until refresh.
- **`tracker.flushDiffs()` exposed on the presence tracker** for callers that need the buffered diff to land synchronously - tests are the primary user, but production code that needs presence state visible to other workers before its own block returns can call it explicitly. No-op when nothing is buffered.

### Added

- **`platform.request(ws, event, data, options?)` for server-initiated request/reply over the same WebSocket.** The server picks a fresh `ref`, sends `{type:'request', ref, event, data}`, and the returned Promise resolves with whatever the client's `onRequest` handler returned. Rejects with `Error('request timed out')` after `timeoutMs` (default `5000`) and with `Error('connection closed')` if the WebSocket closes before a reply arrives. Pending requests are tracked per-connection on `userData[WS_PENDING_REQUESTS]`, so close cleanup is automatic; refs scoped per-connection so a stray reply on one socket cannot resolve a request on another. Use this for server-driven confirmations, capability challenges, or push-driven state queries that today require user code to maintain its own correlation state.
- **`onRequest(handler)` on the client store** for handling server-initiated requests. Sync or async; return a value to reply with it, throw / reject to send an error reply that surfaces on the server as a Promise rejection. Only one handler may be installed at a time; calling `onRequest` again replaces the previous handler. Returns an unsubscribe function that clears the handler if it is still active. With no handler, request frames are dropped silently and the server's call times out. Available both as a top-level export from `svelte-adapter-uws/client` and as a method on the `WSConnection` returned by `connect()`.
- **`testing.TestServer` now exposes `wsConnections`** (the live Set of connected uWS WebSocket instances) so tests that drive `platform.request(ws, ...)` can target a specific connection without a roundtrip through `waitForConnection`.
- **New optional `subscribeBatch` hook on `hooks.ws`** for bulk-authorising the topic list a client resubscribes to on reconnect. Receives `(ws, topics, { platform })` where `topics` is the pre-validated topic list (already filtered for `INVALID_TOPIC`); returns a record mapping the topics you want to deny to a reason (`false` -> `'FORBIDDEN'`, any string -> that reason verbatim). Omit a topic / return `true` / return `undefined` for it -> allow. Returning `undefined` or `{}` from the hook means "allow everything". Designed for the "one DB query for N topics" pattern - users who would otherwise issue N round-trips per reconnect can collapse to one. If `subscribeBatch` is not exported, the per-topic `subscribe` hook is called once per topic in the batch (unchanged behaviour). Sync only in v1; for async lookups, pre-cache grants on `userData` during `upgrade`.
- **Subscribe acknowledgements with structured denial reasons.** Every client subscribe / subscribe-batch frame now carries a numeric `ref` and the server replies per topic with `{type:'subscribed', topic, ref}` on accept or `{type:'subscribe-denied', topic, ref, reason}` on deny. The `subscribe` hook return value drives the reason: `false` denies with `'FORBIDDEN'`; any string return is forwarded verbatim as the reason (canonical codes are `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`, `'RATE_LIMITED'`, but custom strings work too). The framework also emits `'INVALID_TOPIC'` automatically when a client sends a malformed topic. Backward compatible: old clients that send subscribe without a `ref` get no ack frame, exactly like before.
- **`denials` Svelte store on the client.** Mirrors `status` - import it, subscribe, react. Each subscribe-denied frame becomes the latest `{topic, reason, ref}` value. Pair with a banner / toast / route guard to show users why a subscription was rejected. Available both as a top-level export from `svelte-adapter-uws/client` and as a property on the `WSConnection` returned by `connect()`.
- **`SubscribeDenialReason` type exported from `svelte-adapter-uws` and `svelte-adapter-uws/client`** for users who want to discriminate on canonical reason codes in TypeScript.
- **`websocket.upgradeAdmission` option for two-layer admission control on the WebSocket upgrade path.** Both layers opt-in (zero or unset = disabled), independent of each other. `maxConcurrent` caps how many upgrades may be in flight at once - crossed requests get a fast `503 Service Unavailable` before any per-request work (no TLS, no header parsing, no cookie decoding), so a connection storm can be shed without burning CPU. `perTickBudget` caps how many `res.upgrade()` calls run per event-loop tick - once the budget is spent, subsequent calls are deferred via `setImmediate` so the loop is not starved by 10K synchronous handshakes from one I/O batch. Pre-upgrade work (rate limit, origin check, hook dispatch) still runs in the original tick; only the hand-off to the C++ upgrade path is paced. Deferred upgrades preserve submission order and recheck `aborted`/`timedOut` on resume so a closed connection does not call `res.upgrade()`. The admission state lives in a per-instance closure (`createUpgradeAdmission()` in `files/utils.js`), so multiple uWS apps in one process do not interfere.
- **Session resume protocol on WebSocket reconnect.** On every WS open the server now stamps a per-connection session id and announces it to the client (`{"type":"welcome","sessionId":"..."}`). The client stores the id in `sessionStorage` (keyed per ws path) and tracks the highest `seq` it has seen for each topic. When the connection drops and the client reconnects, it presents the previous session id plus the per-topic last-seen seqs in a `{"type":"resume", sessionId, lastSeenSeqs}` frame, sent before `subscribe-batch`. The server acks with `{"type":"resumed"}`.
- **New optional `resume` hook on `hooks.ws`** receiving `(ws, { sessionId, lastSeenSeqs, platform })`. Use this to fill the disconnect gap, typically by calling the replay plugin's `replay.replay(ws, topic, sinceSeq, platform)` for each topic. Without the hook, the server still acks the resume frame and the client falls through to live mode (same behavior as a cold connect). Old clients ignore the welcome envelope; old servers ignore the resume frame; both directions stay backward compatible. The dev Vite plugin and the test harness (`createTestServer`) carry the same protocol so dev mode, tests, and prod behave identically.
- **`WS_SESSION_ID` Symbol slot on `ws.getUserData()`** stamped before the user's `open` hook runs, so handlers can read the session id from `userData[WS_SESSION_ID]` (export from `svelte-adapter-uws/files/utils.js`) without parsing the wire envelope.

## [0.5.0-next.3] - 2026-04-29

### Fixed

- **Throttle plugin no longer leaks topic state.** The trailing-edge tick in `throttle()` now removes the topic entry from its internal map when the trailing window closes with no pending value (matching the existing `debounce()` cleanup). Previously, every topic ever published through `throttle.publish()` left one map entry behind for the lifetime of the limiter; with high-cardinality patterns like `throttle.publish(platform, 'cursor:' + userId, ...)` this grew without bound. External behavior (leading edge, trailing edge, idle restart) is unchanged.
- **Test harness now applies the same wire-protocol topic validation as production.** `createTestServer()` (`svelte-adapter-uws/testing`) was previously checking only the 256-character length cap on `subscribe` / `subscribe-batch` topics; the production handler also rejects topics that contain control characters. Tests written against the harness now reject the same inputs production rejects.

### Changed

- **Internal: shared the JSON-identifier escape, wire-topic validator, and scoped-topic factory across the production handler, the dev Vite plugin, and the test harness.** The production `files/handler.js`, `vite.js`, and `testing.js` previously held byte-identical copies of `esc(s)`, the topic validation loop, and the `platform.topic(name)` shape (publish / created / updated / deleted / set / increment / decrement). All three now import `esc`, `isValidWireTopic`, and `createScopedTopic` from `files/utils.js`, which is the single source of truth for wire-protocol shape. A/B microbench (5M iterations x 10 alternating rounds): cross-module cost was within baseline noise (esc -0.03%, isValidWireTopic +0.41%, createScopedTopic -0.07%; baseline stddev 1.3-4.2%).
- **Internal: shared the `mockWs` / `mockPlatform` test factories across the seven plugin test files** that previously declared their own copies (`channels`, `cursor`, `groups`, `middleware`, `presence`, `ratelimit`, `throttle`). They now live in `test/_helpers.js`. No behavior change.
- **Removed an unused local in `plugins/middleware/server.js`** (`calledIndex`).
- **Internal: each plugin now declares its wire-protocol topic prefix as a `TOPIC_PREFIX` constant** instead of repeating the literal across the file. Affects `cursor`, `groups`, `presence`, `replay` (server + client). Eliminates a class of refactor-rot bugs - notably `plugins/presence/server.js` previously had `topic.slice(11)` for the length of `'__presence:'`, which would silently misbehave if anyone ever changed the prefix string. Now `topic.slice(TOPIC_PREFIX.length)`. No external behavior change.
- **Internal: `client.js` `crud()` and `lookup()` now share a single CRUD reducer ladder** parameterized by storage adapter (`arrayCrudStorage` for `crud`, `recordCrudStorage` for `lookup`) and a `keyOf(item)` extractor. Previously the four code paths (crud no-maxAge, crud maxAge, lookup no-maxAge, lookup maxAge) hand-rolled the `event === 'created' / 'updated' / 'deleted'` ladder against their respective collection shapes. The dispatcher (`applyCrudReducer`) lives once; the four sites call it with their own storage + `keyOf`. The maxAge variants still own their timestamp tracking and sweep timer; only the per-event reducer body collapsed. Behavior preserved exactly: `keyOf` is `(x) => String(x[key])` for the maxAge variants (matching their previous use of `String()` for timestamp Map keys) and `(x) => x[key]` for the no-maxAge variants. 105 `client-real` tests cover the full surface end-to-end.
- **Internal: WebSocket Origin validation in `files/handler.js` now goes through `isOriginAllowed(reqOrigin, headers, ctx)` in `files/utils.js`** instead of a 4-level-nested ladder inline in the upgrade handler. Pure helper, no module-state capture: PROTOCOL_HEADER / HOST_HEADER / PORT_HEADER overrides, `isTls`, and `hasUpgradeHook` are passed via `ctx`. Same policy as before (`'*'`, `'same-origin'`, or string-array allowlist; default-port stripping; malformed Origin rejected). 21 unit tests in `test/utils.test.js` cover the matrix. A/B microbench (`bench/micro-origin.mjs`, 5M iterations x 10 alternating rounds, 10-input mix): -6.01% median runtime for the extracted form, within the harness's noise floor (steady-state rounds 1-7 showed it consistently ~5-7% faster - V8 specializes the early-return function form better than the long `let allowed = false` ladder).
- **e2e suite now allocates ports dynamically.** `test/e2e/` previously hardcoded `49321` (dev) and `49322` (prod), which fall inside the Hyper-V dynamic exclusion range on Windows (auto-assigned per boot somewhere within 49152-65535). On a typical Windows box `npm run test:e2e` failed instantly with `EACCES: permission denied ::1:49321`. A new `test/e2e/ports.js` picks two free OS-assigned ports at module-load time via `net.createServer().listen(0)`, caches them into `E2E_DEV_PORT` / `E2E_PROD_PORT` env vars, and is imported by `playwright.config.js`, `global-setup.js`, `dev.spec.js`, and `prod.spec.js`. The `dev-server.js` / `prod-server.js` fallbacks were updated to read the same env vars when run standalone. No CI/Linux behavior change; Windows users can now actually run the suite (verified: 25/25 e2e tests passing locally on Windows).
- **Internal: per-connection adapter scratch state moved off user-visible dunder strings to Symbol-keyed slots.** The adapter previously stored its `__subscriptions` (Set of subscribed topics, used to populate `CloseContext.subscriptions`) and `__coalesced` (sendCoalesced buffer) directly on user-visible `getUserData()`. A user `upgrade()` hook returning `{ __subscriptions: ... }` would clobber the adapter's tracking; `Object.keys(getUserData())` and JSON-serialize would expose them. Both slots now live under `WS_SUBSCRIPTIONS` and `WS_COALESCED` symbols exported from `files/utils.js`. The user-facing close-handler `CloseContext.subscriptions` shape is unchanged; this is purely internal isolation. Affects `handler.js` (8 sites), `vite.js` (5), `testing.js` (5). A/B microbench (`bench/micro-symbol-vs-dunder.mjs`, 5M iterations x 10 rounds): +1.08% median runtime for Symbol-keyed access on the subscribe hot path, within baseline stddev +/- 1.62%; verdict noise.

## [0.5.0-next.2] - 2026-04-28

### Added

- **`createLock()` plugin at `svelte-adapter-uws/plugins/lock`.** Per-key serialization for critical sections that must not interleave - atomic read-modify-write on user state, "only one in-flight upgrade per resource," anywhere two requests racing the same record would corrupt it. Concurrent `withLock(key, fn)` calls on the same key queue FIFO; calls on different keys run in parallel. Errors from `fn` propagate to the caller and do not block subsequent waiters on the same key. Backed by a single `Map<string, Promise>` chain - no timers, no allocations on the steady-state path. The plugin also exposes `held(key)`, `size()`, and `clear()` for inspection and test teardown. The contract is shaped to map cleanly onto a future Redis-backed swap (`SET NX PX`) in the extensions package, so user code written against the in-process plugin moves to a distributed lock without an API change.
- **`createSession()` plugin at `svelte-adapter-uws/plugins/session`.** In-process session store with sliding TTL: every `get` or `touch` extends an entry's expiry by another full ttl window. Designed for the "load on WS upgrade, refresh on activity" pattern. The plugin exposes `get(token)`, `set(token, data)`, `delete(token)`, `touch(token)`, `size()`, and `clear()`. Expired entries are pruned lazily on access. A soft `maxEntries` cap (default 10000) triggers pruning of expired entries when exceeded; if the map is still over cap after pruning (i.e. all entries are live), the oldest insertion-order entries are evicted to keep memory bounded. The contract is shaped to map cleanly onto a future Redis-hash swap in the extensions package.
- **`createDedup()` plugin at `svelte-adapter-uws/plugins/dedup`.** In-process "have I seen this id before?" cache with **fixed-window** TTL (unlike Session, the window does NOT slide on duplicate claims - the semantics match Redis `SET NX EX`, the eventual distributed swap target). The natural use is wrapping a side-effecting handler so client retries after a flaky disconnect do not double-execute: `if (!dedup.claim(messageId)) return;`. Exposes `claim(id)` (atomic check-and-mark, returns `true` on first sight / after expiry, `false` inside the window), `has(id)`, `delete(id)`, `size()`, and `clear()`. Same `maxEntries` eviction semantics as the Session plugin. This is the in-memory zero-config default for idempotent message delivery.

## [0.5.0-next.1] - 2026-04-28

### Added

- **`platform.sendCoalesced(ws, { key, topic, event, data })`** - new per-connection send primitive with coalesce-by-key semantics. Each `(connection, key)` pair holds at most one pending message; if a newer call for the same key arrives before the previous frame drains, the older value is replaced in place. Latest value wins, original insertion order across keys is preserved. Use for latest-value streams where intermediate values are noise (price ticks, cursor positions, presence state, typing indicators, scroll position). Serialization is deferred to flush time, so a stream that overwrites the same key 1000 times before a drain pays one `JSON.stringify`, not 1000. Pumping resumes automatically on the connection's next drain event - `send()` and `publish()` are unchanged.
- **`platform.pressure`** and **`platform.onPressure(cb)`** - worker-local backpressure signal. The adapter samples once per second (configurable) and exposes `{ active, subscriberRatio, publishRate, memoryMB, reason }` where `reason` is one of `'NONE'`, `'PUBLISH_RATE'`, `'SUBSCRIBERS'`, `'MEMORY'` with fixed precedence (memory wins over publish rate wins over subscribers). `onPressure(cb)` fires on `reason` transitions and returns an unsubscribe function. Use this to drive targeted degradation (shed background streams, return 503 for non-critical writes) instead of generic panic on slow consumers. Thresholds are configurable via `WebSocketOptions.pressure`; each individual signal can be set to `false` to disable. Defaults are conservative and a healthy small app should not trip them in steady state.
- **Per-topic monotonic `seq` on every broadcast envelope** - `platform.publish()` now stamps a monotonic per-topic sequence number into the envelope (`{ topic, event, data, seq }`). The first publish to a topic sends `seq: 1`, the next `seq: 2`, and so on; each topic has its own counter. Reconnecting clients can use the seq to detect dropped frames and resume from where they left off. The wire change is purely additive - clients that don't care about seq simply ignore the extra field. Pass `{ seq: false }` to opt out for ephemeral or high-cardinality topics where the counter map would grow unbounded. The `WSEvent<T>` client type gains an optional `seq?: number` field for downstream consumers. In clustered mode the seq is worker-local; the originating worker's seq propagates verbatim through the relay to other workers, so concurrent publishers on the same topic across multiple workers can produce colliding seqs. The testing harness (`createTestServer`) is brought to wire-format parity, so user tests against the harness see the same envelope shape as production.
- **`classifyCloseCode(code)` - explicit close-code classification on the client.** The reconnect dispatch now goes through a named primitive that maps every WebSocket close code into one of three buckets: `'TERMINAL'` (1008/4401/4403 - permanent rejection, no further reconnect), `'THROTTLE'` (4429 - server-side rate-limit, jump ahead in the backoff curve), or `'RETRY'` (everything else, including normal closes 1000/1001 and abnormal 1006/1011/1012). Behavior is unchanged: terminal codes still stop the retry loop, throttle codes still bump the attempt counter to 5, retry codes still go through the standard backoff. The lift from implicit-third-branch to named primitive makes the contract testable in isolation and gives callers a single place to reason about close semantics.

### Changed

- **Reconnect curve: `2.2^attempt` with a 5 minute cap.** The exponential factor moves from `1.5^attempt` to `2.2^attempt` and the default `maxReconnectInterval` cap moves from `30000` (30 seconds) to `300000` (5 minutes). The proportional +/- 25% jitter is unchanged. The new curve hits the cap by attempt 6 with the default 3 second base, vs the old curve which capped at 30 seconds and stayed there from attempt 6 onward. Net effect: brief restarts feel the same (first few attempts are short), but a sustained outage backs off harder, which is kinder to a server that is genuinely struggling. The `'THROTTLE'` close-code response (4429) inherits the new curve; jumping to attempt 5 now lands at ~155 seconds instead of ~22 seconds. Users who want the old behavior can pass `{ maxReconnectInterval: 30000 }` explicitly. The delay calculation is now a pure helper (`nextReconnectDelay`) on `client.js`, with unit tests covering attempt-zero base case, exponential growth, cap-saturation, multiplicative jitter at the cap (so 10K clients hitting the cap simultaneously don't reconnect in lockstep), and custom base/cap overrides.

---

## [0.4.14] - 2026-04-17

### Fixed

- **`res.upgrade()` fires uWS "writes must be made from within a corked callback" warning**: restored `res.cork()` around the WebSocket upgrade in both the sync (no-upgrade-handler) path and the async (user-upgrade-handler) path, and in the same-signature path in `testing.js`. One warning per upgrade is now gone.
- **Revisited the 0.4.11 "Windows upgrade" fix**: 0.4.11 removed the cork wrapper around `res.upgrade()` based on a 1006 reproducer that turned out to be the same root cause 0.4.12 then fixed with the `authenticate` hook -- Cloudflare Tunnel (and similar edge proxies) silently closing WebSocket connections whose 101 response carries `Set-Cookie`. The cork was never the problem: 0.2.9 shipped the same `res.cork(() => res.upgrade(...))` pattern and has been running on Windows native (NSSM service, no proxy) in production for months without a single 1006. Same uWS version (v20.60.0) in both. With `authenticate` now owning the session-refresh-over-WS contract, `upgradeResponse()` with `Set-Cookie` is already discouraged and emits a build-time + runtime warning, so the proxy-strip scenario no longer rides on the cork site.

### Verification

- Full unit suite: 839/839 pass.
- Playwright e2e suite (dev + prod, browser + raw `ws` client, 25 tests): pass on Windows native against a real uWS server with the restored cork.
- Raw upgrade smoke test against the prod fixture: 3 consecutive WS upgrades, all clean close 1005, no uWS warnings, no 1006.

### Note on the prior diagnosis

The 0.4.11 CHANGELOG entry is kept as-is for historical accuracy. The real fix for the symptom it described landed one commit later in 0.4.12 (`authenticate` hook). If you were relying on `upgradeResponse({ 'set-cookie': ... })` through Cloudflare Tunnel, migrate to `authenticate`.

---

## [0.4.13] - 2026-04-17

### Fixed

- **Streaming SSR `res.write()` warning**: the multi-chunk streaming branch of `writeResponse()` wrote chunks 3+ via a bare `res.write(value)` outside of any cork, which tripped uWS's `writes must be made from within a corked callback` warning once per streamed chunk. The original comment assumed that corking each chunk would hide the backpressure signal, but `res.cork()` invokes its callback synchronously, so the boolean return value of `res.write()` inside cork still reflects the live socket state. Fixed by extracting a `writeChunkWithBackpressure()` helper that corks the write and, if backpressure builds, registers the `onWritable` drain handler inside the same cork. The backpressure semantics, 30s drain timeout, and per-chunk syscall batching are all preserved.
- **Streaming timeout `res.close()` cork**: when the 30s drain timeout fires and the adapter abruptly closes the connection to avoid sending a truncated clean EOF, the close now runs inside `res.cork()` to stay consistent with the rest of the response path and suppress any future uWS state-mutation warnings.

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
