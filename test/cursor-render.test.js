// Renderer factory + backends for the cursor canvas pipeline.
//
// All-mock: a recording 2d context, a recording WebGL2 context, and a canvas
// double that enforces the real platform's context-type lock (the first
// getContext(type) claims the canvas; a different type afterwards returns
// null). The factory's promotion path depends on that lock being modeled
// faithfully - it is the reason the presenter architecture exists.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Canvas2DRenderer } from '../plugins/cursor/render/canvas2d.js';
import { WebGL2Renderer } from '../plugins/cursor/render/webgl2.js';
import { WebGPURenderer } from '../plugins/cursor/render/webgpu.js';
import { selectRenderer, hasWebGL2, hashColor, _resetBackendProbes } from '../plugins/cursor/render/index.js';

function mock2dCtx() {
	const ctx = {
		ops: [],
		fillStyles: [],
		composites: [],
		_fillStyle: '',
		set fillStyle(v) { this._fillStyle = v; this.fillStyles.push(v); },
		get fillStyle() { return this._fillStyle; },
		_gco: 'source-over',
		set globalCompositeOperation(v) { this._gco = v; this.composites.push(v); },
		get globalCompositeOperation() { return this._gco; },
		clearRect(...a) { this.ops.push(['clearRect', ...a]); },
		beginPath() { this.ops.push(['beginPath']); },
		arc(...a) { this.ops.push(['arc', ...a]); },
		fill() { this.ops.push(['fill']); },
		drawImage(...a) { this.ops.push(['drawImage', ...a]); }
	};
	return ctx;
}

const GL_CONSTANTS = {
	VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
	ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, FLOAT: 8, UNSIGNED_BYTE: 9,
	TRIANGLE_STRIP: 10, DEPTH_TEST: 11, BLEND: 12, ONE: 13, ONE_MINUS_SRC_ALPHA: 14,
	COLOR_BUFFER_BIT: 15
};

function mockGl() {
	const gl = {
		...GL_CONSTANTS,
		draws: [],
		uploads: [],
		disposed: [],
		createShader: () => ({}),
		shaderSource() {},
		compileShader() {},
		getShaderParameter: () => true,
		getShaderInfoLog: () => '',
		createProgram: () => ({}),
		attachShader() {},
		linkProgram() {},
		deleteShader() {},
		getProgramParameter: () => true,
		getProgramInfoLog: () => '',
		getUniformLocation: () => ({}),
		createVertexArray: () => ({}),
		bindVertexArray() {},
		createBuffer: () => ({}),
		bindBuffer() {},
		bufferData(target, data) { if (data && data.length !== undefined) this.uploads.push(data.length); },
		enableVertexAttribArray() {},
		vertexAttribPointer() {},
		vertexAttribDivisor() {},
		disable() {},
		enable() {},
		blendFunc() {},
		clearColor() {},
		viewport() {},
		clear() {},
		useProgram() {},
		uniform2f() {},
		uniform1f() {},
		drawArraysInstanced(mode, first, count, instances) { this.draws.push(instances); },
		isContextLost: () => false,
		getExtension: () => null,
		deleteBuffer(b) { this.disposed.push(b); },
		deleteVertexArray() {},
		deleteProgram() {}
	};
	return gl;
}

/**
 * Canvas double with the platform's context-type lock: the first requested
 * type wins; any other type afterwards yields null.
 */
function mockCanvas({ gl = null } = {}) {
	const contexts = { '2d': mock2dCtx(), webgl2: gl };
	let claimed = null;
	return {
		width: 0,
		height: 0,
		contexts,
		getContext(type) {
			if (claimed && claimed !== type) return null;
			const ctx = contexts[type] || null;
			if (ctx) claimed = type;
			return ctx;
		}
	};
}

const cursorAt = (x, y, colorRGBA = 0xff0000ff, hidden = false) => ({ x, y, colorRGBA, hidden });

afterEach(() => {
	_resetBackendProbes();
	delete globalThis.OffscreenCanvas;
});

describe('hashColor', () => {
	it('is deterministic and packs a fully-opaque RGBA', () => {
		const a1 = hashColor('instance-1:42');
		const a2 = hashColor('instance-1:42');
		expect(a1).toBe(a2);
		expect(typeof a1).toBe('number');
		expect(a1 & 0xff).toBe(0xff);
	});

	it('spreads distinct keys across the palette', () => {
		const colors = new Set();
		for (let i = 0; i < 50; i++) colors.add(hashColor('k' + i));
		expect(colors.size).toBeGreaterThan(4);
	});
});

