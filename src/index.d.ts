import type { Adapter } from '@sveltejs/kit';
import type { WebSocket } from 'uWebSockets.js';
import type { TraceContext, TraceOperationOptions, TraceSpan } from './observability.js';
// The upgrade-response helper lives on its own subpath ('svelte-adapter-uws/upgrade-response')
// so runtime code can import it without pulling in this build-time module. Its type is imported
// here only for the internal ReturnType<> reference in WebSocketHandler below; it is NOT re-exported.
import type { upgradeResponse } from './upgrade-response.js';
export type { WebSocket } from 'uWebSockets.js';

/**
 * ## Environment variables (runtime)
 *
 * These are set at runtime, not in the adapter config:
 *
 * | Variable | Default | Description |
 * |---|---|---|
 * | `HOST` | `0.0.0.0` | Bind address |
 * | `PORT` | `3000` | Listen port |
 * | `ORIGIN` | *(derived)* | Fixed origin (e.g. `https://example.com`) |
 * | `SSL_CERT` | - | Path to TLS certificate file (enables HTTPS/WSS natively) |
 * | `SSL_KEY` | - | Path to TLS private key file |
 * | `SSL_WATCH` | `1` | Hot-reload the cert on disk change (SNI swap, no restart); `0` disables |
 * | `SSL_RELOAD_DEBOUNCE_MS` | `500` | Debounce window (ms) for the cert-reload watcher |
 * | `SSL_SNI_HOSTS` | *(cert SAN)* | Comma-separated SNI host override for hot-reload |
 * | `PROTOCOL_HEADER` | - | Header for protocol detection (e.g. `x-forwarded-proto`) |
 * | `HOST_HEADER` | - | Header for host detection (e.g. `x-forwarded-host`) |
 * | `PORT_HEADER` | - | Header for port override (e.g. `x-forwarded-port`) |
 * | `ADDRESS_HEADER` | - | Header for client IP (e.g. `x-forwarded-for`) |
 * | `XFF_DEPTH` | `1` | Position from right in `X-Forwarded-For` |
 * | `BODY_SIZE_LIMIT` | `512K` | Max request body size (`K`, `M`, `G` suffixes) |
 * | `SHUTDOWN_TIMEOUT` | `30` | Seconds to wait during graceful shutdown |
 * | `RECONNECT_DISPERSAL_MS` | `5000` | Graceful-shutdown reconnect dispersal window (ms); `0` disables the advisory |
 * | `CLUSTER_WORKERS` | - | Number of worker threads (`'auto'` for CPU count) |
 * | `CLUSTER_MODE` | *(auto)* | `'reuseport'` (Linux default) or `'acceptor'` (other platforms) |
 *
 * All variables respect the `envPrefix` option (e.g. `MY_APP_PORT` if `envPrefix: 'MY_APP_'`).
 *
 * ### Multi-core clustering
 *
 * ```sh
 * CLUSTER_WORKERS=auto node build    # one worker per CPU core
 * CLUSTER_WORKERS=4 node build       # fixed 4 workers
 * ```
 *
 * Two clustering modes are available:
 *
 * - **`reuseport`** (Linux default) - each worker binds to the same port via `SO_REUSEPORT`.
 *   The kernel distributes incoming connections across workers. No single-threaded acceptor
 *   bottleneck, no single point of failure. One worker crashing does not affect others.
 *
 * - **`acceptor`** (macOS/Windows default) - a primary thread accepts all connections and
 *   distributes them to workers via uWS child app descriptors. Works on all platforms.
 *
 * The mode is auto-detected from the platform. Override with `CLUSTER_MODE=acceptor` or
 * `CLUSTER_MODE=reuseport` (reuseport requires Linux). Workers auto-restart on crash.
 *
 * **WebSocket + clustering:** `publish()` is automatically relayed across all workers.
 * `sendTo()`, `connections`, and `subscribers()` operate on the local worker only.
 *
 * ### Native TLS (no proxy needed)
 *
 * ```sh
 * SSL_CERT=/path/to/cert.pem SSL_KEY=/path/to/key.pem node build
 * ```
 *
 * This uses uWebSockets.js `SSLApp` - HTTPS and WSS with zero proxy overhead.
 *
 * A renewed cert on disk (certbot / cert-manager) is picked up automatically: the
 * server watches the cert directory and swaps the SNI server name in place, so a
 * fresh cert is served without dropping the listen socket or live connections.
 * Set `SSL_WATCH=0` to opt out. A non-SNI / unmatched-SNI client keeps the boot
 * cert until a restart (the SSLApp default context is static). In clustered modes
 * the primary watches the cert directory and broadcasts the reload to every
 * worker, so a renewed cert is picked up live there too - no restart needed.
 */

/** A path-specific cache policy for static build output. */
export interface StaticCacheControlRule {
	/**
	 * Asset path relative to SvelteKit's configured base. A trailing slash
	 * matches that directory tree; otherwise the path matches one exact file.
	 * @example '/fonts/'
	 * @example '/logo.v2.svg'
	 */
	pattern: string;

	/** A complete Cache-Control field value. */
	cacheControl: string;
}

/**
 * Options for the adapter factory. An unrecognized KEY (top-level or under
 * `websocket`) warns at build time with a closest-match suggestion and is
 * ignored, so a config carrying a newer version's key still builds; a
 * recognized key with a VALUE the option cannot honor fails the build with an
 * error naming what the option accepts.
 */
export interface AdapterOptions {
	/**
	 * Output directory for the build.
	 * @default 'build'
	 */
	out?: string;

	/**
	 * Precompress static assets with gzip and brotli.
	 * @default true
	 */
	precompress?: boolean;

	/**
	 * Prefix for environment variables.
	 * @default ''
	 */
	envPrefix?: string;

	/**
	 * Liveness probe path. Reports `200` whenever the process is up, including
	 * during a graceful drain - so a liveness probe never restarts a draining
	 * instance mid-shutdown. Set to `false` to disable.
	 * @default '/healthz'
	 */
	healthCheckPath?: string | false;

	/**
	 * Readiness probe path, distinct from the `healthCheckPath` liveness probe.
	 * Reports `200` with the body `ready` only while this instance can take new
	 * traffic, and `503` otherwise, so a fronting load balancer stops routing
	 * NEW traffic while in-flight requests finish. The `503` body names WHICH
	 * not-ready state it is: `starting` (the socket is bound but the app's `init`
	 * hook has not committed yet), `draining` (graceful shutdown has begun) or
	 * `closed` (the listen socket is gone) - during a rolling deploy that is the
	 * difference between an instance still booting and one going away. Keep it
	 * separate from `healthCheckPath` (a readiness `503` must not trip a liveness
	 * probe into a restart). Must differ from `healthCheckPath`. Set to `false`
	 * to disable.
	 * @default '/readyz'
	 */
	readinessCheckPath?: string | false;

	/**
	 * Readiness-gated boot warmup. During the `starting` window - after the
	 * `init` hook, before the readiness probe reports ready - the configured
	 * paths are rendered once through the real SSR engine, so the render path
	 * is warm before a load balancer routes the first real client in. A cold
	 * SSR render costs roughly twenty times a warm one (measured ~20ms versus
	 * ~1ms), and that penalty otherwise lands on the first request after every
	 * deploy or scale-up. A warmup render runs the app's server hooks like any
	 * request; `event.platform.isWarmupRequest(event.request)` lets a
	 * `hooks.server.js` handle recognize it and skip per-visit side effects.
	 *
	 * `true` warms `/`; `false` disables warmup; `{ paths }` names the absolute
	 * routes to warm. A path configured here is declared surface both family
	 * adapters carry.
	 * @default true
	 */
	warmup?: boolean | { paths: string[] };

	/**
	 * Response headers added to every static and prerendered asset
	 * (`/llms.txt`, `favicon.ico`, `robots.txt`, `.well-known/*`, prerendered
	 * pages, hashed JS/CSS). These responses are served from an in-memory fast
	 * path that returns BEFORE SSR, so security headers set in
	 * `hooks.server.js` `handle` - which only runs on the SSR path - never reach
	 * them. Use this to put CSP, HSTS, X-Frame-Options, Referrer-Policy,
	 * Permissions-Policy (and any custom `x-*` header) on static responses.
	 *
	 * Keys are case-insensitive. The handler's own transfer / caching / range
	 * headers cannot be overridden (`content-type`, `content-encoding`, `etag`,
	 * `cache-control`, `vary`, `accept-ranges`, ...); supplying one logs a
	 * build warning and is ignored. Use `staticCacheControl` for path-specific
	 * cache policies. Merged once at build/index time, so there is zero
	 * per-request cost.
	 *
	 * @example
	 * ```js
	 * adapter({
	 *   staticHeaders: {
	 *     'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
	 *     'x-frame-options': 'DENY',
	 *     'referrer-policy': 'strict-origin-when-cross-origin'
	 *   }
	 * })
	 * ```
	 */
	staticHeaders?: Record<string, string>;

	/**
	 * Path-specific Cache-Control policies for versioned custom assets. Rules
	 * match build-output paths relative to SvelteKit's configured base. A
	 * pattern ending in `/` selects that directory tree; another pattern
	 * selects one exact file. When rules overlap, the most specific pattern
	 * wins. SvelteKit's built-in `/_app/immutable/` policy always takes
	 * precedence.
	 *
	 * Files outside these rules keep `Cache-Control: no-cache` and their ETag.
	 * Configured files also retain their representation-specific ETag and byte
	 * range support. Use immutable caching only when the filename changes with
	 * the content.
	 *
	 * @example
	 * ```js
	 * adapter({
	 *   staticCacheControl: [
	 *     {
	 *       pattern: '/fonts/',
	 *       cacheControl: 'public, max-age=31536000, immutable'
	 *     },
	 *     {
	 *       pattern: '/pictures/',
	 *       cacheControl: 'public, max-age=86400'
	 *     }
	 *   ]
	 * })
	 * ```
	 */
	staticCacheControl?: StaticCacheControlRule[];

	/**
	 * Serve dotfiles from the static/prerendered output. Off by default: a
	 * path with a dot segment (`.env`, `a/.hidden/b`) is left out of the
	 * static index and responds 404, as `adapter-node`'s dotfile default
	 * also refuses them - the files that land in `static/` by accident are
	 * exactly the sensitive ones (a stray `.env`, `.htpasswd`, editor
	 * backups, an unpacked `.git`).
	 *
	 * A top-level `.well-known/` keeps serving its own non-dot files (RFC 8615
	 * discovery: `security.txt`, ACME HTTP-01 challenges). The carve-out
	 * exempts that first path segment, not the tree beneath it, so
	 * `x/.well-known/y` is not an escape hatch and a dotfile inside
	 * `.well-known/` is still refused. Both shapes are stricter than
	 * `adapter-node`, whose static server keeps any path under `.well-known/`.
	 *
	 * Dev and preview do not match this rule and are not evidence about it:
	 * `vite dev` serves `static/` through `sirv` with no dotfile filter at all,
	 * and preview's filter keeps everything under `.well-known/`. Verify
	 * against the production build.
	 *
	 * The exclusion is decided once when assets are indexed, so it has no
	 * per-request cost and no request can reach an excluded file through
	 * encoding tricks - the index simply has no entry. The build warns when
	 * it writes a dot path that serving will refuse, naming each offender
	 * once.
	 * Set `true` to index and serve every dotfile.
	 *
	 * @default false
	 */
	staticDotfiles?: boolean;

	/**
	 * Module path to an optional vendor-neutral tracing provider. The module's
	 * default or named tracing export implements startSpan(name, options)
	 * using the types from svelte-adapter-uws/observability. The adapter
	 * extracts validated W3C traceparent / tracestate headers, keeps the
	 * resulting context active across async native work, and exposes it through
	 * platform.trace and platform.traceContext.
	 *
	 * The provider may return an OpenTelemetry Span directly: its
	 * spanContext(), recordException(), and end() methods are recognized. When
	 * omitted, tracing is a no-op and the native hot path does not allocate
	 * spans.
	 *
	 * @example './src/lib/server/tracing.js'
	 */
	tracing?: string;

	/**
	 * Enable WebSocket support.
	 *
	 * - `true` - enable with built-in pub/sub handler (**no auth, no per-topic
	 *   authorization** - any connected client can subscribe to any topic.
	 *   Use a custom handler with `upgrade` for auth gating)
	 * - `WebSocketOptions` - enable with custom config and/or auth handler
	 *
	 * @example
	 * ```js
	 * // Simplest - just turn it on:
	 * adapter({ websocket: true })
	 *
	 * // With auth:
	 * adapter({
	 *   websocket: {
	 *     handler: './src/lib/server/websocket.js'
	 *   }
	 * })
	 * ```
	 */
	websocket?: boolean | WebSocketOptions;
}

export interface MessageAdmissionOptions {
	/** Maximum application-work frames accepted per connection in `rateWindowMs`. `0` disables. */
	perConnectionRate?: number;
	/** Maximum application-work frames accepted across this worker in `rateWindowMs`. `0` disables. */
	globalRate?: number;
	/**
	 * Maximum application-work payload bytes accepted per connection in
	 * `rateWindowMs`, charged by each incoming frame's byte length. `0`
	 * disables. Refusals use the same `rate_limit` reason and scopes as the
	 * per-frame rates. A single frame larger than the whole window's byte
	 * allowance can never afford its own cost and is refused every time, so
	 * size the allowance against `maxPayloadLength` deliberately.
	 */
	perConnectionBytesRate?: number;
	/**
	 * Maximum application-work payload bytes accepted across this worker in
	 * `rateWindowMs`, charged by each incoming frame's byte length. `0`
	 * disables. Same refusal semantics as `perConnectionBytesRate`.
	 */
	globalBytesRate?: number;
	/** Token-bucket refill window in milliseconds. @default 1000 */
	rateWindowMs?: number;
	/** Maximum concurrently-running application frames per connection. `0` disables. */
	perConnectionConcurrent?: number;
	/** Maximum concurrently-running application frames across this worker. `0` disables. */
	globalConcurrent?: number;
	/**
	 * Maximum messages waiting for a concurrency permit across this worker.
	 * `0` sheds immediately. Queued native payloads are copied before the
	 * uWebSockets.js callback returns; the bound therefore also bounds retained
	 * ingress memory by `maxQueue * maxPayloadLength`.
	 * @default 0
	 */
	maxQueue?: number;
}

/**
 * One scope's publish-egress ceilings, each per rotation window
 * (`EgressOptions.windowMs`). Every ceiling must be a non-negative safe
 * integer; `0` (or omitted) disables that ceiling deliberately, and a value
 * of any other shape refuses the build on every intake surface.
 *
 * Size a ceiling above the largest single publish it must admit. A batch frame
 * is admitted whole or refused whole (`platform.batch()` is a loop over
 * independent publishes, not one frame), and a publish heavier than the entire
 * window allowance (a 10-entry batch under `messages: 5`, or a topic whose
 * subscriber count exceeds `deliveries`) can never fit a window: it is
 * refused on every attempt, reported through the refusal counter and the
 * throttled operational event rather than silently.
 *
 * Ceilings are held per key in a ledger bounded per scope - 4096 keys unless
 * `EgressOptions.maxKeys` sizes it. Keys approaching the bound reclaim windows that have
 * already lapsed, a little at a time, so that the lapsed ones are gone before
 * the ledger is full; a ceiling is given up only when it is full anyway and
 * nothing in it has lapsed. So the bound is on the keys LIVE at once rather
 * than on every key the worker has published to, and a population that fits
 * inside the bound keeps every ceiling however close to the bound it sits.
 * Below it the ceilings apply to every key.
 *
 * Above it - more distinct topics (or tenants) live inside one window than the
 * bound - the ledger evicts, and an evicted key stops being held to its ceiling
 * for the rest of its window. The victim is the key that has spent least of its
 * allowance among a bounded sample (`EgressOptions.evictionSample`) rather than
 * the least-spent key overall, so a group of keys that became busy together can
 * lose some of its members even while quieter keys survive elsewhere. Every
 * eviction that costs enforcement increments
 * `egress_window_evicted_total{scope}`; sustained churn there means live key
 * cardinality has outgrown the ledger, and `maxKeys` is the lever sized for it.
 * A `tenant` ceiling stays the durable one for a high-cardinality topic space:
 * tenant ids have to outnumber the ledger before the tenant scope can be
 * affected at all.
 */
export interface EgressCeilings {
	/** Maximum logical publishes per window. `0` disables. */
	messages?: number;
	/**
	 * Maximum charged wire bytes per window (serialized frame bytes summed
	 * over recipients, pre-compression). `0` disables. This ceiling refuses
	 * once the window's charge has REACHED it - the publish that crosses it
	 * is delivered and the next is refused - because a publish's byte weight
	 * exists only after serialization, which must not precede admission.
	 */
	bytes?: number;
	/**
	 * Maximum deliveries per window (local recipients times messages, an
	 * excluded socket deducted). `0` disables. Refuses the publish that
	 * would cross it.
	 */
	deliveries?: number;
}

/**
 * The `websocket.egress` section: publish-egress accounting ceilings per
 * worker. See the `egress` option on {@link WebSocketOptions} for the charge
 * law, the refusal shape, and the tenant attribution contract.
 */
export interface EgressOptions {
	/**
	 * Accounting window in milliseconds. Rotated lazily per scope key - no
	 * timer. Must be a number `>= 100` (and below the 32-bit timer ceiling,
	 * the shared bound every interval option takes).
	 * @default 1000
	 */
	windowMs?: number;
	/**
	 * Keys each scope's usage ledger may hold at once (one ledger per scope
	 * per worker, plus the tenant-resolution memo). Must be a safe integer
	 * between `1024` and `2^24` (the largest bound a V8 Map can actually
	 * hold); the ledger rounds it UP to the next power of two, because V8
	 * sizes a Map's backing table to a power of two anyway - the rounded
	 * bound holds no fewer keys in the same memory the
	 * requested value would have taken. Memory is paid only for keys actually
	 * seated (~56 bytes per entry at steady churn), so an oversized cap on a
	 * small population costs nothing; size it to the keys LIVE inside one
	 * window when `egress_window_evicted_total{scope}` shows sustained churn.
	 * There is no disable value: an unbounded ledger would turn topic
	 * cardinality into unbounded memory.
	 * @default 4096
	 */
	maxKeys?: number;
	/**
	 * Entries an at-cap eviction inspects before taking the least-active one
	 * it saw (an expired window wins outright and ends the sample). Must be a
	 * safe integer `>= 1`. A deployment that raises `maxKeys` by an order of
	 * magnitude may widen it to match; the walk stays bounded at any width,
	 * because a pass wraps the ledger at most once per eviction.
	 * @default 8
	 */
	evictionSample?: number;
	/** Ceilings applied per topic, to attributed and unattributed publishes alike. */
	topic?: EgressCeilings;
	/**
	 * Ceilings applied per tenant, keyed by the tenant a publish is charged
	 * to (the game lane sender's `attribution` tenant id, or the handler
	 * module's `egressTenantOf(topic)` result). Unattributed publishes are
	 * not bounded here - they fall under `topic` only.
	 */
	tenant?: EgressCeilings;
}

export type MessageOverloadReason = 'rate_limit' | 'concurrency_limit' | 'queue_full';

/** Server response for an application message shed by `messageAdmission`. */
export interface MessageOverloadedFrame {
	type: 'message-overloaded';
	reason: MessageOverloadReason;
	scope: 'connection' | 'global';
	/** Present only for a rate-limit response. */
	retryAfterMs?: number;
}

export interface WebSocketOptions {
	/**
	 * Path to a JS module that exports WebSocket handler functions
	 * (`upgrade`, `open`, `message`, `close`).
	 *
	 * **Optional.** The adapter auto-discovers `src/hooks.ws.js` (or `.ts`, `.mjs`)
	 * if it exists - no config needed. If neither a handler path nor a hooks file
	 * is found, a built-in handler is used that accepts all connections and handles
	 * subscribe/unsubscribe messages from the client store.
	 *
	 * Only specify this if your handler lives at a non-standard path. Naming it
	 * here is enough - the dev plugin reads this value too, so the module the
	 * dev server runs is the module the build bundles. Naming a *different*
	 * module on the plugin (`uws({ handler })`) is a configuration error and
	 * fails the build, rather than letting one of the two win silently.
	 *
	 * @example './src/lib/server/websocket.js'
	 */
	handler?: string;

	/**
	 * URL path to serve WebSocket connections on.
	 * @default '/ws'
	 */
	path?: string;

	/**
	 * URL path for the `authenticate` preflight endpoint.
	 *
	 * The adapter auto-mounts a `POST` endpoint here when your `hooks.ws` file
	 * exports an `authenticate` function. The client store hits it before
	 * opening a WebSocket when `connect({ auth: true })` is used.
	 *
	 * Must differ from `path`. Change this only if the default collides with
	 * your routing or if Cloudflare Access requires a non-`__`-prefixed path.
	 *
	 * @default '/__ws/auth'
	 */
	authPath?: string;

	/**
	 * Prefix for the reserved admin / observability route. When your WebSocket
	 * handler exports an `admin(request)` function (svelte-realtime's auth-gated
	 * introspection handler is the canonical one), the adapter auto-mounts it at
	 * `<adminPath>/*`, registered before the SSR catch-all so it never hits page
	 * routing. The handler is mount-prefix agnostic, so relocating it is a
	 * one-place change here.
	 *
	 * Set `false` to disable the auto-mount entirely - for apps that mount the
	 * `admin` handler themselves (e.g. a SvelteKit `+server.js` route with their
	 * own middleware) and do not want a second, adapter-owned mount point. No
	 * effect unless the handler exports `admin`.
	 *
	 * Must be an absolute path (starting with `/`) that differs from `path` and
	 * `authPath`.
	 * @default '/__realtime'
	 */
	adminPath?: string | false;

	/**
	 * Silence the boot warning that the auto-mounted admin route carries no
	 * adapter-level authentication.
	 *
	 * The adapter mounts `admin` without gating it - whether requests are
	 * authenticated is entirely up to the handler, and the adapter cannot
	 * inspect that - so it warns once at startup. Set this to `true` after
	 * confirming the handler validates a session cookie, bearer token or
	 * equivalent, so the line stops appearing in logs an operator has already
	 * acted on. It changes nothing about routing or authorization.
	 *
	 * @default false
	 */
	adminAuthAcknowledged?: boolean;

	/**
	 * Max message size in bytes. Connections sending larger messages are closed.
	 * Default 1 MB is balanced for typical app payloads in a single frame; uWS
	 * itself defaults to 16 KB. Lower this for stricter caps (e.g. `16 * 1024`
	 * for the uWS-matching 16 KB) when payload-size discipline matters.
	 * @default 1048576 (1 MB)
	 */
	maxPayloadLength?: number;

