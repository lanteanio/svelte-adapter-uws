import type { Readable } from 'svelte/store';

export interface CursorPosition<UserInfo = unknown, Data = unknown> {
	/** User-identifying data from the server's `select` function. */
	user: UserInfo;
	/** Latest cursor/position data. */
	data: Data;
}

/** A viewport source: a scroll-container element, an explicit rect in board
 * coordinates, or a getter returning either (a getter handles a late-bound
 * `bind:this` element). */
export type ViewportSource =
	| Element
	| { x: number; y: number; w: number; h: number; zoom?: number }
	| (() => Element | { x: number; y: number; w: number; h: number; zoom?: number } | null | undefined);

/** One entry of the thinned main-thread feed: the classic store's
 * `{ user, data }` join plus the resolved display color. */
export interface CursorFeedEntry<UserInfo = unknown> {
	user: UserInfo;
	data: { x: number; y: number };
	/** Packed 0xRRGGBBAA, after display-config resolution. */
	colorRGBA: number;
}

/**
 * The handle returned by `cursor(topic, { canvas })`. Rendering starts on
 * `mount()` and the returned teardown stops it, so the natural Svelte 5
 * binding is one line: `$effect(() => cursor(topic, { canvas }).mount())`.
 */
export interface CursorHandle<UserInfo = unknown> {
	/**
	 * Start rendering into the canvas. Idempotent across components: two
	 * mounts of the same topic+canvas share one pipeline. Returns the
	 * teardown; after the last teardown the pipeline pauses (the worker and
	 * the canvas surface are kept, so a later mount on the same element
	 * resumes - including on a different topic).
	 *
	 * Throws when `rendering: 'worker'` is set and the browser cannot
	 * provide a worker pipeline, and when the canvas is currently rendering
	 * a different topic.
	 */
	mount(): () => void;
	/**
	 * Replace the tracked viewport source. Rarely needed - the plugin
	 * auto-tracks the `viewport` option (or the canvas element itself) every
	 * frame; use this for a transform only you can compute, passing the same
	 * shapes the `viewport` option accepts.
	 */
	viewport(source: ViewportSource): void;
	/**
	 * Display config. The callbacks run on the main thread against the
	 * current roster and re-run automatically as users join and leave; only
	 * the resolved per-key results are shipped to the renderer. `colorOf`
	 * returns a hex string ('#rgb', '#rrggbb', '#rrggbbaa') or a packed
	 * 32-bit RGBA integer; any other value keeps the deterministic default
	 * palette. A user hidden by `hide` is excluded from the canvas AND from
	 * the main-thread feed. Throwing callbacks are contained per user.
	 */
	configure(config: {
		colorOf?: (user: UserInfo) => string | number | null | undefined;
		hide?: (user: UserInfo) => boolean;
	}): void;
	/**
	 * Terminal teardown: stops the pipeline and disposes the worker. The
	 * canvas element cannot render cursors again afterwards (its drawing
	 * surface was transferred to the disposed worker - a once-per-element
	 * operation), so prefer the `mount()` teardown for component lifecycles
	 * and reserve `destroy()` for leaving the board entirely.
	 */
	destroy(): void;
	/**
	 * Present only when `mainThreadFeed` is enabled: the thinned, rate-capped
	 * position feed (board coordinates, in-view and non-hidden cursors only),
	 * updated at the feed rate rather than the wire rate.
	 */
	feed?: Readable<Map<string, CursorFeedEntry<UserInfo>>>;
	/**
	 * Present only with `rendering: 'main'`: the classic reactive store, for
	 * apps that draw on their own canvas AND need cursor data reactively.
	 */
	store?: Readable<Map<string, CursorPosition<UserInfo>>>;
}

/** Options shared by both `cursor()` forms. */
export interface CursorStoreOptions {
	/** Drop a cursor that has not updated within this many ms. */
	maxAge?: number;
	/**
	 * Opt into server-side viewport culling. While subscribed/mounted, the
	 * resolved region is reported whenever it changes - covering scroll,
	 * resize, zoom, and late mount with no manual wiring. The reported rect
	 * and your `move()` coordinates must share one coordinate space (the
	 * board's). Omit it and this subscriber sees all cursors (never culled).
	 * In canvas mode it additionally drives the render transform and
	 * client-side culling; omitting it there tracks the canvas element.
	 */
	viewport?: ViewportSource;
}

