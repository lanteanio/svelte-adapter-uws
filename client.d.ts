import type { Readable } from 'svelte/store';

export interface ConnectOptions {
	/**
	 * Full WebSocket URL to connect to.
	 * When set, `path` is ignored and the client connects to this URL directly.
	 * Enables cross-origin usage (e.g. svelte-native, React Native, standalone clients).
	 * @example 'wss://my-app.com/ws'
	 */
	url?: string;

	/**
	 * WebSocket endpoint path. Must match the adapter config.
	 * @default '/ws'
	 */
	path?: string;

	/**
	 * Base delay in ms before reconnecting after a disconnect.
	 * The actual delay grows as `base * 2.2^attempt` with a +/- 25%
	 * jitter, capped at `maxReconnectInterval`.
	 * @default 3000
	 */
	reconnectInterval?: number;

	/**
	 * Maximum delay in ms between reconnection attempts. Once the
	 * exponential curve hits this cap it stays there until the
	 * connection succeeds. The default 5 minute cap is long enough
	 * that 10K clients hammering a recovering server don't sustain the
	 * outage, short enough that a recovered server picks up its
	 * clients within a coffee break.
	 * @default 300000
	 */
	maxReconnectInterval?: number;

	/**
	 * Maximum number of reconnection attempts before giving up.
	 * @default Infinity
	 */
	maxReconnectAttempts?: number;

	/**
	 * Log all WebSocket events to the console.
	 * Useful during development to see exactly what's happening.
	 * @default false
	 */
	debug?: boolean;

	/**
	 * Run a pre-WebSocket HTTP preflight against the adapter's `authenticate`
	 * endpoint before opening the socket. Required only when your server's
	 * `hooks.ws` exports an `authenticate` hook that refreshes session cookies.
	 *
	 * - `true` (recommended) - use the default path `/__ws/auth`
	 * - `string` - use a custom path, e.g. `'/api/ws/auth'`
	 * - `false` / omit - disabled, no preflight (default)
	 *
	 * The preflight is a `fetch(authPath, { method: 'POST', credentials: 'include' })`
	 * that runs before every connect (including reconnects) so rotated session
	 * cookies are picked up. Concurrent connect attempts share a single in-flight
	 * request. On a non-2xx response, the connection is not opened and the status
	 * store transitions to `'closed'` with a permanent rejection.
	 *
	 * This exists because `Set-Cookie` on a 101 Switching Protocols response is
	 * silently dropped by Cloudflare Tunnel and some other strict edge proxies,
	 * which closes the WebSocket with code 1006 before any frames are exchanged.
	 * Refreshing cookies via a normal HTTP response works behind every proxy.
	 *
	 * @default false
	 *
	 * @example
	 * ```ts
	 * // src/hooks.ws.ts
	 * export function authenticate({ cookies }) {
	 *   const session = validateSession(cookies.get('session'));
	 *   if (!session) return false;
	 *   cookies.set('session', renewSession(session), {
	 *     httpOnly: true, secure: true, sameSite: 'lax', path: '/'
	 *   });
	 * }
	 *
	 * // src/routes/+layout.svelte
	 * import { connect } from 'svelte-adapter-uws/client';
	 * connect({ auth: true });
	 * ```
	 */
	auth?: boolean | string;
}

/**
 * A message received from the server via `platform.publish(topic, event, data)`.
 */
export interface WSEvent<T = unknown> {
	/** The topic this message was published to. */
	topic: string;
	/** The event name (e.g. `'created'`, `'updated'`, `'deleted'`). */
	event: string;
	/** The event payload. */
	data: T;
	/**
	 * Monotonic per-topic sequence number stamped by the server on every
	 * `platform.publish()` (omitted when the publisher opts out via
	 * `{ seq: false }`). Each topic has an independent counter starting
	 * at 1.
	 *
	 * Worker-local in clustered mode unless an extension provides a
	 * cluster-wide source of truth (e.g. Redis Lua INCR).
	 */
	seq?: number;
}

// -- Scannable store ----------------------------------------------------------

/**
 * A readable store with an additional `.scan()` method for accumulating state.
 */
