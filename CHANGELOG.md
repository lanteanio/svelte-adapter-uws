# Changelog

All notable changes to `svelte-adapter-uws` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0-next.20] - 2026-05-10

### Changed

- **Bumped `engines.node` to `>=22.0.0` (was `>=20.0.0`); pinned `uWebSockets.js` to v20.67.0 (was v20.60.0).** uWS v20.67.0 dropped Node 20 support upstream; the adapter follows. Node 22 LTS, Node 24 current, and Node 26 are supported. Picks up real upstream wins from v20.60 to v20.67: backpressure fix (v20.64), Latin-1 string handling (v20.65), faster String args via V8 ValueView (v20.63), zero-cost `getRemoteAddress` / `getRemoteAddressAsText` (v20.66), `getRemotePort` / `getProxiedRemotePort` (v20.61), DeclarativeResponse improvements, and symbol-keyed userData support. See `MIGRATION.md` for the runtime-bump checklist.
- **Bumped `peerDependencies.@sveltejs/kit` from `^2.0.0` to `^2.59.0`.** Tightens the floor from "any kit 2.x" to a recent stable that picks up the cumulative kit fixes shipped over the last year. The previous range allowed pre-2.5 installs that were missing significant security and SSR fixes; the new floor matches the audit's recommendation. One known transitive advisory persists (`cookie<0.7.0` via `@sveltejs/kit`'s own `^0.6.0` pin) and is unfixable from this side until kit publishes a release that bumps cookie.

### Security

- **`subscribe` / `subscribeBatch` hooks no longer fail open when async (CRITICAL).** Pre-fix, a hook written as `async (ws, topic) => false` returned a `Promise<false>` from the handler runtime; `result === false` is false (a Promise is not strictly equal to `false`), `typeof result === 'string'` is false, so the framework treated the return as ALLOWED. Every app using async subscribe hooks (the idiomatic style for hooks that touch a session store or DB) silently let every subscribe through, bypassing the developer's intended access control. Fix: the wire-level message handler is `async`; `runSubscribeHook` and `runSubscribeBatchHook` await the user's hook before inspecting the return value. `platform.subscribe` and `platform.checkSubscribe` are also `async` (breaking: callers must `await`); the JSdoc and example block show the new shape. Belt-and-suspenders re-checks after the await catch concurrent-subscribe races so `totalSubscriptions` cannot double-count and the cap cannot be raced past. Mirrored in the dev plugin (`vite.js`) and the test harness (`testing.js`) so a regression test against `createTestServer` exercises the same code path. The `platform.sendTo(filter, ...)` filter sees a different fix shape: an async filter cannot be awaited per-connection without changing the broadcast API, so a Promise return is detected, the connection is treated as not-matching (fail-closed), and a one-time `console.error` directs the developer to resolve filter inputs into userData from the upgrade hook.
- **Wire subscribes to `__`-prefixed system topics blocked by default (HIGH).** Pre-fix, `isValidWireTopic` accepted any topic with a `__` prefix; a normal authenticated client could send `{"type":"subscribe","topic":"__signal:victim-userId"}` and intercept every `live.signal()` to that user, plus plugin presence / group / replay broadcasts on `__presence:*`, `__group:*`, `__replay:*`. Fix: the wire single-subscribe and subscribe-batch branches now reject topics whose first 2 bytes are `__` with `INVALID_TOPIC` UNLESS the new `websocket.allowSystemTopicSubscribe: true` opt-in is set. The block is at the wire layer only; server-side `platform.subscribe(ws, '__signal:userId')` (the legitimate pattern that `enableSignals` uses) still works.
- **Wire `resume` hook is awaited before the `resumed` ack frame (HIGH).** Pre-fix, the user's resume hook fired fire-and-forget and `{type:'resumed'}` went out immediately; the client switched to live mode while replay frames were still in flight, producing out-of-order events. Fix: `await wsModule.resume(ws, ctx)` before the ack. The matching extensions-side fix (replay backends now consult `platform.checkSubscribe(ws, topic)` before reading any topic's buffer) emits a `denied` event on `__replay:{topic}` for topics the wire-subscribe gate would deny; the client treats this similarly to `truncated` (gap-fill stops for that topic, the rest of the resume completes).

### Added

- **`websocket.allowSystemTopicSubscribe: boolean` opt-in flag (default `false`).** When `true`, wire-level subscribes to `__`-prefixed topics are allowed. Use only for advanced apps that intentionally route public topics through the `__` prefix.

### Security

- **`isValidWireTopic` defaults to printable-ASCII-only (LOW).** The wire-topic accept set is tightened from "anything except control bytes / quote / backslash" to "printable ASCII (0x20-0x7E) except quote / backslash". Pre-fix, a hostile client could subscribe to a topic containing U+2028 / U+2029 line separators, U+202E right-to-left override (BiDi spoofing), U+FEFF byte-order mark, or arbitrary non-ASCII characters. These survive the wire and surprise log dashboards, admin UIs, and grep-based incident-response tools that render topic names back to a human. The check is applied at the wire-subscribe and subscribe-batch boundary; server-side `platform.subscribe(ws, topic)` and `platform.checkSubscribe(ws, topic)` keep their previous (looser) accept set so apps using non-ASCII topic names from server code (e.g. `__signal:Jose`, presence rooms with localized labels) are unaffected. Apps that legitimately accept non-ASCII topics from clients can opt in via `websocket.allowNonAsciiTopics: true`. Mirrored in the dev plugin and test harness via `allowNonAsciiTopics` on each respective options surface.
- **`parse_as_bytes` rejects negative and non-finite values (LOW).** Pre-fix, `BODY_SIZE_LIMIT=-100K` resolved to a negative number that read like "no limit" downstream; `BODY_SIZE_LIMIT=Infinity` similarly bypassed every byte-budget check. Both now resolve to NaN, which the existing `if (isNaN(body_size_limit)) throw` guard already routes to a clean startup error. Strict positive-finite numbers (`512K`, `2M`, `0`) keep working unchanged.
- **`parseCookies` returns a null-prototype object (LOW).** Pre-fix, the returned bag had `Object.prototype` as its prototype chain; a request with a `__proto__=evil` Cookie could leak attacker-controlled values through downstream `cookies.toString` / `cookies.constructor` lookups. Fix: `Object.create(null)` removes the prototype chain entirely while preserving every documented `cookies[name]` access pattern. The same null-proto guarantee holds on empty input and on `parseCookies(undefined)`.
- **Expanded `SENSITIVE_KEY_PATTERNS` warning list (LOW).** The userData warning fires when an `upgrade()` hook stores fields whose names suggest sensitive data (`token`, `secret`, `password`, etc.). Added `email`, `phone`, `ssn`, `dob`, `iban`, `creditcard`, `cc`, `pin` so a user upgrade hook that stuffs PII into `userData` (then ships it via `platform.publish` fanout) is flagged once at first connect. The userData object is accessible to every server-side handler and ships out with publishes that include it - catching the antipattern at first connect tells the developer at the call site rather than relying on a code review they may never get.
- **`x-no-dedup` header is no longer consulted (LOW).** Pre-fix, any anonymous client could stamp `x-no-dedup: 1` on every request to defeat the SSR shared-leader fan-in and amplify server-side render cost. Since legitimate debug callers can always send a `Cookie` or `Authorization` header to skip dedup naturally, the bypass header serves no purpose and is now ignored.
- **Dev plugin enforces `allowedOrigins` on the WSS upgrade (LOW).** Pre-fix, the dev plugin printed a warning that "Dev mode does not enforce allowedOrigins" and accepted every WS upgrade. The dev port is reachable from any other process on the dev machine; a hostile page in another browser tab can connect just like it can to the production endpoint. Fix: the dev upgrade handler now runs the same `isOriginAllowed` check the production handler runs, with the same `allowedOrigins` resolution. Apps that need to accept dev connections from arbitrary origins can pass `devSkipOriginCheck: true` to the plugin.
- **Cross-worker relay HMAC defense (opt-in) (LOW).** New `websocket.workerRelayHmacSecret: string` option. When set (must be at least 16 characters), every relay envelope leaving the worker carries an HMAC-SHA256 tag computed over the (topic, envelope) pair; the receiving worker re-computes the tag and refuses the envelope on mismatch. Defends against an adjacent process injecting forged messages into the worker_threads relay (typically reachable only post-compromise). The shared secret must reach every worker via env var or `workerData` - the framework cannot auto-generate a value that is shared across workers. Without the option, behavior is unchanged.

