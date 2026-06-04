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
 * Pass a `viewport` source to opt this subscriber into server-side culling: the
 * store reports the visible region automatically (on scroll, resize, zoom, and
 * late mount) while subscribed, so you write no `reportViewport` wiring yourself.
 *
 * @example
 * ```svelte
 * <script>
 *   import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
 *
 *   let board;
 *   // Auto-reports board's visible region; omit `viewport` to see all cursors.
 *   const cursors = cursor('canvas', { viewport: () => board });
 * </script>
 *
 * <div bind:this={board}
 *      onpointermove={(e) => move('canvas', { x: e.clientX + board.scrollLeft, y: e.clientY + board.scrollTop })}>
 *   {#each [...$cursors] as [key, { user, data }] (key)}
 *     <div style="left: {data.x}px; top: {data.y}px">{user.name}</div>
 *   {/each}
 * </div>
 * ```
 */
export function cursor<UserInfo = unknown, Data = unknown>(
	topic: string,
	options?: {
		/** Drop a cursor that has not updated within this many ms. */
		maxAge?: number;
		/**
		 * Opt into server-side viewport culling. Pass a scroll-container element,
		 * an explicit `{ x, y, w, h, zoom? }` rect, or a getter returning either
		 * (a getter handles a late-bound `bind:this` element). While subscribed,
		 * the store reports the resolved region whenever it changes - covering
		 * scroll, resize, zoom, and mount with no manual wiring. The reported rect
		 * and your `move()` coordinates must share one coordinate space (the
		 * board's). Omit it and the subscriber sees all cursors (never culled).
		 */
		viewport?:
			| Element
			| { x: number; y: number; w: number; h: number; zoom?: number }
			| (() => Element | { x: number; y: number; w: number; h: number; zoom?: number } | null | undefined);
	}
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

/**
 * Report this subscriber's viewport on a topic so the server can cull cursors
 * outside the visible region (once viewport culling is enabled server-side).
 * Reporting is per-subscriber and opt-in: a subscriber that never reports a
 * viewport is treated as whole-board and is never culled. Frames are coalesced
 * via `requestAnimationFrame` (one send per repaint); multi-topic callers do
 * not clobber each other.
 *
 * No-op in non-browser environments and for an unresolvable source.
 *
 * @param topic
 * @param source a scroll-container element (the visible content region is read
 *   from `scrollLeft` / `scrollTop` / `clientWidth` / `clientHeight`), an
 *   explicit `{ x, y, w, h, zoom? }` rect (for a virtualized canvas with its
 *   own transform), or a getter returning either.
 */
export function reportViewport(
	topic: string,
	source:
		| Element
		| { x: number; y: number; w: number; h: number; zoom?: number }
		| (() => Element | { x: number; y: number; w: number; h: number; zoom?: number } | null | undefined)
): void;