	/**
	 * Ceiling on the per-topic sequence registries a worker retains (the
	 * publish counters and the highest-observed map). At the cap, inserting a
	 * new topic evicts the oldest entry that has no live subscribers and no
	 * open resume buffer, and both registries forget it together.
	 *
	 * Eviction cannot corrupt a resuming client, because a forgotten counter
	 * is never REUSED: the evicted value is carried in a bounded floor map,
	 * and when that map fills, every floor in it collapses into one
	 * high-water number, so a re-published topic always resumes above what
	 * any forgotten topic reached. A counter may skip numbers; it never
	 * repeats one. No epoch changes and no client is asked to rehydrate.
	 *
	 * When every eviction candidate is protected, the insert is admitted over
	 * the cap and the cardinality warning fires instead. That protection is
	 * best-effort - an exact-topic subscriber count does not see a wildcard
	 * subscription - and correctness does not depend on it.
	 *
	 * In a cluster, eviction additionally takes only topics the cross-worker
	 * state reporter has judged quiet, so a sibling that still holds a busy
	 * topic cannot read the difference as active divergence. A topic is
	 * unevictable until judged, so the effective clustered ceiling is
	 * `maxTopicSeqEntries + newTopicsPerSecond * 2 * stateHashIntervalMs/1000`
	 * - two reporter intervals of arrivals. Size the option with that second
	 * term in mind rather than from the cap alone. A registry that rises
	 * above the cap holds that level rather than draining back to it:
	 * eviction stops further growth, it does not compact.
	 *
	 * Set `0` to disable the bound entirely (the pre-existing unbounded
	 * behavior). Topics published with `seq: false` never enter these
	 * registries. The carried floor covers the counter this worker issues; a
	 * topic whose sequence comes from an external authority (a numeric `seq`)
	 * is that authority's to keep continuous, and its numbers are
	 * deliberately not folded into this worker's counters.
	 *
	 * Applies to the production runtime and `createTestServer`. `vite dev`
	 * stamps per-topic sequences only on the `game` lane, so its registry is
	 * bounded by the rooms in one dev session and needs no ceiling.
	 * @default 1000000 (the cardinality warning threshold)
	 */
	maxTopicSeqEntries?: number;

	/**
	 * Seconds of inactivity before the connection is closed.
	 * Set to `0` to disable the idle timeout and uWS's automatic ping. A peer
	 * that disappears silently is then never reaped and keeps its connection
	 * slot until the socket is closed by some other means.
	 * @default 120
	 */
	idleTimeout?: number;

	/**
	 * Max bytes of backpressure per connection before messages are dropped.
	 * The uWebSockets.js default is 64 KB; this adapter defaults to 1 MB to
	 * accommodate pub/sub broadcast spikes. Lower this if you expect many
	 * concurrent connections with slow consumers.
	 * @default 1048576 (1 MB)
	 */
	maxBackpressure?: number;

	/**
	 * When `true`, uWS closes a connection that stays pinned over
	 * `maxBackpressure` instead of perpetually shedding its frames. This is the
	 * bounded-recovery knob for a chronically slow consumer that would otherwise
	 * wedge a worker's outbound queue: the default shed-and-continue behavior
	 * keeps the connection alive and silently drops frames past the cap, which is
	 * correct for a transient spike but lets a permanently-slow client tie up
	 * buffer memory indefinitely. Opt in to drop such a client instead.
	 *
	 * Watch `platform.pressure.maxBufferedBytes` /
	 * `platform.pressure.backpressuredConnections` (or the `ws_backpressure_*`
	 * metrics gauges) to decide whether your workload needs it.
	 *
	 * @default false (shed-and-continue; zero-config behavior unchanged)
	 */
	closeOnBackpressureLimit?: boolean;

	/**
	 * Enable per-message deflate compression. Pass `true` for `SHARED_COMPRESSOR`,
	 * or a uWS compression constant (e.g. `uWS.DEDICATED_COMPRESSOR_4KB`) for finer
	 * control.
	 *
	 * Default `false`, which is byte-identical to no compression. When a compressor
	 * IS configured, compression is applied per frame, not blanket: text frames
	 * (`publish` / `send`) compress by default, binary codec frames
	 * (`publishWire` / `sendWire`) are opt-in, the cursor plugin stays uncompressed
	 * (its 60 Hz hot path), and the presence plugin opts in (low-frequency). Pass
	 * `{ compress: false }` to `publish` / `send` for a high-frequency, high-fan-out
	 * text topic: permessage-deflate CPU scales per subscriber (it does not
	 * compress-once-and-fan-out, even for `SHARED_COMPRESSOR`), so compressing a hot
	 * broadcast to many subscribers is expensive. Prefer `SHARED_COMPRESSOR` over a
	 * `DEDICATED_*` compressor on a many-connection server: `DEDICATED_*` keeps a
	 * sliding window per socket (memory grows with connection count) for a small
	 * extra compression gain.
	 *
	 * @default false
	 */
	compression?: boolean | number;

	/**
	 * Automatically send pings to keep the connection alive.
	 * @default true
	 */
	sendPingsAutomatically?: boolean;

	/**
	 * Timeout in seconds for async `upgrade` handlers.
	 * If the upgrade hook doesn't resolve within this time, the connection
	 * is rejected with 504 Gateway Timeout. Set to `0` to disable.
	 * @default 10
	 */
	upgradeTimeout?: number;

	/**
	 * Allowed origins for WebSocket connections.
	 *
	 * - `'same-origin'` - only accept connections whose Origin matches the
	 *   deployment's own origin *(default)*. When the `ORIGIN` env var is set
	 *   it is the authority and the request Host header is NOT consulted:
	 *   Host is attacker-controlled for a non-browser client, so comparing
	 *   two attacker-supplied headers accepts anything. Without `ORIGIN`, the
	 *   comparison falls back to Host (with `HOST_HEADER` / `PROTOCOL_HEADER`
	 *   / `PORT_HEADER` overrides applied). Consequence worth knowing: a
	 *   deployment reachable at several hostnames (apex plus www, a staging
	 *   alias, an internal load-balancer name) must either leave `ORIGIN`
	 *   unset or list every origin explicitly with the array form - with
	 *   `ORIGIN` set, WebSocket upgrades from the other names are refused
	 *   while ordinary HTTP keeps working.
	 * - `'*'` - accept connections from any origin
	 * - `string[]` - whitelist of allowed origin URLs (e.g. `['https://example.com']`)
	 *
	 * Requests without an Origin header (non-browser clients) are rejected
	 * unless an upgrade handler is configured to authenticate them.
	 *
	 * @default 'same-origin'
	 */
	allowedOrigins?: 'same-origin' | '*' | string[];

	/**
	 * Maximum number of WebSocket upgrade requests allowed per IP address
	 * within `upgradeRateLimitWindow` seconds.
	 * Set to `0` to disable upgrade rate limiting.
	 *
	 * The key is the client IP, which is the raw socket address unless
	 * `ADDRESS_HEADER` is set. Behind a reverse proxy, an L4 load balancer, or
	 * docker's `userland-proxy` (its default) that rewrites the source address,
	 * every client arrives as the same gateway IP and this "per-IP" limit
	 * silently collapses into a single GLOBAL cap. Set
	 * `ADDRESS_HEADER=x-forwarded-for` (with `XFF_DEPTH`) so the limiter sees the
	 * real client, set docker `userland-proxy: false` so the source IP is
	 * preserved, or set this to `0` if you rate-limit upstream. The runtime
	 * warns once if it rejects an upgrade keyed on a private/loopback address
	 * while `ADDRESS_HEADER` is unset.
	 *
	 * A global IPv6 address is keyed on its /64 prefix rather than the full
	 * address: a /64 is the smallest block a host is routinely given, so keying
	 * on the /128 would let one host source every request from a fresh address
	 * and never share a bucket with itself. The consequence for legitimate
	 * traffic is that clients behind one /64 (a campus, an office, a VPN
	 * egress) share a bucket. A 6to4 address (`2002::/16`) encodes its site
	 * allocation, so it is keyed coarser, on its /48 site prefix - the whole
	 * site shares one bucket. IPv4, IPv4-mapped addresses and ranges whose
	 * /64 is shared by unrelated clients (NAT64, Teredo, link-local) keep the
	 * full address.
	 * @default 10
	 */
	upgradeRateLimit?: number;

	/**
	 * Time window in seconds for the upgrade rate limiter.
	 * @default 10
	 */
	upgradeRateLimitWindow?: number;

	/**
	 * Per-IP sliding-window rate limit on the auth preflight endpoint - the
	 * request `connect({ auth: true })` clients POST before upgrading. Clients
	 * over the limit get `429 Too Many Requests` and the `authenticate` hook is
	 * never called, so a credential check against a database cannot be driven at
	 * raw server capacity from one address. Set to `0` to disable.
	 *
	 * The default is HIGHER than `upgradeRateLimit` on purpose. Every reconnect
	 * that preflights also upgrades, so this door sees at least as much traffic
	 * as the upgrade door during a deploy's reconnect wave, and a NAT'd network
	 * behind one address multiplies both. Matching them 1:1 would make the
	 * preflight the binding constraint and refuse traffic the upgrade limit would
	 * have admitted.
	 *
	 * Same identity resolution as `upgradeRateLimit`, so it inherits the same
	 * caveat: behind an address-rewriting proxy with `ADDRESS_HEADER` unset,
	 * every client shares one bucket and this becomes a global cap.
	 * @default 30
	 */
	authPathRateLimit?: number;

	/**
	 * Time window in seconds for the auth preflight rate limiter.
	 * @default 10
	 */
	authPathRateLimitWindow?: number;

	/**
	 * Server-enforced admission for established application messages. The gate
	 * covers the app/plugin `message` hook, binary `0x03` ingress routes, and the
	 * JSON `game` publish lane. Protocol-control frames stay outside the gate so
	 * an overloaded client can still unsubscribe, replenish a lease, or recover.
	 *
	 * Rate overflow is shed immediately. Concurrency overflow waits only while
	 * `maxQueue` has room; otherwise it is shed. Every shed receives a typed
	 * `{ type: 'message-overloaded', reason, scope, retryAfterMs? }` response.
	 * All limits are per worker and opt-in; zero or omitted means disabled.
	 */
	messageAdmission?: MessageAdmissionOptions;

	/**
	 * Publish-egress accounting ceilings - the outbound half of a tenant
	 * budget, enforced per worker at every publish-family fan-out
	 * (`publish`, `publishWire`, `publishWireBatch`, `publishBatched`,
	 * `publishGame`, `sendTo`). Every logical publish is charged as
	 * serialized wire bytes times local recipients; the optional ceilings
	 * refuse a publish BEFORE anything happens - no sequence is stamped, no
	 * frame is built, nothing reaches the native layer or the cross-worker
	 * relay - so subscribers never see a sequence gap from a refusal. The
	 * caller receives the refusal shape (`false`, a zero count, or
	 * `{ seq: null, delivered: 0 }` on the game lane).
	 *
	 * Frames received over the cross-worker relay are never charged and never
	 * refused: the origin worker charged its own local recipients, and each
	 * instance owns only its own egress. Cross-instance multiplication is the
	 * extensions bus's half of the contract (see `docs/tenancy.md`).
	 *
	 * The `tenant` ceilings key on the tenant a publish is charged to: the
	 * SENDER's frozen attribution (`attribution` export) on the client-relay
	 * game lane, and the handler module's `egressTenantOf(topic)` export for
	 * server-side publishes. An unattributed publish is bounded by the
	 * `topic` ceilings only. `tenantOf` cannot be configured here - a
	 * function does not survive the build's option serialization, so a
	 * `tenantOf` key in this section refuses the build and points to the
	 * handler export.
	 *
	 * Enforcement semantics, identical on production, `createTestServer`,
	 * and the dev plugin: the `messages` and `deliveries` ceilings refuse
	 * the publish that would cross them; the `bytes` ceiling refuses once
	 * the window's charged bytes have reached it (a publish's byte weight
	 * exists only after serialization, which must not precede admission), so
	 * the crossing publish is delivered and the next is refused. A batching
	 * primitive that builds one wire frame - `publishBatched`,
	 * `publishWireBatch` - is atomic: it is admitted against the pooled weight
	 * of every topic it spans and every tenant that owns them, then delivered
	 * whole or refused whole. `platform.batch()` is not one of them; it loops
	 * independent publishes, so a ceiling can admit part of a `batch()` call.
	 * Refusals are visible as `egress_refused_total{scope}`
	 * on a configured metrics registry, in `platform.pressure.egress`, and
	 * as a throttled `ADAPTER-ERR-EGRESS-REFUSED` operational event -
	 * `publishBatched` returns nothing, so those signals are its only
	 * refusal report.
	 *
	 * The charged `bytes` are the encoded UTF-8 length while a `bytes`
	 * ceiling is armed, and the character length otherwise: measuring the
	 * encoding walks the envelope, so a server that configured no budget - or
	 * one that counts messages rather than bytes - does not pay for a number
	 * nothing decides on. The two agree for ASCII.
	 */
	egress?: EgressOptions;

	/**
	 * Admission control for WebSocket upgrades. Three independent layers are
	 * opt-in (omit or set them to `0` to disable):
	 *
	 * - `maxConcurrent` caps how many upgrades may be in flight at once.
	 *   Crossed requests get a fast `503 Service Unavailable` before any
	 *   per-request work, so a connection storm can be shed without
	 *   spending CPU on TLS / header parsing / cookie decoding.
	 * - `maxConnections` caps reserved upgrades plus live WebSocket
	 *   connections per worker. Its permit is acquired before per-request
	 *   work and held through the socket's close callback, so sequential
	 *   handshakes cannot bypass the ceiling. Crossed requests get `503`.
	 * - `perTickBudget` caps how many `res.upgrade()` calls run per
	 *   event-loop tick. Once the budget is spent, the actual upgrade
	 *   call is deferred via `setImmediate` so the loop is not starved
	 *   by 10K synchronous handshakes from one I/O batch. Pre-upgrade
	 *   work (rate limit check, origin check, hook dispatch) still runs
	 *   in the original tick; only the hand-off to the C++ upgrade
	 *   path is paced. Its deferred queue is finite and sheds overflow with
	 *   `503 Service Unavailable`.
	 *
	 * The three layers default to `0` (disabled). `maxDeferred` applies only
	 * when pacing is enabled, defaults to `1024`, and may be set to `0` to
	 * retain no callbacks after the current tick's budget is spent. Tune to your
	 * peak-load envelope:
	 * `maxConcurrent` should be just above your steady-state in-flight
	 * handshake count; `maxConnections` should reflect the per-worker
	 * socket/file-descriptor and memory budget; `perTickBudget` should be
	 * small enough that one full burst does not block other I/O for
	 * more than a few milliseconds (start with `64` and adjust).
	 *
	 * @example
	 * ```js
	 * adapter({
	 *   websocket: {
	 *     upgradeAdmission: {
	 *       maxConcurrent: 1000,
	 *       maxConnections: 50000,
	 *       perTickBudget: 64,
	 *       maxDeferred: 1024
	 *     }
	 *   }
	 * });
	 * ```
	 */
	upgradeAdmission?: {
		/**
		 * Ceiling on upgrades in flight at once; crossed requests receive a
		 * fast `503 Service Unavailable`. Must be a non-negative safe integer.
		 * `0` or omitted keeps the ceiling disabled.
		 */
		maxConcurrent?: number;
		/**
		 * Finite per-worker ceiling for reserved upgrades plus live WebSocket
		 * connections. A permit is held until `close`; crossed requests receive
		 * `503 Service Unavailable`. Must be a non-negative safe integer.
		 * `0` or omitted keeps the backward-compatible unlimited default.
		 */
		maxConnections?: number;
		/**
		 * Ceiling on `res.upgrade()` calls per event-loop tick; the overflow is
		 * deferred via `setImmediate`. Must be a non-negative safe integer.
		 * `0` or omitted keeps upgrade pacing disabled.
		 */
		perTickBudget?: number;
		/**
		 * Finite per-worker ceiling for callbacks waiting behind
		 * `perTickBudget`. Must be a non-negative safe integer. Defaults to
		 * `1024` while pacing is enabled; `0` rejects every attempt after the
		 * current tick budget instead of retaining it.
		 */
		maxDeferred?: number;
		/**
		 * Reserve a fraction of `maxConcurrent` for a deprioritised cursor-only
		 * upgrade lane (the worker's second WebSocket). A cursor upgrade is
		 * admitted only while both the main ceiling and this sub-budget have
		 * room, so a flood of cursor reconnects can never starve main-WS
		 * admission. The cursor lane is refused first and refused entirely under
		 * siege (a bare `503`, never the holding page - a worker is never a
		 * browser). Default `fraction` is `0.25`. Omit `cursorLane` to disable
		 * the lane: the second counter never increments and the main lane is
		 * byte-identical.
		 */
		cursorLane?: {
			/** Fraction of `maxConcurrent` reserved for the cursor lane. Default `0.25`. */
			fraction?: number;
		};
		/**
		 * Content-negotiated response when an upgrade is refused at capacity.
		 * Defaults to ON whenever `maxConcurrent`, `maxConnections`, or
		 * `perTickBudget` is set: browser navigations
		 * get a self-polling holding page that reloads when a slot frees;
		 * WebSocket upgrades and non-browser HTTP clients keep `503` with a
		 * jittered `Retry-After`. Set `false` to disable polling: an HTML
		 * navigation still receives a minimal accessible `503` document, while
		 * WebSocket and non-HTML clients retain the bare text `503` body.
		 * Every refused lane carries the jittered `Retry-After` - waiting room
		 * on or off, cursor lane included - over a band of at least two whole
		 * seconds (base 2 when no room configures one), so refusals are never
		 * answered one constant second. When
		 * all three admission layers are disabled the gate never rejects, so
		 * the waiting room never engages.
		 */
		waitingRoom?: false | {
			/** Holding-page route the adapter serves. Default `'/__waiting-room'`. */
			path?: string;
			/** Poll endpoint the page hits. Default `'/__admit-check'`. */
			admitCheckPath?: string;
			/** Base seconds for the jittered Retry-After. Default derived from `pollIntervalMs`. */
			retryAfterSeconds?: number;
			/** Page poll cadence in ms. Default `2000`. */
			pollIntervalMs?: number;
			/**
			 * Optional application name shown above the capacity message and in
			 * the document title. HTML-escaped before rendering.
			 */
			appName?: string;
			/**
			 * Optional service-status URL: relative, or `http`, `https`,
			 * `mailto`, `tel`. Rendered as a neutral "Service status" link,
			 * trimmed and HTML-escaped. Any other scheme renders no link.
			 */
			statusUrl?: string;
			/**
			 * Optional help URL: relative, or `http`, `https`, `mailto`,
			 * `tel`. Rendered as a neutral "Get help" link, trimmed and
			 * HTML-escaped. Any other scheme renders no link.
			 */
			supportUrl?: string;
			/** Optional incident reference shown as escaped text. */
			incidentId?: string;
			/**
			 * Module path for locale-aware per-request rendering. The module must
			 * synchronously default-export a `WaitingRoomRenderer` (a named
			 * `renderWaitingRoom` export is also accepted). It receives a safe
			 * request facade with URL, method, and `headers.get(name)`, plus the
			 * live waiting-room context. Return a full HTML document, BCP 47
			 * `lang`, `dir`, and optional response headers. The adapter makes
			 * `lang`/`dir` authoritative on `<html>`, writes
			 * `Content-Language`, and writes `Vary: Accept-Language`.
			 *
			 * This is a build-serializable module path, not a live function.
			 * Mutually exclusive with `template`.
			 *
			 * @example
			 * ```js
			 * // svelte.config.js
			 * waitingRoom: { renderer: './src/lib/server/waiting-room.js' }
			 *
			 * // waiting-room.js
			 * export function renderWaitingRoom({ request }) {
			 *   const german = request.headers.get('accept-language')?.startsWith('de');
			 *   return {
			 *     body: '<!doctype html><html><head><title>...</title></head><body>' +
			 *       '<main><h1>...</h1><p role="status" aria-live="polite">...</p>' +
			 *       '<form method="get"><button>Try again</button></form></main></body></html>',
			 *     lang: german ? 'de' : 'en',
			 *     dir: 'ltr',
			 *     headers: { 'content-security-policy': "default-src 'none'" }
			 *   };
			 * }
			 * ```
			 */
			renderer?: string;
			/**
			 * Override the built-in holding page with a full HTML document. It must
			 * satisfy `AccessibleWaitingDocument`: doctype, valid `html[lang]`
			 * and `html[dir]`, a non-empty title and body, exposed main
			 * landmark and non-empty status live region, plus an exposed enabled
			 * named recovery control or non-empty safe link. The adapter validates this
			 * at construction.
			 * This is
			 * a string (not a function): adapter options are serialized into the
			 * build, so a function could never reach the production runtime. The
			 * following `{{tokens}}` are substituted with the live, escaped values:
			 * `{{queueDepth}}`, `{{estimatedSeconds}}`, `{{pollIntervalMs}}`,
			 * `{{retryAfterSeconds}}`, `{{admitCheckPath}}`, `{{appName}}`,
			 * `{{statusUrl}}`, `{{supportUrl}}`, `{{incidentId}}`. Include your
			 * own poll script (hitting `{{admitCheckPath}}`) if you want
			 * auto-reload; the
			 * built-in page is recommended for that behaviour. Templates are
			 * compiled when the adapter is configured: an unknown token or unclosed
			 * `{{` throws with the supported-token list. Repeat supported tokens as
			 * needed. Write `{{{{token}}}}` to emit literal `{{token}}` text.
			 *
			 * @example
			 * ```js
			 * template: '<!doctype html><html lang="en" dir="ltr"><head>' +
			 *   '<title>Please wait</title></head><body><main><h1>Server at capacity</h1>' +
			 *   '<p role="status" aria-live="polite" aria-atomic="true">' +
			 *   'About {{queueDepth}} browsers are waiting.</p>' +
			 *   '<form method="get"><button type="submit">Try again</button></form>' +
			 *   '</main></body></html>'
			 * ```
			 */
			template?: string;
		};
	};

	/**
	 * Graduated protection posture over the live `platform.pressure` signal,
	 * governing only the admission of NEW upgrades - existing connections are
	 * never affected at any level.
	 *
	 * - `'normal'` (default): today's behaviour. The posture machine is inert
	 *   and adds no work to the hot path.
	 * - `'auto'`: the adapter escalates under sustained pressure and relaxes on
	 *   recovery (escalate fast, relax slow). `normal -> elevated` on sustained
	 *   `pressure.active`; `elevated -> siege` when over-capacity upgrade
	 *   rejects run at twice the gate's admit rate; downward needs a longer
	 *   quiet dwell.
	 * - `'elevated'` / `'siege'`: pin a level for incident response or testing.
	 *
	 * At `'elevated'` every refusal widens its `Retry-After` jitter. At
	 * `'siege'` new upgrades are refused at static-serve cost and
	 * `/__admit-check` always reports busy. Requires
	 * `upgradeAdmission.maxConcurrent` or `upgradeAdmission.maxConnections`
	 * to be set for the gate to have anything
	 * to coordinate; `'auto'` is inert without a ceiling.
	 */
	protection?: 'normal' | 'elevated' | 'siege' | 'auto';

