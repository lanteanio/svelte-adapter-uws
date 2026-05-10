# Migration guide: svelte-adapter-uws 0.4.x to 0.5.x

This guide enumerates every breaking change between the latest 0.4.x release and the current 0.5.x line. Apply each step in order; sections are independent unless explicitly chained.

If you are upgrading via `npm install svelte-adapter-uws@latest`, the registry will pull whatever the current `latest` dist-tag points to. To pin a specific 0.5 prerelease, use `svelte-adapter-uws@next`.

## Breaking changes

### Runtime: Node.js 22+ required (was Node 20+)

**What changed.** `package.json#engines.node` moved from `>=20.0.0` to `>=22.0.0`. Tracks `uWebSockets.js` v20.67.0, which dropped Node 20 support upstream. Node 22 LTS, Node 24 current, and Node 26 are supported. Picks up real upstream wins from v20.60 to v20.67: backpressure fix (v20.64), Latin-1 string handling (v20.65), faster String args via V8 ValueView (v20.63), zero-cost `getRemoteAddress` / `getRemoteAddressAsText` (v20.66), `getRemotePort` / `getProxiedRemotePort` (v20.61), DeclarativeResponse improvements, and symbol-keyed userData support.

**How to migrate.**

- Confirm your runtime is Node 22+ in CI and prod. Node 22 LTS is the minimum.
- Bump any `node:20-*` Docker base image to `node:22-*` or later.
- Bump CI matrix entries from `node-version: '20'` to `'22'` (and optionally add `'24'`).
- Apps that hand-roll `engines` checks against Node 20 should update accordingly.

### Peer dep: `@sveltejs/kit ^2.59.0` (was `^2.0.0`)

**What changed.** The peer-dep floor on `@sveltejs/kit` moved from `^2.0.0` to `^2.59.0`. Apps still pinned to kit 2.0.x to 2.58.x will see a peer-dep warning at install. The previous range allowed pre-2.5 installs that were missing significant cumulative kit fixes; the new floor matches the audit's recommendation.

**How to migrate.** Bump your `@sveltejs/kit` dependency to `^2.59.0` or later in your app's `package.json`. One known transitive advisory persists (`cookie<0.7.0` via kit's own `cookie: ^0.6.0` pin) and is unfixable from this side until the kit team publishes a release that bumps cookie; the advisory is low severity and applies to cookie name/path/domain edge cases.

### 1. Async `subscribe` / `subscribeBatch` hooks now fail closed

**What changed.** Previously, an `async (ws, topic) => false` subscribe hook returned a `Promise<false>` to the runtime; the framework compared the Promise object against `false`, both of which were always falsy-against-truthy mismatches, so the framework treated EVERY async hook return as ALLOWED. Every app using async subscribe hooks (the idiomatic style for hooks that read a session store or DB) silently let every subscribe through, bypassing the developer's intended access control. The runtime now awaits the hook before inspecting its return value.

**How to migrate.** No source change is required if your hook was already correct in intent. AUDIT every async `subscribe` / `subscribeBatch` export to confirm it returns the values you expect (`false`, `'FORBIDDEN'`, etc) on the deny path; tests that previously passed because every subscribe was allowed will now exercise the real gate. `platform.subscribe(ws, topic)` and `platform.checkSubscribe(ws, topic)` are now async and must be awaited at every call site. If you wrote a `platform.sendTo(filter, ...)` filter as an async function, rewrite it to be sync (resolve any input data into `userData` from the upgrade hook); async filters are now treated as not-matching (fail closed) and log a one-time `console.error`.

### 2. Default `maxPayloadLength` raised from 16 KB to 1 MB

**What changed.** The default cap on a single inbound WebSocket frame moved from 16 KB to 1 MB. The new default aligns with `socket.io` and Cloudflare Workers' WS message cap. Apps that were chunking large payloads to fit under 16 KB will now accept them in fewer chunks (or in a single frame).

**How to migrate.** No action needed for most apps. To pin the previous cap, set `websocket.maxPayloadLength: 16 * 1024` in `svelte.config.js`. To pin any other value, set the option to that byte count. DoS protection remains layered: `upgradeAdmission.maxConcurrent` caps connection count, `maxBackpressure` caps per-connection outbound queue size.

