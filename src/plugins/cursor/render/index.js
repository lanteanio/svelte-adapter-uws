/**
 * Renderer factory for the cursor canvas pipeline.
 *
 * `selectRenderer(canvas, opts, current)` owns every backend decision so the
 * caller (the render worker, or the main-thread fallback loop) just holds
 * whatever it returns and calls `render()`:
 *
 *   - forced backends (`gpu: 'canvas2d' | 'webgl2' | 'webgpu'`) construct that
 *     backend directly against the target canvas and fail loudly when it is
 *     unavailable;
 *   - `gpu: 'auto'` starts on Canvas2D drawn directly into the target (zero
 *     overhead for the low-density boards that never get busy) and promotes
 *     to WebGL2 the first time the in-view count reaches `gpuThreshold`;
 *   - passing the `current` renderer back in makes the call cheap and
 *     idempotent: it returns `current` unchanged unless a promotion is due.
 *
 * Promotion mechanics: a canvas's context type is permanent - once a 2d
 * context exists, `getContext('webgl2')` on the same canvas returns null - so
 * "dispose Canvas2D, rebuild WebGL2 on the same surface" is impossible on the
 * web platform. Instead the target's existing 2d context is kept as a
 * PRESENTER: the GL backend renders into an internal `OffscreenCanvas` and
 * the presenter blits it with `globalCompositeOperation = 'copy'` (one
 * GPU-side composite per frame that also replaces alpha, so no clear pass is
 * needed). Promotion therefore requires `OffscreenCanvas`; without it `auto`
 * stays on Canvas2D for the lifetime of the mount. Crossing back below the
 * threshold never downgrades - the GL backend handles low counts fine and
 * swap thrash would cost more than it saves.
 *
 * @module svelte-adapter-uws/plugins/cursor/render
 */

import { Canvas2DRenderer } from './canvas2d.js';
import { WebGL2Renderer } from './webgl2.js';
import { WebGPURenderer } from './webgpu.js';

/**
 * Deterministic key -> packed RGBA color. FNV-1a over the key picks from a
 * fixed palette, so every renderer (worker or main-thread fallback) and
 * every reconnect colors a given cursor identically with no negotiation.
 * Apps override per key through the display config; this is the default.
 * @param {string} key
 * @returns {number} packed 0xRRGGBBAA
 */
export function hashColor(key) {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return PALETTE[(h >>> 0) % PALETTE.length];
}

const PALETTE = [
	0xe6194bff, 0x3cb44bff, 0x4363d8ff, 0xf58231ff,
	0x911eb4ff, 0x42d4f4ff, 0xf032e6ff, 0xbfef45ff,
	0x469990ff, 0xdcbeffff, 0x9a6324ff, 0x800000ff
];

/** @type {boolean | null} cached WebGL2 availability probe */
let _hasWebGL2 = null;

/**
 * Probe WebGL2 support WITHOUT touching the target canvas (a probe on the
 * target would permanently claim its context type). Uses a throwaway 1x1
 * surface; result is cached for the module lifetime.
 * @returns {boolean}
 */
export function hasWebGL2() {
	if (_hasWebGL2 !== null) return _hasWebGL2;
	let probe = null;
	try {
		if (typeof OffscreenCanvas !== 'undefined') {
			probe = new OffscreenCanvas(1, 1).getContext('webgl2');
		} else if (typeof document !== 'undefined') {
			probe = document.createElement('canvas').getContext('webgl2');
		}
	} catch {
		probe = null;
	}
	_hasWebGL2 = probe !== null;
	if (probe) {
		const lose = probe.getExtension('WEBGL_lose_context');
		if (lose) lose.loseContext();
	}
	return _hasWebGL2;
}

/** Test seam: reset the cached probe (a test that patches globals needs a
 * fresh probe per case). Not part of the public surface. */
export function _resetBackendProbes() {
	_hasWebGL2 = null;
}

/**
 * Wraps a GPU backend rendering into an internal surface with the target's
 * retained 2d context as the presenter. Implements the same renderer
 * contract, so the caller cannot tell it apart from a direct backend.
 */
class PresentedRenderer {
	/**
	 * @param {WebGL2Renderer} inner backend drawing into `internal`
	 * @param {OffscreenCanvas} internal
	 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} presentCtx target's 2d context
	 * @param {OffscreenCanvas | HTMLCanvasElement} target
	 */
	constructor(inner, internal, presentCtx, target) {
		this.backend = inner.backend;
		this.presented = true;
		this.inner = inner;
		this.internal = internal;
		this.ctx = presentCtx;
		this.canvas = target;
		this.dpr = inner.dpr;
		this.cssWidth = inner.cssWidth;
		this.cssHeight = inner.cssHeight;
	}

