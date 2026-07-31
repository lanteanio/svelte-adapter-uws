import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export type GroupRole = 'member' | 'admin' | 'viewer';

export interface GroupOptions {
	/**
	 * Maximum members allowed. When full, `join()` returns `false` and
	 * `onFull` fires. Pass `Infinity` to disable the cap (not recommended
	 * at uWS scale).
	 * @default 1_000_000
	 */
	maxMembers?: number;

	/** Initial group metadata (shallow-copied). */
	meta?: Record<string, any>;

	/**
	 * Synchronous admission hook, called before membership is installed.
	 * Return `false` to reject, a role to override the requested role, or
	 * `undefined` to accept it unchanged. Throwing also fails closed.
	 */
	onJoin?: (ws: WebSocket<any>, role: GroupRole) => GroupRole | false | void;

	/** Called after a member leaves. */
	onLeave?: (ws: WebSocket<any>, role: GroupRole) => void;

	/** Called when a join is rejected because the group is full. */
	onFull?: (ws: WebSocket<any>, role: GroupRole) => void;

	/** Called when the group is closed. */
	onClose?: () => void;
}

export interface GroupMember {
	ws: WebSocket<any>;
	role: GroupRole;
}

export interface Group {
	/** The group name. */
	readonly name: string;

	/** The resolved member cap, including the default when none was passed. */
	readonly maxMembers: number;

	/** Group metadata (get/set). */
	meta: Record<string, any>;

	/**
	 * Add a member to the group.
	 *
	 * Returns `true` on success, `false` if the group is full or closed.
	 * Idempotent - joining twice with the same ws is a no-op.
	 *
	 * @example
	 * ```js
	 * if (!group.join(ws, platform, 'admin')) {
	 *   platform.send(ws, 'system', 'error', 'Group is full');
	 * }
	 * ```
	 */
	join(ws: WebSocket<any>, platform: Platform, role?: GroupRole): boolean;

	/**
	 * Remove a member from the group. No-op if not a member.
	 */
	leave(ws: WebSocket<any>, platform: Platform): void;

	/**
	 * Broadcast to all members, or filter by role.
	 *
	 * @example
	 * ```js
	 * group.publish(platform, 'chat', { text: 'hello' });
	 * group.publish(platform, 'admin-msg', data, 'admin');
	 * ```
	 */
	publish(platform: Platform, event: string, data?: unknown, role?: GroupRole): void;

	/**
	 * Send to a single member. Throws if the ws is not a member.
	 */
	send(platform: Platform, ws: WebSocket<any>, event: string, data?: unknown): void;

	/** List all members with their roles. */
	members(): GroupMember[];

	/** Current member count. */
	count(): number;

	/** Check if a ws is a member. */
	has(ws: WebSocket<any>): boolean;

	/**
	 * Dissolve the group. Broadcasts a `close` event, unsubscribes all
	 * members, and clears state. Subsequent joins return `false`.
	 */
	close(platform: Platform): void;

	/**
	 * Ready-made WebSocket hooks for group admission and membership.
	 *
	 * `subscribe` intercepts the internal `__group:{name}` topic and calls
	 * `join()` to gate access. Returns `false` when `onJoin` rejects or the group
	 * is full or closed. Its registered namespace can reach this hook through
	 * the default system-topic guard, but the wire landing still requires
	 * `join()` to establish tracked membership.
	 * `unsubscribe` calls `leave()` when the client unsubscribes from the
	 * internal topic. `close` calls `leave()`.
	 *
	 * @example
	 * ```js
	 * export const { subscribe, unsubscribe, close } = lobby.hooks;
	 * ```
	 */
	hooks: {
		subscribe(ws: WebSocket<any>, topic: string, ctx: { platform: Platform }): boolean | void;
		unsubscribe(ws: WebSocket<any>, topic: string, ctx: { platform: Platform }): void;
		close(ws: WebSocket<any>, ctx: { platform: Platform }): void;
	};
}

/**
 * Create a broadcast group with roles, membership limits, and lifecycle hooks.
 *
 * @example
 * ```js
 * import { createGroup } from 'svelte-adapter-uws/plugins/groups';
 *
 * const lobby = createGroup('lobby', {
 *   maxMembers: 50,
 *   meta: { game: 'chess' },
 *   onJoin: (ws, role) => console.log('joined as', role),
 *   onFull: (ws) => { // notify rejected client }
 * });
 * ```
 */
export function createGroup(name: string, options?: GroupOptions): Group;
