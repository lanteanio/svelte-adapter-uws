import type { Readable } from 'svelte/store';

/**
 * Get a reactive store of users present on a topic.
 *
 * Returns a readable Svelte store containing an array of user data objects.
 * The array updates automatically when users join or leave.
 *
 * Defaults to a 90 s `maxAge` sweep: entries that haven't been refreshed
 * by a heartbeat or diff/state inside the window are removed
 * from the local map. The server emits `{userKey: data}` heartbeats
 * every 30 s by default, so still-present users re-appear on the next
 * heartbeat (no flicker). Pass `maxAge: 0` to opt out of the sweep for
 * admin / audit views that want unbounded retention.
 *
 * You must also subscribe to the topic itself (via `on()`, `crud()`, etc.)
 * for the server's `subscribe` hook to fire and register your presence.
 *
 * @param topic - Topic to track presence on
 * @param options - `maxAge` defaults to 90000 (ms). Pass `0` to disable
 *   the sweep.
 *
 * @example
 * ```svelte
 * <script>
 *   import { on } from 'svelte-adapter-uws/client';
 *   import { presence } from 'svelte-adapter-uws/plugins/presence/client';
 *
 *   const messages = on('room');
 *   const users = presence('room');
 * </script>
 *
 * <aside>
 *   <h3>{$users.length} online</h3>
 *   {#each $users as user (user.id)}
 *     <span>{user.name}</span>
 *   {/each}
 * </aside>
 * ```
 */
export function presence<T extends Record<string, any> = Record<string, any>>(
	topic: string,
	options?: { maxAge?: number }
): Readable<T[]>;

/**
 * Push field updates for the current user on a topic.
 *
 * Sets one or more fields (a typing flag, a selection range, a status) on the
 * entry this connection represents, merged field by field on the server and
 * broadcast to observers as a presence `diff`. You must already be present on
 * the topic (subscribed via `on()` / `crud()`, the same requirement as
 * `presence()`); a push from a connection that has not joined is a silent no-op.
 * Whether a field is durable or transient is decided by the server's presence
 * config, not the caller.
 *
 * @param topic - Topic the user is present on
 * @param fields - Fields to set on this user's entry
 */
export function presenceUpdate(topic: string, fields: Record<string, any>): void;
