import type { Readable } from 'svelte/store';
import type { WSEvent } from '../../client.js';

export interface GroupMemberClient {
	role: 'member' | 'admin' | 'viewer';
}

export interface GroupStore extends Readable<WSEvent | null> {
	/** Reactive store of current group members and their roles. */
	members: Readable<GroupMemberClient[]>;
}

/**
 * Get a reactive group store for a named group.
 *
 * The store itself emits group events (messages, join/leave notifications).
 * Use `.members` for the live member list.
 *
 * @example
 * ```svelte
 * <script>
 *   import { group } from 'svelte-adapter-uws/plugins/groups/client';
 *
 *   const lobby = group('lobby');
 *   const members = lobby.members;
 * </script>
 *
 * <p>{$members.length} members in lobby</p>
 * ```
 */
export function group(name: string): GroupStore;