	/**
	 * Prometheus-style registry for admission and posture observability.
	 * Off by default; when set, the adapter registers and emits:
	 *
	 * - `http_requests_total{method,outcome}` - completed HTTP requests
	 *   (counter), with a bounded verb and success/client-error/server-error/
	 *   aborted outcome.
	 * - `http_request_duration_seconds{method,outcome}` - HTTP completion
	 *   duration (histogram with explicit fractional-second buckets).
	 * - `upgrade_admitted_total` - upgrades accepted (counter).
	 * - `upgrade_rejected_total{reason}` - upgrades rejected before open
	 *   (counter). Reasons, in the order the upgrade path can reach them:
	 *   `siege`, `over_capacity`, `cursor_lane`, `connection_capacity`,
	 *   `duplicate_header` (a
	 *   repeated `Host` / `Origin` / `Authorization` / framing header, which
	 *   cannot be given one reading), `ip_rate_limit`, `bad_origin`,
	 *   `deferred_overflow`,
	 *   `auth_timeout`, `auth_rejected`, `hook_error`. One more reason,
	 *   `auth_rate_limit`, is emitted on the `connect({ auth: true })`
	 *   preflight POST rather than on an upgrade - it shares this counter
	 *   because it refuses the same client at the door in front of the
	 *   handshake. That preflight also refuses a repeated framing header
	 *   with a `400`, and THAT rejection is not counted on any series, so a
	 *   dashboard built on this counter sees duplicate-header refusals from
	 *   the upgrade path only.
	 * - `upgrade_duration_seconds{outcome}` - admit/reject/abort/error decision
	 *   duration (histogram with explicit seconds-valued buckets).
	 * - `upgrade_inflight` - upgrades between admission and open (gauge,
	 *   sampled once per pressure interval).
	 * - `upgrade_deferred_depth` - callbacks retained by the bounded pacing
	 *   queue (gauge).
	 * - `upgrade_deferred_oldest_age_seconds` - live age of the oldest retained
	 *   callback (gauge).
	 * - `upgrade_deferred_rejected_total` - callbacks shed because that finite
	 *   queue was full (counter).
	 * - `ws_connection_headroom` - remaining reserved-or-live connection
	 *   permits (gauge). Registered only when `maxConnections` is enabled
	 *   and updated on each permit acquire/release.
	 * - `waiting_room_queue_depth` - clients polling the waiting room
	 *   (gauge, sampled; `0` when the room is off).
	 * - `protection_posture_state` - `0` normal / `1` elevated / `2` siege
	 *   (gauge, sampled).
	 * - `protection_posture_transitions_total{from,to}` - posture level
	 *   changes (counter).
	 * - `framework_assertion_violations_total{category,severity}` - framework
	 *   invariant violations, mirroring the queryable `platform.assertions`
	 *   Map. `severity` is `soft` (a recoverable `assert`) or `fatal` (a
	 *   hard-tier termination). Category cardinality is bounded by the
	 *   source-declared categories (counter).
	 * - `upgrade_rate_map_evicted_total{door}` - rate-limit entries evicted at
	 *   the map cap; `door` is `upgrade` or `auth` (counter).
	 * - `ws_connections` - live WebSocket connections on this worker (gauge,
	 *   sampled).
	 * - `ws_connection_duration_seconds{outcome}` - clean/abnormal connection
	 *   lifetime (histogram).
	 * - `ws_messages_total{kind,outcome}` - completed inbound text/binary
	 *   messages by success/error outcome (counter).
	 * - `ws_message_admission_rejected_total{reason,scope}` - application
	 *   messages shed by the established-message rate/concurrency/queue gate.
	 * - `ws_message_duration_seconds{kind,outcome}` - awaited inbound handler
	 *   duration (histogram with explicit fractional-second buckets).
	 * - `ws_subscriptions` - live topic subscriptions across this worker's
	 *   connections (gauge, sampled). Divide by `ws_connections` for the
	 *   subscriber ratio; the two are exported separately because averaging
	 *   per-worker ratios is not the cluster ratio.
	 * - `ws_publishes_total` - publish calls on this worker (counter). Counts
	 *   publishes, never per-recipient deliveries: uWS fans out in C++.
	 * - `ws_publish_outcomes_total{outcome}` - native TopicTree publish calls
	 *   classified as delivered/no-subscribers (counter), with no recipient walk.
	 * - `ws_backpressure_max_bytes` - worst per-connection outbound buffered
	 *   bytes over the sampled connection set (gauge, sampled; `0` when healthy).
	 * - `ws_backpressure_connections` - sampled connections holding a
	 *   backpressured outbound queue (gauge, sampled; `0` when healthy).
	 * - `ws_dropped_frames_total` - exact outbound frames uWS shed at the
	 *   configured backpressure limit (counter).
	 * - `ws_dropped_bytes_total` - exact payload bytes in those shed frames
	 *   (counter, bytes).
	 * - `egress_refused_total{scope}` - publishes refused pre-hoc by a
	 *   configured `websocket.egress` ceiling (counter); nothing was
	 *   delivered, relayed, or sequence-stamped for them. `scope` is `topic`
	 *   or `tenant`.
	 * - `egress_window_evicted_total{scope}` - live usage windows dropped at
	 *   the egress ledger's key cap (counter). Each one stops enforcing that
	 *   key's ceiling for the rest of its window, and the symptom is FEWER
	 *   refusals, so a non-zero rate here is what distinguishes a budget that
	 *   has run out of ledger room from traffic that simply fits.
	 * - `pressure_saturation` - worker saturation, `0` healthy to `1` at the
	 *   configured thresholds (gauge, sampled).
	 * - `pressure_reason` - the live pressure reason as a severity-ordered
	 *   code: `0` none, `1` subscribers, `2` publish rate, `3` psi, `4` cpu
	 *   quota, `5` capacity, `6` memory (gauge, sampled).
	 * - `pressure_reason_transitions_total{from,to}` - pressure reason changes,
	 *   including incident entry and recovery (counter). Both labels use the
	 *   bounded reason vocabulary, so brief incidents remain visible without
	 *   introducing unbounded cardinality.
	 * - `pressure_sample_timestamp_seconds` - unix time of the most recent
	 *   completed pressure sample (gauge). The sampling timer is `unref`'d; if
	 *   it stops, every sampled gauge above keeps serving its last value while
	 *   the target still reads up. Alert on this timestamp's age.
	 * - `resident_memory_bytes` - process RSS (gauge, sampled). Worker threads
	 *   share one address space, so every worker reports the same value.
	 * - `heap_used_ratio` - used fraction of this worker isolate's V8 heap
	 *   (gauge, sampled). Per-isolate, so each worker has its own.
	 * - `psi_cpu_some_avg10`, `psi_memory_full_avg10`, `psi_io_full_avg10` -
	 *   kernel pressure-stall readings (gauges, sampled). Registered only when
	 *   the startup probe finds PSI; a later transient read failure writes `NaN`
	 *   instead of serving a stale reading beside a fresh sample timestamp.
	 * - `cpu_throttled_ratio` - fraction of the sampled window the cgroup CPU
	 *   quota held the process suspended (gauge, sampled). Same startup-probe and
	 *   transient-`NaN` semantics as the PSI gauges.
	 * - `open_fds` / `fd_soft_limit` - open descriptors and the soft limit
	 *   (gauges, sampled every ~5 pressure intervals). Registered only where
	 *   the source exists (Linux, macOS). Whole-process values: every worker
	 *   reports the same number.
	 * - `state_divergence_total{role}` - cross-worker state-hash divergence
	 *   detections; `role` is `majority` or `minority` (counter). Structure-only
	 *   hash, so no topic strings and no client identity.
	 * - `relay_gap_frames_total` - relayed frames proven lost to this worker
	 *   (counter). Counts frames, not incidents; a lower bound.
	 * - `relay_spill_quarantines_total{reason}` - lagging relay peers quarantined
	 *   at the finite pending-byte or pending-age ceiling (`bytes` or `age`).
	 * - `relay_spill_dropped_bytes_total` - pending relay bytes discarded at
	 *   quarantine (counter).
	 * - `relay_spill_pending_age_seconds` - worst oldest-pending age observed by
	 *   the reporting worker at quarantine (gauge). Measured from the peer's
	 *   last drain progress, so it reads "stopped draining", not "behind".
	 * - `relay_frame_refused_total{lane}` - publishes refused by the sender-side
	 *   relay frame ceiling; local subscribers still received them (counter).
	 *   `lane` is `publish` or `batched`.
	 * - `relay_frame_oversized_total` - relay frames the primary refused to
	 *   reassemble at the reader ceiling, attributed once to a surviving
	 *   worker's registry (counter).
	 * - `framework_resource_growth_suspected_total{resource}` - sustained-growth
	 *   suspicions from the optional resource-growth auditor (counter).
	 *   Registered only when `resourceGrowthAuditIntervalMs` is set.
	 *
	 * Every metric declares how it combines across worker threads. That law is
	 * executed, not merely documented: `platform.metricsSnapshot()` merges the
	 * cluster with it. See the README metrics table for the per-metric column.
	 *
	 * With metrics enabled, transport completion wrappers read a monotonic
	 * timer and emit bounded-label counters/histograms; gauges ride the existing
	 * pressure sampler. With the option unset the original handlers are
	 * registered unchanged and native publish sites make only a null-hook check:
	 * no timer, label, request closure, WeakMap entry, or recipient walk. A registry built with
	 * `createMetrics({ prefix: 'app_' })` prefixes its own `serialize()` output;
	 * `platform.metricsSnapshot()` deliberately stays on canonical, unprefixed
	 * manifest names so its merge law is independent of registry rendering.
	 * No client identity (IP, session) ever appears in a label.
	 *
	 * The two counters record server decisions, not client behaviour: a
	 * client that disconnects mid-upgrade is counted in neither, so their
	 * sum can read below a load balancer's attempt count under flappy
	 * clients. Instrument failures are contained - a registry that throws
	 * on emit logs once and is silenced, never disturbing the upgrade path
	 * or the sampler - while a registry that throws during instrument
	 * creation fails at startup, loudly.
	 *
	 * This is a **module path** (like `handler`), not a live object: adapter
	 * options are serialized into the build, so a registry constructed in
	 * `svelte.config.js` could never reach the production runtime. Point it at a
	 * module whose default export (or a named `metrics` / `registry` export) is
	 * the registry; the adapter populates it and exposes it on
	 * `platform.metrics`.
	 *
	 * **One instance, with the Vite plugin.** With the adapter's Vite plugin in
	 * `vite.config.js` (`import uws from 'svelte-adapter-uws/vite'` - the
	 * standard setup, it also provides dev WebSockets), the registry is bundled
	 * into the app's own server graph and deduplicated with every route that
	 * imports it, so `platform.metrics` and a direct
	 * `import { metrics } from '$lib/server/metrics.js'` read the SAME
	 * instance and either read point works. Without the plugin the adapter
	 * falls back to a standalone bundle, which instantiates the module a
	 * second time: adapter counters then land on a copy that only
	 * `platform.metrics` can reach, a direct app-graph import reads the other,
	 * empty copy, and any module-level side effect runs twice per process. The
	 * build warns when it takes that fallback.
	 *
	 * @example
	 * ```js
	 * // src/lib/server/metrics.js
	 * import { createMetrics } from 'svelte-adapter-uws-extensions/prometheus';
	 * export const metrics = createMetrics();
	 *
	 * // svelte.config.js
	 * adapter({
	 *   websocket: {
	 *     upgradeAdmission: { maxConcurrent: 1000, maxConnections: 50000 },
	 *     protection: 'auto',
	 *     metrics: './src/lib/server/metrics.js'
	 *   }
	 * });
	 *
	 * // src/routes/metrics/+server.js
	 * export const GET = ({ platform }) =>
	 *   new Response(platform.metrics.serialize(), {
	 *     headers: { 'content-type': 'text/plain; version=0.0.4' }
	 *   });
	 * ```
	 */
	metrics?: string;

	/**
	 * Module path to a primary-thread init hook that runs ONCE, in the primary
	 * thread, before any worker spawns (clustered mode only). Use it to allocate
	 * cross-worker shared memory - a `SharedArrayBuffer`, SPSC/MPSC rings, a
	 * `MessagePort` - that every worker then receives, same references, no race.
	 *
	 * This is a **module path** (like `metrics`), not a live function: adapter
	 * options are serialized into the build, so a function written in
	 * `svelte.config.js` could never reach the production runtime. Point it at a
	 * module whose default export (or a named `primaryInit` export) is
	 * `({ env }) => any`. The return value is attached to every worker's
	 * `workerData` and surfaced to the `init` hook as `workerData`; it is replayed
	 * IDENTICALLY when a crashed worker is respawned (a fresh buffer would be a
	 * different world). The module is bundled as its own isolated entry, so the
	 * primary loads only it - never the app graph - and a top-level side effect in
	 * `hooks.ws` never runs in the supervisor.
	 *
	 * No effect in single-process mode (there is no primary thread and nothing to
	 * share memory with). Pairs with `workers` for dedicated compute workers.
	 *
	 * @example
	 * ```js
	 * // src/lib/server/cluster.js
	 * export default function primaryInit({ env }) {
	 *   const world = new SharedArrayBuffer(WORLD_BYTES);
	 *   return { world };   // -> every worker's init({ workerData }) sees the same buffer
	 * }
	 *
	 * // svelte.config.js
	 * adapter({ websocket: { primaryInit: './src/lib/server/cluster.js', workers: { compute: 2 } } });
	 *
	 * // src/hooks.ws.js
	 * export function init({ platform, workerData }) {
	 *   const view = new Int32Array(workerData.world);
	 *   // ...drive the shared world
	 * }
	 * ```
	 */
	primaryInit?: string;

	/**
	 * Worker roles for a clustered deployment. Splits the `CLUSTER_WORKERS` pool
	 * (or `'auto'` = CPU count) into I/O workers (listen + serve connections) and
	 * dedicated compute workers that NEVER bind a listen socket - so a
	 * latency-critical tick loop pays no connection-I/O jitter - while staying
	 * under the same unified lifecycle (drain, crash-respawn with identical
	 * `workerData`, heartbeat, metrics).
	 *
	 * `compute` is how many of the total workers are compute workers; I/O workers
	 * = total - compute. A compute worker fires the `init` hook (receiving the
	 * `primaryInit` shared memory via `workerData`) and runs entirely app-driven.
	 * `compute` must be less than the total worker count.
	 *
	 * No effect in single-process mode. Requires `CLUSTER_WORKERS` to be set for
	 * the cluster to exist at all.
	 *
	 * @default { compute: 0 }
	 * @example
	 * ```js
	 * // 12 total workers: 6 serve connections, 6 run the shared-memory sim
	 * // CLUSTER_WORKERS=12 node build
	 * adapter({ websocket: { primaryInit: './src/lib/server/cluster.js', workers: { compute: 6 } } });
	 * ```
	 */
	workers?: {
		/** How many of the `CLUSTER_WORKERS` total are dedicated compute workers (no listen socket). Must be < total. @default 0 */
		compute?: number;
	};

	/**
	 * Interval in milliseconds for the cross-worker state-hash reporter
	 * (clustered mode only). When greater than `0`, each worker periodically
	 * folds a structure-only projection of its per-topic delivered-sequence
	 * map into a single 32-bit hash and reports it to the primary, which
	 * compares the live workers' hashes per primary-assigned epoch and logs a
	 * `state-divergence` event (and increments the `state_divergence_total`
	 * metric when a `metrics` registry is configured) if they disagree at rest.
	 *
	 * Divergence means a publish that reached some workers did not reach
	 * another - a relay drop, partial fan-out, or a frame one worker failed to
	 * apply - which a single-worker deployment can never have. Only the integer
	 * hash and the worker's thread id cross the thread boundary: no topic
	 * strings, no payloads, no client identity.
	 *
	 * Off by default (`0`): no reporter timer is scheduled and the path costs
	 * nothing. In single-process mode the reporter never runs regardless of
	 * this value (there are no other workers to compare against). The detection
	 * is observe-only; the optional auto-restart of a diverged worker is a
	 * separate primary-level switch (`RESTART_ON_STATE_DIVERGENCE=1`) that
	 * defaults off. `30000` (30s) is a sensible enabled value.
	 *
	 * @default 0 (disabled)
	 */
	stateHashIntervalMs?: number;

	/**
	 * Interval in milliseconds for the per-worker consistency auditor - a
	 * background safety net that runs the framework's structural invariant
	 * predicates against a bounded, structure-only snapshot of the worker's live
	 * connections on a slow, jittered, unref'd timer.
	 *
	 * It runs OFF the hot path: publish, send, subscribe, and close pay nothing;
	 * the only cost is reading state the worker already maintains, on a timer
	 * that never holds the event loop open. The snapshot is bounded - a fixed
	 * slice of connections per tick, walked round-robin - so a worker with a
	 * million connections audits a constant amount of work each tick regardless
	 * of population, and the snapshot carries no payloads, no topic strings, and
	 * no client identity beyond the per-connection session id used as a log
	 * label.
	 *
	 * A detected violation logs a package-attributed `[lantean/diagnostic ...]` line and
	 * increments the queryable `platform.assertions` counter (the soft tier) - it
	 * never terminates the worker. The single exception is a subscription slot
	 * that has become a non-`Set` (heap or dispatch corruption that cannot heal):
	 * if it persists across two consecutive audits, it escalates to a deferred
	 * worker restart (exit code 78). A healthy or transient state is never killed.
	 *
	 * On by default at `5000` (5s). Set to `0` to disable entirely - no timer is
	 * scheduled and the path costs nothing. Unlike `stateHashIntervalMs`, this
	 * runs in single-process AND clustered deployments alike (it is a per-worker
	 * net, not a cross-worker comparison).
	 *
	 * @default 5000
	 */
	consistencyAuditIntervalMs?: number;

	/**
	 * Interval in milliseconds for the optional per-worker resource-growth
	 * auditor - a background trend detector that samples the SIZE of the live
	 * bookkeeping collections (connections, topic index, caches) on a slow,
	 * jittered, unref'd timer and flags a series that climbs monotonically, the
	 * signature of a close / unsubscribe / eviction path that stopped shedding.
	 * It reads only Map/Set sizes, never a monotonic-by-design counter.
	 *
	 * OBSERVE-ONLY: a suspected trend increments the
	 * `framework_resource_growth_suspected_total{resource}` metric and logs at
	 * most one throttled warning per worker; it NEVER asserts, throws, or
	 * terminates. Distinct from `consistencyAuditIntervalMs`, which checks
	 * point-in-time invariants rather than a time-series trend.
	 *
	 * Off by default (`0` - no timer is scheduled and the path costs nothing),
	 * because a trend signal is probabilistic; the always-on structural guard is
	 * the deterministic simulator (`svelte-adapter-uws/sim`), not production.
	 * `30000` (30s) is a sensible enabled value.
	 *
	 * @default 0 (disabled)
	 */
	resourceGrowthAuditIntervalMs?: number;

	/**
	 * Backpressure-signal thresholds for `platform.pressure` and
	 * `platform.onPressure(cb)`. The adapter samples the worker once per
	 * `sampleIntervalMs` and reports the most urgent active signal.
	 *
	 * Any individual threshold may be set to `false` to disable that
	 * signal entirely. The defaults are conservative: a small healthy app
	 * should never trip them in steady state.
	 *
	 * @example
	 * ```js
	 * adapter({
	 *   websocket: {
	 *     pressure: {
	 *       memoryHeapUsedRatio: 0.9,
	 *       publishRatePerSec: 50000,
	 *       subscriberRatio: false  // disable this signal
	 *     }
	 *   }
	 * });
	 * ```
	 */
	pressure?: {
		/**
		 * Trigger `'MEMORY'` pressure when `process.memoryUsage().heapUsed
		 * / heapTotal` is greater than or equal to this ratio (0 to 1).
		 *
		 * Memory has the highest precedence: a worker approaching OOM
		 * reports `'MEMORY'` even if publish rate or fan-out are also
		 * elevated.
		 *
		 * Set to `false` to disable.
		 *
		 * @default 0.85
		 */
		memoryHeapUsedRatio?: number | false;

		/**
		 * Trigger `'PUBLISH_RATE'` pressure when `platform.publish()`
		 * calls per second on this worker reach this value.
		 *
		 * Set to `false` to disable.
		 *
		 * @default 10000
		 */
		publishRatePerSec?: number | false;

		/**
		 * Trigger `'SUBSCRIBERS'` pressure when the average number of
		 * subscriptions per active connection (total subscriptions /
		 * connections, on the local worker) reaches this value.
		 *
		 * High fan-out per connection means each `publish()` does heavy
		 * work; this signal lets a multi-tenant deployment shed
		 * background streams before broadcast latency climbs.
		 *
		 * Set to `false` to disable.
		 *
		 * @default 50
		 */
		subscriberRatio?: number | false;

		/**
		 * Sample interval in milliseconds. Must be a number of at least
		 * 100 ms - the floor that prevents pathological tight-loop
		 * sampling - and no greater than `2147483647` (Node stores a
		 * timer delay in a signed 32-bit integer, and a larger delay
		 * overflows to fire every millisecond). The build refuses
		 * anything outside those bounds or misshaped rather than
		 * silently running at the default cadence.
		 *
		 * @default 1000
		 */
		sampleIntervalMs?: number;

		/**
		 * Per-topic message-rate threshold for runaway-publisher detection.
		 * When a topic crosses this value in a sample window the
		 * `onPublishRate` callback fires (or a throttled `console.warn`
		 * does, by default). Independent of the aggregate
		 * `publishRatePerSec` signal - this one names the offender.
		 *
		 * Set to `false` to disable per-topic message-rate detection.
		 *
		 * @default 5000
		 */
		topicPublishRatePerSec?: number | false;

		/**
		 * Per-topic byte-rate threshold for runaway-publisher detection.
		 * When a topic's outgoing bytes per second cross this value the
		 * same surface fires as `topicPublishRatePerSec`.
		 *
		 * The rate is measured in UTF-16 code units of the JSON envelope,
		 * which equals bytes for ASCII envelopes; a heavily non-ASCII
		 * payload reads up to 3x under its UTF-8 wire size. The unit is
		 * deliberate: this is an advisory detection signal, and an exact
		 * byte count would put an O(length) encode on every publish. The
		 * `egress` ceilings - which refuse rather than warn - charge real
		 * wire bytes.
		 *
		 * Set to `false` to disable per-topic byte-rate detection.
		 *
		 * @default 10485760 (10 MB/s)
		 */
		topicPublishBytesPerSec?: number | false;

		/**
		 * Trigger `'PSI'` pressure when the kernel's cpu `some` avg10 stall
		 * percentage (`/proc/pressure/cpu`) reaches this value - the share of
		 * the last 10s in which at least one runnable task waited for a CPU.
		 * Active only on a PSI-enabled Linux kernel; elsewhere the source is
		 * absent and this signal never fires. Set to `false` to disable.
		 *
		 * @default 60
		 */
		psiCpuSome?: number | false;

		/**
		 * Trigger `'PSI'` pressure when the kernel's memory `full` avg10
		 * stall percentage (`/proc/pressure/memory`) reaches this value -
		 * time in which every non-idle task stalled on memory at once
		 * (thrash), which fires meaningfully earlier than an OOM-adjacent
		 * heap ratio. Set to `false` to disable.
		 *
		 * @default 15
		 */
		psiMemoryFull?: number | false;

		/**
		 * Trigger `'PSI'` pressure when the kernel's io `full` avg10 stall
		 * percentage (`/proc/pressure/io`) reaches this value. Set to
		 * `false` to disable.
		 *
		 * @default 50
		 */
		psiIoFull?: number | false;

		/**
		 * Trigger `'CPU_QUOTA'` pressure when the container's CFS quota held
		 * the process suspended for at least this fraction of the sample
		 * window (from cgroup `cpu.stat` throttled-time deltas; v1 and v2
		 * layouts both supported). A quota-throttled worker is not merely
		 * contended - it is periodically STOPPED - so this is a distinct,
		 * higher-precedence signal than PSI. Active only inside a
		 * quota-limited cgroup. Set to `false` to disable.
		 *
		 * @default 0.25
		 */
		cpuThrottledRatio?: number | false;
	};