export interface TopicStore<T> extends Readable<T | null> {
	/**
	 * Create a derived store that accumulates events using a reducer.
	 *
	 * Like `Array.reduce` but reactive - each new event feeds through
	 * the reducer and the store updates with the new accumulated value.
	 *
	 * @example
	 * ```svelte
	 * <script>
	 *   import { on } from 'svelte-adapter-uws/client';
	 *
	 *   const todos = on('todos').scan([], (list, { event, data }) => {
	 *     if (event === 'created') return [...list, data];
	 *     if (event === 'deleted') return list.filter(t => t.id !== data.id);
	 *     if (event === 'updated') return list.map(t => t.id === data.id ? data : t);
	 *     return list;
	 *   });
	 * </script>
	 *
	 * {#each $todos as todo}
	 *   <p>{todo.text}</p>
	 * {/each}
	 * ```
	 *
	 * @param initial - Starting value (e.g. `[]`, `{}`, `0`)
	 * @param reducer - Called with `(accumulator, event)` on each new event
	 */
	scan<A>(initial: A, reducer: (acc: A, value: T) => A): Readable<A>;
}

// -- Direct exports (recommended) --------------------------------------------

/**
 * Get a reactive Svelte store for a topic. Auto-connects and auto-subscribes.
 *
 * **This is the only function most users need.**
 *
 * @example Topic-level (all events):
 * ```svelte
 * <script>
 *   import { on } from 'svelte-adapter-uws/client';
 *   const todos = on('todos');
 * </script>
 *
 * {#if $todos}
 *   <p>{$todos.event}: {JSON.stringify($todos.data)}</p>
 * {/if}
 * ```
 *
 * @example Event-level (filtered, wrapped in `{ data }`):
 * ```svelte
 * <script>
 *   import { on } from 'svelte-adapter-uws/client';
 *   const newTodo = on('todos', 'created');
 * </script>
 *
 * {#if $newTodo}
 *   <p>New: {$newTodo.data.text}</p>
 * {/if}
 * ```
 *
 * @example Accumulate state with .scan() (Svelte 5):
 * ```svelte
 * <script>
 *   import { on } from 'svelte-adapter-uws/client';
 *   const todos = on('todos').scan([], (list, { event, data }) => {
 *     if (event === 'created') return [...list, data];
 *     if (event === 'deleted') return list.filter(t => t.id !== data.id);
 *     return list;
 *   });
 * </script>
 * ```
 */
export function on<T = unknown>(topic: string): TopicStore<WSEvent<T>>;
export function on<T = unknown>(topic: string, event: string): TopicStore<{ data: T }>;

/**
 * Readable store - connection status. Auto-connects on first access.
 *
 * Five states drive distinct UI affordances:
 * - `'connecting'` - establishing a connection (initial attempt or retry)
 * - `'open'` - connected, live data is flowing
 * - `'suspended'` - WS is technically open but the tab is in the background;
 *   server may close idle backgrounded sockets, so live data is best-effort
 * - `'disconnected'` - lost connection, will retry automatically
 * - `'failed'` - terminal: auth denied, max retries exhausted, or `close()` called
 *
 * @example
 * ```svelte
 * <script>
 *   import { status } from 'svelte-adapter-uws/client';
 * </script>
 *
 * {#if $status === 'open'}
 *   <span class="badge">Live</span>
 * {:else if $status === 'suspended'}
 *   <span class="badge muted">Paused (background)</span>
 * {:else if $status === 'failed'}
 *   <span class="badge error">Connection failed</span>
 * {:else}
 *   <span class="badge">Reconnecting...</span>
 * {/if}
 * ```
 */
export const status: Readable<'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'>;

/**
 * Canonical reasons for a `subscribe-denied` server response. The
 * server's `subscribe` hook may return any of these or any custom
 * string; the framework also emits `'INVALID_TOPIC'` automatically
 * when a client sends a malformed topic.
 */
export type SubscribeDenialReason =
	| 'UNAUTHENTICATED'
	| 'FORBIDDEN'
	| 'INVALID_TOPIC'
	| 'RATE_LIMITED';

/**
 * Latest subscribe-denied response from the server. The store stays at
 * `null` until the first denial; on each new denial it emits
 * `{ topic, reason, ref }`. `reason` is one of the canonical codes
 * above, or any custom string the server hook returned.
 *
 * @example
 * ```svelte
 * <script>
 *   import { denials } from 'svelte-adapter-uws/client';
 * </script>
 *
 * {#if $denials}
 *   <p class="error">Subscription to {$denials.topic} denied: {$denials.reason}</p>
 * {/if}
 * ```
 */
export const denials: Readable<{
	topic: string;
	reason: SubscribeDenialReason | string;
	ref: number | string;
} | null>;