### 3. Wire-level subscribes to `__`-prefixed system topics blocked by default

**What changed.** Previously, any authenticated client could send `{"type":"subscribe","topic":"__signal:victim-userId"}` and intercept every `live.signal()` to that user, plus plugin presence / group / replay broadcasts on `__presence:*`, `__group:*`, `__replay:*`. The wire-level subscribe and subscribe-batch handlers now reject any topic whose first two bytes are `__` with `INVALID_TOPIC`. Server-side `platform.subscribe(ws, '__signal:userId')` (the legitimate framework pattern) still works.

**How to migrate.** No action needed if you only subscribe to system topics from server code. If your app legitimately routes public topics through the `__` prefix (rare), set `websocket.allowSystemTopicSubscribe: true` in `svelte.config.js`.

### 4. `resume` hook now awaited before the `resumed` ack frame

**What changed.** The user's `resume` hook previously fired fire-and-forget; the `{type:'resumed'}` ack went out immediately and the client switched to live mode while replay frames were still in flight, producing out-of-order events. The runtime now awaits the resume hook before sending the ack.

**How to migrate.** Confirm any async work you do in the `resume` hook (replay enqueue, DB lookup, etc.) is `await`ed inside the hook body. Long-running synchronous work in the hook will now delay the resume ack; refactor expensive work to fire after the ack via `setImmediate` if needed.

### 5. `/__ws/auth` POST now requires Origin / `x-requested-with` / `Sec-Fetch-Site`

**What changed.** The authenticate POST endpoint previously accepted any credentialed cross-origin POST. A request must now satisfy at least one of: `x-requested-with: XMLHttpRequest`, `Sec-Fetch-Site: same-origin`, or an `Origin` header matching `allowedOrigins`. The bundled adapter client always stamps `x-requested-with` on its preflight POST, so browser-side flows are unaffected.

**How to migrate.** No action needed for browser apps using the bundled client. For native (non-browser) clients hitting `/__ws/auth` directly, either stamp `x-requested-with: XMLHttpRequest` on the request, or set `websocket.authPathRequireOrigin: false` in `svelte.config.js` to opt out.

### 6. Dynamic compression skipped for credentialed responses (BREACH defense)

**What changed.** The dynamic brotli/gzip branch previously fired on every response above 1 KB. Combined with attacker-influenced reflected input alongside a secret in the page body (CSRF token, session ID, API key), the compressed length leaked the secret one byte at a time via the BREACH attack. Requests carrying `Cookie` or `Authorization` now skip dynamic compression. Anonymous responses still compress; build-time precompressed static files are unaffected.

**How to migrate.** No action needed; uncompressed credentialed SSR is the safe default. If you have audited every page for BREACH defenses (random per-response masking, prefix randomization, no secrets reflected with attacker input), opt back in via `websocket.compressCredentialedResponses: true`.

### 7. Refuse to start on `same-origin` policy without host pin

**What changed.** A bare `allowedOrigins: 'same-origin'` config running without `ORIGIN` env, `HOST_HEADER` env, native TLS (`SSL_CERT`/`SSL_KEY`), or an `upgrade()` hook previously silently accepted any non-browser scripted client (the same-origin check compares two attacker-controlled headers). The runtime now throws at startup with a human-readable resolution list.

**How to migrate.** Pick one of: set the `ORIGIN` env var to your canonical origin, set `HOST_HEADER` env, configure native TLS, export an `upgrade()` hook, or switch `allowedOrigins` to an explicit string-array allowlist. Apps that have audited the deployment can opt out via `websocket.unsafeSameOriginWithoutHostPin: true`.

### 8. Wire-topic accept set tightened to printable ASCII

**What changed.** The wire accept set moved from "anything except control bytes / quote / backslash" to "printable ASCII (0x20-0x7E) except quote / backslash". Pre-fix, hostile clients could subscribe to topics containing line-separator characters, BiDi overrides, byte-order marks, or arbitrary non-ASCII. Server-side `platform.subscribe` and `platform.checkSubscribe` keep their previous looser accept set, so server-side code using non-ASCII topic names is unaffected.