### Added

- **`websocket.allowNonAsciiTopics: boolean` (default `false`).** Relaxes the wire-topic accept set to allow non-ASCII characters. Always-illegal control bytes / quote / backslash remain rejected.
- **`websocket.workerRelayHmacSecret: string`.** Opt-in HMAC over the cross-worker relay envelope. Must be at least 16 characters and must be the same value across every worker that relays to / from this one.
- **`devSkipOriginCheck: boolean` plugin option.** Disables the dev plugin's `allowedOrigins` enforcement on WSS upgrades. Use only for local dev scenarios where the WSS must accept arbitrary origins.

### Security

- **Dev plugin (`vite.js`) and test harness (`testing.js`) hard-assert `WS_SUBSCRIPTIONS` shape on subscribe (MED).** Pre-fix, both surfaces used optional chaining (`subs?.[WS_SUBSCRIPTIONS]`) when reading the per-connection subscription Set out of `ws.getUserData()`. If the Set was missing or wrong-shaped (a framework regression in userData initialization, or a hostile harness manipulation in tests), every subscribe silently bypassed the per-connection cap (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) and registered without ever incrementing accounting. Fix: both surfaces now run the same `assert(subs instanceof Set, 'subs.shape', null)` the production handler runs at the equivalent site. In test mode the assert throws so vitest surfaces the regression; in dev it logs a structured `console.error`. Brings dev / test / prod to parity on the cap-presence invariant so a regression that breaks userData initialization fails the CI lane that always runs first.

### Security