	/**
	 * Posture push-export (opt-in): listen on a local stream socket (a unix
	 * domain socket path, or a `\\.\pipe\...` named pipe on Windows) and push
	 * the live protection posture as newline-delimited JSON -
	 * `{"v":1,"posture":"elevated","reason":"PSI","value":0.83,"psi":{...},"cpuThrottle":{...}}` -
	 * to every connected consumer: once on connect, once on every posture or
	 * reason transition, and once per 1 Hz pressure sample (the steady cadence
	 * doubles as a liveness signal - silence means the adapter is gone). Built
	 * for an external edge-defense daemon or watchdog that wants the app's
	 * load state without speaking its protocol. Local-only and payload-free.
	 *
	 * @example
	 * ```js
	 * adapter({ websocket: { postureExport: '/run/app/posture.sock' } });
	 * ```
	 */
	postureExport?: string | { path: string } | false;

	// - Security and policy opt-ins -------------------------------------------

	/**
	 * Allow wire-level subscribes to `__`-prefixed topics. Default `false`:
	 * the server rejects any `subscribe` / `subscribe-batch` whose topic
	 * starts with `__` (those are framework-internal channels for signals,
	 * presence, replay, etc.). Set `true` only for advanced apps that
	 * intentionally route public topics through the `__` prefix.
	 *
	 * Server-side `platform.subscribe(ws, '__signal:userId')` and the like
	 * always work because the block is on the wire layer only.
	 *
	 * @default false
	 */
	allowSystemTopicSubscribe?: boolean;

	/**
	 * Require wire-subscribe authorization. Default `false`: standalone, any
	 * connected client may subscribe to any (non-`__`, shape-valid) topic - the
	 * adapter's primitive contract. When `true`, a CLIENT-initiated `subscribe`
	 * / `subscribe-batch` frame is honored only for a topic the server already
	 * authorized for that connection via `platform.subscribe` (recorded in its
	 * subscription set), unless the app exports its own `subscribe` /
	 * `subscribeBatch` hook - in which case that hook decides every topic.
	 * Set `'strict'` for a hybrid framework/app: every topic must already have
	 * a server grant AND the application hook must allow it. This preserves the
	 * legacy `true` contract while preventing a permissive hybrid hook from
	 * bypassing a framework's tenant or room grant.
	 *
	 * This closes the bypass where a client names a topic it was never granted
	 * (a private room, another tenant's channel) and receives its fan-out,
	 * because the server-side guard ran only on the server-initiated subscribe,
	 * not the client's wire frame. Server-side `platform.subscribe` is the
	 * trusted grant-establishing path and is never gated by this.
	 * `platform.checkSubscribe(ws, topic, { requireGrant: true })` - the gate
	 * `presence.sync` and `cursor.snapshot` run - honors the same grant model
	 * once armed: the topic must be in the connection's grant set AND pass the
	 * hook chain, so those snapshot lanes cannot bypass tenant isolation
	 * either. (`presence.join` is invoked by the app from its own already
	 * gated subscribe path and is not covered by this.) A framework whose subscriptions
	 * are all server-initiated (svelte-realtime) arms this automatically via
	 * `platform.authorizeWireSubscribe()`; direct adapter apps set it here.
	 * The Vite dev server has a separate, flat option bag: repeat this as
	 * `uws({ authorizeWireSubscribe: true })` in `vite.config.js`. Security flags
	 * are not copied from `svelte.config.js` into the already-created dev plugin.
	 *
	 * @default false
	 */
	authorizeWireSubscribe?: boolean | 'strict';

	/**
	 * Allow non-ASCII characters in wire-submitted topic names. Default
	 * `false`: only printable ASCII (0x20-0x7E) excluding `"` and `\` is
	 * accepted, blocking line separators (U+2028/U+2029), bidirectional
	 * overrides (U+202E), the byte-order mark, and other surprise runes
	 * that survive the wire and confuse log dashboards / admin UIs.
	 *
	 * Always-illegal `"` and `\` remain rejected even with this set.
	 *
	 * @default false
	 */
	allowNonAsciiTopics?: boolean;

	/**
	 * Require an `Origin`-equivalent header on the `/__ws/auth` POST
	 * endpoint (CSRF defense). When `true`, the request must satisfy at
	 * least one of: `x-requested-with: XMLHttpRequest`, `Sec-Fetch-Site:
	 * same-origin`, or an `Origin` header matching `allowedOrigins`. The
	 * adapter client always stamps `x-requested-with` so the browser path
	 * is unaffected.
	 *
	 * Set `false` to accept native (non-browser) clients without those
	 * headers.
	 *
	 * @default true
	 */
	authPathRequireOrigin?: boolean;

	/**
	 * Apply dynamic brotli/gzip compression to responses for credentialed
	 * requests (those carrying `Cookie` or `Authorization`). Default
	 * `false` defends against the [BREACH](https://en.wikipedia.org/wiki/BREACH)
	 * attack (compressed length leaks attacker-influenced reflected
	 * input alongside a secret in the page body).
	 *
	 * Set `true` only after auditing the page surface for BREACH
	 * defenses (random per-response masking, prefix randomization, no
	 * secrets reflected with attacker input). Build-time precompressed
	 * static files are unaffected.
	 *
	 * @default false
	 */
	compressCredentialedResponses?: boolean;

	/**
	 * Restore the previous warn-only behavior when `allowedOrigins:
	 * 'same-origin'` is paired with no fronting trust (no `ORIGIN` env,
	 * no `HOST_HEADER` env, no native TLS, no `upgrade()` hook). Default
	 * `false`: the runtime throws at startup because the same-origin
	 * check then compares two attacker-controlled headers.
	 *
	 * Set `true` only when the deployment context has been independently
	 * audited; pin the deployment shape first (`ORIGIN`, `HOST_HEADER`,
	 * native TLS, or an `upgrade()` hook).
	 *
	 * @default false
	 */
	unsafeSameOriginWithoutHostPin?: boolean;
}

// - User's WebSocket handler module exports ---------------------------------

/**
 * Options accepted by `authenticateCookies.set()` and `.delete()`. Matches the
 * shape SvelteKit uses for `cookies.set()`.
 */
export interface CookieSerializeOptions {
	/** Required by `authenticateCookies.set()` and `.delete()`. */
	path: string;
	domain?: string;
	expires?: Date;
	/** In seconds. */
	maxAge?: number;
	/** Defaults to `true`. */
	httpOnly?: boolean;
	/** Defaults to `true`, except on plain HTTP at `localhost`. */
	secure?: boolean;
	partitioned?: boolean;
	/** Defaults to `'lax'`. Set to `false` to omit the attribute. */
	sameSite?: 'strict' | 'lax' | 'none' | boolean;
	/** Defaults to `true`. Set to `false` to skip URI-encoding the value. */
	encode?: boolean;
}

/**
 * SvelteKit-like cookies API available inside the `authenticate` hook.
 * Mutations via `.set()` and `.delete()` become `Set-Cookie` headers on the
 * HTTP response returned from the endpoint.
 */
export interface AuthenticateCookies {
	get(name: string): string | undefined;
	getAll(): Record<string, string>;
	set(name: string, value: string, options: CookieSerializeOptions): void;
	delete(name: string, options: CookieSerializeOptions): void;
}

/**
 * Live context passed to a custom `waitingRoom.template`. All numeric fields
 * are UX estimates surfaced for the holding page, never an admission input.
 */
export interface WaitingRoomContext {
	/** Polls seen in the last poll interval (a UX estimate, not an admission input). */
	queueDepth: number;
	/** Rolling drain-rate estimate in seconds (a UX estimate). */
	estimatedSeconds: number;
	/** Configured page poll cadence in ms. */
	pollIntervalMs: number;
	/** Configured base for the jittered Retry-After in seconds. */
	retryAfterSeconds: number;
	/** The poll endpoint path the page should fetch. */
	admitCheckPath: string;
	/** Configured application name, or an empty string when omitted. */
	appName: string;
	/** Configured service-status URL, or an empty string when omitted. */
	statusUrl: string;
	/** Configured support URL, or an empty string when omitted. */
	supportUrl: string;
	/** Configured incident reference, or an empty string when omitted. */
	incidentId: string;
}

/** Synchronous request facade passed to a waiting-room renderer module. */
export interface WaitingRoomRequestContext {
	/** Uppercase request method. */
	readonly method: string;
	/** Path plus query string for the holding-page request. */
	readonly url: string;
	/** Case-insensitive request-header lookup; absent headers return `null`. */
	readonly headers: {
		get(name: string): string | null;
	};
}

/** Per-request context passed to a locale-aware waiting-room renderer. */
export interface WaitingRoomRendererContext extends WaitingRoomContext {
	readonly request: WaitingRoomRequestContext;
}

/**
 * One accessible document baseline for every custom waiting path.
 *
 * At runtime `body` is parsed and validated for a doctype; valid
 * `html[lang]` and `html[dir]`; non-empty title and body; exposed main
 * landmark and non-empty status live region; and an exposed enabled named recovery
 * control or non-empty safe link. Comments and hidden, inert, template, script,
 * and style subtrees cannot satisfy the contract. Renderer `lang` and
 * `dir` are authoritative and are applied before that validation.
 */
export interface AccessibleWaitingDocument {
	/**
	 * A full HTML document containing an `<html>` element. This is trusted
	 * application HTML; escape every request/configuration value you interpolate.
	 */
	body: string;
	/** Valid BCP 47 language tag; emitted as `Content-Language` and `html[lang]`. */
	lang: string;
	/** Document direction; emitted as `html[dir]`. */
	dir: 'ltr' | 'rtl' | 'auto';
	/**
	 * Optional extra response headers. Adapter-owned framing, cache, language,
	 * and variation headers cannot be overridden.
	 */
	headers?: Record<string, string>;
}

/** Compatibility name for the document returned by a waiting-room renderer. */
export interface WaitingRoomRendererResult extends AccessibleWaitingDocument {}

/** Synchronous build-bundled renderer for a localized waiting-room document. */
export type WaitingRoomRenderer = (
	context: WaitingRoomRendererContext
) => AccessibleWaitingDocument;

/**
 * Minimal registry contract for the `metrics` option: the subset of a
 * Prometheus-style registry the adapter calls. The `createMetrics()` registry
 * from `svelte-adapter-uws-extensions/prometheus` satisfies it as-is (and
 * owns naming concerns like a global prefix); any object with the same shape
 * works. Registration must be idempotent per name if the registry is shared
 * across consumers.
 */
export interface MetricsRegistry {
	counter(
		name: string,
		help: string,
		labelNames?: string[]
	): {
		/**
		 * Increment the counter. `value` defaults to 1; a registry that ignores it
		 * will under-count any metric the runtime increments in bulk (the relay-gap
		 * counter reports FRAMES lost, not incidents), so implement it.
		 */
		inc(labels?: Record<string, string>, value?: number): void;
	};
	gauge(
		name: string,
		help: string
	): { set(value: number): void };
	/**
	 * Observe a distribution. Optional: the adapter registers no histogram
	 * today, so a registry without this method satisfies the contract and
	 * nothing breaks.
	 *
	 * It is declared because a registry that omits it cannot be TOLD what
	 * buckets to use, and a duration histogram is worthless with the wrong
	 * ones. Bucket bounds are the caller's to choose and are always in the
	 * metric's own unit.
	 *
	 * Unit convention: durations are `seconds`, named with a `_seconds`
	 * suffix, with bucket bounds written as fractions of a second
	 * (`0.001`, `0.005`, `0.01`, ...). Milliseconds are not used in a metric
	 * name or value even where the source clock reports them, so a bound
	 * always reads in the same unit as the sample. Sizes are `bytes` with a
	 * `_bytes` suffix. A histogram of sub-second work whose buckets start at
	 * `1` records every sample in the first bucket and measures nothing.
	 */
	histogram?(
		name: string,
		help: string,
		options?: { labelNames?: string[]; buckets?: number[] }
	): { observe(labels?: Record<string, string>, value?: number): void };
	/**
	 * Render all metrics in Prometheus text exposition format. Present on the
	 * `createMetrics()` registry from `svelte-adapter-uws-extensions/prometheus`;
	 * optional here because the adapter itself only ever calls `counter`/`gauge`.
	 * Read it from a scrape route via `platform.metrics`.
	 *
	 * NOT required for `platform.metricsSnapshot()`, which is built from the
	 * values the adapter wrote rather than from rendered text.
	 */
	serialize?(): string;
}

/**
 * Context passed to the `upgrade` handler.
 */
export interface UpgradeContext {
	/** Request headers (all lowercase keys). */
	headers: Record<string, string>;
	/** Parsed cookies from the Cookie header. */
	cookies: Record<string, string>;
	/** The request URL path, including query string if present (e.g. '/ws?token=abc'). */
	url: string;
	/** Remote IP address. */
	remoteAddress: string;
	/**
	 * Per-connection correlation id. Reads `X-Request-ID` from the upgrade
	 * request when present (sanitized; printable ASCII, max 128 chars), else
	 * a fresh UUID. Stamped once at upgrade and reused for every WS hook on
	 * this connection (`platform.requestId` matches in `open`, `message`,
	 * `subscribe`, `drain`, `close`, etc.).
	 */
	requestId: string;
	/** Validated W3C context active for this upgrade, or null when tracing is disabled. */
	traceContext: TraceContext | null;
}

/**
 * Context passed to the optional `authenticate` handler.
 *
 * `authenticate` runs as a normal HTTP POST before the WebSocket upgrade, so
 * any `Set-Cookie` headers from `cookies.set()` ride on a standard response
 * and work behind every proxy (unlike `Set-Cookie` on the 101 upgrade, which
 * Cloudflare Tunnel and some other strict edge proxies silently drop).
 */
export interface AuthenticateContext {
	/** The incoming request (standard `Request` object, with body). */
	request: Request;
	/** Request headers (all lowercase keys). */
	headers: Record<string, string>;
	/** SvelteKit-like cookies API. Mutations become Set-Cookie on the response. */
	cookies: AuthenticateCookies;
	/** The request URL path, including query string if present. */
	url: string;
	/** Remote IP address (honoring `ADDRESS_HEADER` / `XFF_DEPTH`). */
	remoteAddress: string;
	/** Shorthand for returning `remoteAddress`. Matches the SvelteKit event shape. */
	getClientAddress: () => string;
	/** The platform API (publish, send, topic helpers, etc.). */
	platform: Platform;
}

/**
 * Context passed to `open` and `drain` handlers.
 */
export interface OpenContext {
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Context passed to the `message` handler.
 */
export interface MessageContext {
	/** The raw message data. */
	data: ArrayBuffer;
	/** Whether the message is binary. */
	isBinary: boolean;
	/**
	 * The JSON-parsed envelope, when the adapter parsed the frame for
	 * control-message routing (subscribe / unsubscribe / hello / resume /
	 * reply / subscribe-batch) but no control type matched.
	 *
	 * Plugin-layer JSON envelope dispatchers (e.g. svelte-realtime's
	 * `createMessage({ onJsonMessage })`) consume this directly instead of
	 * re-running `TextDecoder + JSON.parse` on every frame.
	 *
	 * `undefined` when:
	 * - the frame is binary (`isBinary === true`), or
	 * - the frame did not start with `{"ty` (byte[3] !== 0x79), or
	 * - the frame was larger than 8 KiB, or
	 * - `JSON.parse` threw, or
	 * - the parsed value was not a plain object (null / array / primitive).
	 *
	 * The adapter's `websocket.maxPayloadLength` (default 1 MB) is the
	 * structural ceiling for frame size; this field adds no separate cap.
	 */
	msg?: any;
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Context passed to the `close` handler.
 *
 * The `id` / `duration` / `messagesIn` / `messagesOut` / `bytesIn` /
 * `bytesOut` fields are populated only when a `close` hook is exported
 * - the adapter skips the per-connection counter bookkeeping otherwise
 * to keep the hot path zero-cost for stats-uninterested apps.
 */
export interface CloseContext {
	/** The WebSocket close code. */
	code: number;
	/** The close reason (as ArrayBuffer). */
	message: ArrayBuffer;
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
	/**
	 * Topics this connection was subscribed to via the client store's
	 * subscribe/unsubscribe protocol. Does not include topics subscribed
	 * via manual `ws.subscribe()` calls in server hooks.
	 */
	subscriptions: Set<string>;
	/**
	 * Per-connection session id, the same UUID announced to the client
	 * in the `welcome` envelope. Useful for correlating server logs with
	 * a specific socket lifecycle.
	 */
	id?: string;
	/** Connection lifetime in milliseconds (open -> close). */
	duration?: number;
	/** Count of incoming messages from the client over the connection. */
	messagesIn?: number;
	/**
	 * Count of direct outgoing messages to this specific connection
	 * (welcome, subscribe acks, replies, `platform.send`,
	 * `platform.sendCoalesced`, matched `platform.sendTo`).
	 *
	 * Topic-broadcast `platform.publish()` fan-out is **not** counted
	 * because uWS does the dispatch in C++ and per-recipient byte
	 * accounting would defeat the fast path. For aggregate publish-rate
	 * pressure use `platform.pressure.publishRate` instead.
	 */
	messagesOut?: number;
	/** Total bytes received over the connection. */
	bytesIn?: number;
	/** Total bytes sent directly to this connection (same caveat as `messagesOut`). */
	bytesOut?: number;
}

/**
 * Context passed to the `subscribe` handler.
 */
export interface SubscribeContext {
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Canonical reasons for a `subscribe-denied` ack. The `subscribe` hook
 * may return any of these strings, or any other string (forwarded
 * verbatim to the client). The framework also emits `'INVALID_TOPIC'`
 * automatically when a client sends a malformed topic.
 *
 * - `'UNAUTHENTICATED'` - no valid session / user identity.
 * - `'FORBIDDEN'` - user is identified but not authorised for the topic.
 * - `'INVALID_TOPIC'` - topic failed wire-protocol validation
 *   (length / control chars). Emitted by the framework, not the hook.
 * - `'RATE_LIMITED'` - a per-connection subscribe bound tripped. Emitted by
 *   the framework for the landed-subscription cap, and for the in-flight
 *   authorization cap - the count of attempts currently parked in their
 *   (possibly async) hook await; an attempt refused there never reaches the
 *   hook. Hooks may also return it for their own rate policies. Settled
 *   attempts free the in-flight budget, and the stock client re-sends a
 *   topic refused for this reason on a short jittered delay, so the
 *   condition resolves without application code.
 */
export type SubscribeDenialReason =
	| 'UNAUTHENTICATED'
	| 'FORBIDDEN'
	| 'INVALID_TOPIC'
	| 'RATE_LIMITED';

/**
 * The client-driven relay lane (the `game` lane; see `platform.grantPublish`).
 *
 * Client -> server: `{ type: 'game', event, data, id? }`. There is NO
 * client-supplied topic - the server derives it from the connection's publish
 * grant, so a client can never publish to a room it was not granted. `event` is
 * a string; `data` is arbitrary JSON; `id` is an optional client-chosen input
 * id (number or string) echoed to the other receivers for input ordering /
 * prediction-reconcile.
 *
 * Server -> the room (fan-out): the standard `{ topic, event, data, seq }`
 * envelope with `id` echoed when the sender supplied one. The SENDER is excluded
 * (it already holds its own input and predicts locally). `seq` is a monotonic
 * per-room counter stamped by the home worker.
 *
 * Server -> the sender, on an ungranted or malformed frame:
 * `{ type: 'game-denied', reason, id? }` (`id` echoed when present).
 */
export interface GameFrame {
	type: 'game';
	event: string;
	data?: unknown;
	id?: number | string;
}

/**
 * The `game-denied` ack sent back to the SENDER of a rejected `game` frame.
 *
 * - `'FORBIDDEN'` - the connection holds no publish grant (never granted, or
 *   revoked). Grant one with `platform.grantPublish(ws, topic)`.
 * - `'INVALID'` - the connection is granted but the frame was malformed
 *   (a non-string `event`).
 */
export type GameDenialReason = 'FORBIDDEN' | 'INVALID';

export interface GameDeniedFrame {
	type: 'game-denied';
	reason: GameDenialReason;
	id?: number | string;
}

/**
 * Context passed to the `resume` handler.
 *
 * Fired when a reconnecting client presents the session id from its
 * previous connection plus the per-topic seq numbers it last saw. Use
 * this to fill the disconnect gap, typically by calling
 * `replay.replay(ws, topic, sinceSeq, platform)` per entry.
 */
export interface ResumeContext {
	/** Session id the client received in the welcome envelope of its previous connection. */
	sessionId: string;
	/**
	 * Highest seq the client saw per topic before disconnecting. Topics
	 * the client never received a message for are absent. Pass each
	 * `(topic, sinceSeq)` to your replay buffer.
	 */
	lastSeenSeqs: Record<string, number>;
	/**
	 * Generation the client last saw per topic, keyed the same as
	 * `lastSeenSeqs`. Compare each to `platform.topicEpoch(topic)`: on a
	 * match the client's offset is valid and you gap-fill as usual; on a
	 * mismatch the topic's seq space reset since the client last saw it
	 * (a restart, or a per-topic authority bump), so re-read it from the
	 * source of truth instead of replaying a reset space against a stale
	 * offset. Absent (the field omitted on the wire) for a client that
	 * never received an epoch; absence is treated as a match.
	 */
	lastSeenEpochs?: Record<string, number>;
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * A connection's server-resolved attribution: who traffic on this connection
 * is accounted to. Resolved exactly once per connection at open from the
 * handler module's `attribution(user)` export, validated, frozen, and read
 * back via `attribution(ws)` from `svelte-adapter-uws/connection`.
 *
 * Every present field is a string of `[a-zA-Z0-9_-]` with 1-64 characters -
 * the same rule svelte-realtime applies to tenant ids, which also excludes
 * the NUL byte every downstream key delimiter relies on.
 */
export interface Attribution {
	/** The tenant (organization, workspace) this connection belongs to. */
	readonly tenantId?: string;
	/** The principal (user, service identity) inside that tenant. */
	readonly principalId?: string;
	/** An application-defined entitlement label (a billing or quota class). */
	readonly entitlement?: string;
}

/**
 * Shape of the user's WebSocket handler module.
 *
 * Create a file (e.g. `src/lib/server/websocket.js`) and export any
 * of these functions. All are optional - the built-in handler already
 * handles subscribe/unsubscribe for the client store.
 *
 * Every hook receives `(ws, context)` where context always includes `platform`
 * plus any hook-specific fields. This gives you full access to publish, send,
 * and topic helpers directly in your WebSocket hooks.
 *
 * @example
 * ```js
 * // src/hooks.ws.js - auto-discovered, no config needed
 *
 * export function upgrade({ cookies }) {
 *   if (!cookies.session_id) return false; // reject with 401
 *   const user = await validateSession(cookies.session_id);
 *   if (!user) return false;
 *   return { userId: user.id }; // attach data to socket
 * }
 *
 * export function open(ws, { platform }) {
 *   ws.subscribe(`user:${ws.getUserData().userId}`);
 *   platform.topic('users').increment();
 * }
 *
 * export function close(ws, { platform }) {
 *   platform.topic('users').decrement();
 * }
 * ```
 */
export interface WebSocketHandler<UserData = unknown> {
	/**
	 * Optional HTTP preflight that runs before the WebSocket upgrade.
	 *
	 * Recommended for any flow that needs to refresh a session cookie on WS
	 * connect. Returning cookies from this hook goes out via a standard HTTP
	 * response, which works behind every proxy. Setting `Set-Cookie` on the
	 * 101 upgrade response (via `upgradeResponse()`) is silently dropped by
	 * Cloudflare Tunnel and some other strict edge proxies.
	 *
	 * Triggered by the client store via `connect({ auth: true })`, which
	 * POSTs to `/__ws/auth` (configurable via `websocket.authPath`) before
	 * opening every WebSocket - including after reconnects.
	 *
	 * Return values:
	 * - `undefined` / `void` - success, responds 204 with any cookies set via `cookies.set()`.
	 * - `false` - respond 401 Unauthorized.
	 * - `Response` - use the returned response directly; any `cookies.set()` calls are merged in.
	 *
	 * May be async.
	 *
	 * @example
	 * ```js
	 * export function authenticate({ cookies }) {
	 *   const session = validateSessionToken(cookies.get('session'));
	 *   if (!session) return false;
	 *   cookies.set('session', renewSession(session), {
	 *     httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7
	 *   });
	 * }
	 * ```
	 */
	authenticate?: (ctx: AuthenticateContext) =>
		| Response | false | void
		| Promise<Response | false | void>;