/** Options accepted when a `canvas` is supplied. */
export interface CursorCanvasOptions extends CursorStoreOptions {
	/** Render target. Its drawing surface is transferred to a dedicated
	 * worker when the browser supports it. */
	canvas: HTMLCanvasElement;
	/**
	 * Which thread renders. `'auto'` (default) uses a worker when
	 * `Worker` + `OffscreenCanvas` + `transferControlToOffscreen` exist and
	 * silently renders on the main thread otherwise (same call, same visual
	 * result, lower ceiling). `'worker'` requires the worker pipeline and
	 * throws at `mount()` without it - for deployments that refuse to ship
	 * an untested fallback. `'main'` forces main-thread rendering and
	 * additionally exposes `handle.store` for reactive reads.
	 */
	rendering?: 'auto' | 'main' | 'worker';
	/**
	 * Which backend draws. `'auto'` (default) starts on Canvas2D and
	 * promotes to WebGL2 when the in-view count first reaches
	 * `gpuThreshold`; forced values name a backend and fail loudly when it
	 * is unavailable.
	 */
	gpu?: 'auto' | 'canvas2d' | 'webgl2' | 'webgpu';
	/** In-view cursor count at which `gpu: 'auto'` promotes to a GPU
	 * backend (default 500). Crossing back down never downgrades. */
	gpuThreshold?: number;
	/**
	 * Opt-in thinned position feed back to the main thread, for the
	 * incidental reactive needs of worker mode (a leader badge, a minimap).
	 * `true` samples at 10 Hz; `{ rate }` picks the frequency. Off by
	 * default: the point of worker mode is that the main thread reads
	 * nothing from the cursor stream. The feed always ships raw wire
	 * positions - smoothing changes pixels, never the data surface.
	 */
	mainThreadFeed?: boolean | { rate?: number };
	/**
	 * Render-in-the-past interpolation for remote cursors. `true` selects
	 * the tuned defaults; the object form exposes the knobs. Remote cursors
	 * render `interpolationMs` behind their newest known position, so a
	 * dropped or late frame is invisible (there is almost always a real
	 * pair of samples around the render time) at the cost of that small
	 * trailing delay. `'auto'` (default) tracks twice the measured update
	 * interval and collapses toward a 32ms floor when updates arrive at
	 * display rate. `extrapolateMs` caps dead-reckoning when the buffer
	 * runs dry (default 250); `snapGapMs` is the sample gap treated as a
	 * discontinuity and snapped rather than smeared (default 500). Requires
	 * a canvas (the plain store has no render loop). Off by default.
	 */
	smooth?: boolean | {
		interpolationMs?: 'auto' | number;
		extrapolateMs?: number;
		snapGapMs?: number;
	};
}

/**
 * Reactive cursor data for a topic.
 *
 * Returns a `Readable<Map<string, CursorPosition>>` that updates
 * automatically when cursors move, join, or disconnect. Internally merges
 * the `catalog` (user metadata) and `update`/`bulk` (positions) streams;
 * entries are emitted only after both user and position are known.
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
	options: CursorCanvasOptions
): CursorHandle<UserInfo>;

/**
 * Rendered cursors for a topic: hand `cursor()` a canvas and the whole
 * ingest-decode-merge-paint pipeline moves into a dedicated worker that owns
 * its own WebSocket and the canvas's transferred drawing surface - the main
 * thread reads nothing from the cursor stream at any density. On a browser
 * without the worker pipeline the identical call renders on the main thread
 * instead (no API difference, no thrown error in `'auto'` mode).
 *
 * @example
 * ```svelte
 * <script>
 *   import { cursor, move } from 'svelte-adapter-uws/plugins/cursor/client';
 *   let canvas = $state();
 *   $effect(() => cursor('board:42', { canvas }).mount());
 * </script>
 *
 * <canvas bind:this={canvas} class="cursor-layer"></canvas>
 * <div onpointermove={(e) => move('board:42', { x: e.clientX, y: e.clientY })}> ... </div>
 * ```
 */
export function cursor<UserInfo = unknown, Data = unknown>(
	topic: string,
	options?: CursorStoreOptions
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
export function reportViewport(topic: string, source: ViewportSource): void;