**How to migrate.** No action needed unless your app legitimately accepts non-ASCII topic names FROM CLIENTS. If it does, set `websocket.allowNonAsciiTopics: true`.

### 9. `isValidWireTopic` rejects `"` and `\\`

**What changed.** The wire-accept set now matches `esc()`'s rejection set. Pre-fix, a client could subscribe to topic `"` (passes wire), and any later `platform.publish('"', ...)` crashed because envelope-build threw on those characters.

**How to migrate.** No action needed for healthy apps. If you have client code that sent literal `"` or `\\` topic names, rename those topics.

### 10. SSR dedup cache key includes `base_origin`

**What changed.** Previously the dedup key was `method + '\0' + url`. In virtual-hosting deployments (one uWS instance behind multiple Host aliases), two concurrent anonymous GETs to `/` from `tenantA.example` and `tenantB.example` shared one SSR call, producing a cross-tenant leak. The key is now `method + '\0' + base_origin + '\0' + url`.

**How to migrate.** No action needed; previously-correct apps see a tighter dedup behavior.

### 11. Cookie `path` / `domain` attribute injection blocked in `serializeCookie`

**What changed.** Both attributes are now validated against the same character class as cookie values (no CTLs, no `;`, no `,`, no whitespace, no DEL) before concatenation. Non-strings throw the same way as malformed names/values.

**How to migrate.** Confirm every `cookies.set(name, value, { path, domain })` call passes a valid path / domain. Calls passing user-influenced strings will now throw at the call site instead of silently producing a malformed `Set-Cookie`.

### 12. Wire single-subscribe frames consult `subscribeBatch` when only `subscribeBatch` is exported

**What changed.** Previously, an app exporting only `subscribeBatch` for centralized authorization had its hook fire for batch frames but silently bypassed for single subscribes. Single subscribes are now routed through `subscribeBatch` (treated as a 1-element batch) when only `subscribeBatch` is exported.

**How to migrate.** A `subscribeBatch` hook authored before this fix may now receive 1-element `topics` arrays where it previously did not see single frames at all. Confirm your hook handles short arrays correctly (any reasonable hook does).

### 13. Initial-mount client subscribes are microtask-batched

**What changed.** Multiple `subscribe(topic)` calls landing in the same microtask now coalesce into one `{type:'subscribe-batch', topics, ref}` wire frame instead of N individual `{type:'subscribe', topic, ref}` frames. Triggers `subscribeBatch` on the server once instead of `subscribe` N times.

**How to migrate.** Update any test that asserts on the exact wire shape of two same-microtask subscribes seeing two `subscribe` frames; use `.find(m => m.type === 'subscribe-batch' && m.topics.includes(...))` instead. No source change in app code.

### 14. Client `status` store expanded to a five-state machine

**What changed.** The `'closed'` state was split into `'disconnected'` (transient, will retry), `'failed'` (terminal: auth denied, max retries, or `close()` called), and `'suspended'` (open but tab is backgrounded). `ready()` now resolves on either `'open'` or `'suspended'`.

**How to migrate.** Replace any `$status === 'closed'` check with the appropriate split:

- `$status === 'disconnected'` for transient drops
- `$status === 'failed'` for terminal failures
- `$status === 'failed' || $status === 'disconnected'` for "anything not connected"
- Read `_permaClosed` directly if the only relevant case was the terminal one.

### 15. Presence plugin wire format switched to a compact diff protocol

**What changed.** The five-event format (`list` / `join` / `updated` / `leave` / `heartbeat`) collapses to two diff-shaped events plus the existing heartbeat: `presence_state` (full snapshot) and `presence_diff` (joins/leaves). Diffs are microtask-batched. Server and client ship in one bundle, so a single-package upgrade is seamless.

**How to migrate.** No action needed for users of the bundled `presence()` Svelte store on the client. Hand-rolled clients that consume the wire directly need to switch decoders to handle `presence_state` and `presence_diff` events. Stale browser tabs from a previous deploy will see a blank presence list until refresh.

