import type { Adapter } from '@sveltejs/kit';
import type { WebSocket } from 'uWebSockets.js';
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
 * cert until a restart (the SSLApp default context is static). Automatic reload is
 * single-process only in this release; a cluster deployment reloads on restart.
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
	 * Reports `200` when ready and `503` once graceful shutdown has begun, so a
	 * fronting load balancer stops routing NEW traffic to a draining instance
	 * while its in-flight requests finish. Keep it separate from
	 * `healthCheckPath` (a readiness `503` during drain must not trip a liveness
	 * probe into a restart). Must differ from `healthCheckPath`. Set to `false`
	 * to disable.
	 * @default '/readyz'
	 */
	readinessCheckPath?: string | false;

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
	 * build warning and is ignored. Merged once at build/index time, so there
	 * is zero per-request cost.
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
	 * Only specify this if your handler lives at a non-standard path.
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
	 * Max message size in bytes. Connections sending larger messages are closed.
	 * Default 1 MB is balanced for typical app payloads in a single frame; uWS
	 * itself defaults to 16 KB. Lower this for stricter caps (e.g. `16 * 1024`
	 * for the uWS-matching 16 KB) when payload-size discipline matters.
	 * @default 1048576 (1 MB)
	 */
	maxPayloadLength?: number;

	/**
	 * Seconds of inactivity before the connection is closed.
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
	 * - `'same-origin'` - only accept connections where Origin matches Host and scheme *(default)*
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
	 * @default 10
	 */
	upgradeRateLimit?: number;

	/**
	 * Time window in seconds for the upgrade rate limiter.
	 * @default 10
	 */
	upgradeRateLimitWindow?: number;

	/**
	 * Admission control for WebSocket upgrades. Two independent layers,
	 * both opt-in (omit or set to `0` to disable):
	 *
	 * - `maxConcurrent` caps how many upgrades may be in flight at once.
	 *   Crossed requests get a fast `503 Service Unavailable` before any
	 *   per-request work, so a connection storm can be shed without
	 *   spending CPU on TLS / header parsing / cookie decoding.
	 * - `perTickBudget` caps how many `res.upgrade()` calls run per
	 *   event-loop tick. Once the budget is spent, the actual upgrade
	 *   call is deferred via `setImmediate` so the loop is not starved
	 *   by 10K synchronous handshakes from one I/O batch. Pre-upgrade
	 *   work (rate limit check, origin check, hook dispatch) still runs
	 *   in the original tick; only the hand-off to the C++ upgrade
	 *   path is paced.
	 *
	 * Both default to `0` (disabled). Tune to your peak-load envelope:
	 * `maxConcurrent` should be just above your steady-state in-flight
	 * count to act as a circuit breaker; `perTickBudget` should be
	 * small enough that one full burst does not block other I/O for
	 * more than a few milliseconds (start with `64` and adjust).
	 *
	 * @example
	 * ```js
	 * adapter({
	 *   websocket: {
	 *     upgradeAdmission: { maxConcurrent: 1000, perTickBudget: 64 }
	 *   }
	 * });
	 * ```
	 */
	upgradeAdmission?: {
		maxConcurrent?: number;
		perTickBudget?: number;
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
		 * Defaults to ON whenever `maxConcurrent` is set: browser navigations
		 * get a self-polling holding page that reloads when a slot frees;
		 * WebSocket upgrades and non-browser HTTP clients keep `503` with a
		 * jittered `Retry-After`. Set `false` to force the bare `503` for
		 * every client (today's behaviour). When `maxConcurrent` is unset the
		 * gate never rejects, so the waiting room never engages.
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
			 * Override the built-in holding page with a full HTML document. This is
			 * a string (not a function): adapter options are serialized into the
			 * build, so a function could never reach the production runtime. The
			 * following `{{tokens}}` are substituted with the live, escaped values:
			 * `{{queueDepth}}`, `{{estimatedSeconds}}`, `{{pollIntervalMs}}`,
			 * `{{retryAfterSeconds}}`, `{{admitCheckPath}}`. Include your own poll
			 * script (hitting `{{admitCheckPath}}`) if you want auto-reload; the
			 * built-in page is recommended for that behaviour.
			 *
			 * @example
			 * ```js
			 * template: '<!doctype html><title>Hang tight</title>' +
			 *   '<p>You are number {{queueDepth}} in line (~{{estimatedSeconds}}s).</p>'
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
	 * At `'elevated'` the waiting room widens its `Retry-After` jitter. At
	 * `'siege'` new upgrades are refused at static-serve cost and
	 * `/__admit-check` always reports busy. Requires
	 * `upgradeAdmission.maxConcurrent` to be set for the gate to have anything
	 * to coordinate; `'auto'` is inert without a ceiling.
	 */
	protection?: 'normal' | 'elevated' | 'siege' | 'auto';

	/**
	 * Prometheus-style registry for admission and posture observability.
	 * Off by default; when set, the adapter registers and emits:
	 *
	 * - `upgrade_admitted_total` - upgrades accepted (counter).
	 * - `upgrade_rejected_total{reason}` - upgrades rejected before open
	 *   (counter). Reasons: `siege`, `over_capacity`, `cursor_lane`,
	 *   `ip_rate_limit`, `bad_origin`, `auth_timeout`, `auth_rejected`,
	 *   `hook_error`.
	 * - `upgrade_inflight` - upgrades between admission and open (gauge,
	 *   sampled once per pressure interval).
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
	 *
	 * Accept-path cost is one unlabelled counter increment per admitted
	 * upgrade; rejection branches add one labelled increment each; gauges
	 * ride the existing pressure sampler. With the option unset every site
	 * is a single undefined check. Metric names are unprefixed - pass a
	 * registry built with `createMetrics({ prefix })` to namespace them.
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
	 * the registry; the adapter bundles it, populates it, and exposes the SAME
	 * instance on `platform.metrics`. Scrape it from a route via
	 * `platform.metrics` - do NOT import the metrics module again from app code,
	 * which would create a second, empty copy.
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
	 *     upgradeAdmission: { maxConcurrent: 1000 },
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
	 * A detected violation logs a structured `[adapter-uws/assert]` line and
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
		 * Sample interval in milliseconds. Clamped to a minimum of 100 ms
		 * to prevent pathological tight-loop sampling.
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
	 *
	 * This closes the bypass where a client names a topic it was never granted
	 * (a private room, another tenant's channel) and receives its fan-out,
	 * because the server-side guard ran only on the server-initiated subscribe,
	 * not the client's wire frame. Server-side `platform.subscribe` /
	 * `platform.checkSubscribe` are the trusted authorization path and are never
	 * gated by this. A framework whose subscriptions are all server-initiated
	 * (svelte-realtime) arms this automatically via
	 * `platform.authorizeWireSubscribe()`; direct adapter apps set it here.
	 *
	 * @default false
	 */
	authorizeWireSubscribe?: boolean;

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
	path?: string;
	domain?: string;
	expires?: Date;
	/** In seconds. */
	maxAge?: number;
	httpOnly?: boolean;
	secure?: boolean;
	partitioned?: boolean;
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
	set(name: string, value: string, options?: CookieSerializeOptions): void;
	delete(name: string, options?: Pick<CookieSerializeOptions, 'path' | 'domain'>): void;
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
}

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
	): { inc(labels?: Record<string, string>): void };
	gauge(
		name: string,
		help: string
	): { set(value: number): void };
	/**
	 * Render all metrics in Prometheus text exposition format. Present on the
	 * `createMetrics()` registry from `svelte-adapter-uws-extensions/prometheus`;
	 * optional here because the adapter itself only ever calls `counter`/`gauge`.
	 * Read it from a scrape route via `platform.metrics`.
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
 * - `'RATE_LIMITED'` - per-subscribe rate limit hit. Reserved; not
 *   emitted by the framework today.
 */
export type SubscribeDenialReason =
	| 'UNAUTHENTICATED'
	| 'FORBIDDEN'
	| 'INVALID_TOPIC'
	| 'RATE_LIMITED';

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
	 * Async-allowed. The adapter awaits the returned promise before
	 * closing the listen socket. Throws are logged and ignored: shutdown
	 * is best-effort and the adapter cannot refuse to stop. If your
	 * teardown is strictly required, surface its failure via your own
	 * logging / alerting before the adapter logs it.
	 *
	 * Per-worker firing in clustered mode, same as `init`. Each worker
	 * fires `shutdown` independently when it receives the shutdown signal.
	 *
	 * @example
	 * ```js
	 * // hooks.ws.js
	 * import { live } from 'svelte-realtime/server';
	 *
	 * export async function shutdown({ platform }) {
	 *   await live.flushPendingCronTicks(platform);
	 * }
	 * ```
	 */
	shutdown?: (ctx: { platform: Platform }) => void | Promise<void>;

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
		| boolean | void | SubscribeDenialReason | string;

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
	 * everything". Sync only in v1.
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
	) => Record<string, boolean | SubscribeDenialReason | string> | void;

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
	 */
	resume?: (ws: WebSocket<UserData>, ctx: ResumeContext) => void;

	/** Called when the connection closes. */
	close?: (ws: WebSocket<UserData>, ctx: CloseContext) => void;
}

// - Platform type for event.platform ----------------------------------------

/**
 * Snapshot returned by `platform.pressure` and supplied to
 * `platform.onPressure(cb)` callbacks. All numbers are worker-local.
 */
export interface PressureSnapshot {
	/** `true` when `reason !== 'NONE'`. Convenience flag for boolean checks. */
	readonly active: boolean;
	/**
	 * Worker-global saturation in `0..1`. `0` is idle, `1` is saturated;
	 * higher always means more pressure. It is the worst-of the active
	 * threshold signals' distance toward their thresholds, folded with the
	 * worst per-connection internal flow-control reading. Use it for a coarse
	 * "how loaded is this worker" gauge (e.g. `value > 0.8` for a high-load
	 * guard); `reason` still names the most urgent specific signal.
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
	 * Top 5 topics by message rate during the last sample window, sorted
	 * descending by `messagesPerSec`. Each entry is
	 * `{ topic, messagesPerSec, bytesPerSec }`. Empty when no
	 * `platform.publish()` calls landed in the window.
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
	bytesPerSec: number;
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
	 * The adapter never writes a response header automatically - emitting
	 * `X-Request-ID` on the response is an app-layer concern.
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
	 * In clustered mode the seq is worker-local (each worker stamps its
	 * own publishes; relayed messages pass through with the originating
	 * worker's seq). For cluster-wide monotonic seq, wire up the Redis
	 * Lua INCR variant from the extensions package.
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
	batch(messages: { topic: string; event: string; data?: unknown }[]): boolean[];

	/**
	 * Publish a list of `{topic, event, data}` events as a single
	 * `{type:'batch', events:[...]}` WebSocket frame per affected
	 * subscriber. Each subscriber receives only the events whose topics
	 * are in their subscription set, in submitted order. Subscribers
	 * with no overlap with the batch's topics receive nothing.
	 *
	 * Compared to a `publish()` loop, the wire savings are
	 * one-frame-per-subscriber instead of N-frames-per-subscriber. The
	 * benefit grows with N (events per call) and with subscriber-set
	 * overlap; tiny batches with disjoint topics may pay a small
	 * JS-fanout cost over the C++ TopicTree path used by `publish()`
	 * (the receiver-side decode is faster regardless).
	 *
	 * Capability gating: clients advertise `'batch'` support via a
	 * `{type:'hello', caps:['batch']}` frame after open. The bundled
	 * `svelte-adapter-uws/client` does this automatically. Connections
	 * that have not advertised the capability fall back to N
	 * individual frames - mixing old and new clients in the same call
	 * is safe.
	 *
	 * Cross-worker relay: events are relayed individually through the
	 * existing per-microtask relay path. Receiving workers see N
	 * individual relayed publishes, not a batched delivery. Wire-level
	 * batching applies to the originating worker's local fanout only.
	 * Pass `{relay: false}` per-event to skip the relay (use when the
	 * messages came from an external pub/sub source already fanning
	 * out to every worker).
	 *
	 * Frame-size budget: a batched frame larger than 256 KB triggers a
	 * throttled `console.warn`. Chunk large batches into multiple
	 * `publishBatched` calls.
	 *
	 * Order guarantee: within one batched frame, events appear in call
	 * order. Across batches, same subscriber-side ordering as today.
	 *
	 * Coalesce interaction: events submitted via `publishBatched` do
	 * not interact with `sendCoalesced` per-key replacement; mixing
	 * batched topics and sendCoalesced topics on the same subscriber
	 * is supported but produces separate frames.
	 *
	 * @example
	 * ```js
	 * platform.publishBatched([
	 *   { topic: 'org:42:items', event: 'updated', data: a },
	 *   { topic: 'org:42:items', event: 'updated', data: b },
	 *   { topic: 'org:42:audit', event: 'created', data: c }
	 * ]);
	 * // Subscribers of org:42:items only -> one frame, two events.
	 * // Subscribers of both topics      -> one frame, three events.
	 * // Subscribers of neither          -> no frame at all.
	 * ```
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
		/** Per-message `seq`: `false` omits it, a positive-integer `number` stamps that exact authoritative seq, omitted uses the in-memory counter. */
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
	 * WebSocket closes before a reply arrives. Pending requests are
	 * tracked per-connection, so close cleanup is automatic.
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
	 * name, never a user id, never a socket handle. Pure read (a fresh plain
	 * object each call), so it is safe to expose behind an auth-gated admin
	 * route or feed to a dashboard.
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
		pressure: {
			active: boolean;
			reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY' | 'CPU_QUOTA' | 'PSI' | 'CAPACITY';
			value: number;
			subscriberRatio: number;
			publishRate: number;
			memoryMB: number;
		};
		assertions: Record<string, number>;
	};

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
	checkSubscribe(ws: WebSocket<unknown>, topic: string): Promise<string | null>;

	/**
	 * Arm wire-subscribe authorization for this process (the programmatic
	 * equivalent of the `websocket.authorizeWireSubscribe` option). Once armed,
	 * a CLIENT-initiated `subscribe` / `subscribe-batch` frame is honored only
	 * for a topic the server already authorized for that connection via
	 * `platform.subscribe`, unless the app exports its own `subscribe` /
	 * `subscribeBatch` hook (which then decides). Server-side `platform.subscribe`
	 * / `platform.checkSubscribe` are never gated by this.
	 *
	 * For a framework that owns subscription authorization and routes every
	 * legitimate subscribe through `platform.subscribe` (e.g. svelte-realtime,
	 * which gates each subscription in its stream RPC): call once at startup,
	 * before connections arrive. Idempotent and process-wide.
	 */
	authorizeWireSubscribe(): void;

	/**
	 * Unsubscribe a connection from a topic from server-side code.
	 * Symmetric counterpart to `platform.subscribe()`.
	 *
	 * Idempotent: returns `false` if the connection was not subscribed,
	 * otherwise removes the subscription, decrements `totalSubscriptions`,
	 * fires `hooks.ws.unsubscribe` (informational, not a gate - mirrors
	 * the wire-level unsubscribe path), and returns `true`.
	 *
	 * Closed-WS safe: returns `false` and bumps `platform.closedWsAborts`
	 * if the socket has already closed.
	 */
	unsubscribe(ws: WebSocket<unknown>, topic: string): boolean;

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
	 * so a scrape route can expose its Prometheus-text output directly. Importing
	 * the metrics module again from app code would create a second, empty copy -
	 * read it here instead.
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
	publish(event: string, data?: unknown): void;
	/** Shorthand for `.publish('created', data)`. Pairs with `crud()` / `lookup()`. */
	created(data?: unknown): void;
	/** Shorthand for `.publish('updated', data)`. Pairs with `crud()` / `lookup()`. */
	updated(data?: unknown): void;
	/** Shorthand for `.publish('deleted', data)`. Pairs with `crud()` / `lookup()`. */
	deleted(data?: unknown): void;
	/** Shorthand for `.publish('set', value)`. Pairs with `count()`. */
	set(value: number): void;
	/** Shorthand for `.publish('increment', amount)`. Pairs with `count()`. */
	increment(amount?: number): void;
	/** Shorthand for `.publish('decrement', amount)`. Pairs with `count()`. */
	decrement(amount?: number): void;
}

/**
 * Wrap upgrade hook return value to include response headers on the 101
 * Switching Protocols response.
 *
 * **Warning (Cloudflare):** attaching `Set-Cookie` to the 101 response is
 * rejected by Cloudflare Tunnel and some other strict edge proxies. The
 * WebSocket opens, then closes with code 1006 before any frames are exchanged.
 * For session-cookie refresh use the `authenticate` hook instead, which
 * refreshes cookies over a normal HTTP response and works behind every proxy.
 *
 * This helper remains supported for non-cookie response headers and for
 * deployments that do not sit behind strict proxies.
 *
 * @example Custom non-cookie headers (safe):
 * ```js
 * import { upgradeResponse } from 'svelte-adapter-uws';
 *
 * export function upgrade({ cookies }) {
 *   const session = validateSession(cookies.session_id);
 *   if (!session) return false;
 *   return upgradeResponse({ userId: session.userId }, { 'x-session-version': '2' });
 * }
 * ```
 */
export function upgradeResponse<UserData>(
	userData: UserData,
	headers: Record<string, string | string[]>
): { __upgradeResponse: true; userData: UserData; headers: Record<string, string | string[]> };

export default function adapter(options?: AdapterOptions): Adapter;