/**
 * Coarse classification of the cause behind a non-open status transition.
 *
 * - `'TERMINAL'` - server permanently rejected the client (1008, 4401, 4403).
 *   The retry loop is stopped; the user must re-authenticate or refresh.
 * - `'EXHAUSTED'` - reconnect attempts exceeded `maxReconnectAttempts`. The
 *   network never came back; the user typically needs a manual retry.
 * - `'THROTTLE'` - server signalled rate-limiting (4429). Reconnect is still
 *   scheduled, but jumped ahead in the backoff curve.
 * - `'RETRY'` - normal transient drop (1006 abnormal closure, network blip,
 *   server restart, etc). Reconnect is in progress.
 * - `'AUTH'` - auth preflight (`{ auth: true }`) failed before the WebSocket
 *   was opened. 4xx is terminal; 5xx and network errors retry.
 */
export type FailureClass = 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY' | 'AUTH';

/**
 * Latest failure cause behind a non-open status transition. The `kind`
 * discriminator tells you whether the failure came from a WebSocket close
 * frame (`'ws-close'`, with a `code` field) or from the HTTP auth
 * preflight (`'auth-preflight'`, with a `status` field).
 */
export type Failure =
	| { kind: 'ws-close'; class: 'TERMINAL' | 'EXHAUSTED' | 'THROTTLE' | 'RETRY'; code: number; reason: string }
	| { kind: 'auth-preflight'; class: 'AUTH'; status: number; reason: string };

/**
 * Cause of the most recent non-open status transition. `null` while
 * connected (or before any failure has occurred). Set on TERMINAL /
 * THROTTLE / RETRY close codes, on the reconnect cap being exhausted
 * (`'EXHAUSTED'`), and on auth-preflight failures (`'AUTH'`). Cleared
 * on the next successful `'open'`. Not set on an intentional `close()`
 * call - `status === 'failed'` plus `failure === null` is the
 * deliberately-ended state.
 *
 * @example
 * ```svelte
 * <script>
 *   import { status, failure } from 'svelte-adapter-uws/client';
 * </script>
 *
 * {#if $failure?.class === 'TERMINAL'}
 *   <p class="error">Session expired. Please log in again.</p>
 * {:else if $failure?.class === 'THROTTLE'}
 *   <p class="warn">Server is busy, retrying shortly...</p>
 * {:else if $failure?.class === 'EXHAUSTED'}
 *   <button onclick={() => location.reload()}>Reconnect</button>
 * {:else if $status === 'disconnected'}
 *   <span>Reconnecting...</span>
 * {/if}
 * ```
 */
export const failure: Readable<Failure | null>;

/**
 * Install a handler for server-initiated requests over the same WebSocket.
 *
 * The server calls `platform.request(ws, event, data)` and awaits a
 * reply; this handler is where that lands. Return a value (sync or
 * async) and the framework sends it back. Throw or reject to send an
 * error reply, which surfaces on the server as a Promise rejection.
 *
 * Only one handler may be installed at a time. Calling `onRequest`
 * again replaces the previous handler; the returned function clears
 * the handler if it is still the active one. With no handler
 * installed, incoming request frames are dropped and the server's
 * awaiting Promise times out.
 *
 * @example
 * ```js
 * import { onRequest } from 'svelte-adapter-uws/client';
 *
 * onRequest(async (event, data) => {
 *   if (event === 'confirm-action') {
 *     return { confirmed: confirm(`Are you sure? (${data.op})`) };
 *   }
 *   throw new Error('unknown event: ' + event);
 * });
 * ```
 */
export function onRequest(
	handler: (event: string, data: unknown) => unknown | Promise<unknown>
): () => void;

/**
 * Live CRUD list - one line for real-time collections.
 *
 * Subscribes to a topic and automatically handles `created`, `updated`,
 * and `deleted` events. Pair with `platform.topic('...').created(item)`
 * on the server for zero-boilerplate real-time lists.
 *
 * @param topic - Topic to subscribe to
 * @param initial - Starting data (e.g. from a load function)
 * @param options - Options (default key: `'id'`)
 *
 * @example
 * ```svelte
 * <script>
 *   import { crud } from 'svelte-adapter-uws/client';
 *   let { data } = $props(); // { todos: [...] } from +page.server.js load()
 *
 *   const todos = crud('todos', data.todos);
 *   // $todos auto-updates when server publishes created/updated/deleted
 * </script>
 *
 * {#each $todos as todo (todo.id)}
 *   <p>{todo.text}</p>
 * {/each}
 * ```
 *
 * @example Notification feed (newest first):
 * ```js
 * const notifications = crud('notifications', [], { prepend: true });
 * ```
 */
