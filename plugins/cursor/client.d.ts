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
 * automatically when cursors move, join, or disconnect. Internally
 * merges the `catalog` (user metadata) and `update`/`bulk` (positions)
 * streams; entries are emitted only after both user and position are
 * known.
 *
 * @example
 * ```svelte
 * <script>
 *   import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
 *
 *   const cursors = cursor('canvas');
 *
 *   function onmousemove(e) {
 *     move('canvas', { x: e.clientX, y: e.clientY });
 *   }
 * </script>
 *
 * <div on:mousemove={onmousemove}>
 *   {#each [...$cursors] as [key, { user, data }] (key)}
 *     <div style="left: {data.x}px; top: {data.y}px">
 *       {user.name}
 *     </div>
 *   {/each}
 * </div>
 * ```
 */
export function cursor<UserInfo = unknown, Data = unknown>(
	topic: string,
	options?: { maxAge?: number }
): Readable<Map<string, CursorPosition<UserInfo, Data>>>;

/**
 * Send a cursor move on a topic. Frames are coalesced via
 * `requestAnimationFrame` so calling `move()` at 1000 Hz (high-DPI
 * mouse) collapses to at most one send per repaint, matching the
 * server-side `topicThrottle` default. Multi-topic callers do not
 * clobber each other.
 *
 * No-op in non-browser environments.
 */
export function move(topic: string, data: unknown): void;