### 16. Replay plugin checks subscribe authorization before reading a topic's buffer

**What changed.** Replay backends now consult `platform.checkSubscribe(ws, topic)` before reading any topic's buffer; topics the wire-subscribe gate would deny emit a `denied` event on `__replay:{topic}` (the client treats this similarly to `truncated`).

**How to migrate.** No action needed if you use the bundled replay client, which handles the new event. Hand-rolled replay consumers should add a branch for `denied` events.

### 17. `parse_as_bytes` rejects negative and non-finite values

**What changed.** `BODY_SIZE_LIMIT=-100K` previously resolved to a negative number that read like "no limit" downstream; `BODY_SIZE_LIMIT=Infinity` similarly bypassed every byte-budget check. Both now resolve to NaN, which the existing `if (isNaN(body_size_limit)) throw` guard routes to a clean startup error.

**How to migrate.** Audit any `BODY_SIZE_LIMIT` env value you set; values must be strictly positive finite (`512K`, `2M`) or `0` (which means unlimited).

### 18. `parseCookies` returns a null-prototype object

**What changed.** The returned bag has no prototype chain; a request with a `__proto__=evil` Cookie cannot leak attacker-controlled values through `cookies.toString` / `cookies.constructor` lookups.

**How to migrate.** No action needed unless your code reads inherited prototype methods off a `parseCookies` result (rare). Iterate keys with `for (const k in bag)` or `Object.keys(bag)` as before.

### 19. `x-no-dedup` header is no longer consulted

**What changed.** Any anonymous client could previously stamp `x-no-dedup: 1` to defeat SSR shared-leader fan-in and amplify server-side render cost. The header is now ignored.

**How to migrate.** If you used `x-no-dedup: 1` for per-request tracing during debugging, send a `Cookie` or `Authorization` header instead (legitimate authenticated callers always skip dedup).

### 20. Dev plugin enforces `allowedOrigins` on the WSS upgrade

**What changed.** The dev plugin previously printed a warning that "Dev mode does not enforce allowedOrigins" and accepted every WS upgrade. Dev now runs the same `isOriginAllowed` check production runs.

**How to migrate.** No action needed if your dev `allowedOrigins` matches the dev origin you connect from. To accept dev connections from arbitrary origins (legacy local dev scenarios), pass `devSkipOriginCheck: true` to the Vite plugin.

### 21. Bounded-by-default capacity caps across the adapter and bundled plugins

**What changed.** Every internal `Map` / `Set` whose growth is driven by client behaviour or topic cardinality now has an explicit upper bound (default 1,000,000) and a documented saturation behaviour. New subscribes past `MAX_SUBSCRIPTIONS_PER_CONNECTION` respond with `subscribe-denied` reason `'RATE_LIMITED'`. New `platform.request()` past the per-connection cap rejects synchronously. Plugins (`ratelimit`, `throttle`, `debounce`, `cursor`, `presence`, `lock`) gain `maxBuckets` / `maxTopics` / `maxConnections` / `maxKeys` options at the same defaults.

**How to migrate.** No action needed for healthy apps; defaults are deliberately generous. Apps that approach 1M of any single resource per connection or per topic registry should investigate the leak rather than raise the cap.

### 22. `queue` plugin `maxSize` default changed from `Infinity` to `1,000,000`

**What changed.** The `queue` plugin now drops tasks via `onDrop` once 1M waiting tasks accumulate per key.

**How to migrate.** Pass `{ maxSize: Infinity }` explicitly to opt back into the previous behaviour. Any real workload reaching 1M waiting tasks per key likely has a leak.

### 23. `lock.clear()` rejects pending waiters with `LOCK_CLEARED`

**What changed.** Pre-fix, `clear()` only cleared the lookup Map and pending callers continued to resolve as the chain unfolded. The new waiter-queue owns the only reference to pending callers, so `clear()` must explicitly reject them.

**How to migrate.** If you relied on pending calls completing across a `clear()` in a teardown path, catch `LOCK_CLEARED` and treat it as success.