export function crud<T extends Record<string, any>>(
	topic: string,
	initial?: T[],
	options?: { key?: keyof T & string; prepend?: boolean; maxAge?: number }
): Readable<T[]>;

/**
 * Live keyed object - like `crud()` but returns a `Record` keyed by ID.
 * Better for dashboards and fast lookups where you need `$users['abc']`.
 *
 * @param topic - Topic to subscribe to
 * @param initial - Starting data (e.g. from a load function)
 * @param options - Options (default key: `'id'`)
 *
 * @example
 * ```svelte
 * <script>
 *   import { lookup } from 'svelte-adapter-uws/client';
 *   let { data } = $props();
 *
 *   const users = lookup('users', data.users);
 * </script>
 *
 * {#if $users[selectedId]}
 *   <UserCard user={$users[selectedId]} />
 * {/if}
 * ```
 */
export function lookup<T extends Record<string, any>>(
	topic: string,
	initial?: T[],
	options?: { key?: keyof T & string; maxAge?: number }
): Readable<Record<string, T>>;

/**
 * Ring buffer of the last N events on a topic.
 * Perfect for chat messages, activity feeds, and notification lists.
 *
 * @param topic - Topic to subscribe to
 * @param max - Maximum number of events to keep (default: 50)
 * @param initial - Starting data
 *
 * @example
 * ```svelte
 * <script>
 *   import { latest } from 'svelte-adapter-uws/client';
 *
 *   const messages = latest('chat', 100);
 * </script>
 *
 * {#each $messages as msg}
 *   <p><b>{msg.event}:</b> {msg.data.text}</p>
 * {/each}
 * ```
 */
export function latest<T = unknown>(
	topic: string,
	max?: number,
	initial?: WSEvent<T>[]
): Readable<WSEvent<T>[]>;

/**
 * Live counter store -- handles `set`, `increment`, and `decrement` events.
 *
 * Pair with `platform.topic('metric').publish('increment', 1)` on the server.
 *
 * @param topic - Topic to subscribe to
 * @param initial - Starting value (default: 0)
 *
 * @example
 * ```svelte
 * <script>
 *   import { count } from 'svelte-adapter-uws/client';
 *   const online = count('online-users');
 * </script>
 *
 * <p>{$online} users online</p>
 * ```
 */
export function count(topic: string, initial?: number): Readable<number>;

/**
 * Wait for a specific event on a topic. Resolves once and unsubscribes.
 *
 * @param topic - Topic to listen on
 * @param event - Optional event name to filter on
 * @param options - Options (e.g. `{ timeout: 5000 }`)
 *
 * @example
 * ```js
 * import { once } from 'svelte-adapter-uws/client';
 *
 * // Wait for server confirmation after a form submit
 * const result = await once('jobs', 'completed');
 *
 * // With a timeout (rejects if no event within 5s)
 * const result = await once('jobs', 'completed', { timeout: 5000 });
 *
 * // Timeout without event filter
 * const event = await once('jobs', { timeout: 5000 });
 * ```
 */
export function once<T = unknown>(topic: string, options?: { timeout?: number }): Promise<WSEvent<T>>;
export function once<T = unknown>(topic: string, event: string, options?: { timeout?: number }): Promise<{ data: T }>;

/**
 * Create a store that subscribes to a topic derived from a reactive value.
 * When the source store changes, the subscription automatically switches to
 * the new topic and the old one is released.
 *
 * Useful when the topic depends on runtime state like a user ID, selected item,
 * or route parameter - no manual subscribe/unsubscribe lifecycle to manage.
 *
 * @example
 * ```svelte
 * <script>
 *   import { page } from '$app/stores';
 *   import { onDerived } from 'svelte-adapter-uws/client';
 *   import { derived } from 'svelte/store';
 *
 *   // Subscribe to a topic based on the current page's item ID
 *   const roomId = derived(page, ($page) => $page.params.id);
 *   const messages = onDerived((id) => `room:${id}`, roomId);
 * </script>
 * ```
 */
export function onDerived<T = unknown>(
	topicFn: (value: T) => string,
	store: import('svelte/store').Readable<T>
): import('svelte/store').Readable<WSEvent | null>;