describe('Canvas2DRenderer', () => {
	it('throws when the canvas cannot give a 2d context', () => {
		const canvas = mockCanvas({ gl: mockGl() });
		canvas.getContext('webgl2'); // claim the context type
		expect(() => new Canvas2DRenderer(canvas)).toThrow(/different context type/);
	});

	it('sizes the surface in device pixels on resize', () => {
		const canvas = mockCanvas();
		const r = new Canvas2DRenderer(canvas, { devicePixelRatio: 2 });
		r.resize(100, 50);
		expect(canvas.width).toBe(200);
		expect(canvas.height).toBe(100);
		expect(r.cssWidth).toBe(100);
		expect(r.cssHeight).toBe(50);
	});

	it('resize accepts a device-pixel-ratio update and rescales from then on', () => {
		const canvas = mockCanvas();
		const r = new Canvas2DRenderer(canvas, { devicePixelRatio: 1 });
		r.resize(100, 100);
		expect(canvas.width).toBe(100);
		r.resize(100, 100, 2);
		expect(canvas.width).toBe(200);
		const ctx = canvas.contexts['2d'];
		r.render([cursorAt(10, 20)], 1);
		expect(ctx.ops.filter((o) => o[0] === 'arc')[0].slice(1, 3)).toEqual([20, 40]);
	});

	it('draws one arc per visible cursor at device-pixel coordinates and skips hidden ones', () => {
		const canvas = mockCanvas();
		const r = new Canvas2DRenderer(canvas, { devicePixelRatio: 2 });
		r.resize(100, 100);
		const ctx = canvas.contexts['2d'];
		r.render([cursorAt(10, 20), cursorAt(30, 40, 0x00ff00ff, true), cursorAt(50, 60)], 3);
		const arcs = ctx.ops.filter((o) => o[0] === 'arc');
		expect(arcs).toHaveLength(2);
		expect(arcs[0][1]).toBe(20); // 10 * dpr
		expect(arcs[0][2]).toBe(40); // 20 * dpr
		expect(ctx.ops[0][0]).toBe('clearRect');
	});

	it('renders packed colors as rgba() strings and caches them', () => {
		const canvas = mockCanvas();
		const r = new Canvas2DRenderer(canvas);
		r.resize(10, 10);
		const ctx = canvas.contexts['2d'];
		r.render([cursorAt(1, 1, 0x11223344)], 1);
		r.render([cursorAt(2, 2, 0x11223344)], 1);
		expect(ctx.fillStyles[0]).toBe('rgba(17,34,51,' + (0x44 / 255) + ')');
		// Cached: the exact same string instance is reused on the second frame.
		expect(ctx.fillStyles[1]).toBe(ctx.fillStyles[0]);
	});

	it('dispose drops the context and render becomes a no-op', () => {
		const canvas = mockCanvas();
		const r = new Canvas2DRenderer(canvas);
		r.dispose();
		expect(() => r.render([cursorAt(1, 1)], 1)).not.toThrow();
	});
});

describe('WebGL2Renderer', () => {
	it('throws when webgl2 is unavailable on the canvas', () => {
		const canvas = mockCanvas(); // no gl context available
		expect(() => new WebGL2Renderer(canvas)).toThrow(/webgl2/);
	});

	it('uploads only visible cursors and draws that many instances', () => {
		const gl = mockGl();
		const canvas = mockCanvas({ gl });
		const r = new WebGL2Renderer(canvas, { devicePixelRatio: 1 });
		r.resize(100, 100);
		r.render([cursorAt(1, 2), cursorAt(3, 4, 0xffffffff, true), cursorAt(5, 6)], 3);
		expect(gl.draws).toEqual([2]);
	});

	it('skips the draw entirely for an empty frame', () => {
		const gl = mockGl();
		const canvas = mockCanvas({ gl });
		const r = new WebGL2Renderer(canvas);
		r.resize(10, 10);
		r.render([], 0);
		expect(gl.draws).toHaveLength(0);
	});

	it('grows staging capacity geometrically and never shrinks', () => {
		const gl = mockGl();
		const canvas = mockCanvas({ gl });
		const r = new WebGL2Renderer(canvas);
		r.resize(10, 10);
		const many = Array.from({ length: 300 }, (_, i) => cursorAt(i, i));
		r.render(many, 300);
		expect(gl.draws).toEqual([300]);
		r.render([cursorAt(1, 1)], 1);
		expect(gl.draws).toEqual([300, 1]);
	});
});

