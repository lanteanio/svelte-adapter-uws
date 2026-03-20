import type { Readable } from 'svelte/store';

export interface CursorPosition<UserInfo = unknown, Data = unknown> {
	/** User-identifying data from the server's `select` function. */
	user: UserInfo;
	/** Latest cursor/position data. */
	data: Data;
}

/**
 * Get a reactive store of cursor positions on a topic.
 *
 * Returns a `Readable<Map<string, CursorPosition>>` that updates
 * automatically when cursors move or disconnect.
 *
 * @example
 * ```svelte
 * <script>
 *   import { cursor } from 'svelte-adapter-uws/plugins/cursor/client';
 *
 *   const cursors = cursor('canvas');
 * </script>
 *
 * {#each [...$cursors] as [key, { user, data }] (key)}
 *   <div style="left: {data.x}px; top: {data.y}px">
 *     {user.name}
 *   </div>
 * {/each}
 * ```
 */
export function cursor<UserInfo = unknown, Data = unknown>(
	topic: string,
	options?: {
		maxAge?: number;
		/**
		 * Enable smooth lerp interpolation for cursor movement.
		 * When enabled, `update` events with numeric `x` and `y` fields
		 * are interpolated via requestAnimationFrame instead of snapping.
		 * `snapshot`, `bulk`, and `remove` events always snap immediately.
		 */
		interpolate?: boolean;
	}
): Readable<Map<string, CursorPosition<UserInfo, Data>>>;
