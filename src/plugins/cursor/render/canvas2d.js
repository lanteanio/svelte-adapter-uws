/**
 * Canvas2D cursor renderer: the baseline backend that works on every canvas
 * the plugin can be handed (an `OffscreenCanvas` inside the render worker, or
 * a plain `HTMLCanvasElement` on the main-thread fallback - both expose the
 * same `getContext('2d')`).
 *
 * The renderer contract shared by every backend in this directory:
 *
 *   constructor(canvas, { devicePixelRatio?, radius? })
 *   resize(w, h)                 CSS-pixel viewport size changed
 *   render(cursors, count)       draw one frame; `cursors` is an iterable of
 *                                `{ x, y, colorRGBA, hidden }` in CSS pixels,
 *                                `count` an upper bound on its length so
 *                                typed-array backends can size buffers in one
 *                                allocation (this backend ignores it)
 *   dispose()                    release the context and caches
 *
 * The network layer never references a renderer type; swapping backends is
 * the factory's job (./index.js). Positions arrive already transformed into
 * view space - the caller owns the board-to-viewport transform - so a
 * renderer only scales CSS pixels to device pixels.
 *
 * @module svelte-adapter-uws/plugins/cursor/render/canvas2d
 */

/** Default dot radius in CSS pixels. */
const DEFAULT_RADIUS = 4;

/** Cap on the per-instance fill-style string cache (colors are per-user, so
 * this is generous; the clear-on-overflow keeps a pathological color churn
 * from growing the Map unboundedly). */
const COLOR_CACHE_MAX = 1024;

/**
 * Render a packed 0xRRGGBBAA color as a CSS `rgba()` string.
 * @param {number} c unsigned 32-bit RGBA
 */
function cssColor(c) {
	const r = (c >>> 24) & 0xff;
	const g = (c >>> 16) & 0xff;
	const b = (c >>> 8) & 0xff;
	const a = c & 0xff;
	return 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255) + ')';
}

export class Canvas2DRenderer {
	/**
	 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
	 * @param {{ devicePixelRatio?: number, radius?: number }} [opts]
	 */
	constructor(canvas, opts) {
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			throw new Error('cursor renderer: canvas.getContext(\'2d\') returned null (the canvas already has a different context type)');
		}
		this.backend = 'canvas2d';
		this.canvas = canvas;
		/** The 2d context. The factory reads this when it promotes the canvas
		 * to presenter duty for a GPU backend, so it must stay reachable for
		 * the lifetime of the instance. */
		this.ctx = ctx;
		this.dpr = (opts && opts.devicePixelRatio) || 1;
		this.radius = (opts && opts.radius) || DEFAULT_RADIUS;
		/** Last CSS-pixel size seen by resize(); the factory sizes the internal
		 * GPU surface from these on promotion. */
		this.cssWidth = 0;
		this.cssHeight = 0;
		/** @type {Map<number, string>} packed color -> fillStyle string */
		this._colors = new Map();
	}

	/**
	 * @param {number} w CSS pixels
	 * @param {number} h CSS pixels
	 * @param {number} [dpr] current device pixel ratio; monitor moves and
	 *   browser zoom change it mid-session, so it travels with the resize
	 */
	resize(w, h, dpr) {
		if (typeof dpr === 'number' && dpr > 0) this.dpr = dpr;
		this.cssWidth = w;
		this.cssHeight = h;
		const pw = Math.max(1, Math.round(w * this.dpr));
		const ph = Math.max(1, Math.round(h * this.dpr));
		if (this.canvas.width !== pw) this.canvas.width = pw;
		if (this.canvas.height !== ph) this.canvas.height = ph;
	}

	/**
	 * @param {Iterable<{ x: number, y: number, colorRGBA: number, hidden?: boolean }>} cursors
	 * @param {number} count ignored by this backend
	 */
	render(cursors, count) {
		void count;
		const ctx = this.ctx;
		if (!ctx) return;
		const dpr = this.dpr;
		const r = this.radius * dpr;
		const tau = Math.PI * 2;
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		for (const c of cursors) {
			if (c.hidden) continue;
			let fill = this._colors.get(c.colorRGBA);
			if (fill === undefined) {
				if (this._colors.size >= COLOR_CACHE_MAX) {
					// Evict one (insertion order) instead of clearing: a working
					// set sitting exactly at the cap must not rebuild every frame.
					this._colors.delete(this._colors.keys().next().value);
				}
				fill = cssColor(c.colorRGBA);
				this._colors.set(c.colorRGBA, fill);
			}
			ctx.fillStyle = fill;
			ctx.beginPath();
			ctx.arc(c.x * dpr, c.y * dpr, r, 0, tau);
			ctx.fill();
		}
	}

	dispose() {
		this.ctx = null;
		this._colors.clear();
	}
}