	/**
	 * Called once after the listen socket is bound and before any
	 * `upgrade` / `open` / `message` hooks fire. Use this to capture
	 * `platform` at boot time - the canonical entry point for cron
	 * registration, warmup tasks, scheduled metrics dumps, external
	 * pubsub bridge setup, or any "I need platform before the first
	 * connection" pattern.
	 *
	 * Async-allowed. The adapter awaits the returned promise before
	 * `start()` resolves (production) or `createTestServer()` resolves
	 * (test harness). Connections accepted at the kernel level during a
	 * slow async init queue until init resolves - but `open` / `message`
	 * hooks for those queued connections may run concurrently with the
	 * tail of init's execution. For most "capture platform" patterns the
	 * race is harmless (writes are idempotent); use synchronous init or
	 * an app-level ready-gate if strict ordering matters.
	 *
	 * **Per-worker firing in clustered mode.** Each worker process calls
	 * `start()` and fires `init` independently. An app running with N
	 * workers will see N `init` calls - one per worker. Do not assume
	 * singleton semantics; if you need a singleton (e.g. a single cron
	 * publisher across the cluster), layer leader election on top.
	 *
	 * Throws re-throw to the caller: boot failure should be loud. The
	 * `start()` promise rejects, the index.js entrypoint logs it, and the
	 * process crashes - which is the right behavior for a server that
	 * cannot complete its boot work.
	 *
	 * @example
	 * ```js
	 * // hooks.ws.js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * export function init({ platform }) {
	 *   // Capture platform so live.cron can publish without waiting
	 *   // for the first WebSocket connection.
	 *   live.setCronPlatform(platform);
	 * }
	 * ```
	 *
	 * **`workerData`** is whatever the `websocket.primaryInit` module returned,
	 * replayed identically to every worker (and every respawn) - the cross-worker
	 * shared memory (a `SharedArrayBuffer`, rings, a `MessagePort`) seeded once in
	 * the primary thread before any worker spawned. It is `null` in single-process
	 * mode and when no `primaryInit` is configured. A dedicated compute worker
	 * (`websocket.workers.compute`) also fires `init` with `workerData` but never
	 * binds a listen socket.
	 */
	init?: (ctx: { platform: Platform; workerData: any }) => void | Promise<void>;

	/**
	 * Called once during graceful shutdown, before the listen socket is
	 * closed and before existing WebSocket connections are kicked. Use
	 * this for app-level teardown that needs `platform` - cron drain,
	 * last metrics dump, external pubsub bridge teardown, queue flush.
	 *
	 * Async-allowed, and awaited before the listen socket closes - but only
	 * until the shutdown budget is spent. `SHUTDOWN_TIMEOUT` (seconds,
	 * default `30`) bounds the whole shutdown sequence, this hook included:
	 * when it expires the adapter logs that the hook did not settle and
	 * closes anyway. The hook itself is not interrupted (user code cannot
	 * be), it simply stops holding the close path, so work still running
	 * past that point may be lost. `SHUTDOWN_TIMEOUT=0` is the no-budget
	 * spelling: the await is unbounded and a wedged hook holds the process
	 * until something kills it.
	 *
	 * Throws are logged and ignored: shutdown is best-effort and the
	 * adapter cannot refuse to stop. If your teardown is strictly required,
	 * surface its failure via your own logging / alerting before the
	 * adapter logs it.
	 *
	 * The context carries the budget so a hook can honour it rather than be
	 * cut off by it:
	 *
	 * - `reason` - what started the shutdown (`'SIGTERM'`, `'SIGINT'`, or
	 *   `'shutdown'` for a programmatic close).
	 * - `signal` - aborts when the budget is spent, so a flush can stop
	 *   cleanly at a consistent point. `null` when no budget is configured.
	 * - `deadline` - wall-clock epoch ms the budget expires at, to compare
	 *   against your own `Date.now()`. `null` when no budget is configured.
	 *
	 * The three budget fields are OPTIONAL because one surface does not have
	 * them: the `vite dev` plugin fires this hook with `platform` alone. A
	 * dev server has no shutdown budget to report, so read them with a
	 * default (`signal ?? null`) if your hook must also run under dev. The
	 * built server and `createTestServer` both pass all four.
	 *
	 * Per-worker firing in clustered mode, same as `init`. Each worker
	 * fires `shutdown` independently when it receives the shutdown signal.
	 *
	 * @example
	 * ```js
	 * // hooks.ws.js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * export async function shutdown({ platform, signal }) {
	 *   await live.flushPendingCronTicks(platform, { signal });
	 * }
	 * ```
	 */
	shutdown?: (ctx: {
		platform: Platform;
		reason?: string | null;
		signal?: AbortSignal | null;
		deadline?: number | null;
	}) => void | Promise<void>;

	/**
	 * Called during the HTTP upgrade handshake.
	 *
	 * - Return an object to accept - it becomes `ws.getUserData()`.
	 * - Return `false` to reject with 401.
	 * - Omit this export to accept all connections with `{}` as user data.
	 *
	 * May be async.
	 */
	upgrade?: (ctx: UpgradeContext) =>
		| UserData | false
		| ReturnType<typeof upgradeResponse<UserData>>
		| Promise<UserData | false | ReturnType<typeof upgradeResponse<UserData>>>;

	/**
	 * Resolve who traffic on a connection is accounted to.
	 *
	 * Called exactly once per connection at open, BEFORE the `open` hook, with
	 * the connection's `ws.getUserData()` - the server-trusted identity the
	 * `upgrade` hook established. The result is validated, frozen, stored for
	 * the connection's life, and read back via `attribution(ws)` from
	 * `svelte-adapter-uws/connection`; the bundled ratelimit plugin reads its
	 * `tenantId` when no `tenant` resolver of its own is configured.
	 *
	 * MUST be synchronous - it runs inside the open callback, ahead of every
	 * hook that needs the answer. Resolve identity itself in the async-capable
	 * `upgrade` hook; derive the attribution from userData here.
	 *
	 * Fail-closed: a throwing resolver, a promise, a misshaped result, or an
	 * id outside `[a-zA-Z0-9_-]` / 64 chars refuses the connection at open
	 * (close code 1008) with one logged error line, rather than admitting it
	 * unattributed. Returning `null` / `undefined` (or omitting the export)
	 * means unattributed and is always accepted.
	 */
	attribution?: (user: UserData) => Attribution | null | undefined;

	/**
	 * Resolve the tenant a server-side publish on `topic` is charged to, for
	 * the `websocket.egress` tenant ceilings. This is how a framework's topic
	 * namespace convention (svelte-realtime's `@t/<id>/` prefix, for one)
	 * plugs into the egress budget without the adapter hardcoding any topic
	 * grammar.
	 *
	 * MUST be a pure synchronous function of the topic string - its answers
	 * are memoized. Return a tenant id under the shared attribution rule
	 * (`[a-zA-Z0-9_-]`, 1-64 chars) or `null` / `undefined` for an
	 * unattributed topic. Fail-closed on defects: an invalid id or a throwing
	 * resolver charges the publish UNATTRIBUTED (never a mangled key) and
	 * reports `ADAPTER-ERR-EGRESS-TENANT-RESOLVER` once per worker; a defined
	 * non-function export refuses startup outright.
	 *
	 * Not consulted on the client-relay game lane, where the SENDER's frozen
	 * `attribution` tenant id is the charged tenant. The ledger keys tenants
	 * only - `principalId` rides the attribution object for the inbound
	 * limiter surfaces, because per-principal budgets are the inbound rate
	 * limiter's job while egress budgets are tenant fair-share.
	 */
	egressTenantOf?: (topic: string) => string | null | undefined;

	/** Called when a WebSocket connection is established. */
	open?: (ws: WebSocket<UserData>, ctx: OpenContext) => void;

	/**
	 * Called when a message is received.
	 *
	 * **Note:** subscribe/unsubscribe messages from the client store are
	 * handled automatically before this is called. You only need this for
	 * custom application-level messages.
	 */
	message?: (ws: WebSocket<UserData>, ctx: MessageContext) => void;

	/**
	 * Called when a client tries to subscribe to a topic.
	 *
	 * **Wire-level scope only.** This hook fires when a client sends a
	 * `{type:'subscribe'}` (or `{type:'subscribe-batch'}`) wire frame.
	 * Server-side code that calls `ws.subscribe(topic)` directly bypasses
	 * this hook - the uWS C++ subscribe is not intercepted. Frameworks
	 * and plugins that subscribe a connection on the user's behalf
	 * (RPC handlers, integration layers) must route through
	 * `platform.subscribe(ws, topic)` to inherit this gate. Otherwise the
	 * loader / RPC response runs and any data fans out before the
	 * client's eventual wire-level subscribe is denied.
	 *
	 * Return values:
	 * - `false` - deny with the default reason `'FORBIDDEN'`.
	 * - A string - deny with that string as the reason. The framework
	 *   recognises `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`,
	 *   and `'RATE_LIMITED'` as the canonical codes; any other string
	 *   is forwarded verbatim to the client.
	 * - Anything else (or omit this export) - allow.
	 *
	 * May be async: the returned promise is awaited before the value is
	 * inspected, so `async () => false` denies just like `() => false`,
	 * and a rejection denies with `'INTERNAL_ERROR'` exactly like a throw.
	 *
	 * When the client supplied a `ref` with its subscribe op, the
	 * server emits a `{type:'subscribed', topic, ref}` ack on accept or
	 * a `{type:'subscribe-denied', topic, ref, reason}` ack on deny.
	 * Old clients that send subscribe without a `ref` get no ack
	 * (silent allow / silent deny, as before).
	 *
	 * @example
	 * ```js
	 * export function subscribe(ws, topic, { platform }) {
	 *   const { role, userId } = ws.getUserData();
	 *   if (!userId) return 'UNAUTHENTICATED';
	 *   if (topic.startsWith('admin') && role !== 'admin') return 'FORBIDDEN';
	 * }
	 * ```
	 */
	subscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) =>
		| boolean | void | SubscribeDenialReason | string
		| Promise<boolean | void | SubscribeDenialReason | string>;

	/**
	 * Optional batch variant of `subscribe`. Called once when a client
	 * sends a `subscribe-batch` frame (typically on reconnect, where
	 * the client resubscribes to every topic it had before in a single
	 * message). Use this to authorise N topics with one DB query
	 * instead of N.
	 *
	 * **Wire-level scope only.** Same caveat as `subscribe`: server-side
	 * code that calls `ws.subscribe(topic)` directly does not pass through
	 * this hook. Frameworks subscribing on the user's behalf must route
	 * through `platform.subscribe(ws, topic)` - one call per topic, the
	 * per-topic `subscribe` hook fires for each. This hook is exclusively
	 * the optimization point for client-initiated bulk authorization.
	 *
	 * Receives the set of pre-validated topics (already filtered for
	 * `INVALID_TOPIC`) and returns a record mapping the topics you
	 * want to deny to a reason. Use:
	 *
	 * - `false` -> deny with the default reason `'FORBIDDEN'`.
	 * - A string -> deny with that string as the reason. Canonical
	 *   codes are `'UNAUTHENTICATED'`, `'FORBIDDEN'`, `'INVALID_TOPIC'`,
	 *   `'RATE_LIMITED'`; any other string is forwarded verbatim to
	 *   the client.
	 * - Omit a topic, return `true`, or return `undefined` for it -> allow.
	 *
	 * Returning `undefined` or `{}` from the hook means "allow
	 * everything". May be async: the returned promise is awaited before
	 * its entries are read, and a rejection denies the whole batch with
	 * `'INTERNAL_ERROR'` exactly like a throw.
	 *
	 * If you do not export this hook, the per-topic `subscribe` hook
	 * is called once per topic in the batch (unchanged behaviour).
	 *
	 * @example
	 * ```js
	 * export async function subscribeBatch(ws, topics, { platform }) {
	 *   const { userId } = ws.getUserData();
	 *   const allowed = await db.allowedTopics(userId, topics);
	 *   const allowedSet = new Set(allowed);
	 *   const denials = {};
	 *   for (const topic of topics) {
	 *     if (!allowedSet.has(topic)) denials[topic] = 'FORBIDDEN';
	 *   }
	 *   return denials;
	 * }
	 * ```
	 */
	subscribeBatch?: (
		ws: WebSocket<UserData>,
		topics: string[],
		ctx: SubscribeContext
	) =>
		| Record<string, boolean | SubscribeDenialReason | string> | void
		| Promise<Record<string, boolean | SubscribeDenialReason | string> | void>;

	/**
	 * Called when a client unsubscribes from a topic (ref count reached zero).
	 *
	 * Use this to clean up per-topic state like presence or group membership
	 * without waiting for the socket to close.
	 */
	unsubscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) => void;

	/**
	 * Called when backpressure has drained (buffered data was sent).
	 * Use this for flow control when sending large or frequent messages.
	 */
	drain?: (ws: WebSocket<UserData>, ctx: OpenContext) => void;

	/**
	 * Called when a reconnecting client presents a previous session id and
	 * the per-topic sequence numbers it last saw. Use this to fill the gap
	 * caused by the disconnect window, typically by calling
	 * `replay.replay(ws, topic, sinceSeq, platform)` from the replay plugin
	 * for each topic the client cares about.
	 *
	 * If you do not export this hook, reconnects still work; the client
	 * just falls through to live mode without a gap fill (same as a cold
	 * connect). Wire it up only when your app needs in-flight events that
	 * landed during a brief network blip.
	 *
	 * The `lastSeenSeqs` object keys are topic names, values are the
	 * highest `seq` the client received before disconnect. Topics the
	 * client never received a message for are absent.
	 *
	 * The hook may be async. While it runs, the server buffers any live frame
	 * published to a recovering topic and flushes it once the connection goes
	 * live, so a message that lands mid-resume is never lost. Return the highest
	 * `seq` you delivered per topic - a `{ [topic]: seq }` map, or a bare number
	 * for a single-topic resume - and the server de-duplicates those buffered
	 * frames against it exactly. Return nothing and they are still delivered, but
	 * a frame from the narrow window between the buffer opening and your backend
	 * read may arrive twice (at-least-once) instead of exactly once.
	 *
	 * @example
	 * ```js
	 * import { createReplay } from 'svelte-adapter-uws/plugins/replay';
	 * const replay = createReplay({ size: 500 });
	 *
	 * export function resume(ws, { lastSeenSeqs, platform }) {
	 *   for (const [topic, sinceSeq] of Object.entries(lastSeenSeqs)) {
	 *     replay.replay(ws, topic, sinceSeq, platform);
	 *   }
	 * }
	 * ```
	 *
	 * @example
	 * ```js
	 * // Exact de-dup: report the highest seq delivered per topic.
	 * export async function resume(ws, { lastSeenSeqs, platform }) {
	 *   const covered = {};
	 *   for (const [topic, sinceSeq] of Object.entries(lastSeenSeqs)) {
	 *     covered[topic] = await myBackend.replay(ws, topic, sinceSeq, platform);
	 *   }
	 *   return covered;
	 * }
	 * ```
	 */
	resume?: (ws: WebSocket<UserData>, ctx: ResumeContext) =>
		void | Record<string, number> | number | Promise<void | Record<string, number> | number>;

	/** Called when the connection closes. */
	close?: (ws: WebSocket<UserData>, ctx: CloseContext) => void;
}

// - Platform type for event.platform ----------------------------------------

/**
 * Snapshot returned by `platform.pressure` and supplied to
 * `platform.onPressure(cb)` callbacks. All numbers are worker-local.
 */
export interface PressureSnapshot {
	/**
	 * Wall-clock milliseconds of the most recent completed sample, or `null`
	 * when the sampler has not folded yet - which is the only thing in this
	 * shape that distinguishes a reading from the initial placeholder, since
	 * every number below starts at `0` and `0` is a legitimate value for all of
	 * them except `memoryMB`. Branch on it before rendering or alerting:
	 *
	 * ```js
	 * const p = platform.pressure;
	 * if (p.sampledAt === null) return 'not sampled yet';
	 * ```
	 *
	 * It also dates the reading, so `Date.now() - sampledAt` growing past the
	 * sample interval is a wedged sampler - the same condition the
	 * `pressure_sample_timestamp_seconds` gauge exists to alert on. Always
	 * `null` in the Vite dev plugin and in `createTestServer`, which fabricate
	 * the snapshot and never sample.
	 */
	readonly sampledAt: number | null;
	/** `true` when `reason !== 'NONE'`. Convenience flag for boolean checks. */
	readonly active: boolean;
	/**
	 * Worker-global saturation in `0..1`. `0` is idle, `1` is saturated;
	 * higher always means more pressure. It is the worst-of the active
	 * threshold signals' distance toward their thresholds, folded with the
	 * worst per-connection internal flow-control reading. Use it for a coarse
	 * "how loaded is this worker" gauge (e.g. `value > 0.8` for a high-load
	 * guard); `reason` still names the most urgent specific signal.
	 *
	 * The per-connection component is a client-asserted report: a
	 * flow-controlled client states its own starved-send backlog when it asks
	 * for a fresh window, because the server deliberately never mirrors the
	 * client's permit consumption. The report is clamped to at most `1` and
	 * halved every sample, so the worst a hostile or broken client can do is
	 * hold `value` high while it keeps re-asserting - it can never touch
	 * `reason`, `active`, or any admission posture, which derive only from
	 * server-side counters. Automation that must resist a lying client should
	 * gate on `reason` (or the specific snapshot fields) rather than on
	 * `value` alone.
	 */
	readonly value: number;
	/**
	 * Average subscriptions per connection on this worker
	 * (`totalSubscriptions / connections`). `0` when the worker has no
	 * connections.
	 */
	readonly subscriberRatio: number;
	/** `platform.publish()` calls per second on this worker, last sample window. */
	readonly publishRate: number;
	/** Resident-set size in megabytes (`process.memoryUsage().rss`). */
	readonly memoryMB: number;
	/**
	 * Most urgent active signal. Precedence is fixed:
	 * `MEMORY > CAPACITY > CPU_QUOTA > PSI > PUBLISH_RATE > SUBSCRIBERS > NONE`.
	 * `'CAPACITY'` appears only when the protection posture is engaged
	 * (`elevated`/`siege`) and outranks every signal except `MEMORY`.
	 * `'CPU_QUOTA'` (container CFS quota suspending the process) and `'PSI'`
	 * (kernel stall time) appear only on hosts exposing those sources.
	 */
	readonly reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
	/**
	 * Kernel stall-time readings (avg10 percentages from `/proc/pressure`),
	 * or `null` on hosts without PSI.
	 */
	readonly psi: { cpuSome10: number, memoryFull10: number, ioFull10: number } | null;
	/**
	 * Container CFS-quota throttling over the last sample window, or `null`
	 * outside a quota-limited cgroup. `throttledRatio` is the fraction of
	 * the window the whole process sat suspended by the scheduler.
	 */
	readonly cpuThrottle: { throttledRatio: number, nrThrottledDelta: number } | null;
	/**
	 * Worst per-connection outbound queue depth (`ws.getBufferedAmount()`, in
	 * bytes) seen over the connections sampled this tick. `0` in the healthy
	 * steady state. Compare against `maxBackpressure` (1 MB default) to gauge how
	 * close the worst consumer is to the point where uWS begins shedding frames.
	 * The walk is bounded (up to 1024 connections per tick), so on a worker
	 * holding more than that this is a bounded sample rather than an exact max.
	 */
	readonly maxBufferedBytes: number;
	/**
	 * Number of sampled connections holding a notable outbound queue (more than
	 * 64 KB of un-flushed bytes) at sample time - a wedged or slow consumer count
	 * rather than the transient in-flight bytes of a healthy flush. Bounded by
	 * the same per-tick sample cap as `maxBufferedBytes`.
	 */
	readonly backpressuredConnections: number;
	/** Exact frames reported by uWS as dropped during the last sample window. */
	readonly droppedFrames: number;
	/** Exact payload bytes reported by uWS as dropped during the last sample window. */
	readonly droppedBytes: number;
	/**
	 * Worker publish-egress figures for the last sample window: local
	 * deliveries (recipients times messages, exclusions deducted), charged
	 * wire bytes, and `websocket.egress` ceiling refusals per scope. All
	 * zeros while nothing publishes; the ceilings' own enforcement window
	 * (`egress.windowMs`) is independent of this reporting window.
	 *
	 * `bytes` is the encoded UTF-8 length while a `bytes` ceiling is armed -
	 * the unit that ceiling decides on - and the character length while none
	 * is, because measuring an encoding walks every envelope and nothing
	 * reads the result until a ceiling does. The two agree for ASCII
	 * payloads, which is what the adapter's own envelope framing is.
	 * In `createTestServer` these are live cumulative totals instead (the
	 * harness runs no sampler; `sampledAt` stays `null` there), and the dev
	 * plugin reports inert zeros while still enforcing the ceilings.
	 */
	readonly egress: {
		deliveries: number;
		bytes: number;
		refusedTopic: number;
		refusedTenant: number;
	};
	/**
	 * Top 5 topics by message rate during the last sample window, sorted
	 * descending by `messagesPerSec`. Each entry is
	 * `{ topic, messagesPerSec, bytesPerSec, deliveriesPerSec }`. Empty when
	 * no `platform.publish()` calls landed in the window.
	 */
	readonly topPublishers: TopicPublishRate[];
}

/**
 * Per-topic publish-rate sample, surfaced via `platform.pressure.topPublishers`
 * and the `platform.onPublishRate(cb)` callback.
 */
export interface TopicPublishRate {
	topic: string;
	messagesPerSec: number;
	/**
	 * Envelope size per second in UTF-16 code units (equal to bytes for
	 * ASCII envelopes) - the unit `topicPublishBytesPerSec` is compared
	 * against.
	 */
	bytesPerSec: number;
	/**
	 * Egress deliveries per second for the topic (local recipients times
	 * messages). Additive: `messagesPerSec` and `bytesPerSec` keep their
	 * meanings, and no over-threshold decision reads this dimension.
	 */
	deliveriesPerSec: number;
}

/**
 * Available on `event.platform` in server hooks, load functions, and actions.
 *
 * To get type-checking, add this to your `src/app.d.ts`:
 *
 * ```ts
 * import type { Platform as AdapterPlatform } from 'svelte-adapter-uws';
 *
 * declare global {
 *   namespace App {
 *     interface Platform extends AdapterPlatform {}
 *   }
 * }
 * ```
 */
export interface RuntimeVersionInfo {
	/** Adapter version read from the package metadata that produced this runtime. */
	adapter: string | null;
	/** Frozen wire revision parsed from protocol.schema.json. */
	protocolRevision: number | null;
	/**
	 * Actually resolved svelte-realtime version. `null` when the resolver
	 * reports the package absent; the literal `'unresolvable'` when something
	 * is present that cannot be read (a broken exports map, an invalid
	 * package config) - a configuration to fix, not an absence.
	 */
	realtime: string | null;
	/**
	 * Actually resolved extensions version. `null` when the resolver reports
	 * the package absent; the literal `'unresolvable'` when something is
	 * present that cannot be read - a configuration to fix, not an absence.
	 */
	extensions: string | null;
}

export interface Platform {
	/**
	 * Per-request / per-connection correlation id, suitable for threading
	 * through structured logs.
	 *
	 * For HTTP requests, a fresh UUID is generated per request. For WS
	 * connections, the id is stamped once at upgrade and reused for every
	 * hook on that connection. In both cases, an inbound `X-Request-ID`
	 * header overrides the generated value when present (sanitized:
	 * printable ASCII only, max 128 chars; invalid values are ignored).
	 *
	 * Application responses do not receive a header automatically. Adapter-owned
	 * 500 responses (SSR, authentication endpoint, and WebSocket upgrade-hook
	 * failures) echo the resolved id as `X-Request-ID` for operator correlation.
	 *
	 * @example
	 * ```js
	 * export async function GET({ platform, url }) {
	 *   logger.info({ requestId: platform.requestId, path: url.pathname }, 'request started');
	 *   const data = await loadData();
	 *   return json({ data, requestId: platform.requestId });
	 * }
	 * ```
	 */
	readonly requestId: string;

