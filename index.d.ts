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
 * | `PROTOCOL_HEADER` | - | Header for protocol detection (e.g. `x-forwarded-proto`) |
 * | `HOST_HEADER` | - | Header for host detection (e.g. `x-forwarded-host`) |
 * | `PORT_HEADER` | - | Header for port override (e.g. `x-forwarded-port`) |
 * | `ADDRESS_HEADER` | - | Header for client IP (e.g. `x-forwarded-for`) |
 * | `XFF_DEPTH` | `1` | Position from right in `X-Forwarded-For` |
 * | `BODY_SIZE_LIMIT` | `512K` | Max request body size (`K`, `M`, `G` suffixes) |
 * | `SHUTDOWN_TIMEOUT` | `30` | Seconds to wait during graceful shutdown |
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
	 * Health check endpoint path. Set to `false` to disable.
	 * @default '/healthz'
	 */
	healthCheckPath?: string | false;

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
	 * Max message size in bytes. Connections sending larger messages are closed.
	 * @default 16384 (16 KB)
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
	 * Enable per-message deflate compression.
	 * Pass `true` for `SHARED_COMPRESSOR`, or a uWS compression constant
	 * (e.g. `uWS.DEDICATED_COMPRESSOR_4KB`) for finer control.
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
	};

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
	};
}

// -- User's WebSocket handler module exports ---------------------------------

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
	/** The platform API - publish, send, topic helpers, etc. */
	platform: Platform;
}

/**
 * Context passed to the `close` handler.
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

// -- Platform type for event.platform ----------------------------------------

/**
 * Snapshot returned by `platform.pressure` and supplied to
 * `platform.onPressure(cb)` callbacks. All numbers are worker-local.
 */
export interface PressureSnapshot {
	/** `true` when `reason !== 'NONE'`. Convenience flag for boolean checks. */
	readonly active: boolean;
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
	 * Most urgent active signal, by fixed precedence:
	 * `MEMORY > PUBLISH_RATE > SUBSCRIBERS > NONE`.
	 */
	readonly reason: 'NONE' | 'PUBLISH_RATE' | 'SUBSCRIBERS' | 'MEMORY';
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
	 *     would grow unbounded).
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
	publish(topic: string, event: string, data?: unknown, options?: { relay?: boolean; seq?: boolean }): boolean;

	/**
	 * Publish multiple messages in one call.
	 * Returns an array of `publish()` results (one per message; `false` means no subscribers).
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
	 * Send a message to a single WebSocket connection.
	 * Wraps in the same `{ topic, event, data }` envelope as `publish()`.
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
	send(ws: WebSocket<any>, topic: string, event: string, data?: unknown): number;

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
	sendTo(filter: (userData: any) => boolean, topic: string, event: string, data?: unknown): number;

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
	 * Live snapshot of worker-local backpressure signals.
	 *
	 * Sampled by a coarse 1 Hz timer (configurable via
	 * `WebSocketOptions.pressure.sampleIntervalMs`). Reading the snapshot
	 * is a property access; no I/O or computation per read.
	 *
	 * `reason` is the most urgent active signal. Precedence is fixed:
	 * `MEMORY > PUBLISH_RATE > SUBSCRIBERS`. A worker under multiple
	 * stresses reports the highest-priority one.
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