	resize(w, h, dpr) {
		if (typeof dpr === 'number' && dpr > 0) this.dpr = dpr;
		this.cssWidth = w;
		this.cssHeight = h;
		this.inner.resize(w, h, dpr);
		const pw = Math.max(1, Math.round(w * this.dpr));
		const ph = Math.max(1, Math.round(h * this.dpr));
		if (this.canvas.width !== pw) this.canvas.width = pw;
		if (this.canvas.height !== ph) this.canvas.height = ph;
	}

	render(cursors, count) {
		this.inner.render(cursors, count);
		const ctx = this.ctx;
		if (!ctx) return;
		// 'copy' replaces every pixel including alpha: blit and clear in one op.
		ctx.globalCompositeOperation = 'copy';
		ctx.drawImage(this.internal, 0, 0, this.canvas.width, this.canvas.height);
		ctx.globalCompositeOperation = 'source-over';
	}

	dispose() {
		this.inner.dispose();
		this.ctx = null;
	}
}

/**
 * Pick (or keep) the renderer for a canvas.
 *
 * @param {OffscreenCanvas | HTMLCanvasElement} canvas the target surface
 * @param {{
 *   gpu?: 'auto' | 'canvas2d' | 'webgl2' | 'webgpu',
 *   gpuThreshold?: number,
 *   lastCount?: number,
 *   devicePixelRatio?: number,
 *   radius?: number
 * }} [opts]
 * @param {{ backend: string, presented?: boolean } | null} [current] the
 *   renderer returned by the previous call, if any
 * @returns {Canvas2DRenderer | WebGL2Renderer | PresentedRenderer}
 */
export function selectRenderer(canvas, opts, current) {
	const o = opts || {};
	const gpu = o.gpu === undefined ? 'auto' : o.gpu;
	const threshold = o.gpuThreshold === undefined ? 500 : o.gpuThreshold;
	const lastCount = o.lastCount || 0;
	const base = { devicePixelRatio: o.devicePixelRatio || 1, radius: o.radius };

	if (gpu !== 'auto' && gpu !== 'canvas2d' && gpu !== 'webgl2' && gpu !== 'webgpu') {
		throw new Error('cursor renderer: unknown gpu mode ' + JSON.stringify(gpu));
	}

	// Forced backends: construct once, then always return the existing one.
	if (gpu === 'canvas2d') return current && current.backend === 'canvas2d' ? /** @type {any} */ (current) : new Canvas2DRenderer(canvas, base);
	if (gpu === 'webgl2') return current && current.backend === 'webgl2' ? /** @type {any} */ (current) : new WebGL2Renderer(canvas, base);
	if (gpu === 'webgpu') return current && current.backend === 'webgpu' ? /** @type {any} */ (current) : new WebGPURenderer(canvas, base);

	// auto. WebGPU joins this ladder (preferred over WebGL2) once it ships.
	if (current) {
		// Never downgrade; promote Canvas2D -> WebGL2 when the density gate
		// trips and an internal surface is possible.
		if (
			current.backend === 'canvas2d' &&
			lastCount >= threshold &&
			typeof OffscreenCanvas !== 'undefined' &&
			hasWebGL2()
		) {
			const c2d = /** @type {Canvas2DRenderer} */ (current);
			const w = c2d.cssWidth || 1;
			const h = c2d.cssHeight || 1;
			const internal = new OffscreenCanvas(Math.max(1, Math.round(w * c2d.dpr)), Math.max(1, Math.round(h * c2d.dpr)));
			let inner;
			try {
				inner = new WebGL2Renderer(internal, base);
			} catch {
				// Context-starved environments (too many live GL contexts) fail
				// here; stay on Canvas2D rather than dropping frames.
				return /** @type {any} */ (current);
			}
			inner.resize(w, h);
			return new PresentedRenderer(inner, internal, c2d.ctx, canvas);
		}
		return /** @type {any} */ (current);
	}

	// First construction under auto: when the caller already knows the density
	// is past the gate (a re-mount of a busy board) and GL can claim the
	// target directly, skip the presenter hop entirely.
	if (lastCount >= threshold && hasWebGL2()) {
		try {
			return new WebGL2Renderer(canvas, base);
		} catch {
			return new Canvas2DRenderer(canvas, base);
		}
	}
	return new Canvas2DRenderer(canvas, base);
}