/**
 * Returns a promise that resolves when the WebSocket connection is open.
 * Auto-connects if not already connected.
 *
 * Resolves immediately in SSR (no WebSocket available).
 *
 * Rejects with an error if the connection is permanently closed before it
 * opens - for example, when the server sends a terminal close code (1008,
 * 4401, 4403), retries are exhausted, or `close()` is called explicitly.
 *
 * @example
 * ```js
 * import { ready } from 'svelte-adapter-uws/client';
 * await ready();
 * // connection is now open
 * ```
 */
export function ready(): Promise<void>;

// -- Power-user API ----------------------------------------------------------

export interface WSConnection {
	/** Readable store - the latest event from any subscribed topic. */
	events: Readable<WSEvent | null>;

	/** Readable store - connection status. */
	status: Readable<'connecting' | 'open' | 'suspended' | 'disconnected' | 'failed'>;

	/**
	 * Readable store - latest subscribe-denied response from the server.
	 * `null` until the first denial.
	 */
	denials: Readable<{
		topic: string;
		reason: SubscribeDenialReason | string;
		ref: number | string;
	} | null>;

	/**
	 * Readable store - cause of the most recent non-open status
	 * transition. `null` while connected. See the `failure` top-level
	 * export for full semantics and the `Failure` discriminated union
	 * for the value shape.
	 */
	failure: Readable<Failure | null>;

	/**
	 * Install a handler for server-initiated requests. Returns an
	 * unsubscribe function that clears the handler if still active.
	 */
	onRequest: (
		handler: (event: string, data: unknown) => unknown | Promise<unknown>
	) => () => void;

	/**
	 * Get a reactive store for a specific topic.
	 * Auto-subscribes to the topic.
	 */
	on<T = unknown>(topic: string): TopicStore<WSEvent<T>>;

	/**
	 * Subscribe to a topic. Duplicate calls are ignored.
	 * Subscriptions persist across reconnects.
	 *
	 * **Tip:** `on()` calls this automatically.
	 */
	subscribe(topic: string): void;

	/** Unsubscribe from a topic. */
	unsubscribe(topic: string): void;

	/**
	 * Send a custom message to the server. Dropped silently if not connected.
	 *
	 * Strings and JSON-serializable objects are sent as text frames after
	 * `JSON.stringify`. `ArrayBuffer` and any `ArrayBufferView` (Uint8Array,
	 * DataView, etc) are sent as binary frames unchanged.
	 */
	send(data: unknown): void;

	/**
	 * Send a message, queuing it if not currently connected.
	 * Queued messages flush automatically on reconnect (FIFO order).
	 *
	 * Strings and JSON-serializable objects are sent as text frames after
	 * `JSON.stringify`. `ArrayBuffer` and any `ArrayBufferView` (Uint8Array,
	 * DataView, etc) are sent as binary frames unchanged. Queued binary
	 * payloads are kept as-is in the in-memory queue and flushed verbatim
	 * on reconnect.
	 */
	sendQueued(data: unknown): void;

	/**
	 * Bytes the browser has accepted via `ws.send` but not yet flushed to
	 * the OS socket buffer. Mirrors the native WebSocket property of the
	 * same name. Returns 0 when the underlying socket does not exist
	 * (pre-connect or post-close).
	 *
	 * Use for client-side paced sending: after each chunk, check
	 * `conn.bufferedAmount` against a high-water mark and back off until
	 * it drops below a low-water mark before sending the next chunk.
	 * Keeps the browser send queue bounded regardless of payload size.
	 *
	 * @example
	 * ```js
	 * const HIGH = 4 * 1024 * 1024;
	 * const LOW = 1 * 1024 * 1024;
	 * for (const chunk of chunks) {
	 *   while (conn.bufferedAmount > HIGH) await delay(LOW_WAIT_MS);
	 *   conn.sendQueued(chunk);
	 * }
	 * ```
	 */
	readonly bufferedAmount: number;

	/** Close the connection permanently. Will not auto-reconnect. */
	close(): void;
}

/**
 * Connect to the adapter's WebSocket server.
 *
 * Returns a **singleton**. Auto-connects and auto-reconnects.
 *
 * Most users should use `on()` and `status` directly - they auto-connect
 * behind the scenes. Use `connect()` when you need `close()`, `send()`,
 * or custom `ConnectOptions`.
 *
 * @example
 * ```js
 * import { connect } from 'svelte-adapter-uws/client';
 * const ws = connect();
 * ws.subscribe('notifications');
 * ws.close(); // when done
 * ```
 */
export function connect(options?: ConnectOptions): WSConnection;
