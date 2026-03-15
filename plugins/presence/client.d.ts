import type { Readable } from 'svelte/store';

/**
 * Get a reactive store of users present on a topic.
 *
 * Returns a readable Svelte store containing an array of user data objects.
 * The array updates automatically when users join or leave.
 *
 * You must also subscribe to the topic itself (via `on()`, `crud()`, etc.)
 * for the server's `subscribe` hook to fire and register your presence.
 *
 * @param topic - Topic to track presence on
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
