import type { Readable } from 'svelte/store';

export interface ConnectOptions {
	/**
	 * WebSocket endpoint path. Must match the adapter config.
	 * @default '/ws'
	 */
	path?: string;

	/**
	 * Base delay in ms before reconnecting after a disconnect.
	 * Uses exponential backoff with jitter.
	 * @default 3000
	 */
	reconnectInterval?: number;

	/**
	 * Maximum delay in ms between reconnection attempts.
	 * @default 30000
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
 * Readable store - connection status: `'connecting'` | `'open'` | `'closed'`.
 * Auto-connects on first access.
 *
 * @example
 * ```svelte
 * <script>
 *   import { status } from 'svelte-adapter-uws/client';
 * </script>
 *
 * {#if $status === 'open'}
 *   <span class="badge">Live</span>
 * {/if}
 * ```
 */
export const status: Readable<'connecting' | 'open' | 'closed'>;

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
 * Returns a promise that resolves when the WebSocket connection is open.
 * Auto-connects if not already connected.
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
	status: Readable<'connecting' | 'open' | 'closed'>;

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
	 * Send a custom message to the server.
	 * Dropped silently if not connected.
	 */
	send(data: unknown): void;

	/**
	 * Send a message, queuing it if not currently connected.
	 * Queued messages flush automatically on reconnect (FIFO order).
	 */
	sendQueued(data: unknown): void;

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