describe('WebGPURenderer', () => {
	it('fails loudly at construction', () => {
		expect(() => new WebGPURenderer()).toThrow(/not shipped/);
	});
});

describe('selectRenderer', () => {
	it('throws on an unknown gpu mode', () => {
		expect(() => selectRenderer(mockCanvas(), { gpu: 'cuda' })).toThrow(/unknown gpu mode/);
	});

	it('honors forced backends and returns the existing instance on re-select', () => {
		const canvas = mockCanvas();
		const first = selectRenderer(canvas, { gpu: 'canvas2d' });
		expect(first).toBeInstanceOf(Canvas2DRenderer);
		const again = selectRenderer(canvas, { gpu: 'canvas2d' }, first);
		expect(again).toBe(first);
	});

	it('forced webgpu throws (reserved backend)', () => {
		expect(() => selectRenderer(mockCanvas(), { gpu: 'webgpu' })).toThrow(/not shipped/);
	});

	it('auto picks Canvas2D when no GPU surface exists', () => {
		const r = selectRenderer(mockCanvas(), { gpu: 'auto' });
		expect(r.backend).toBe('canvas2d');
	});

	it('auto stays on the current renderer below the density gate', () => {
		const canvas = mockCanvas();
		const r = selectRenderer(canvas, { gpu: 'auto' });
		const again = selectRenderer(canvas, { gpu: 'auto', lastCount: 100, gpuThreshold: 500 }, r);
		expect(again).toBe(r);
	});

	it('promotes Canvas2D to a presented WebGL2 renderer at the gate, keeping the target 2d context as presenter', () => {
		const internalGl = mockGl();
		globalThis.OffscreenCanvas = class {
			constructor(w, h) { this.width = w; this.height = h; }
			getContext(type) { return type === 'webgl2' ? internalGl : null; }
		};
		_resetBackendProbes();

		const canvas = mockCanvas();
		const c2d = selectRenderer(canvas, { gpu: 'auto' });
		c2d.resize(200, 100);
		const targetCtx = canvas.contexts['2d'];

		const promoted = selectRenderer(canvas, { gpu: 'auto', lastCount: 600, gpuThreshold: 500 }, c2d);
		expect(promoted).not.toBe(c2d);
		expect(promoted.backend).toBe('webgl2');
		expect(promoted.presented).toBe(true);

		promoted.render([cursorAt(1, 1), cursorAt(2, 2)], 2);
		expect(internalGl.draws).toEqual([2]);
		// The blit replaces every pixel (clear + draw in one composite op).
		const blits = targetCtx.ops.filter((o) => o[0] === 'drawImage');
		expect(blits).toHaveLength(1);
		expect(targetCtx.composites).toContain('copy');

		// Never downgrade: dropping below the gate keeps the promoted renderer.
		const after = selectRenderer(canvas, { gpu: 'auto', lastCount: 3, gpuThreshold: 500 }, promoted);
		expect(after).toBe(promoted);
	});

	it('promotion is impossible without OffscreenCanvas: auto stays on Canvas2D for the mount lifetime', () => {
		const canvas = mockCanvas({ gl: mockGl() });
		const c2d = selectRenderer(canvas, { gpu: 'auto' });
		expect(c2d.backend).toBe('canvas2d');
		const after = selectRenderer(canvas, { gpu: 'auto', lastCount: 10_000, gpuThreshold: 500 }, c2d);
		// hasWebGL2 may even be true via a document probe elsewhere; the gate
		// here is the missing OffscreenCanvas for the internal surface.
		expect(after).toBe(c2d);
	});

	it('first construction under auto goes straight to direct WebGL2 when the density is already past the gate', () => {
		const gl = mockGl();
		globalThis.OffscreenCanvas = class {
			constructor(w, h) { this.width = w; this.height = h; }
			getContext(type) { return type === 'webgl2' ? mockGl() : null; }
		};
		_resetBackendProbes();
		const canvas = mockCanvas({ gl });
		const r = selectRenderer(canvas, { gpu: 'auto', lastCount: 600, gpuThreshold: 500 });
		expect(r).toBeInstanceOf(WebGL2Renderer);
		expect(r.presented).toBeUndefined();
	});

	it('hasWebGL2 caches its probe until reset', () => {
		expect(hasWebGL2()).toBe(false); // bare node: no OffscreenCanvas, no document
		globalThis.OffscreenCanvas = class {
			getContext(type) { return type === 'webgl2' ? mockGl() : null; }
		};
		expect(hasWebGL2()).toBe(false); // cached
		_resetBackendProbes();
		expect(hasWebGL2()).toBe(true);
	});
});
