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
}

// -- User's WebSocket handler module exports ---------------------------------

/**
 * Context passed to the `upgrade` handler.
 */
export interface UpgradeContext {
	/** Request headers (all lowercase keys). */
	headers: Record<string, string>;
	/** Parsed cookies from the Cookie header. */
	cookies: Record<string, string>;
	/** The request URL path. */
	url: string;
	/** Remote IP address. */
	remoteAddress: string;
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
	 * Called during the HTTP upgrade handshake.
	 *
	 * - Return an object to accept - it becomes `ws.getUserData()`.
	 * - Return `false` to reject with 401.
	 * - Omit this export to accept all connections with `{}` as user data.
	 *
	 * May be async.
	 */
	upgrade?: (ctx: UpgradeContext) => UserData | false | Promise<UserData | false>;

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
	 * - Return `false` to deny the subscription (silently ignored on the client).
	 * - Return anything else (or omit this export) to allow.
	 *
	 * Use this for per-topic authorization - e.g. only let admins subscribe to `'admin'`.
	 *
	 * @example
	 * ```js
	 * export function subscribe(ws, topic, { platform }) {
	 *   const { role } = ws.getUserData();
	 *   if (topic.startsWith('admin') && role !== 'admin') return false;
	 * }
	 * ```
	 */
	subscribe?: (ws: WebSocket<UserData>, topic: string, ctx: SubscribeContext) => boolean | void;

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

	/** Called when the connection closes. */
	close?: (ws: WebSocket<UserData>, ctx: CloseContext) => void;
}

// -- Platform type for event.platform ----------------------------------------

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
	 * @param topic - Topic string (e.g. `'todos'`, `'user:123'`, `'org:456'`)
	 * @param event - Event name (e.g. `'created'`, `'updated'`, `'deleted'`)
	 * @param data - Payload (will be JSON-serialized)
	 * @param options - Optional. Pass `{ relay: false }` to skip cross-worker relay
	 *   (use this when the message comes from an external pub/sub source like Redis
	 *   or Postgres that already delivers to every process).
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
	publish(topic: string, event: string, data?: unknown, options?: { relay?: boolean }): boolean;

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
	 * Send a message to all connections whose userData matches a filter.
	 * Returns the number of connections the message was sent to.
	 *
	 * The filter receives each connection's userData (whatever `upgrade()` returned).
	 *
	 * **Performance note:** `sendTo()` iterates every open connection on the local
	 * worker to evaluate the filter. For broadcasting to large groups, prefer
	 * `publish()` with a topic — topics are dispatched by uWS's C++ TopicTree
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

export default function adapter(options?: AdapterOptions): Adapter;