	/**
	 * Validated W3C context for the currently active HTTP, WebSocket, RPC, bus,
	 * or durable-work operation. Concurrent operations on one connection remain
	 * isolated. Null when tracing is not configured or no valid context exists.
	 */
	readonly traceContext: TraceContext | null;

	/**
	 * Vendor-neutral trace boundary. run() creates a provider span and keeps its
	 * context active across async work; inject() writes traceparent/tracestate to
	 * an outbound carrier. With no configured provider these methods are no-op
	 * compatible and do not allocate spans.
	 */
	readonly trace: Readonly<{
		readonly enabled: boolean;
		current(): TraceContext | null;
		extract(carrier: Headers | Record<string, unknown>): TraceContext | null;
		inject<T extends Headers | Record<string, string>>(carrier: T, context?: TraceContext | null): T;
		run<T>(name: string, options: TraceOperationOptions, fn: (span: TraceSpan | null) => T): T;
		withContext<T>(context: TraceContext | null, fn: () => T): T;
	}>;

	/**
	 * Publish a message to all WebSocket clients subscribed to a topic.
	 *
	 * The message is automatically wrapped in a `{ topic, event, data }` envelope
	 * that the client store (`svelte-adapter-uws/client`) understands.
	 *
	 * Every published frame is automatically stamped with a monotonic
	 * per-topic `seq` field in the envelope. The first publish to a topic
	 * sends `seq: 1`, the next `seq: 2`, and so on; each topic has an
	 * independent counter. Reconnecting clients can use the seq to detect
	 * gaps and resume from where they left off. Pass `{ seq: false }` to
	 * skip stamping for high-cardinality or perf-sensitive topics where
	 * the counter map would grow unbounded.
	 *
	 * A multi-worker runtime refuses that worker-local default because it
	 * cannot preserve one monotonic sequence across multiple origins. Use
	 * unsequenced frames or an external ordered sequencer and fan-out as
	 * described by the options below.
	 *
	 * @param topic - Topic string (e.g. `'todos'`, `'user:123'`, `'org:456'`)
	 * @param event - Event name (e.g. `'created'`, `'updated'`, `'deleted'`)
	 * @param data - Payload (will be JSON-serialized)
	 * @param options - Optional.
	 *   - `relay: false` skips cross-worker relay (use when the message
	 *     comes from an external pub/sub source like Redis or Postgres
	 *     that already delivers to every process).
	 *   - `seq: false` skips the per-topic monotonic seq stamp (use for
	 *     ephemeral or high-cardinality topics where the counter map
	 *     would grow unbounded). `seq: <number>` (a positive integer) stamps
	 *     that exact value instead of the in-memory counter and does not
	 *     advance it - a non-positive-integer seq is rejected, not stamped - the hook
	 *     a replay backend uses to put the broadcast frame and its buffer on
	 *     one authoritative seq space (see the extensions replay layer). A
	 *     legacy truthy `seq: true` still means the in-memory counter.
	 *     In a multi-worker runtime, an omitted/`true` seq throws because each
	 *     worker owns a different counter. Use `{ seq: false }`, or supply a
	 *     positive externally-authoritative number together with `relay: false`
	 *     so the external ordered source, not the built-in multi-origin relay,
	 *     fans the frame to every process.
	 *   - `compress: false` skips permessage-deflate for this frame. No-op
	 *     unless `websocket.compression` is configured, where text frames
	 *     compress by default; pass `false` for a high-frequency,
	 *     high-fan-out topic (deflate CPU scales per subscriber).
	 *   - `jitterMs: <ms>` stamps a de-herd window on the frame. Each receiving
	 *     client rolls its own random delay in `[0, jitterMs)` before handing the
	 *     frame to its subscribers, so a single broadcast that makes N clients all
	 *     act (retry, refetch, re-render) ramps across the window instead of
	 *     spiking at t+0. The outbound fan-out stays one native publish; only the
	 *     clients' local dispatch is staggered. Omit / `0` = immediate (default).
	 *
	 * @example
	 * ```js
	 * // In a form action or API route:
	 * export async function POST({ platform }) {
	 *   const todo = await db.save(data);
	 *   platform.publish('todos', 'created', todo);
	 * }
	 * ```
	 *
	 * @returns `true` when delivered locally or relayed; `false` with no
	 *   subscribers - and `false` when a configured `websocket.egress`
	 *   ceiling refused the publish, in which case nothing was delivered,
	 *   relayed, or sequence-stamped.
	 */
	publish(topic: string, event: string, data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): boolean;

	/**
	 * Publish via a plugin-declared binary wire codec. Subscribers that
	 * advertised `wire.capability` in their `hello` frame receive a compact
	 * binary `0x03` frame; everyone else receives the identical JSON envelope
	 * `publish()` would have sent. App authors never call this - it is the
	 * plugin-author surface for a high-throughput topic family (the cursor
	 * plugin is the first beneficiary, gated by `cursor.protocol:2`).
	 *
	 * Zero-cost when no connected client wants binary: this takes the same
	 * single `app.publish` fan-out as `publish()`. The codec's `encode` may
	 * return `null` for a frame it cannot represent, which transparently falls
	 * back to JSON for that one frame.
	 *
	 * @param topic - Topic string
	 * @param event - Event name (the codec maps it to an opcode)
	 * @param data - Payload (passed to `wire.encode`, or JSON-serialized on fallback)
	 * @param wire - The plugin's wire codec: a negotiated `capability` token, a
	 *   1-byte `schemaVersion`, an `encode(event, data, state?)` returning the
	 *   payload bytes or `null` to fall back to JSON for this frame, and an
	 *   optional `state` factory (`onAttach(ws)` / `onDetach(ws, state)`) for a
	 *   stateful codec - the framework creates one state object per connection,
	 *   passes it to `encode`, and stamps `state.schemaVersion ?? schemaVersion`
	 *   on the frame. A stateless codec (no `state`) keeps the single
	 *   encode-once-send-many fan-out; a stateful one is encoded per connection.
	 * @param options - Same `relay` / `seq` semantics as `publish()`, plus
	 *   `compress` (binary codec frames are NOT compressed by default; pass
	 *   `{ compress: true }` to opt a low-frequency codec into permessage-deflate
	 *   when `websocket.compression` is configured - the cursor hot path leaves
	 *   it off, presence opts in) and `excludeWs` (sender exclusion for echo
	 *   suppression: the frame is never delivered to that socket on any path -
	 *   binary, JSON fallback, or JSON fast path; the cross-instance relay
	 *   still fires, since the excluded socket only exists locally).
	 */
	publishWire(
		topic: string,
		event: string,
		data: unknown,
		wire: {
			capability: string;
			schemaVersion: number;
			encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
			/**
			 * Stateless codec only: route this topic through native cohort fan-out so
			 * one publish becomes two native fan-outs (the byte-identical binary frame
			 * to the binary cohort, the JSON envelope to the JSON cohort) instead of a
			 * per-connection walk. For a high-fan-out topic where every binary
			 * subscriber receives the IDENTICAL frame - a mega-lobby world snapshot. The
			 * first shared publish migrates the topic's current subscribers into
			 * cohorts; later joiners are cohorted at subscribe time. An excluding publish
			 * (`excludeWs`) or a declined encode falls back to the per-connection walk.
			 * Register the codec via `registerWireCodec` for the clustered path.
			 */
			shared?: boolean;
			state?: {
				onAttach: (ws: WebSocket<any>) => unknown;
				onDetach?: (ws: WebSocket<any>, state: unknown) => void;
			};
		},
		options?: {
			relay?: boolean;
			/**
			 * `false` omits the seq; a positive-integer `number` stamps that exact
			 * authoritative seq (from a replay backend) onto both the JSON envelope
			 * and the `0x03` binary frame without advancing the in-memory counter;
			 * omitted (or a legacy truthy) uses the in-memory per-worker counter.
			 */
			seq?: boolean | number;
			compress?: boolean;
			/** Never delivered to this socket; exclusion is local to this instance. */
			excludeWs?: WebSocket<any>;
		}
	): boolean;

	/**
	 * Single-target counterpart to `publishWire()`. The connection receives a
	 * binary `0x03` frame when it advertised `wire.capability` and the codec
	 * can encode the frame; otherwise the JSON envelope `send()` would have
	 * sent. No per-topic seq is stamped (matches `send()`). Used for
	 * snapshot/catalog frames to a single late-joining subscriber.
	 */
	sendWire(
		ws: WebSocket<any>,
		topic: string,
		event: string,
		data: unknown,
		wire: {
			capability: string;
			schemaVersion: number;
			encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
			state?: {
				onAttach: (ws: WebSocket<any>) => unknown;
				onDetach?: (ws: WebSocket<any>, state: unknown) => void;
			};
		},
		options?: { compress?: boolean }
	): number;

	/**
	 * Multi-entry fan-out via a STATEFUL wire codec: one tick's same-event
	 * updates delivered as ONE binary frame per capable connection (the codec's
	 * `<event>-batch` form, `{ updates }` data) and as the per-entry JSON
	 * envelopes - byte-identical to N `publishWire` calls - for everyone else.
	 * Each entry may carry its own `excludeWs` (per-entry author suppression).
	 * Sequencing, accounting, and the cross-instance relay match N
	 * `publishWire` calls (one seq and one relay envelope per entry).
	 * An entry may carry its own explicit `seq` - the cluster-authoritative
	 * number a replay backend already allocated for that frame - with exactly
	 * `publishWire({ seq: N })`'s rules: a NUMBER must be a positive integer
	 * or the whole batch is refused, it is stamped verbatim without advancing
	 * the counter, and on a multi-worker runtime it additionally requires
	 * `{ seq: false, relay: false }` on the options (options renounce the
	 * counter, entries carry the authority, and `relay: false` proves the
	 * multi-origin built-in relay is not also fanning out). A non-number
	 * entry `seq` falls through to the shared options, exactly as it would on
	 * `publishWire`'s own options object; entries without one draw from the
	 * shared options as before. Every numeric per-entry seq is validated
	 * before anything is stamped or delivered: an invalid one refuses the
	 * WHOLE batch, so a mid-batch refusal cannot leave earlier entries
	 * already fanned out. A batch-level numeric `options.seq` stays refused outright
	 * - on every topology, and whatever the entries array holds, including
	 * one entry or none, so that contract never changes shape with the data:
	 * one number cannot be the one-seq-per-entry this method publishes.
	 * Degradation is per connection: a codec that declines the batch falls back
	 * to per-entry encodes, a per-entry decline to that entry's JSON envelope,
	 * and a dropped frame or announce poisons the capability to JSON until
	 * reconnect. A stateless codec routes through the per-entry path unchanged.
	 *
	 * The whole array is read before any of it is published. The length and the
	 * options object are pinned on entry, and every entry's `data`,
	 * `excludeWs` and `seq` are read in a pass of their own before the first
	 * envelope is built - which is where a payload's `toJSON` first runs. So
	 * application code running inside this call cannot change what the call
	 * publishes: not an entry already built, and not one whose turn has yet to
	 * come. No two subscribers are handed different bytes for the same entry,
	 * an exclusion cannot be cleared out from under the delivery walk, an
	 * exclusion cannot be installed on an entry that did not carry one, and a
	 * seq cannot be rewritten after its entry was read.
	 *
	 * What it does NOT freeze is a payload's own fields: replacing those
	 * reaches every subscriber, because each path holds the same object rather
	 * than a copy of it. Do not mutate a payload from inside one that has been
	 * handed to a publish.
	 */
	publishWireBatch(
		topic: string,
		event: string,
		entries: Array<{ data: unknown; excludeWs?: WebSocket<any>; seq?: number }>,
		wire: {
			capability: string;
			schemaVersion: number;
			encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
			state?: {
				onAttach: (ws: WebSocket<any>) => unknown;
				onDetach?: (ws: WebSocket<any>, state: unknown) => void;
			};
		},
		options?: { seq?: boolean; relay?: boolean; compress?: boolean }
	): boolean;

	/**
	 * Multi-entry single-target counterpart to `publishWireBatch()`: one tick's
	 * same-event updates for ONE subscriber as a single binary frame, or the
	 * per-entry JSON envelopes when the connection has no capability. The
	 * per-subscriber twin for culled (per-viewer) delivery walks. No per-topic
	 * seq is stamped (matches `send()` / `sendWire()`). Returns the uWS send
	 * status of the last frame sent.
	 */
	sendWireBatch(
		ws: WebSocket<any>,
		topic: string,
		event: string,
		entries: Array<{ data: unknown }>,
		wire: {
			capability: string;
			schemaVersion: number;
			encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
			state?: {
				onAttach: (ws: WebSocket<any>) => unknown;
				onDetach?: (ws: WebSocket<any>, state: unknown) => void;
			};
		},
		options?: { compress?: boolean }
	): number;

	/**
	 * Register a wire codec under its capability so a clustered deployment's
	 * cross-worker relay can re-derive it on a receiving worker and re-encode binary
	 * locally for that worker's binary-capable subscribers - without it, subscribers
	 * on a worker other than the publisher's receive the JSON envelope. The bundled
	 * cursor and presence plugins register their codec automatically on first use;
	 * call this only for a custom plugin-author codec you publish through
	 * `publishWire`. Idempotent (last registration per capability wins); a no-op in
	 * single-process mode (no relay) and for a codec with no string capability.
	 */
	registerWireCodec(wire: {
		capability: string;
		schemaVersion: number;
		encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
		/** Stateless shared codec (see `publishWire`). Registering a `shared: true`
		 *  codec is what lets the clustered relay re-derive it and run the cohort split
		 *  on each receiving worker. Same shape the codec carries to `publishWire`. */
		shared?: boolean;
		state?: {
			onAttach: (ws: WebSocket<any>) => unknown;
			onDetach?: (ws: WebSocket<any>, state: unknown) => void;
		};
	}): void;

	/**
	 * Publish multiple messages, returning per-message delivery results.
	 *
	 * **NOT wire-level batching.** Under the hood this is a `for` loop
	 * calling `publish()` once per message, so N submitted messages still
	 * produce N WebSocket frames per subscribed connection. For
	 * one-frame-per-subscriber wire batching, use `publishBatched()`.
	 *
	 * Two distinct contracts:
	 * - `batch(messages)` -> N frames per subscriber, returns `boolean[]`.
	 * - `publishBatched(messages)` -> 1 frame per subscriber (events
	 *   array), returns `void`; opt-in by client capability.
	 *
	 * @example
	 * ```js
	 * export async function POST({ platform, request }) {
	 *   const { items } = await request.json();
	 *   platform.batch(items.map(item => ({ topic: 'orders', event: 'created', data: item })));
	 * }
	 * ```
	 */
	batch(messages: {
		topic: string;
		event: string;
		data?: unknown;
		options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number };
	}[]): boolean[];

	/**
	 * <!-- API_DOC:platform.publishBatched:START -->
	 * ### `platform.publishBatched(messages, options?)`
	 *
	 * Publish a list of events as one `{type:'batch', events:[...]}` WebSocket
	 * frame per affected subscriber when the local subscriber shape permits it.
	 * The method returns `void`. Each message has `topic`, `event`, optional
	 * `data`, optional `coalesceKey`, and per-message `options.relay` / `options.seq`;
	 * call-level `options.compress` opts the resulting frames into compression.
	 *
	 * ```js
	 * platform.publishBatched([
	 *   { topic: 'org:42:items', event: 'updated', data: a },
	 *   { topic: 'org:42:items', event: 'updated', data: b },
	 *   { topic: 'org:42:audit', event: 'created', data: c, options: { seq: false } }
	 * ], { compress: false });
	 * ```
	 *
	 * Each subscriber receives only events for topics it holds, in surviving call
	 * order; a subscriber with no overlap receives nothing. The fast path is used
	 * when every interested local subscriber advertised the `batch` capability
	 * and every interested subscriber sees the same event slice (a single topic
	 * always has one slice). Otherwise that worker safely falls back to individual
	 * event envelopes. The bundled client advertises `batch` automatically and
	 * dispatches each contained event through the ordinary per-topic store path.
	 *
	 * **Cross-worker contract.** The relay mirrors the origin's own path
	 * selection. When the origin takes the fast path, it sends one
	 * `publish-batched` IPC frame carrying the complete relay-eligible event
	 * list, and every receiving worker reruns capability and subscriber-slice
	 * detection against its own sockets - so a peer may emit one local batch
	 * frame or fall back locally. When the origin itself falls back (a
	 * subscriber without the `batch` capability, or interested subscribers
	 * seeing different event slices), each surviving event relays
	 * individually and peers deliver individual event envelopes. An event
	 * with `{ relay: false }` is kept in origin-local delivery and omitted
	 * from the cross-worker list either way.
	 *
	 * **Coalescing, order, and sequence.** Events sharing a string `coalesceKey`
	 * collapse before framing; only the latest survives at its latest occurrence,
	 * while unkeyed events never collapse. Each survivor is independently stamped
	 * like `publish()`. `{ seq: false }` omits the stamp; a positive integer stamps
	 * that exact externally authoritative value. In a multi-worker runtime every
	 * survivor must use `seq:false` or an authoritative number with `relay:false`;
	 * the entire surviving batch is validated before any counter or delivery can
	 * occur. `sendCoalesced` remains a separate per-connection queue and produces
	 * separate frames.
	 *
	 * **Frame and compression budget.** A batch envelope larger than 256 KB emits
	 * a throttled warning; split it into multiple calls. Compression defaults to
	 * false. `{ compress: true }` applies consistently to the shared-frame fast
	 * path and every individual-frame fallback when WebSocket compression is
	 * configured.
	 *
	 * Do not confuse this with `platform.batch(messages)`: that method is a
	 * `publish()` loop, returns one boolean per message, and always produces
	 * individual event frames. Use `publishBatched()` for wire batching.
	 * <!-- API_DOC:platform.publishBatched:END -->
	 */
	publishBatched(messages: Array<{
		topic: string;
		event: string;
		data?: unknown;
		/**
		 * Optional coalesce key. When two events in the same call share
		 * a `coalesceKey`, only the latest one survives - the earlier
		 * value is dropped before the batch frame is built. Use this
		 * for high-frequency streams where intermediate values are
		 * noise (cursor positions, price ticks, presence, typing
		 * indicators). Events without a `coalesceKey` are never
		 * coalesced.
		 *
		 * @example
		 * ```js
		 * platform.publishBatched(positions.map(p => ({
		 *   topic: 'cursors',
		 *   event: 'move',
		 *   data: p,
		 *   coalesceKey: 'cursor:' + p.userId  // latest position per user
		 * })));
		 * ```
		 */
		coalesceKey?: string;
		/** Per-message `seq`: `false` omits it, a positive-integer `number` stamps that exact authoritative seq, omitted uses the in-memory counter. Multi-worker runtimes require `false` or an authoritative number with `relay:false`. */
		options?: { relay?: boolean; seq?: boolean | number };
	}>, options?: {
		/**
		 * Compress the batch frame when `websocket.compression` is configured.
		 * Default `false`: a batched frame mixes event types, so compression is
		 * opt-in. Applies to the whole batch (the shared-frame fast path and the
		 * per-event slow-path fallback alike).
		 */
		compress?: boolean;
	}): void;