- **`/__ws/auth` POST now requires Origin / `x-requested-with` / `Sec-Fetch-Site` (MED, CSRF).** Pre-fix, the authenticate POST endpoint accepted any credentialed cross-origin POST: an attacker page from a third-party origin could fire `fetch(..., { credentials: 'include' })` and the victim's cookie rode along, executing the user's `authenticate()` hook on the victim's behalf (cookie refresh, audit-log write, per-user counter bump). Fix: a request must now satisfy at least one of `x-requested-with: XMLHttpRequest` (the adapter client always stamps this on its preflight POST), `Sec-Fetch-Site: same-origin` (modern browsers stamp this automatically; cannot be forged from script), or an `Origin` header matching the configured `allowedOrigins` policy. Apps that need to accept this endpoint from native (non-browser) clients without those headers can opt out via `websocket.authPathRequireOrigin: false` in `svelte.config.js`. The check is mirrored in the dev plugin (`vite.js`) so dev and production share one defense. Implementation lives in a new exported helper `isAuthOriginAccepted(headers, originCtx)` in `files/utils.js`; the helper forces `hasUpgradeHook: false` on the underlying `isOriginAllowed` check so the upgrade hook (which authenticates the WS connection) cannot accidentally relax the auth-endpoint defense.
- **Dynamic compression skipped for credentialed responses (MED, BREACH).** Pre-fix, the dynamic brotli/gzip branch fired on every response above 1 KB regardless of credentials; combined with attacker-influenced reflected input alongside a secret in the page body (CSRF token, session ID, API key), the compressed length leaked the secret one byte at a time via the [BREACH attack](https://en.wikipedia.org/wiki/BREACH). Fix: requests carrying `Cookie` or `Authorization` now skip dynamic compression; the SSR body is sent uncompressed. Apps that have audited their pages for BREACH defenses (random per-response masking, prefix randomization, no secrets reflected with attacker input) can opt back in via `websocket.compressCredentialedResponses: true`. Anonymous responses continue to compress as before. Build-time precompressed static files are unaffected - they ship at their original compressed size regardless of the request's credential state, which is safe because their content does not depend on attacker input.
- **Refuse to start on `same-origin` policy without host pin (MED).** Pre-fix, the bare default `allowedOrigins: 'same-origin'` running without ORIGIN env, HOST_HEADER env, native TLS (SSL_CERT/SSL_KEY), or an `upgrade()` hook silently accepted any non-browser scripted client because the same-origin check compares two attacker-controlled headers (Origin vs Host). Fix: the runtime now throws at startup with a human-readable resolution list (set ORIGIN env / set HOST_HEADER env / use native TLS / export an upgrade hook / use an allowlist). Apps that have audited the deployment and want the previous warn-only behavior can opt out via `websocket.unsafeSameOriginWithoutHostPin: true`. Detection lives in a new exported helper `describeUnsafeSameOriginConfig(input)` in `files/utils.js` that returns `null` when safe and the error string when the misconfig is present.

### Added

- **`websocket.authPathRequireOrigin: boolean` (default `true`).** Toggles the CSRF defense for the `/__ws/auth` POST endpoint. Set to `false` to accept native (non-browser) clients without `x-requested-with`, `Sec-Fetch-Site`, or matching `Origin` headers.
- **`websocket.compressCredentialedResponses: boolean` (default `false`).** Toggles dynamic compression of responses to credentialed requests. Set to `true` only after auditing the page surface for BREACH defenses.
- **`websocket.unsafeSameOriginWithoutHostPin: boolean` (default `false`).** Restores the previous warn-only behavior when `allowedOrigins: 'same-origin'` is paired with no fronting trust. Set only when the deployment context has been independently audited.

### Security

- **`isValidWireTopic` rejects `"` (charCode 34) and `\\` (charCode 92) (HIGH).** The wire-accept set now matches `esc()`'s rejection set. Pre-fix, a client could subscribe to topic `"` (passes wire), and any later `platform.publish('"', ...)` crashed because `envelopePrefix` calls `esc(topic)` which throws on those characters. Worse, the `envelopePrefix` LRU cache could be partially populated with hostile keys. Aligning the two rejection sets keeps wire-accept and envelope-build invariants in lockstep.
- **Cookie `path` / `domain` attribute injection blocked in `serializeCookie` (HIGH).** Pre-fix, attacker-influenced strings flowed into `Path=` / `Domain=` concatenations verbatim, allowing CRLF response-splitting (`/foo\r\nX-Evil:`), attribute smuggling (`/a; HttpOnly; Domain=victim.com`), and `Set-Cookie` line-splitting via `,`. Both attributes are now validated against the same CHAR class as cookie values (no CTLs, no `;`, no `,`, no whitespace, no DEL) before concatenation; non-strings throw the same way as malformed names/values.
- **SSR dedup cache key includes `base_origin` (HIGH).** Pre-fix, the dedup key was `method + '\0' + url`. In virtual-hosting deployments (one uWS instance behind multiple Host aliases, common in SaaS), two concurrent anonymous GETs to `/` from `tenantA.example` and `tenantB.example` shared one SSR call - the second waiter received the leader's host-rendered response. SvelteKit's `request.url.host` flows into rendered HTML, so the bug was a real cross-tenant leak. Key is now `method + '\0' + base_origin + '\0' + url`.

### Documentation

- **Multi-tenant guidance added to plugin module headers (`plugins/presence`, `plugins/groups`, `plugins/replay`, `plugins/cursor`).** Plugin in-memory state is keyed by topic name verbatim; in single-process multi-tenant deployments, two tenants sharing a room name collide on the same map entry. The fix is at the call site - prefix room/topic names with a tenant scope (`'org-' + ctx.user.tenantId + ':lobby'`). The plugin internals are correct under that pattern; a full plugin-level scope API is deferred (would require breaking changes to `list` / `count` signatures across all four plugins).

## [0.5.0-next.19] - 2026-05-08

### Changed

- **Default `maxPayloadLength` raised from 16 KB to 1 MB.** The previous default capped a single inbound WebSocket frame at 16 KB, which forced any chunked-upload framework to use ~12 KB chunks (after typical 90% headroom) and produced ~9000-chunk round trips for a 100 MB file. uWS itself defaults to 16 MB; 16 KB was excessively conservative. The new default aligns with `socket.io`'s 1 MB default and Cloudflare Workers' WS message cap (also 1 MB), keeping apps portable to the edge. DoS exposure at the new cap is still bounded: `upgradeAdmission.maxConcurrent` controls concurrent connection count, `maxBackpressure` (also 1 MB) controls per-connection outbound queue size, and uWS handles inbound frames synchronously so per-frame buffer cost is freed quickly. Apps that need a stricter cap can pin via `websocket.maxPayloadLength: 16 * 1024` (or any other value) in `svelte.config.js`. Behavior change in the `next.*` prerelease line; users on the `latest` dist-tag (0.4.x) are unaffected.

  **Other related caps unchanged.** The 8192-byte control-message JSON.parse ceiling (`files/handler.js`), the 256-topic `subscribe-batch` cap, and the matching client-side `SUBSCRIBE_BATCH_MAX_BYTES` (8000) / `SUBSCRIBE_BATCH_MAX_TOPICS` (200) are all about control-message framing, not payload size - subscribe / unsubscribe / hello frames are inherently small JSON. Raising them would just make the JSON.parse-on-every-message scan more expensive without benefit. The `BATCH_FRAME_WARN_BYTES` (256 KB) outbound `publishBatched` warning threshold is about uWS's permessage-deflate compression cost, also independent of inbound frame size. The 1 MB raise is isolated to one axis (incoming frame size); the other caps protect against different things.

### Added

- **`platform.maxPayloadLength: number` and `platform.bufferedAmount(ws): number` for backpressure-aware framework code.** Two new platform members designed for downstream RPC / upload / streaming primitives that need to reason about frame sizing and per-connection send-queue depth without piggybacking the values on the wire or wrapping `ws.getBufferedAmount()` defensively. `maxPayloadLength` is a numeric snapshot of the configured cap (1 MB by default after the raise above) - read once at framework init, no per-message cost. `bufferedAmount(ws)` is a constant-time pass-through to `ws.getBufferedAmount()` wrapped in a `try/catch` that returns 0 for closed connections, so callers can use it on every send without defending against teardown races. Mirrored on the dev plugin (`vite.js`) and the `createTestServer` test platform (`testing.js`); the parity test enforces drift-free triple-mirror going forward. Five new tests in `test/platform-payload-bufferedamount.test.js` pin the contracts: `maxPayloadLength` is a number and snapshot-stable, `bufferedAmount` returns 0 for fresh connections, returns a finite non-negative number under load, and never throws on closed connections.

- **`conn.bufferedAmount` getter on the client `WSConnection` returned by `connect()`.** Mirrors the native browser `WebSocket.bufferedAmount` property, returning 0 when the underlying socket does not exist (pre-connect or post-close). Use for client-side paced sending: chunked-upload pumps that previously called `sendQueued()` blindly can now check `conn.bufferedAmount` against high-water / low-water marks and back off until the queue drains, keeping the browser send queue bounded regardless of payload size. Pairs with the next.16 fix that made `sendQueued` actually preserve binary frames - together they turn the client-side primitive into a backpressure-aware paced sender. Three-line passthrough on the connection object; zero overhead.

  Use case context: `svelte-realtime`'s `live.upload` server primitive (just shipped) builds chunked upload streams. With the four members above in place, the client pump can size chunks against `platform.maxPayloadLength`, pace sends against `conn.bufferedAmount`, and the server can monitor per-recipient pressure via `platform.bufferedAmount(ws)` - all without piggybacking metadata on the wire or implementing per-framework workarounds. Three of the four asks are pure additions (no behavior change for current callers); the `maxPayloadLength` raise is the one behavior change in this batch and is opt-out via the existing config knob.

  **Not addressed:** uWS does not expose a per-connection receive-side pause/resume primitive at the JS layer (uWS's design philosophy is "TCP backpressure handles it" - they rely on the kernel socket buffer slowing the sender when reads are not consumed). Frameworks that need true server-side receive flow control (e.g. when a slow disk write blocks the consumer of an async-iterable upload stream) should keep the existing pattern of capping the buffered-chunk queue and aborting with a typed error if the consumer cannot keep up. If uWS adds the primitive in a future release, we can expose it via `platform.pauseReceive(ws)` / `platform.resumeReceive(ws)` then.

## [0.5.0-next.18] - 2026-05-08

### Fixed

- **`$env/dynamic/private` (and `$env/dynamic/public`) returned empty values in modules reached via the ws-handler import graph after next.17.** Concrete pain point: `import { env } from '$env/dynamic/private'` followed by a top-level `env.DATABASE_URL` read in `src/lib/server/db.js` / `src/lib/server/redis.js` / `src/lib/server/tasks.js` / `src/hooks.ws.js` saw an empty proxy. The same variables were correctly visible via `process.env` at the same call site, which is the workaround users discovered (and which the demo's source comments cite). Failure mode was invisible: `createPgClient({ connectionString: env.DATABASE_URL })` silently became `createPgClient({ connectionString: undefined })` and `createRedisClient({ url: env.REDIS_URL })` silently fell through to the library default `redis://localhost:6379` - if a different Redis happened to be running on that port, the app silently wrote presence keys / cluster registry to a foreign database.

  Root cause: SvelteKit's Vite plugin resolves `$env/dynamic/private` to `export { private_env as env } from '<runtime>/shared-server.js'` - a module-level mutable `private_env = {}` populated lazily by `Server.init({ env })` (`@sveltejs/kit/src/runtime/shared-server.js`). The pre-next.17 esbuild fallback path used a custom virtual-module resolver that substituted `export const env = process.env;` directly, sidestepping the runtime indirection entirely. Once next.17 made the Vite-plugin path actually work (modules now flow through SvelteKit's normal resolution), the runtime indirection became load-bearing: until `Server.init` runs, `private_env` is empty. handler.js's `await server.init({ env: process.env })` was at module-body level, AFTER the `import * as wsModule from 'WS_HANDLER'` had already evaluated - so the user's `src/lib/server/*` modules read env at module-load time, before init populated the proxy. ESM evaluates imported modules' bodies fully (including TLA) before the importer's body runs, which means *the server.init call literally cannot run before the user's env reads* if init is in handler.js's body.

  Fix moves Server instantiation + `await server.init({ env: process.env })` into a new `files/_init.js` module imported in `files/handler.js` IMMEDIATELY BEFORE the `WS_HANDLER` import. ESM evaluates imports in source order, depth-first; each imported module's body fully completes (including TLA) before the next import is processed. So `_init.js`'s top-level `await server.init(...)` blocks until SvelteKit's `private_env` and `public_env` are populated, and only then does the next import (`WS_HANDLER`) start evaluating. The user's `src/lib/server/*` modules now see populated env at module load. handler.js's body still uses `server.respond(...)` for SSR rendering - the only thing that moved is the construction + init. A multi-line comment in `handler.js` above the two imports spells out the load-order rationale and explicitly forbids reordering them; a similarly long block at the top of `_init.js` documents why this module exists at all so a future refactor doesn't accidentally inline it back. Behavior change in `handler.js`'s body is null: `server` is the same instance the previous code constructed, just imported from `_init.js` instead of declared inline.

  Build pipeline: `_init.js` is one of the runtime template files copied via `builder.copy(files, out, ...)` in `index.js`, so it inherits the same SHIMS / SERVER / MANIFEST placeholder substitution as `handler.js`. No changes to the second-pass Rollup bundling at `index.js:239` (the template files are not bundled, they reference the bundled `./server/index.js` and `./server/manifest.js` chunks at runtime). Verified end-to-end against `svelte-realtime-demo`'s production build: `build/_init.js` correctly holds `await server.init({ env: process.env })`; `build/handler.js`'s import block has `import { server } from './_init.js'` on line 22 directly above `import * as wsModule from './server/ws-handler.js'` on line 23, in that exact order.

  No runtime behavior change for users without the Vite plugin (esbuild fallback path's custom `$env/dynamic/private` substitution is unchanged). No hot-path impact (one-time module evaluation cost; identical work to before, just moved earlier in the import chain). The reporter's process.env workaround still works as a belt-and-suspenders fallback but is no longer required after this fix lands - callers can return to the canonical `import { env } from '$env/dynamic/private'` pattern in `src/lib/server/*` modules.

## [0.5.0-next.17] - 2026-05-08

### Fixed

- **Vite plugin's `ws-handler` entry was silently dropped under SvelteKit + Vite 7's environment API, causing every shared module imported by both `hooks.ws` and SvelteKit routes to be DUPLICATED in the build output (each with its own singleton state).** The plugin's `config()` hook returned `{ build: { rollupOptions: { input: { 'ws-handler': handlerPath } } } }`. SvelteKit's own Vite plugin sets the SSR build input wholesale during a later phase via the Vite 7 environment API (`client` and `ssr` environments), which silently wiped our entry from the merged config. The adapter then found no `tmp/ws-handler.js` after `writeServer(tmp)` and silently fell through to the `esbuild` fallback path - which bundles `ws-handler.js` as a fully standalone module with `packages: 'external'`, inlining ALL local code (everything from `src/lib/server/`) into the ws-handler bundle. SvelteKit's parallel build pass inlined or chunked the same modules into its own routes. Result: two physical copies of every shared module. Concrete user impact: a Prometheus metrics registry exported from `src/lib/server/metrics.js` and imported by both `hooks.ws` (writes counters from `wirePublishRateMetrics`, `connectionMetricsHook`, `createLeader`) and the `/metrics` route (serializes via `metrics.export()`) became two disjoint registries - the `/metrics` scrape returned `# HELP`/`# TYPE` headers but no labelled counter values, because the registry it serialized had been DEFINED but never INCREMENTED. Same shape for any in-memory cache, leader-election state, custom rate limiter, or other singleton shared between hooks.ws and routes. The user sees correct runtime behavior with mysteriously empty observability.

  Fix replaces the `config()`-hook input merge with `configResolved()` + `buildStart()` + `this.emitFile`. The new flow: `configResolved()` detects the SSR build via `resolved.build.ssr` (`env.isSsrBuild` in `config()` is `false` even during SSR builds under the Vite 7 environment API, so the old detection was wrong on a second axis) and captures the `hooks.ws` handler path; `buildStart()` runs late enough that SvelteKit's input has been finalized, gates on `this.environment.name === 'ssr'` so the client build does not also emit the entry, and calls `this.emitFile({ type: 'chunk', id: handlerPath, fileName: 'ws-handler.js' })` to inject the entry directly into the active Rollup pipeline. `fileName: 'ws-handler.js'` (instead of `name: 'ws-handler'`) forces the output to the top level of the SSR output dir, matching the location the adapter's second-pass Rollup checks at `${tmp}/ws-handler.js`. The emitted entry now participates in Vite's chunking strategy: shared modules between hooks.ws and SvelteKit routes land in `chunks/<name>-<hash>.js` and both sides import the SAME chunk file - one physical module, one singleton.

  Verified end-to-end against `svelte-realtime-demo`: pre-fix, `build/server/ws-handler.js` had the metrics module's source inlined and `build/server/chunks/metrics-Di2jejzk.js` had a separate copy (two `class MetricsRegistry` definitions across the build). Post-fix, `build/server/ws-handler.js` and `build/server/index.js` both contain ZERO copies of the source; `build/server/chunks/metrics-Di2jejzk.js` is the singular copy; `ws-handler.js`, the `/metrics` route's `_server-*.js`, the `cluster-cron` page chunk, and every other importer all reference the same chunk path. Counters incremented from the WS handler now reach the `/metrics` scrape correctly. The previously-loosened test in `svelte-realtime-demo`'s `cluster-cron` test #4 (relaxed from `expect(body).toContain('leader_acquired_total{key_class=')` to the looser `expect(body).toContain('leader_acquired_total')`) can be restored to the strict form.

  No new runtime dependencies, zero hot-path impact (build-time only), no behavior change for users without the Vite plugin (esbuild fallback path is unchanged and still warns appropriately). The `config()` hook is removed entirely from the plugin since `configResolved` now owns all SSR-detection logic.

## [0.5.0-next.16] - 2026-05-08

### Fixed

- **`client.send` and `client.sendQueued` mangled `ArrayBuffer` and typed-array payloads into the literal text `'{}'`, blocking binary RPCs end-to-end.** Both methods (and the queue-flush path on reconnect) called `JSON.stringify(data)` unconditionally before handing the payload to `ws.send`. `JSON.stringify(new ArrayBuffer(N))` returns the 2-byte text `'{}'` because `ArrayBuffer` has no own enumerable properties, regardless of `N`. Every binary frame from a `live.binary` RPC (svelte-realtime: `0x00` marker + uint16 BE header length + JSON header + raw payload bytes) reached the wire as the literal text `'{}'`; the server's `handleRpc` failed its `data instanceof ArrayBuffer && bytes[0] === 0x00` check and silently dropped the frame as a malformed RPC envelope; the client-side promise hung to its 30-second timeout. Visible end-to-end as `[ws->] string len=2 {}` in Playwright `framesent` traces and as "0/N chunks" stalls on file-upload demos. The pre-binary handshake (hello, subscribe-batch, the JSON RPC envelope) all worked because they ARE plain JSON; only `ArrayBuffer` / `ArrayBufferView` payloads got mangled.

  Both `send` and `sendQueued` now route through a shared `serializeForSend(data)` helper that branches on `data instanceof ArrayBuffer || ArrayBuffer.isView(data)` and passes binary inputs through to `ws.send` unchanged. JSON-serializable inputs continue to pass through `JSON.stringify` exactly as before - this is a pure unblock for the binary path with zero behavior change for current text callers. The internal `sendQueue` now stores already-decided values (`string | ArrayBuffer | ArrayBufferView`) so the reconnect-flush path is trivially correct: each entry was serialized at enqueue time and reaches the wire verbatim, no per-flush type branching needed. Covers `Uint8Array`, `DataView`, and every other `ArrayBufferView`; deliberately does not introduce a `Blob` branch (YAGNI - `live.binary` builds an `ArrayBuffer` directly, no current consumer asks for `Blob`).

  JSDoc on `send` and `sendQueued` (in both `client.js` and `client.d.ts`) now spells out the contract: *"Strings and JSON-serializable objects are sent as text frames after `JSON.stringify`. `ArrayBuffer` and any `ArrayBufferView` (Uint8Array, DataView, etc) are sent as binary frames unchanged."* The same wording on `sendQueued` adds: *"Queued binary payloads are kept as-is in the in-memory queue and flushed verbatim on reconnect."* Closes the same class of "I called this with X and got mystery behavior" bug for whatever the next binary use case is.

  No wire-format change for receivers - server-side `handleRpc` already accepted both binary and text frames; uWS hands binary frames as `ArrayBuffer` to the user's `message` hook with `isBinary: true`. Test coverage in new `test/client-binary.test.js` (7 tests): `send` + `ArrayBuffer` reaches the wire by reference (no `JSON.stringify`), `send` + `Uint8Array` and `DataView` likewise (covers all `ArrayBufferView` shapes), `send` still `JSON.stringify`s plain objects, `sendQueued` mirrors `send` for both shapes, and the load-bearing regression test that explicitly asserts a 200 KB `ArrayBuffer` no longer reaches the wire as the literal text `'{}'` (with the right `byteLength` preserved). The full 146-test client-real suite continues to pass under the refactor, confirming no behavior change for the JSON path.

## [0.5.0-next.15] - 2026-05-06

### Added

- **`hooks.ws.init({ platform })` and `hooks.ws.shutdown({ platform })` lifecycle hooks for boot-time and teardown-time app code.** Two new optional exports alongside `upgrade` / `open` / `close`. `init` fires once per worker process after the listen socket is bound and before the first `upgrade` / `open` / `message` hook can run; `shutdown` fires once per worker before the listen socket closes and before existing connections are kicked. Both hooks receive `{ platform }` as a single context argument (extensible later without a breaking change), are async-allowed (the adapter awaits the returned promise), and target the recurring "I need `platform` at boot, not on first connect" pattern that previously forced library code to capture `platform` lazily inside an `open` hook - which meant per-second cron warnings and brittle wakeup races during the boot-to-first-connect window. Concrete pain point: `svelte-realtime`'s `live.cron(...)` registers at module load, but its tick cannot call `platform.publish` until something triggers `setCronPlatform(platform)` from inside an `open` hook; with `init` exported, the realtime layer captures `platform` at the deterministic moment the server is ready. Same shape works for warmup tasks, scheduled metrics dumps, external pubsub bridge setup, and any other "needs platform on boot" flow. Whitelist (`knownWsExports` in `files/handler.js`) updated to include both names, mirrored on dev (`vite.js`) and the test harness (`testing.js`); `init` runs to completion before `createTestServer()` resolves so test setup is fully ready when callers `await` it.

  **Async semantics.** `start()` (production) and `createTestServer()` (test harness) return promises that resolve only after `init` completes. A throwing `init` rejects the promise - boot failure should be loud, the index.js entrypoint surfaces it as an unhandled rejection, the process crashes. `shutdown` is best-effort: throws are logged with `console.error('[ws] shutdown hook threw:', err)` and ignored, since the adapter cannot refuse to stop. The dev plugin (`vite.js`) wires `init` into the existing `handlerReady` chain so a slow async init does not race with the `/__ws/auth` middleware setup, and `shutdown` into `server.httpServer` 'close' so it fires on Ctrl-C / programmatic close. The production handler's `start(host, port)` is now `async` and awaitable; `files/index.js` now `await`s both `start()` and `shutdown()` so per-worker init failures crash the worker and per-worker shutdown teardown completes before drain.

  **Per-worker firing in clustered mode is documented LOUDLY.** Each worker process calls `start()` and fires `init` independently. An app running with N workers will see N `init` calls, one per worker. JSDoc on the `init` hook in `index.d.ts` explicitly notes this: "Do not assume singleton semantics; if you need a singleton (e.g. a single cron publisher across the cluster), layer leader election on top." The `shutdown` hook fires per-worker for the same reason. svelte-realtime's `live.cron` will need its own leader election for "1 Hz cron" semantics in clustered mode, but that is downstream concern; the adapter's job is the deterministic boot/teardown signal.

  **Open-race caveat documented.** If `init` is slow async, kernel-queued WebSocket connections may fire `open` hooks concurrently with the tail of init's execution. The hard guarantee "init fires before any open" only holds for synchronous init OR if the user installs an app-level ready-gate that 503s upgrades during init. For most "capture platform" cases (the canonical use), the race is harmless because writes are idempotent. JSDoc spells this out so apps that need strict ordering know to keep init synchronous or layer their own gate.

  Test coverage in new `test/init-shutdown-hooks.test.js` (11 tests): fire-once with `{ platform }` context, no-op when not exported, async awaiting, throwing-init rejection, init can call `platform.publish` (platform fully wired before init runs), init fires before open for kernel-queued connections, shutdown fire-once with platform context, async shutdown awaiting, throwing shutdown logged-and-ignored (server still closes), shutdown sees connections still registered before they are kicked, init-then-shutdown ordering. All 355 existing tests across `utils`, `platform-parity`, `platform-subscribe`, `upgrade-admission-wiring`, `connection-stats`, and `testing` continue to pass under the async lifecycle refactor.

## [0.5.0-next.14] - 2026-05-05

### Added

- **`platform.subscribe(ws, topic)` and `platform.unsubscribe(ws, topic)` for server-side subscribe-with-authorization.** New first-class platform methods that route a server-initiated subscribe through the user's `hooks.ws.subscribe` authorization hook before the actual `ws.subscribe` runs. Returns `null` on success or a denial reason string on failure (`'INVALID_TOPIC'`, `'RATE_LIMITED'`, `'FORBIDDEN'`, or any custom string returned from the hook). Idempotent on repeat subscribe of the same `(ws, topic)`: hook does not re-fire, `totalSubscriptions` is not double-charged. Updates `WS_SUBSCRIPTIONS` and the per-worker counter so observability (`platform.subscribers(topic)`, `platform.pressure`, the close-hook `subscriptions` set) matches client-initiated subscribe frames. Does not emit a `{type:'subscribed', topic, ref}` ack frame - there is no client `ref` for a server-initiated subscribe; that is an application-level concern handled by the caller's RPC response.

  Closes a real authorization-bypass class of bug for downstream frameworks that subscribe a connection on the user's behalf inside an RPC handler (e.g. svelte-realtime's stream-RPC `_executeStreamRpc` calling `ws.subscribe(topic)` directly). Direct `ws.subscribe()` calls go to uWS's C++ TopicTree without firing the wire-level subscribe hook - the hook only fires for `{type:'subscribe'}` and `{type:'subscribe-batch'}` wire frames. With direct calls, the loader runs and the initial-data response (and any `'join'` broadcasts) reach the wire before the client's eventual wire-level subscribe is denied with `FORBIDDEN`. Routing through `platform.subscribe` puts the gate where it belongs: before any data fans out. JSDoc on `hooks.ws.subscribe` and `subscribeBatch` now explicitly notes the wire-level scope and points downstream library authors at `platform.subscribe` as the correct path. Mirrored on the dev plugin (`vite.js`) and the `createTestServer` test platform (`testing.js`) so behavior is identical across surfaces; the parity test in `test/platform-parity.test.js` enforces this for dev/prod going forward. New `test/platform-subscribe.test.js` covers six contract points: hook gates the actual subscribe (denial flows through unchanged), idempotency (hook fires once per `(ws, topic)`, no double-charge), `INVALID_TOPIC` short-circuits before the hook, the subscription wires the connection into the publish broadcast path, `unsubscribe` removes the subscription and fires the unsubscribe hook (also idempotent), and a documented contract test that `ws.subscribe()` direct intentionally bypasses the hook (the bypass we are guarding against).

- **`platform.checkSubscribe(ws, topic)` for pure-gate authorization without subscribing.** Companion to `platform.subscribe` for callers that need to make the authorization decision in one step and perform the actual `ws.subscribe` later as part of a different orchestration. The shipped use case: an RPC framework whose stream-handler runs a loader between authorization and subscribe so the loader can fail cleanly without leaving a half-subscribed connection or a spurious `'join'` broadcast (svelte-realtime's `_executeStreamRpc` is the canonical example). Returns `null` to allow or a string denial reason. Pure - does not modify subscription state, does not call `ws.subscribe`, does not increment counters; the cap (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) is intentionally not consulted because no subscription is being created. Callers who plan to subscribe immediately after a clean check should prefer `platform.subscribe` for the atomic gate + subscribe + cap + state update flow. Mirrored on dev (`vite.js`) and on the `createTestServer` test platform (`testing.js`); the parity test enforces both sides ship the method.

### Fixed

- **Subscribe-hook chain now fails closed when a user hook throws (security default, was silent allow / handler crash).** `runSubscribeHook` and `runSubscribeBatchHook` (`files/handler.js`) now wrap the user-supplied callback in a `try/catch`. A throwing `subscribe` hook denies that subscribe with a canonical `'INTERNAL_ERROR'` reason; a throwing `subscribeBatch` hook denies every topic in the batch with the same reason. Before this change, a throwing hook propagated through the uWS message handler - behavior depended on uWS's frame-handler error path and could either crash the connection or fall through to allow (path-dependent on subscribe vs subscribe-batch + which surface invoked the hook). Logging the error to `console.error` keeps the cause visible without requiring callers to wrap their own hooks defensively. Affects every entry point uniformly: wire-level subscribe / subscribe-batch frames, `platform.subscribe`, and the new `platform.checkSubscribe`. Same fail-closed semantics mirrored on `vite.js` and `testing.js`.

- **Wire-level single-subscribe frames now consult `subscribeBatch` when only `subscribeBatch` is exported.** Previously the wire-level handler at `files/handler.js:2670` consulted only `runSubscribeHook` - a user who exported only `subscribeBatch` for centralized authorization had their hook fire for batch frames but **silently bypassed for single subscribes**. Same gap was present in the just-shipped `platform.subscribe` (called only the per-topic hook). Both paths now route through a shared internal helper `runUserSubscribeGate(ws, topic)` that mirrors the wire-level subscribe-batch precedence (subscribeBatch first, treating the single subscribe as a 1-element batch; falls back to per-topic `subscribe` if the batch hook is not exported). A user who exports only `subscribeBatch` now has their hook gate fired consistently across single and batch frames AND for both `platform.subscribe` and `platform.checkSubscribe`. Behavioral note: a `subscribeBatch` hook authored before this fix may receive 1-element `topics` arrays where it previously did not see single frames at all; this is consistent with the documented "set of pre-validated topics" contract (a 1-element set is still a set) and any reasonable hook handles it correctly. The wire-level subscribe-batch frame path is unchanged - it already consulted `subscribeBatch` when exported. Behavior cross-checked by a new test that fires the same `(ws, topic)` decisions through both `platform.checkSubscribe` and the wire-level subscribe-batch frame and asserts they agree topic-by-topic.

## [0.5.0-next.13] - 2026-05-05

### Fixed

- **Dev-mode platform missing six methods exposed by production - broke any downstream wrapper that captured those method references via `.bind`.** The dev platform constructed in `vite.js` had quietly drifted from the production platform across multiple releases as new primitives landed: `batch` (multi-publish helper), `sendCoalesced` (next.1), `pressure` and `onPressure` (next.1, refined through next.8), `onPublishRate` (next.4), and the `assertions` getter (next.8) were all missing from the dev base platform. Downstream consumers that wrap `platform` at construction time - e.g. the cluster pubsub bus in `svelte-adapter-uws-extensions/redis/pubsub` doing `sendCoalesced: platform.sendCoalesced.bind(platform)` - crashed on the first WebSocket message in `npm run dev` with `TypeError: Cannot read properties of undefined (reading 'bind')`. Production was unaffected; only dev had the parity gap. The fix adds shims for all six: `batch(messages)` runs the same `for`-loop over `publish()` that production does (returning the per-message `boolean[]`), `sendCoalesced` degrades to immediate `send` (dev runs over the `ws` library and has no real C++ outbound queue, so there is no backpressure to coalesce against - the production happy-path observable behavior is preserved), `pressure` returns a zero-valued `PressureSnapshot` (`active: false`, `reason: 'NONE'`, all numeric fields `0`, `topPublishers: []`) rather than `null` so destructuring `pressure.active` / `.reason` / `.topPublishers` in downstream code does not crash on field access, `onPressure(cb)` and `onPublishRate(cb)` accept the callback and return the documented unsubscribe stub, and the `assertions` getter returns a fresh empty `Map` per read (dev never tracks invariant violations - production exposes a live shared Map of category counts). Per-WebSocket and per-request `requestId` mechanics in dev (`Object.create(platform)` clones with `wsPlatform.requestId = ...` / `authPlatform.requestId = ...`) are unchanged - production also has no base-platform `requestId` getter, both dev and prod set it per-clone, so this was correctly already at parity. A comment block above the dev platform definition spells out the parity contract so the next time a primitive lands on production, the reviewer is reminded to mirror it here.

- **Mechanical regression guard against future dev/prod platform drift.** New `test/platform-parity.test.js` parses both `files/handler.js` and `vite.js` with acorn (already a transitive dev dep via Vite, no new install), locates the `const platform = { ... }` ObjectExpression in each, extracts the top-level keys (methods, properties, getters), and asserts every key on the production base platform also exists on the dev base platform. The check is one-directional (prod is a subset of dev) so dev-only debugging hooks remain allowed; the failure mode names the missing keys explicitly so a reviewer can mirror them at a glance. The test caught the `batch` gap above that an eyes-on audit had missed.

### Documentation

- **Throttle plugin docstrings rewritten to stop pointing readers at the multi-publisher trap.** The module-level docstring previously cited "mouse position, typing indicators" as canonical use cases, and the `@example` for `throttle()` showed N users emitting cursor moves into one shared topic - exactly the multi-publisher pattern the plugin's single shared pending slot handles wrong (fast publishers overwrite slow publishers' pending payloads, slow publishers' updates almost never reach subscribers; measured at `bench/28-throttle-per-key-ab.mjs`). Module docstring now describes the plugin as "per-topic publish rate limiting for single-publisher streams" and lists actually-safe use cases (server-aggregated metrics, live counters, world-state snapshots, job-progress feeds), with an explicit "not suitable for multi-publisher streams that share a topic" line. Function-level docstring gains a Caveat block linking to the bench and pointing at the world-state-tick aggregation pattern as the fix. The `@example` is rewritten to demonstrate that pattern (server maintains `Map<userId, latestPos>`, publishes one snapshot per tick), so the canonical example reading teaches the right architecture instead of the broken one. No runtime change.

## [0.5.0-next.12] - 2026-05-04

### Fixed

- **`sendCoalesced` silently dropped messages over `maxBackpressure`.** The flush callback in `flushCoalescedFor` (`files/handler.js`) was refactored to a block-bodied arrow when assertions and per-connection byte accounting landed in next.8, and the explicit `return` of `ws.send`'s status code was lost in that refactor. `drainCoalesced` therefore saw `undefined` instead of the documented 0/1/2 contract, treating every send - including ones uWS reported as DROPPED (return code 2, sent over the configurable `maxBackpressure` cap) - as a clean success. The pending Map entry was deleted, the message never reached the wire, and the resume-on-drain path at the `drain` hook had nothing to retry. In healthy conditions the bug was invisible because `ws.send` returned 0; under sustained backpressure on a slow client (the exact workload `sendCoalesced` exists to handle), messages exceeding `maxBackpressure` were silently lost. The callback now propagates `ws.send`'s return code so DROPPED retains the entry for retry and BACKPRESSURE halts the loop as the algorithm intended. As a small companion correction, the per-connection `bytesOut` counter exposed on the `close` hook (next.4) no longer counts payloads that were DROPPED - the byte count now reflects what actually reached the kernel buffer rather than what was attempted. The `drainCoalesced` algorithm itself in `files/utils.js` was correct all along and unit-tested in `test/utils.test.js`; the regression lived purely at the production caller's wiring.

## [0.5.0-next.11] - 2026-05-04

### Fixed

- **False-positive boot warning when `hooks.ws` exports `subscribeBatch` or `resume`.** The `knownWsExports` whitelist in `files/handler.js` was not updated when those two hooks shipped, so any app exporting either got a `Warning: WebSocket handler exports unknown "subscribeBatch"` (or `"resume"`) line at startup, with a `Did you mean one of: open, message, upgrade, close, drain, subscribe, unsubscribe, authenticate?` suggestion that pointedly omitted the hook the user had just written. The hook itself was always picked up and called correctly - the runtime reads `wsModule.subscribeBatch` directly in the bulk-subscribe path and `wsModule.resume` directly in the resume-protocol path - but the warning text actively misled downstream users into deleting the export to silence it, which silently disabled the documented bulk-auth and gap-fill paths. Whitelist now includes `subscribeBatch` and `resume` alongside the rest of the supported hook surface.

## [0.5.0-next.10] - 2026-05-04

### Changed

- **`package-lock.json` refreshed via `npm audit fix` to clear all four high-severity advisories in transitive dev / peer dependencies** (`@sveltejs/kit`, `picomatch`, `socket.io-parser`, `vite`) plus two moderates (`postcss`, `devalue`). No `package.json` range changes; no runtime dependency added or removed; the published package's `dependencies` (the four `@rollup/plugin-*` + `rollup`) remain clean and audit-free as they have always been. This is a dev-tree cleanup - npm consumers of `svelte-adapter-uws` are unaffected because `package-lock.json` does not ship in the npm tarball and peer-dep versions are resolved against the consumer's own tree. Five low-severity advisories remain (`cookie` transitive of `@sveltejs/kit`; `uuid` / `hyperid` / `autocannon` chain pulled in by the bench scripts), all fix-by-`--force` only and would either require a kit major bump or downgrade `autocannon` to an unusable 6-year-old version.

## [0.5.0-next.9] - 2026-05-04

### Added

- **Two new chaos / fault-injection scenarios on the test harness's `__chaos` setter.** `ipc-reorder` is a continuous scenario like `slow-drain` but defers each outbound frame by an independently-random delay in `[0, maxJitterMs)` so adjacent frames can arrive out of order; useful for exercising seq-gap detection, idempotency-key handling, and any protocol code that assumes ordered delivery. `maxJitterMs` is capped at `60_000`. `worker-flap` is a one-shot trigger that closes every currently-live WebSocket connection with a clean close frame (default `code: 1012`, default `reason: 'worker restart'`, both configurable); the server stays up and any active continuous chaos scenario (e.g. `drop-outbound`) survives the flap. Use `worker-flap` to verify clients reconnect, present their resume token, and the user's `resume` hook fills the gap correctly. Both ship alongside the existing `drop-outbound` and `slow-drain`; the API shape (`__chaos({ scenario, ... })`) is unchanged. README chaos section updated with examples + the continuous-vs-one-shot distinction; `ChaosScenario` discriminated union in `testing.d.ts` extended with both new variants.

- **`maxWaitMs` option on `lock.withLock`.** Third argument now accepts `{ maxWaitMs: number }`. When set, the caller is rejected with a typed `LOCK_TIMEOUT` error (with `.code`, `.key`, and `.maxWaitMs` fields) if it does not acquire the lock within `maxWaitMs` milliseconds. The current holder's `fn` is not interrupted; only the waiting caller gives up. Subsequent waiters on the same key are unaffected and continue in their original order, so a timeout never blocks the queue for later callers. `maxWaitMs: 0` fails immediately if any other caller holds or is queued ahead of you (try-lock pattern). Negative or non-finite values are rejected with a validation error. Unblocks bounded-wait surfaces in downstream consumers (e.g. `live.lock` in `svelte-realtime`) without forcing each consumer to reimplement the queueing algorithm.

### Changed

- **`lock` plugin internals refactored from chain-of-promises to per-key waiter queue.** No-op for users of `withLock(key, fn)` - the contract (FIFO ordering, error-isolation between callers, per-key independence, the `maxKeys` cap) is unchanged. The new representation is what makes `maxWaitMs` implementable correctly: the chain-of-promises pattern could not support timeouts without race conditions because cancelling B mid-wait would leave C chained off B's promise but C's `await prev` would resolve immediately when B's rejection settled, letting C run while A still held the lock. The waiter-queue makes "skip cancelled entries on advance" a one-line check in the dispatch loop.
- **`lock.clear()` now rejects pending waiters with a typed `LOCK_CLEARED` error**, instead of orphaning them. Soft semantic change from the prior chain-of-promises implementation, where `clear()` only cleared the lookup Map and pending callers continued to resolve as the chain unfolded (each promise was independent of the Map, held only by its caller). The waiter-queue owns the only reference to pending callers, so without an explicit rejection in `clear()` they would hang forever - which is worse than the documented teardown use case. If you relied on pending calls completing across a `clear()` in a teardown path, catch `LOCK_CLEARED` and treat it as success.

### Documentation

- **README catch-up pass.** Three plugins shipped without README sections (`lock`, `session`, `dedup`); each now has a full Setup / Usage / API / Options / Limitations entry. Plugin sections that already existed but were stale gained the new cap options inline (`cursor.maxConnections` / `maxTopics`, `presence.maxConnections` / `maxTopics`, `throttle` / `debounce` second-arg `maxTopics`, `ratelimit.maxBuckets` row in Options table); `queue.maxSize` default updated to `1_000_000` in the Options table. The test harness section gained `upgradeAdmission` configuration documentation (shipped in next.6 but undocumented) and a curated-re-exports note pointing at the helpers and userData slot constants that downstream test code can import from `svelte-adapter-uws/testing` (shipped in next.5 but undocumented). Client-store automatic-behaviours section gained a "Microtask-batched initial subscribes" entry covering the next.7 wire-shape change. Table of contents updated for the three new plugin sections.

- **README `Lock` section updated for `maxWaitMs`.** New "Bounded wait with `maxWaitMs`" subsection covers the third-argument shape, the `LOCK_TIMEOUT` error code + fields, the `maxWaitMs: 0` try-lock pattern, and the "subsequent waiters unaffected" guarantee. API table entry for `withLock` mentions the new options arg. `clear()` row updated to call out the `LOCK_CLEARED` rejection semantic. Limitations section clarifies that `maxWaitMs` caps wait time, not hold time - a hung `fn` still holds the lock indefinitely.

## [0.5.0-next.8] - 2026-05-03

### Added

- **Framework invariant assertions + `platform.assertions` observability.** A two-tier `assert(cond, category, context)` / `devAssert(cond, message, context)` helper pair lands in `files/utils.js` and is installed at ~27 invariant sites in the production handler covering envelope build, WebSocket lifecycle (open / message / drain / close / resume hook entries), subscription bookkeeping (`subs.shape`, `subs.total-negative`), server-initiated request entry shape, sendCoalesced state, cross-worker IPC payload types, and per-topic publish stats shape. On violation the counter for the category increments on the live module-level Map exposed via the new `platform.assertions` getter, and a structured `[adapter-uws/assert] {"category":"...","context":...}` line is logged. In production a violation does NOT throw - a thrown exception inside a uWS C++ callback frame can corrupt the binding state, and the metric + structured log are sufficient observability. In test mode (`process.env.VITEST` set, or `NODE_ENV === 'test'`) `assert` additionally throws so vitest surfaces the failure as a test error. `devAssert` is dev-time only - a complete no-op when `NODE_ENV === 'production'`. New README "platform.assertions" section under Platform API documents the shape and the report-an-issue workflow when a counter goes non-zero. The `platform.assertions` getter is also exposed on `TestPlatform` (createTestServer) for symmetry, so test code can read counts during integration runs.

- **Bounded-by-default capacity caps across the adapter and bundled plugins.** Every `Map` / `Set` whose growth is driven by client behaviour or topic cardinality now declares an explicit upper bound and a documented saturation behaviour, so an unbounded subscribe loop, a runaway server-initiated request stream, or a `chat-${userId}` topic-cardinality leak can no longer exhaust process memory silently. Defaults are deliberately generous (1,000,000 across the board) to avoid biting any healthy app at uWS scale; aggregate-memory protection still belongs to `upgradeAdmission.maxConcurrent`.
  - **Adapter core** (handler.js, vite.js, testing.js):
    - `WS_SUBSCRIPTIONS` per-connection set: cap 1,000,000. New subscribes past the cap respond with `subscribe-denied` reason `'RATE_LIMITED'`. Applies to both the single-subscribe and `subscribe-batch` paths in production, dev, and the test harness.
    - `WS_PENDING_REQUESTS` per-connection map: cap 1,000,000. New `platform.request()` calls past the cap reject synchronously with "pending requests exceeded".
    - `WS_COALESCED` per-connection map: cap 1,000,000. New keys past the cap drop the oldest insertion-order entry on insert (latest-value-wins contract is preserved by definition).
    - `topicSeqs` module-level seq registry: warn-only at 1,000,000 distinct topics. The resume protocol depends on each entry persisting for the process lifetime, so eviction would corrupt reconnecting clients - instead, a single structured `console.warn` with the topN recent publishers fires when the threshold is first crossed, surfacing the leak shape before OOM.
    - `lastPublishWarnAt` runaway-publisher dedup: cap 1,000,000 with FIFO eviction; pure dedup state, dropping oldest just resets the warn cooldown for that topic.
  - **Plugins**:
    - `ratelimit`: new `maxBuckets` option (default 1,000,000). Hard-evicts oldest insertion-order bucket on insert at cap, protecting against sustained DDoS where the lazy expired-entry sweep cannot free slots.
    - `throttle` and `debounce`: new `maxTopics` option (default 1,000,000). When the topic registry is at cap, the oldest insertion-order entry is flushed (its pending value publishes immediately) and dropped before the new topic is inserted.
    - `cursor`: new `maxConnections` and `maxTopics` options (each default 1,000,000). Drop oldest insertion-order entry on insert at cap; pending throttle timers on the dropped topic are cleared first.
    - `presence`: new `maxConnections` and `maxTopics` options (each default 1,000,000).
    - `lock`: new `maxKeys` option (default 1,000,000). New-key `withLock` synchronously rejects with "active key count exceeded" when the chain is at cap; existing keys can still be re-entered.
- **README "Capacity model" section** under Backpressure & connection limits. Single tabular reference for every internal cap, its default, its saturation behaviour, and whether it is overridable. Documents the per-conn-cap-multiplier reasoning (per-conn caps catch single-connection bugs; aggregate memory bounds come from `upgradeAdmission.maxConcurrent`) and the `topicSeqs` warn-only rationale.

### Changed

- **`queue` plugin `maxSize` default changed from `Infinity` to `1,000,000`.** Soft API change: existing users who relied on unbounded queues see their queue start dropping tasks via `onDrop` once 1M waiting tasks accumulate per key. Pass `{ maxSize: Infinity }` explicitly to opt back into the previous behaviour. The new default brings the plugin in line with the rest of the bounded-by-default audit; no real workload should reach 1M waiting tasks per key without a leak.

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
- **Revisited the 0.4.11 "Windows upgrade" fix**: 0.4.11 removed the cork wrapper around `res.upgrade()` based on a 1006 reproducer that turned out to be the same root cause 0.4.12 then fixed with the `authenticate` hook - Cloudflare Tunnel (and similar edge proxies) silently closing WebSocket connections whose 101 response carries `Set-Cookie`. The cork was never the problem: 0.2.9 shipped the same `res.cork(() => res.upgrade(...))` pattern and has been running on Windows native (NSSM service, no proxy) in production for months without a single 1006. Same uWS version (v20.60.0) in both. With `authenticate` now owning the session-refresh-over-WS contract, `upgradeResponse()` with `Set-Cookie` is already discouraged and emits a build-time + runtime warning, so the proxy-strip scenario no longer rides on the cork site.

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

- **`authenticate` hook**: new optional export in `hooks.ws.js`/`hooks.ws.ts` that runs as a normal HTTP POST before the WebSocket upgrade. Refreshing session cookies via `cookies.set()` here rides on a standard response and works behind every proxy - including Cloudflare Tunnel, which silently closes WebSocket connections whose 101 response carries `Set-Cookie` (symptom: `open` fires server-side, then close code 1006 before any frames). The hook receives the SvelteKit-shaped event `{ request, headers, cookies, url, remoteAddress, getClientAddress, platform }`. Return `undefined` for an implicit 204 (recommended), `false` for 401, or a `Response` for full control. Only mounted when exported - zero runtime cost otherwise.
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

- **WebSocket upgrade on Windows**: `res.cork()` wrapping `res.upgrade()` produced a malformed 101 Switching Protocols response on Windows, causing the browser to never receive the upgrade response (TCP FIN, close code 1006). The server-side `open` handler fired normally, but the 101 bytes were never flushed to the client. Removed the cork wrapper from both the synchronous (no upgrade handler) and asynchronous (user upgrade handler) paths in the production runtime and the test harness. No performance impact - `res.writeHeader()` accumulates headers on the response object and `res.upgrade()` flushes them in a single syscall regardless of cork.

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

- `url` option in `ConnectOptions` - connect to a remote WebSocket server by full URL instead of deriving from `window.location`. Enables cross-origin usage from mobile apps (Svelte Native, React Native), standalone clients, and any environment where the backend lives on a different origin. When `url` is set, `path` is ignored and the `window` guard is bypassed.

#### Testing

- Playwright e2e test suite (`npm run test:e2e`) - 25 tests against a real SvelteKit fixture app. Covers SSR, static files, WebSocket pub/sub, upgrade authentication, subscribe-batch, platform API (sendTo, subscribers, topic helpers, cork), and the browser client with V8 coverage collection in both dev and production modes.
- Coverage pipeline (`npm run test:coverage`) - collects V8 coverage from vitest unit tests, Playwright server processes, and the browser via Chrome DevTools Protocol.
- 62 new unit tests bringing client.js to 96% lines. Covers: once() with timeout, onDerived() lifecycle, debug mode logging, visibility reconnect, zombie detection, sendQueued overflow, maxReconnectAttempts exhaustion, throttle close codes, oversized message rejection, crud/lookup maxAge with initial data and stop/restart, cursor bulk/remove/maxAge/snapshot, groups join/leave/close lifecycle, presence join/leave/heartbeat/maxAge sweep, replay scan() lifecycle, ratelimit unban/keyBy fallbacks, throttle cancel/debounce timer paths, presence deepEqual for Set/Map/Array/circular references, cursor throttle leading-edge timer clearing.

### Fixed

- **Security**: esbuild fallback for `$env/dynamic/public` no longer leaks private environment variables. Previously the fallback mapped all dynamic `$env` imports to `process.env` regardless of public/private distinction. Now `$env/dynamic/public` is filtered to only include variables matching the configured `publicPrefix`.
- **Vite plugin**: `unsubscribe` hook is now wired into the dev WebSocket handler and HMR comparison. Previously, changing or adding an `unsubscribe` export in `hooks.ws` had no effect in dev mode.
- **Client**: `ready()` resolves immediately during SSR regardless of singleton state. Previously it could hang forever if `on()` or `connect()` had already created a singleton on the server. In native app environments (no `window` but an explicit `url`), `ready()` correctly waits for the connection to open instead of short-circuiting.
- **Adapter**: esbuild fallback now passes the full `kit.alias` map (not just `$lib`) so custom alias imports in `hooks.ws` resolve correctly.
- **Handler**: WebSocket upgrade rate limiter resets both windows after a long idle gap (>= 2x window duration), preventing stale counts from producing false 429 rejections.
- **Presence plugin**: `select()` return value is validated - throws a clear `TypeError` if it returns a non-object (string, number, null, undefined) instead of crashing later with an unhelpful `in` operator error.
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

- Cursor client interpolation (added in 0.4.2, fixed in 0.4.3) - removed entirely because lerp-based smoothing adds visible latency without benefit when cursor updates already arrive near display refresh rate.

---

## [0.4.3] - 2026-03-20

### Fixed

- Cursor interpolation freeze during rapid movement. Each server update now immediately moves the cursor 50% toward the target instead of deferring all movement to the rAF loop. Lerp factor bumped from 0.3 to 0.5.

---

## [0.4.2] - 2026-03-20

### Added

#### Cursor Plugin

- `interpolate` option in `cursor()` - enables smooth rAF-driven lerp rendering (30% per frame). Numeric `x`/`y` data is interpolated; non-numeric data falls back to direct assignment. Snapshot, bulk, and remove events snap immediately.

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