### 24. `start()` is now async; init / shutdown lifecycle hooks supported

**What changed.** `start(host, port)` (production) and `createTestServer()` (test harness) return promises that resolve only after the new `init` hook completes. A throwing `init` rejects the promise. The dev plugin and test harness await `init` before declaring readiness. Two new optional `hooks.ws` exports: `init({ platform })` and `shutdown({ platform })`.

**How to migrate.** No action needed for the default code paths (the adapter's `index.js` already awaits). If you have custom code calling `start()` directly, await it. To use `init` to capture `platform` at boot (replacing the lazy "first connect" pattern), export `async init({ platform })`. Each worker fires its own `init`; layer leader election on top if you need cluster-wide singleton semantics.

### 25. `lock.withLock` accepts `maxWaitMs` and rejects with `LOCK_TIMEOUT`

**What changed.** Third argument to `withLock(key, fn, { maxWaitMs })` now supports bounded-wait. A rejected waiter receives a typed `LOCK_TIMEOUT` error with `.code`, `.key`, and `.maxWaitMs`. The current holder is not interrupted; subsequent waiters are unaffected.

**How to migrate.** No action needed for existing two-argument callers (no behavior change for them). If you adopt `maxWaitMs`, handle `LOCK_TIMEOUT` rejections at the call site.

### 26. Per-event `coalesceKey` collapses duplicates in `publishBatched`

**What changed.** Per-event `coalesceKey?: string` collapses same-key duplicates before framing in `publishBatched`. Latest value wins at the latest occurrence's position. Capability-gated: clients opt in via a `{type:'hello', caps:['batch']}` frame after open (the bundled client does this automatically). When the fast path does not apply, `publishBatched` falls back to a per-event `publish()` loop.

**How to migrate.** Hand-rolled client code consuming the wire directly should send a `hello` frame advertising the `batch` capability if it wants batched frames; otherwise the server falls back to per-event frames as before. Bundled clients work automatically.

### 27. Per-connection adapter scratch state moved to Symbol-keyed slots

**What changed.** `__subscriptions` and `__coalesced` previously sat directly on user-visible `getUserData()`. They now live under `WS_SUBSCRIPTIONS` and `WS_COALESCED` symbols exported from `files/utils.js`. The user-facing `CloseContext.subscriptions` shape is unchanged.

**How to migrate.** If your `upgrade()` hook returned an object containing a `__subscriptions` or `__coalesced` key, those keys will no longer collide with the adapter; you keep your own values. If your code read the adapter's internals via `getUserData().__subscriptions`, switch to `import { WS_SUBSCRIPTIONS } from 'svelte-adapter-uws/files/utils.js'` and read `getUserData()[WS_SUBSCRIPTIONS]`.

### 28. `platform.subscribe` and `platform.checkSubscribe` are first-class authorization gates

**What changed.** `platform.subscribe(ws, topic)` routes a server-initiated subscribe through the user's `hooks.ws.subscribe` authorization hook before the actual `ws.subscribe` runs. Returns `null` on success or a denial reason. `platform.checkSubscribe(ws, topic)` is a pure-gate companion (does not modify subscription state). Direct `ws.subscribe()` calls intentionally bypass the hook (the bypass we are guarding against).

**How to migrate.** Downstream library / framework code that previously called `ws.subscribe()` directly inside an RPC handler (a real authorization-bypass class of bug) should switch to `await platform.subscribe(ws, topic)` and treat a non-null return value as a denial.

## After upgrading

Run your test suite. Pay particular attention to:

- Async `subscribe` / `subscribeBatch` hooks that may now correctly deny requests they previously allowed.
- Custom WebSocket clients decoding `__presence:{topic}` and `__replay:{topic}` frames.
- Code that depended on the `'closed'` status state.
- Native (non-browser) clients hitting `/__ws/auth` directly.
- Deployments running `same-origin` without an `ORIGIN` / `HOST_HEADER` pin.
- Custom `BODY_SIZE_LIMIT` env values.

Report regressions against the changelog entry the issue maps to.