	/**
	 * Send a request to a single connection and await its reply.
	 *
	 * The server picks a fresh `ref`, sends `{type:'request', ref, event, data}`,
	 * and the returned Promise resolves with whatever the client's
	 * `onRequest` handler returned (or rejects with an `Error` carrying
	 * the message the client sent back if its handler threw / rejected).
	 *
	 * Rejects with `Error('request timed out')` after `timeoutMs`
	 * (default `5000`) and with `Error('connection closed')` if the
	 * WebSocket closes before a reply arrives. The closed rejection
	 * appends which side of transmission the close landed on: a frame
	 * that was `never sent` or `could not be sent` leaves the remote
	 * outcome known and is safe to retry after reconnect, while one
	 * `handed to the transport and no reply had arrived` must be
	 * reconciled or retried only through an idempotent operation.
	 * Pending requests are tracked per-connection, so close cleanup
	 * is automatic.
	 *
	 * Pairs with the client store's `onRequest(handler)`. Use this for
	 * server-driven confirmations, capability challenges, or
	 * push-driven state queries.
	 *
	 * @example
	 * ```js
	 * // In a hook on the server:
	 * const reply = await platform.request(ws, 'confirm-action', { op: 'delete' }, {
	 *   timeoutMs: 5000
	 * });
	 * if (reply.confirmed) await actuallyDelete();
	 * ```
	 */
	request<TReply = unknown>(
		ws: WebSocket<any>,
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<TReply>;

	/**
	 * Broadcast a request to EVERY connection subscribed to `topic` on this
	 * instance and collect their replies - the request/reply analog of
	 * `publish`. Each subscriber's client `onRequest` handler runs; partial
	 * success is the contract, so a subscriber that times out, errors, or
	 * whose socket closed lands in the result as `{ ok: false, error }` and
	 * never fails the whole call. Returns one entry per subscribed socket.
	 *
	 * `timeoutMs` (default 5000) bounds each request; since they run
	 * concurrently it is effectively the whole-fan-out budget. Walks THIS
	 * worker's subscriber set (cluster-wide broadcast is the extensions layer).
	 *
	 * @example
	 * ```js
	 * const results = await platform.requestTopic('room:42', 'ping', {});
	 * const live = results.filter((r) => r.ok).map((r) => r.reply);
	 * ```
	 */
	requestTopic<TReply = unknown>(
		topic: string,
		event: string,
		data?: unknown,
		options?: { timeoutMs?: number }
	): Promise<Array<{ ok: true; reply: TReply } | { ok: false; error: string }>>;

	/**
	 * Send a message to a single WebSocket connection.
	 * Wraps in the same `{ topic, event, data }` envelope as `publish()`.
	 *
	 * Returns the uWS send result: `0` = SUCCESS, `1` = BACKPRESSURE
	 * (queued, will flush on drain), `2` = DROPPED (frame discarded
	 * because the socket has closed or its queue is over the limit).
	 *
	 * Closed-WS safe: if the socket has already closed, returns `2`
	 * (DROPPED) and bumps `platform.closedWsAborts` rather than
	 * propagating uWS's "Invalid access" exception.
	 *
	 * @example
	 * ```js
	 * // In hooks.ws.js - reply to sender:
	 * export function message(ws, { data }) {
	 *   const msg = JSON.parse(Buffer.from(data).toString());
	 *   ws.send(JSON.stringify({ topic: 'echo', event: 'reply', data: { got: msg } }));
	 * }
	 * ```
	 */
	send(ws: WebSocket<any>, topic: string, event: string, data?: unknown, options?: { compress?: boolean }): number;

	/**
	 * Send a message to a single connection with coalesce-by-key semantics.
	 *
	 * Each `(ws, key)` pair holds at most one pending message. If a newer
	 * `sendCoalesced` for the same `key` arrives before the previous frame
	 * drains to the wire, the older one is dropped in place: latest value
	 * wins. Insertion order is preserved across overwrites.
	 *
	 * Use for latest-value streams where intermediate values are noise -
	 * price ticks, cursor positions, presence state, typing indicators,
	 * scroll/scrub positions. For at-least-once delivery, use `send()` or
	 * `publish()` instead.
	 *
	 * Serialization is deferred to the actual flush, so a stream that
	 * overwrites the same `key` 1000 times before a single drain pays one
	 * `JSON.stringify`, not 1000.
	 *
	 * The flush attempts immediately and again on every uWS drain event.
	 * On backpressure or drop from the underlying socket, pumping stops
	 * and resumes when the connection drains.
	 *
	 * @example
	 * ```js
	 * // In hooks.ws.js - cursor positions during a collaborative edit.
	 * // Each peer sees only the latest cursor for every other user;
	 * // intermediate positions are dropped under load.
	 * export function message(ws, { data, platform }) {
	 *   const msg = JSON.parse(Buffer.from(data).toString());
	 *   if (msg.event !== 'cursor') return;
	 *   const { docId, userId } = ws.getUserData();
	 *   for (const peer of getPeersOf(docId)) {
	 *     platform.sendCoalesced(peer, {
	 *       key: 'cursor:' + userId,
	 *       topic: 'doc:' + docId,
	 *       event: 'cursor',
	 *       data: { userId, x: msg.data.x, y: msg.data.y }
	 *     });
	 *   }
	 * }
	 * ```
	 *
	 * @param ws - The WebSocket connection.
	 * @param message - `{ key, topic, event, data }`. `key` identifies the
	 *   coalesce slot per connection; `topic`, `event`, `data` are the
	 *   envelope fields the client store understands.
	 */
	sendCoalesced(
		ws: WebSocket<any>,
		message: { key: string; topic: string; event: string; data?: unknown }
	): void;

	/**
	 * Send a message to all connections whose userData matches a filter.
	 * Returns the number of connections the message was sent to.
	 *
	 * The filter receives each connection's userData (whatever `upgrade()` returned).
	 *
	 * **Performance note:** `sendTo()` iterates every open connection on the local
	 * worker to evaluate the filter. For broadcasting to large groups, prefer
	 * `publish()` with a topic - topics are dispatched by uWS's C++ TopicTree
	 * with O(subscribers) fan-out and no JS loop. Use `sendTo()` when you need
	 * to target connections by arbitrary runtime properties that can't be mapped
	 * to a static topic name (e.g., filtering by session data set at upgrade time).
	 *
	 * In clustered mode, `sendTo()` only reaches connections on the local worker.
	 * `publish()` relays across all workers automatically.
	 *
	 * @example
	 * ```js
	 * // Send to a specific user (no need to maintain your own Map):
	 * export async function POST({ platform, request }) {
	 *   const { targetUserId, message } = await request.json();
	 *   platform.sendTo(
	 *     (userData) => userData.userId === targetUserId,
	 *     'dm', 'new-message', { message }
	 *   );
	 * }
	 *
	 * // For a known user ID, subscribing each user to a personal topic
	 * // at upgrade time and using publish() is more efficient at scale:
	 * // platform.publish(`user:${targetUserId}`, 'dm', 'new-message', { message });
	 * ```
	 *
	 * Egress note: the filter pass runs over every connection FIRST and the
	 * sends follow, so a configured `websocket.egress` ceiling can refuse the
	 * whole fan-out pre-hoc - a refused call sends nothing and returns `0`.
	 * The count is charged to the topic's egress (and its resolved tenant),
	 * but never to the per-topic publish-rate stats, which keep meaning
	 * publish-family calls.
	 */
	sendTo(filter: (userData: any) => boolean, topic: string, event: string, data?: unknown, options?: { compress?: boolean }): number;

	/**
	 * Advise connected clients to reconnect on a jittered schedule, then (by
	 * default) close them. A draining or restarting node broadcasts the additive
	 * `reconnect` control frame so each client rolls its own delay in
	 * `[afterMs, afterMs + windowMs)` instead of a whole fleet stampeding the
	 * replacement node in one backoff window. The frame is unknown-type-safe, so an
	 * old client simply ignores it and falls back to normal backoff.
	 *
	 * `windowMs` (required, > 0) is the dispersal width; `afterMs` (default 0) is a
	 * floor delay to hold clients off while the replacement warms. `close` (default
	 * `true`) sends a graceful `1001` close after the advisory; pass `false` to
	 * advise without closing. `filter` limits the advisory to matching connections
	 * (by their upgrade `userData`, evaluated synchronously like `sendTo`). Returns
	 * the number of connections advised. Graceful `shutdown()` calls this
	 * automatically when `RECONNECT_DISPERSAL_MS > 0` (default 5000).
	 *
	 * @example
	 * ```js
	 * // Drain this node before a rolling deploy, scattering reconnects over 10s:
	 * platform.adviseReconnect({ windowMs: 10000 });
	 * ```
	 *
	 * Egress note: the advisory is operator-lane egress - it carries no topic
	 * and no tenant, so it lands in the worker egress figures but sits
	 * outside every `websocket.egress` ceiling; a drain command is never
	 * refusable by a budget.
	 */
	adviseReconnect(options?: { windowMs?: number; afterMs?: number; close?: boolean; filter?: (userData: any) => boolean; compress?: boolean }): number;

	/**
	 * Number of active WebSocket connections.
	 *
	 * @example
	 * ```js
	 * export async function GET({ platform }) {
	 *   return json({ online: platform.connections });
	 * }
	 * ```
	 */
	readonly connections: number;

	/**
	 * Per-worker count of best-effort uWS operations that aborted
	 * because the underlying WebSocket had already closed.
	 *
	 * Ws-targeted platform methods (`subscribe`, `unsubscribe`, `send`,
	 * `sendCoalesced`, `sendTo`, `request`) and the wire-level
	 * subscribe / subscribe-batch handlers swallow uWS's "Invalid
	 * access of closed uWS.WebSocket" exception so callers never need
	 * a per-site try/catch when a socket closes mid-async-setup.
	 * Each swallow bumps this counter.
	 *
	 * A non-zero value is normal under client churn (browser tab close,
	 * network blips, mass-reconnect waves). A rapidly-growing value
	 * under steady load indicates either pathological client behaviour
	 * or that the server's async setup path is too long for its
	 * connect rate - worth investigating but not, on its own, a bug.
	 *
	 * Monotonic, per-worker, reset only on process restart. In
	 * clustered mode, sum across workers to get the cluster total.
	 *
	 * @example
	 * ```js
	 * // periodic ops log
	 * setInterval(() => {
	 *   console.log('closed-ws aborts:', platform.closedWsAborts);
	 * }, 60_000);
	 * ```
	 */
	readonly closedWsAborts: number;

	/**
	 * A PII-free snapshot of this worker's transport-layer health: connection
	 * count, backpressure posture, protection level, payload cap, and the
	 * framework-invariant counters. Counts and enums only - never a topic
	 * name, never a user id, never a socket handle. Counts, enums, and package
	 * versions only. Pure read (a fresh plain object each call), so it is safe
	 * to expose behind an auth-gated admin route or feed to a dashboard.
	 *
	 * The scalar pressure signals are reported but `topPublishers` is omitted
	 * (topic names can embed ids); read `pressure` directly with your own
	 * authorization when you need per-topic detail.
	 *
	 * svelte-realtime's `introspect()` composes this under a `transport` key
	 * when present, so an app-level admin route surfaces the dispatch snapshot
	 * and this transport snapshot from one call.
	 *
	 * @example
	 * ```js
	 * export function GET({ platform }) {
	 *   return Response.json(platform.introspect());
	 * }
	 * ```
	 */
	introspect(): {
		connections: number;
		closedWsAborts: number;
		protection: 'normal' | 'elevated' | 'siege';
		maxPayloadLength: number;
		versions: RuntimeVersionInfo;
		pressure: {
			/** `null` until the first sample; see `PressureSnapshot.sampledAt`. */
			sampledAt: number | null;
			active: boolean;
			reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
			value: number;
			subscriberRatio: number;
			publishRate: number;
			memoryMB: number;
			maxBufferedBytes: number;
			backpressuredConnections: number;
			droppedFrames: number;
			droppedBytes: number;
			egress: {
				deliveries: number;
				bytes: number;
				refusedTopic: number;
				refusedTenant: number;
			};
		};
		assertions: Record<string, number>;
		diagnostics: {
			retained: number;
			recent: Array<{
				diagnosticId: string;
				kind: 'state-divergence';
				observedAt: number;
				complete: boolean;
				affectedStreamCount: number;
				evidenceTruncated: boolean;
			}>;
		};
	};

	/**
	 * Resolve a bounded state-divergence diagnostic by the opaque id emitted in
	 * the primary log. The returned stream identifiers are process-lifetime
	 * HMACs, never raw topic names. This is sensitive operational evidence:
	 * expose it only through an authenticated admin route.
	 */
	diagnostic(diagnosticId: string): {
		diagnosticId: string;
		kind: 'state-divergence';
		epoch: number;
		observedAt: number;
		complete: boolean;
		evidenceTruncated: boolean;
		explainedBySequenceSummary: boolean;
		expectedWorkers: number;
		reportingWorkers: number;
		workers: Array<{
			threadId: number;
			role: 'majority' | 'minority';
			totalStreams: number;
			sampledStreams: number;
			truncated: boolean;
		}>;
		affectedStreams: Array<{
			streamId: string;
			classification: 'tail-sequence-gap' | 'stream-presence-mismatch';
			gapLowerBound: number | null;
			workers: Array<{
				threadId: number;
				role: 'majority' | 'minority';
				sequence: number | null;
			}>;
		}>;
	} | null;

	/**
	 * Number of clients subscribed to a specific topic.
	 *
	 * @example
	 * ```js
	 * export async function GET({ platform, params }) {
	 *   return json({ viewers: platform.subscribers(`page:${params.id}`) });
	 * }
	 * ```
	 */
	subscribers(topic: string): number;

	/**
	 * Whether `request` is a synthetic boot-warmup render rather than a real
	 * client request. Boot warmup renders the configured paths once during
	 * `starting` to warm the SSR path before readiness; those renders run the
	 * app's server hooks like any request, so a `hooks.server.js` handle that
	 * writes analytics, counts a visit, or touches a per-request resource can
	 * call this to skip that work for the warmup. The tag is by object identity,
	 * never a header, so a real client cannot forge a request that reads as
	 * synthetic.
	 *
	 * @example
	 * ```js
	 * export async function handle({ event, resolve }) {
	 *   if (!event.platform?.isWarmupRequest(event.request)) recordVisit(event);
	 *   return resolve(event);
	 * }
	 * ```
	 */
	isWarmupRequest(request: Request): boolean;

	/**
	 * Invoke `fn(ws, userData)` once for every connection currently
	 * subscribed to `topic`, on this instance. Where `subscribers(topic)`
	 * returns a count, this yields the sockets themselves so a plugin can
	 * make a per-subscriber decision the shared `publish` fan-out cannot:
	 * send a culled / per-viewport slice, skip a back-pressured consumer,
	 * or vary the payload per recipient.
	 *
	 * Cost is O(connections) and is paid only by the caller, so reserve it
	 * for topics that genuinely need per-subscriber treatment (a high-
	 * fan-out cursor topic with viewport culling); the zero-config publish
	 * path never calls it. Pair it with `send` (closed-WS safe) and
	 * `bufferedAmount` inside `fn`.
	 *
	 * Cluster note: each instance holds only its own connections, so this
	 * walks the local subscriber set; a topic whose subscribers span
	 * instances is handled per-instance.
	 *
	 * @example
	 * ```js
	 * // Backpressure-aware per-subscriber cursor fan-out:
	 * platform.forEachSubscriber(`__cursor:${board}`, (ws) => {
	 *   if (platform.bufferedAmount(ws) > maxQueued) return; // skip slow consumer
	 *   platform.send(ws, topic, 'bulk', sliceFor(ws));
	 * });
	 * ```
	 */
	forEachSubscriber(
		topic: string,
		fn: (ws: WebSocket<unknown>, userData: any) => void
	): void;

	/**
	 * The configured maximum size, in bytes, of a single inbound
	 * WebSocket frame. Frames larger than this are rejected by uWS at the
	 * protocol level (the connection is closed). Read this from server-
	 * side code (RPC frameworks, upload primitives, chunked stream
	 * protocols) to size payloads against the actual cap rather than
	 * guessing or piggybacking the value on the wire.
	 *
	 * Configured via `websocket.maxPayloadLength` in `svelte.config.js`;
	 * defaults to 1 MB.
	 *
	 * @example
	 * ```js
	 * // Size upload chunks below the cap, leaving room for envelope:
	 * const chunkSize = Math.floor(platform.maxPayloadLength * 0.9);
	 * ```
	 */
	readonly maxPayloadLength: number;

	/**
	 * Bytes currently queued on `ws` that uWS has accepted but not yet
	 * flushed to the OS socket buffer. Returns 0 for closed connections.
	 *
	 * Use for backpressure-aware sends (skip / coalesce / pace publishes
	 * when the queue is large) and per-connection memory-pressure
	 * telemetry. Constant-time: one C++ call, safe to invoke on every
	 * send.
	 *
	 * @example
	 * ```js
	 * // Skip publish to slow consumer above 4 MB queued:
	 * if (platform.bufferedAmount(ws) > 4 * 1024 * 1024) return;
	 * platform.send(ws, topic, event, data);
	 * ```
	 */
	bufferedAmount(ws: WebSocket<unknown>): number;

	/**
	 * Subscribe a connection to a topic from server-side code, running the
	 * user's `hooks.ws.subscribe` authorization hook first.
	 *
	 * Use this from any server-side path that needs to subscribe a
	 * connection on the user's behalf - RPC handlers, framework
	 * integration layers, plugins - to inherit the centralized
	 * `hooks.ws.subscribe` authorization gate. Calling `ws.subscribe(topic)`
	 * directly bypasses the gate (the wire-level subscribe hook fires only
	 * for `{type:'subscribe'}` and `{type:'subscribe-batch'}` wire frames,
	 * not for direct uWS API calls).
	 *
	 * Returns `null` on success, or a denial reason string on failure
	 * (`'INVALID_TOPIC'`, `'RATE_LIMITED'`, `'FORBIDDEN'`, or any custom
	 * string returned from the user's subscribe hook). On denial, no
	 * subscription is created and internal state is unchanged.
	 *
	 * Idempotent: calling twice with the same `(ws, topic)` returns `null`
	 * both times and does not double-charge counters or trigger the hook
	 * a second time. Updates `WS_SUBSCRIPTIONS` and `totalSubscriptions`
	 * so observability stays consistent with client-initiated subscribes.
	 *
	 * One exception, and it is a revocation rather than a race: if
	 * {@link Platform.unsubscribe} cancels this call while its hook is still
	 * awaiting, and the topic is nonetheless held afterwards only because that
	 * cancelled hook installed membership itself (a plugin join), the call
	 * resolves `'FORBIDDEN'` and removes that membership rather than reporting
	 * it as a success. A subscription granted AFTER the revocation is current
	 * authority and still resolves `null`.
	 * Does not send a `{type:'subscribed', topic, ref}` ack frame - there
	 * is no client `ref` for a server-initiated subscribe.
	 *
	 * Returns a `Promise` because the user's subscribe / subscribeBatch
	 * hook may be async (the framework awaits the hook before inspecting
	 * its return). Callers must `await` the result.
	 *
	 * Closed-WS safe: if the socket closes during the awaited hook (or
	 * before the call, e.g. caller `await`-ed something else first) the
	 * method silently returns `null` rather than propagating uWS's
	 * "Invalid access of closed uWS.WebSocket" exception. Each abort
	 * increments `platform.closedWsAborts`. Callers can fire-and-forget
	 * without a per-site try/catch.
	 *
	 * @example
	 * ```js
	 * // In an RPC handler that needs to subscribe the connection
	 * // on the user's behalf, with the centralized auth gate:
	 * const denial = await platform.subscribe(ws, topic);
	 * if (denial) {
	 *   return reply({ error: denial });
	 * }
	 * // Authorized - proceed with the loader / initial data.
	 * ```
	 */
	subscribe(ws: WebSocket<unknown>, topic: string): Promise<string | null>;

	/**
	 * Consult the user's subscribe-hook chain for a single topic without
	 * actually subscribing the connection. Returns `null` to allow or a
	 * string denial reason to deny.
	 *
	 * Use this when the caller wants to make the subscribe decision in
	 * one step and perform the actual `ws.subscribe` later as part of a
	 * different orchestration - e.g. an RPC framework that runs a
	 * loader between authorization and the subscribe, and wants the
	 * loader to fail cleanly without leaving a half-subscribed
	 * connection or a spurious 'join' broadcast.
	 *
	 * Mirrors the wire-level subscribe-batch precedence: if the user
	 * has exported `subscribeBatch`, that hook is consulted first (with
	 * the single topic in a 1-element array); otherwise the per-topic
	 * `subscribe` hook is consulted. A user who exports only one of the
	 * two still gets a consistent gate across single and batch entry
	 * points.
	 *
	 * Pure - does not modify subscription state, does not call
	 * `ws.subscribe`, does not increment the subscription counter. The
	 * cap (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) is NOT consulted here
	 * because no subscription is being created; cap enforcement belongs
	 * on the actual subscribe action. If the caller plans to follow a
	 * `null` return with a `ws.subscribe`, route through
	 * `platform.subscribe` for atomic gate + subscribe + cap + state
	 * update instead.
	 *
	 * Returns a `Promise` because the user's subscribe / subscribeBatch
	 * hook may be async (the framework awaits the hook before inspecting
	 * its return). Callers must `await` the result. Fail-closed: a
	 * throwing user hook denies with `'INTERNAL_ERROR'` rather than
	 * crashing the caller.
	 *
	 * Pass `{ requireGrant: true }` for an OBSERVER lane - a caller showing a
	 * connection state for a topic it should already hold, rather than one
	 * deciding whether to grant it. With wire-subscribe authorization armed
	 * and no app subscribe hook, that mode also requires the topic to be in
	 * the connection's grant set (a prior `platform.subscribe`), which is what
	 * stops `presence.sync` / `cursor.snapshot` handing over a cross-tenant
	 * roster. Membership is checked again after an async side-effect hook, so a
	 * `platform.unsubscribe` that lands while authorization is pending revokes
	 * the observation; a topic genuinely re-granted before the check lands is
	 * admitted. It is deliberately not the default: the ordinary use below gates
	 * BEFORE the grant exists, so requiring one would deny every such call.
	 * Observer mode also applies the configured client wire-topic alphabet,
	 * because presence/cursor pass a topic named by a snapshot frame rather than
	 * a server-trusted string.
	 *
	 * @example
	 * ```js
	 * // Inside a stream-RPC handler that gates before running the
	 * // loader, and subscribes only if the loader succeeds:
	 * const denial = await platform.checkSubscribe(ws, topic);
	 * if (denial) return reply({ id, ok: false, error: denial });
	 * const initial = await loader(args, ws);
	 * ws.subscribe(topic);
	 * onJoin(ws, topic);
	 * reply({ id, ok: true, data: initial, topic });
	 * ```
	 */
	checkSubscribe(
		ws: WebSocket<unknown>,
		topic: string,
		options?: { requireGrant?: boolean }
	): Promise<string | null>;

	/**
	 * Arm wire-subscribe authorization for this worker (the programmatic
	 * equivalent of the `websocket.authorizeWireSubscribe` option). Once armed,
	 * a CLIENT-initiated `subscribe` / `subscribe-batch` frame is honored only
	 * for a topic the server already authorized for that connection via
	 * `platform.subscribe`, unless the app exports its own `subscribe` /
	 * `subscribeBatch` hook (which then decides). Pass `'strict'` to require
	 * BOTH that server grant and an application-hook allow; strict is latched and
	 * cannot be downgraded by a later legacy call. Server-side `platform.subscribe`
	 * is the trusted grant-establishing path and is never gated by this;
	 * `platform.checkSubscribe(ws, topic, { requireGrant: true })` - the
	 * observer-lane mode - additionally requires grant-set membership once
	 * armed.
	 *
	 * For a framework that owns subscription authorization and routes every
	 * legitimate subscribe through `platform.subscribe` (e.g. svelte-realtime,
	 * which gates each subscription in its stream RPC): call once at startup,
	 * before connections arrive. Idempotent and worker-wide; call it from each
	 * worker's startup hook rather than expecting one worker's call to mutate
	 * another worker's JavaScript realm.
	 */
	authorizeWireSubscribe(): 'legacy' | 'strict';
	authorizeWireSubscribe(mode: 'legacy' | 'strict'): 'legacy' | 'strict';

	/**
	 * Unsubscribe a connection from a topic from server-side code.
	 * Symmetric counterpart to `platform.subscribe()`.
	 *
	 * Idempotent: returns `false` if the connection was not subscribed,
	 * otherwise removes the subscription, decrements `totalSubscriptions`,
	 * fires `hooks.ws.unsubscribe` (informational, not a gate - mirrors
	 * the wire-level unsubscribe path), and returns `true`.
	 *
	 * The decrement describes LIVE connections. Once a socket's close has
	 * been accounted, every membership it held was released as a whole, so
	 * a call landing after that - an async plugin leave, a revocation
	 * resuming late - still removes and still returns `true`, but charges
	 * nothing. Charging it again would put the counter below the truth.
	 *
	 * A topic whose subscribe is still in flight (parked in an async
	 * authorization-hook await) is tombstoned instead: the pending grant
	 * is discarded when the awaited subscribe lands, and the cancel
	 * counts as a removal (`true`).
	 *
	 * Closed-WS safe: returns `false` and bumps `platform.closedWsAborts`
	 * if the socket has already closed.
	 */
	unsubscribe(ws: WebSocket<unknown>, topic: string): boolean;

	/**
	 * Authorize a connection to publish to `topic` via the client-driven relay
	 * (`game`) lane - the trusted server-side dual of `platform.subscribe`. Bind
	 * this at join, after the connection is authorized for the room.
	 *
	 * A client `game` frame carries NO topic; the server derives it from this
	 * binding, so a client can only publish to a room it was granted. A
	 * connection holds at most one publish binding (one room per socket); a
	 * second call re-binds to the new topic. This is the general
	 * publish-authorization primitive - a real-time game session is its first
	 * consumer, but any app can grant a client the right to publish to a room.
	 *
	 * The client sends `{ type: 'game', event, data, id? }`; the server stamps a
	 * monotonic per-room `seq` and fans `{ topic, event, data, seq, id? }` out to
	 * the room's other subscribers (the sender is excluded - it predicts locally
	 * from its own input). An ungranted or malformed frame is answered to the
	 * sender with `{ type: 'game-denied', reason, id? }`.
	 *
	 * Closed-WS safe: returns `false` (and bumps `platform.closedWsAborts`) if the
	 * socket has already closed, otherwise binds and returns `true`.
	 * Throws when the runtime has more than one I/O worker: this lane's sequencer
	 * is deliberately single-home. A clustered deployment may keep one I/O
	 * worker and use the remaining workers as compute workers, or supply an
	 * external authoritative room sequencer instead.
	 */
	grantPublish(ws: WebSocket<unknown>, topic: string): boolean;

	/**
	 * Clear a connection's client-publish binding - the dual of `unsubscribe`,
	 * for session end. After this the connection's `game` frames are denied
	 * (`game-denied` `FORBIDDEN`) until re-granted. Idempotent: returns `true` if
	 * a binding was cleared, `false` if there was none (or the socket had closed).
	 */
	revokePublish(ws: WebSocket<unknown>): boolean;

	/**
	 * The topic a connection is currently bound to publish to via the `game`
	 * lane, or `null` when it holds no grant. Read-only introspection.
	 */
	publishGrant(ws: WebSocket<unknown>): string | null;

	/**
	 * Relay a `game`-lane message to a topic's local subscribers from
	 * server-side code, EXCLUDING `senderWs` and echoing its client `id`. The
	 * server stamps the per-room `seq`. This is the same primitive the wire-level
	 * `game` handler calls after resolving the topic from the sender's grant;
	 * call it directly to inject a server-authored frame into the relay sequence
	 * (e.g. a bot's input). Returns the stamped `seq` and the number of
	 * subscribers delivered to.
	 * Throws in a topology with more than one I/O worker for the same reason as
	 * `grantPublish`: local fan-out cannot satisfy the cluster-wide contract.
	 *
	 * Egress note: this is the one publish with a socket in hand, so its
	 * `websocket.egress` tenant is the SENDER's frozen `attribution` tenant
	 * id (never the `egressTenantOf` topic resolver). A ceiling refusal
	 * returns `{ seq: null, delivered: 0 }` with no sequence consumed.
	 */
	publishGame(
		senderWs: WebSocket<unknown> | null,
		topic: string,
		event: string,
		data?: unknown,
		id?: number | string
	): { seq: number | null; delivered: number };

	/**
	 * Live snapshot of worker-local backpressure signals.
	 *
	 * Sampled by a coarse 1 Hz timer (configurable via
	 * `WebSocketOptions.pressure.sampleIntervalMs`). Reading the snapshot
	 * is a property access; no I/O or computation per read.
	 *
	 * `reason` is the most urgent active signal. Precedence is fixed:
	 * `MEMORY > CAPACITY > CPU_QUOTA > PSI > PUBLISH_RATE > SUBSCRIBERS`. A
	 * worker under multiple stresses reports the highest-priority one.
	 * `'CAPACITY'` appears only when the protection posture is engaged (see
	 * `protection`); `'CPU_QUOTA'` and `'PSI'` only on hosts exposing the
	 * kernel sources.
	 *
	 * @example
	 * ```js
	 * export async function POST({ platform, request }) {
	 *   if (platform.pressure.reason === 'MEMORY') {
	 *     return new Response('Try again shortly', { status: 503 });
	 *   }
	 *   const todo = await db.create(await request.formData());
	 *   platform.publish('todos', 'created', todo);
	 *   return new Response('OK');
	 * }
	 * ```
	 */
	readonly pressure: PressureSnapshot;

	/**
	 * Live protection posture: `'normal'`, `'elevated'`, or `'siege'`. Resolves
	 * the operator's `WebSocketOptions.protection` setting against the current
	 * pressure (when set to `'auto'`); a pinned value reads back as itself, and
	 * an absent setting reads `'normal'`. Reading is a property access. Governs
	 * only NEW-upgrade admission; existing connections are never affected.
	 *
	 * Use it in hook code to tighten an extension's behaviour under load, e.g.
	 * require a capability cookie only when `platform.protection !== 'normal'`.
	 */
	readonly protection: 'normal' | 'elevated' | 'siege';

	/**
	 * The metrics registry configured via `WebSocketOptions.metrics` (a module
	 * path whose default export is the registry), or `null` when unset. This is
	 * the SAME instance the adapter populates with admission/posture instruments,
	 * so a scrape route can expose its Prometheus-text output directly. With the
	 * Vite plugin the module is bundled into the app's own server graph, so a
	 * direct import of the metrics module reads this same instance; on a build
	 * made without the plugin (standalone fallback, the build warns), this
	 * property is the only read point that reaches the populated copy.
	 *
	 * @example
	 * ```js
	 * // src/routes/metrics/+server.js
	 * export const GET = ({ platform }) =>
	 *   new Response(platform.metrics.serialize(), {
	 *     headers: { 'content-type': 'text/plain; version=0.0.4' }
	 *   });
	 * ```
	 */
	readonly metrics: MetricsRegistry | null;

	/**
	 * Cluster-wide metrics in Prometheus text format, or `null` when no
	 * `metrics` registry is configured (or it has no `serialize()`).
	 *
	 * `platform.metrics.serialize()` renders ONE worker: every worker thread
	 * builds its own registry, and they all serve the same port, so a scrape
	 * lands on an arbitrary worker and gets an arbitrary fraction of the truth.
	 * Counters appear to jump backwards between scrapes, gauges alias across
	 * workers, and every `rate()` over them is noise. There is no per-worker
	 * port to scrape instead - this is the way to get the whole picture.
	 *
	 * Each metric combines by its declared law: counters and per-worker
	 * quantities add, process-wide readings and saturation take the worst,
	 * sample freshness takes the stalest.
	 *
	 * It reports the ADAPTER's metrics. What crosses the thread boundary is the
	 * values the adapter itself wrote, keyed by its own declared names, never
	 * your registry's rendered text. A prefix therefore affects only
	 * `platform.metrics.serialize()`; this snapshot always emits unprefixed
	 * adapter names, and `serialize()` is not required. A metric your app registered is not
	 * included: the adapter cannot know whether yours should be summed, maxed
	 * or averaged, and guessing would be a silent wrong number. Read those from
	 * `platform.metrics` per worker.
	 *
	 * Cluster counters do not decrease between consecutive documents from one
	 * process. That takes three mechanisms, because a summed counter can fall
	 * for three different reasons and only one of them involves a restart:
	 *
	 * - A worker that EXITS has its final counter totals carried forward, so a
	 *   replacement starting at zero does not drop the sum.
	 * - A LIVE worker that misses the collection deadline - a long synchronous
	 *   stretch, a major collection - contributes its last known counter totals
	 *   rather than dropping out. A per-worker counter never decreases, so
	 *   re-using its previous total undercounts it for that scrape instead of
	 *   erasing it.
	 * - A DEGRADED document omits counter families entirely rather than
	 *   publishing one worker's fraction of them. A gap reads as staleness; a
	 *   smaller value for a growing series reads as a counter reset, and the
	 *   recovery then gets charged as traffic that never happened.
	 *
	 * Only counters are carried - a gauge describes a live worker, and a stale
	 * connection count is a wrong number rather than a lagging one. So gauges
	 * DO dip when a worker is missing, which is what
	 * `metrics_snapshot_workers_reporting` is for.
	 *
	 * The residual is one-directional: a total can lag reality by up to one
	 * collection interval of one worker's traffic. It does not go backwards.
	 *
	 * The document always carries `metrics_snapshot_workers_expected` and
	 * `metrics_snapshot_workers_reporting`. Reporting means more than answering
	 * IPC: every required counter factory must be registered and every required
	 * worker gauge must have produced a numeric sample. An empty, restarted, or
	 * partly initialized worker therefore lowers reporting instead of silently
	 * omitting families from a document that claims completeness. When the two
	 * values differ, alert on the partial answer rather than reading a summed
	 * series dip as a real traffic drop.
	 *
	 * It also carries `metrics_snapshot_degraded`, `1` when the collection did
	 * not complete at all and the document is this worker alone. That case
	 * needs its own flag: a worker that never heard back from the primary does
	 * not know how many siblings it has, so expected and reporting would agree
	 * with each other and the partial-answer alert above would stay silent.
	 *
	 * One collection runs at a time across the whole cluster - a request that
	 * arrives while one is open joins it - so hitting the route hard cannot fan
	 * out into a cluster broadcast per request. The bound is enforced by the
	 * primary, not per worker: N workers each admitting one collection that
	 * fans out to all N would be the amplification it is meant to prevent.
	 *
	 * In a single-process deployment this still merges (of one worker), so the
	 * document has the same shape either way and enabling `CLUSTER_WORKERS`
	 * does not change what your dashboard reads.
	 *
	 * @param options.timeoutMs How long to wait for workers to report, clamped
	 *   to 50-10000ms. Default 2000. The ceiling sits below a default Prometheus
	 *   scrape timeout on purpose: a slower snapshot is useless to its caller,
	 *   and one generous deadline would become the wait for every caller that
	 *   joins that collection.
	 *
	 * @example
	 * ```js
	 * // src/routes/metrics/+server.js
	 * export const GET = async ({ platform }) => {
	 *   const body = await platform.metricsSnapshot();
	 *   if (body === null) return new Response('metrics not configured', { status: 503 });
	 *   return new Response(body, {
	 *     headers: { 'content-type': 'text/plain; version=0.0.4' }
	 *   });
	 * };
	 * ```
	 */
	metricsSnapshot(options?: { timeoutMs?: number }): Promise<string | null>;

	/**
	 * Register a callback fired on each pressure-state transition (when
	 * `pressure.reason` changes between samples). Fired at most once per
	 * sample tick. Returns an unsubscribe function.
	 *
	 * Use this for push-style reaction: pause background streams when the
	 * worker is under load, resume them when it recovers.
	 *
	 * Callbacks run synchronously inside the sampler. A throwing listener
	 * does not break the sampler or other listeners; the error is logged
	 * and the next listener still runs.
	 *
	 * @example
	 * ```js
	 * export function open(ws, { platform }) {
	 *   const off = platform.onPressure(({ reason, active }) => {
	 *     ws.send(JSON.stringify({ topic: '__pressure', event: reason, data: { active } }));
	 *   });
	 *   ws.getUserData().__offPressure = off;
	 * }
	 *
	 * export function close(ws) {
	 *   ws.getUserData().__offPressure?.();
	 * }
	 * ```
	 */
	onPressure(cb: (snapshot: PressureSnapshot) => void): () => void;

	/**
	 * Register a callback fired once per sample window with the list of
	 * topics whose publish rate has crossed `topicPublishRatePerSec` or
	 * `topicPublishBytesPerSec` for that window. Each entry is
	 * `{ topic, messagesPerSec, bytesPerSec }`.
	 *
	 * Use this to log, page on-call, or apply a per-topic backpressure
	 * response. Registering at least one callback suppresses the
	 * default throttled `console.warn` output - the user owns the
	 * surface at that point.
	 *
	 * Callbacks run synchronously inside the sampler. A throwing
	 * listener does not break the sampler or other listeners; the
	 * error is logged and the next listener still runs. Returns an
	 * unsubscribe function.
	 *
	 * @example
	 * ```js
	 * adapter({
	 *   websocket: {
	 *     pressure: {
	 *       topicPublishRatePerSec: 10000,
	 *       topicPublishBytesPerSec: 5 * 1024 * 1024
	 *     }
	 *   }
	 * });
	 *
	 * // In a server hook or load function:
	 * platform.onPublishRate((events) => {
	 *   for (const e of events) {
	 *     metrics.record('runaway_publisher', { topic: e.topic, rate: e.messagesPerSec });
	 *   }
	 * });
	 * ```
	 */
	onPublishRate(cb: (events: TopicPublishRate[]) => void): () => void;

	/**
	 * Get a scoped helper for a topic. Reduces repetition when publishing
	 * multiple events to the same topic, and provides CRUD shorthand methods
	 * that pair with the client's `crud()` helper.
	 *
	 * @param topic - Topic string (e.g. `'todos'`, `'user:123'`)
	 *
	 * @example
	 * ```js
	 * // In a form action:
	 * export async function POST({ platform, request }) {
	 *   const todos = platform.topic('todos');
	 *   const todo = await db.create(await request.formData());
	 *   todos.created(todo);   // clients see 'created' event
	 * }
	 *
	 * export const actions = {
	 *   update: async ({ platform, request }) => {
	 *     const todos = platform.topic('todos');
	 *     const todo = await db.update(await request.formData());
	 *     todos.updated(todo); // clients see 'updated' event
	 *   },
	 *   delete: async ({ platform, request }) => {
	 *     const todos = platform.topic('todos');
	 *     const id = (await request.formData()).get('id');
	 *     await db.delete(id);
	 *     todos.deleted({ id }); // clients see 'deleted' event
	 *   }
	 * };
	 * ```
	 */
	topic(topic: string): TopicHelper;

	/**
	 * Current generation of a topic's seq space. A reconnecting client
	 * presents the epoch it last saw per topic (alongside its `lastSeenSeqs`);
	 * compare each to this value in your `resume` hook to decide whether the
	 * client's offset is still valid (gap-fill) or points into a seq space
	 * that has since reset (cold-rehydrate).
	 *
	 * In a single worker the seq counters live in process memory and all
	 * reset together on a restart, so every topic shares the one per-process
	 * generation. A backend with its own per-topic seq authority (a shared
	 * store) reports a per-topic value of the same shape.
	 */
	topicEpoch(topic: string): number;

	/**
	 * Current wall-clock time in milliseconds since the epoch, read through the
	 * adapter's injectable runtime so plugins and app code share one swappable
	 * clock a controlled harness can seed. Coarsely cached (about 1 Hz), so it
	 * is for timestamps and throttle windows rather than sub-millisecond timing.
	 */
	now(): number;

	/**
	 * Strictly-forward monotonic time in milliseconds, immune to wall-clock
	 * steps. Use for measuring durations; pair two reads and subtract.
	 */
	monotonic(): number;

	/**
	 * A hybrid logical clock stamp for events that must order consistently
	 * across workers (or across a coarse / briefly-backward wall clock).
	 *
	 * - `wall` is a non-decreasing wall-clock value in epoch milliseconds,
	 *   sourced from the injectable runtime clock. It never moves backward:
	 *   a same-millisecond or backward clock read holds the previous value.
	 * - `logical` is a tiebreaker that resets to `0` whenever `wall` advances
	 *   and increments when two stamps share a millisecond, so the
	 *   `(wall, logical)` pair is a strict per-process ordering.
	 * - `nodeId` is a short, stable per-process identity assigned once at
	 *   init from the injectable runtime RNG (a seeded harness reproduces it);
	 *   in clustered mode it is effectively the worker identity.
	 *
	 * Call only when an event needs a causal stamp - it is intentionally off
	 * the per-publish hot path.
	 */
	hlc(): { wall: number; logical: number; nodeId: string };

	/**
	 * Random source read through the adapter's injectable runtime, so a seeded
	 * harness can make values reproducible while production uses the native RNG.
	 */
	random: {
		/** A float in `[0, 1)`, the `Math.random()` contract. */
		float(): number;
		/** An unsigned 32-bit integer. */
		u32(): number;
		/** A RFC 4122 v4 UUID string. */
		uuid(): string;
		/** `n` random bytes. */
		bytes(n: number): Uint8Array;
	};
}

export interface TopicHelper {
	/** Publish a custom event to this topic. */
	publish(event: string, data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('created', data)`. Pairs with `crud()` / `lookup()`. */
	created(data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('updated', data)`. Pairs with `crud()` / `lookup()`. */
	updated(data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('deleted', data)`. Pairs with `crud()` / `lookup()`. */
	deleted(data?: unknown, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('set', value)`. Pairs with `count()`. */
	set(value: number, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('increment', amount)`. Pairs with `count()`. */
	increment(amount?: number, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
	/** Shorthand for `.publish('decrement', amount)`. Pairs with `count()`. */
	decrement(amount?: number, options?: { relay?: boolean; seq?: boolean | number; compress?: boolean; jitterMs?: number }): void;
}

// `upgradeResponse` is exported from the 'svelte-adapter-uws/upgrade-response' subpath, not
// from this root module - see src/upgrade-response.d.ts for the helper and its docs.

// Build internals. These are not part of the supported API and carry no
// compatibility promise - they are declared because the module really does
// export them, and a runtime export with no declaration is the drift this
// package closed once already (an import that runs but does not typecheck).
// Prefer configuring the adapter through `AdapterOptions`.

/**
 * Top-level option keys the adapter factory recognizes. Anything else passed
 * to `adapter()` is ignored and warned about at build time; only a known key
 * with an unusable value fails the build.
 * @internal
 */
export declare const KNOWN_ADAPTER_OPTION_KEYS: ReadonlySet<string>;

/**
 * Top-level keys in an adapter options object that the factory does not
 * recognize, each annotated with the closest documented key when one is close
 * enough to name.
 * @internal
 */
export declare function unknownAdapterOptionKeys(
	opts: Record<string, unknown> | null | undefined
): string[];

/**
 * Websocket option keys the adapter recognizes. Anything else in the
 * `websocket` object is dropped at build time and warned about.
 * @internal
 */
export declare const KNOWN_WEBSOCKET_OPTION_KEYS: ReadonlySet<string>;

/**
 * Keys present in a `websocket` object that the adapter does not recognize.
 * @internal
 */
export declare function unknownWebsocketOptionKeys(
	websocket: Record<string, unknown> | null | undefined
): string[];

/**
 * The build-time warning naming every static path the dotfile rule refuses.
 * The `.well-known` carve-out exempts the first path segment, not the tree
 * under it, so the message must not promise more than its own list delivers.
 * @internal
 */
export declare function renderRefusedDotfileWarning(refused: string[]): string;

/**
 * Serialize normalized websocket options into the object baked into the build.
 * Throws when a flag that restricts access carries a non-boolean value, since
 * reading such a value as "off" would silently disarm it.
 * @internal
 */
export declare function serializeWsOptions(
	websocket: Record<string, unknown> | null,
	adminPath: string | false
): Record<string, unknown>;

/**
 * Recognized keys inside the nested `websocket` option objects, keyed by the
 * dotted path of the object they belong to. A typo nested one level down is
 * dropped just as silently as a top-level one, so these are checked too.
 * @internal
 */
export declare const KNOWN_NESTED_WEBSOCKET_OPTION_KEYS: Readonly<
	Record<string, ReadonlySet<string>>
>;

/**
 * Read the record the Vite plugin leaves of which module it built the
 * WebSocket handler from. `null` when the build carries no such record.
 * @internal
 */
export declare function readHandlerOrigin(
	tmp: string
): { source: string; absolute: string | null; from: string } | null;

/**
 * Refuse when the adapter's `websocket.handler` disagrees with the module the
 * Vite plugin actually bundled, which would otherwise ship a handler the app
 * did not ask for. Warns only when an older/unrelated plugin emitted no origin
 * record at all.
 * @internal
 */
export declare function assertBundledHandlerMatches(
	handler: string | null | undefined,
	origin: { source: string; absolute?: string | null; from: string } | null,
	log: { warn: (msg: string) => void }
): void;

/**
 * Read the record the Vite plugin leaves of which module it built the metrics
 * registry from. `null` when the build carries no such record.
 * @internal
 */
export declare function readMetricsOrigin(
	tmp: string
): { source: string; absolute: string | null; from: string } | null;

/**
 * Refuse when the adapter's `websocket.metrics` disagrees with the module the
 * Vite plugin actually bundled, which would otherwise ship adapter counters
 * incrementing on a registry no scrape route reads. Warns only when an
 * older/unrelated plugin emitted no origin record at all.
 * @internal
 */
export declare function assertBundledMetricsMatches(
	metrics: string | null | undefined,
	origin: { source: string; absolute?: string | null; from: string } | null,
	log: { warn: (msg: string) => void }
): void;

export default function adapter(options?: AdapterOptions): Adapter;
