/**
 * WebGL2 cursor renderer: instanced unit-quad backend for high cursor
 * densities. One draw call per frame regardless of count: a 4-vertex
 * triangle strip is instanced per cursor with a per-instance position and
 * color, and the fragment shader carves a smooth-edged disc out of the quad.
 *
 * Implements the same renderer contract as ./canvas2d.js. Accepts both an
 * `OffscreenCanvas` (worker, or the factory's internal promotion surface)
 * and an `HTMLCanvasElement` (main-thread with a forced GL backend).
 *
 * Buffer strategy: positions and colors live in growable typed arrays
 * (capacity doubles, never shrinks) uploaded with `gl.DYNAMIC_DRAW` each
 * frame. The `count` argument to render() sizes the upload without a
 * pre-pass over the iterable; hidden cursors are skipped during the fill so
 * the instance count only covers visible ones.
 *
 * The context is created with `premultipliedAlpha: true` (the default) and
 * the shader emits premultiplied color, so compositing is correct both when
 * this canvas is the on-screen surface and when the factory blits it into a
 * 2d presenter context.
 *
 * @module svelte-adapter-uws/plugins/cursor/render/webgl2
 */

/** Default dot radius in CSS pixels (matches the Canvas2D backend). */
const DEFAULT_RADIUS = 4;

const VERTEX_SRC = `#version 300 es
layout(location=0) in vec2 a_corner;   // unit quad corner in [-1,1]
layout(location=1) in vec2 a_pos;      // per-instance center, device px
layout(location=2) in vec4 a_color;    // per-instance RGBA, normalized
uniform vec2 u_resolution;             // drawing buffer size, device px
uniform float u_radius;                // dot radius, device px
out vec2 v_uv;
out vec4 v_color;
void main() {
	v_uv = a_corner;
	v_color = a_color;
	vec2 px = a_pos + a_corner * u_radius;
	vec2 clip = (px / u_resolution) * 2.0 - 1.0;
	gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
out vec4 outColor;
void main() {
	float dist = length(v_uv);
	// Anti-aliased disc edge: fully opaque inside, ~1px feather at the rim.
	float alpha = 1.0 - smoothstep(0.82, 1.0, dist);
	if (alpha <= 0.0) discard;
	float a = v_color.a * alpha;
	outColor = vec4(v_color.rgb * a, a); // premultiplied
}`;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} type
 * @param {string} src
 */
function compile(gl, type, src) {
	const sh = gl.createShader(type);
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(sh);
		gl.deleteShader(sh);
		throw new Error('cursor renderer: shader compile failed: ' + log);
	}
	return sh;
}

export class WebGL2Renderer {
	/**
	 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
	 * @param {{ devicePixelRatio?: number, radius?: number }} [opts]
	 */
	constructor(canvas, opts) {
		const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false });
		if (!gl) {
			throw new Error('cursor renderer: canvas.getContext(\'webgl2\') returned null (no WebGL2, or the canvas already has a different context type)');
		}
		this.backend = 'webgl2';
		this.canvas = canvas;
		this.gl = gl;
		this.dpr = (opts && opts.devicePixelRatio) || 1;
		this.radius = (opts && opts.radius) || DEFAULT_RADIUS;
		this.cssWidth = 0;
		this.cssHeight = 0;

		const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
		const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
		const prog = gl.createProgram();
		gl.attachShader(prog, vs);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(prog);
			gl.deleteProgram(prog);
			throw new Error('cursor renderer: program link failed: ' + log);
		}
		this.program = prog;
		this.uResolution = gl.getUniformLocation(prog, 'u_resolution');
		this.uRadius = gl.getUniformLocation(prog, 'u_radius');

		this.vao = gl.createVertexArray();
		gl.bindVertexArray(this.vao);

		// Unit quad corners, shared by every instance.
		this.cornerBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

		// Per-instance center positions (device px).
		this.posBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
		gl.vertexAttribDivisor(1, 1);

		// Per-instance RGBA colors, one byte per channel, normalized in-shader.
		this.colorBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
		gl.vertexAttribDivisor(2, 1);

		gl.bindVertexArray(null);

		gl.disable(gl.DEPTH_TEST);
		gl.enable(gl.BLEND);
		// Premultiplied-alpha over.
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.clearColor(0, 0, 0, 0);

		/** Growable CPU-side instance staging. */
		this._capacity = 0;
		/** @type {Float32Array} */
		this._positions = new Float32Array(0);
		/** @type {Uint8Array} */
		this._colors = new Uint8Array(0);
	}

	/** Ensure staging arrays hold at least `n` instances. */
	_ensureCapacity(n) {
		if (n <= this._capacity) return;
		let cap = this._capacity || 256;
		while (cap < n) cap *= 2;
		this._capacity = cap;
		this._positions = new Float32Array(cap * 2);
		this._colors = new Uint8Array(cap * 4);
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
	 * @param {number} count upper bound on iterable length (sizes the staging upload)
	 */
	render(cursors, count) {
		const gl = this.gl;
		if (!gl || gl.isContextLost()) return;
		this._ensureCapacity(count);
		const pos = this._positions;
		const col = this._colors;
		const dpr = this.dpr;
		let n = 0;
		for (const c of cursors) {
			if (c.hidden) continue;
			if (n >= this._capacity) break; // count was an under-estimate; render what fits
			pos[n * 2] = c.x * dpr;
			pos[n * 2 + 1] = c.y * dpr;
			const rgba = c.colorRGBA;
			col[n * 4] = (rgba >>> 24) & 0xff;
			col[n * 4 + 1] = (rgba >>> 16) & 0xff;
			col[n * 4 + 2] = (rgba >>> 8) & 0xff;
			col[n * 4 + 3] = rgba & 0xff;
			n++;
		}

		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (n === 0) return;

		gl.useProgram(this.program);
		gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
		gl.uniform1f(this.uRadius, this.radius * dpr);
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
		gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, n * 2), gl.DYNAMIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
		gl.bufferData(gl.ARRAY_BUFFER, col.subarray(0, n * 4), gl.DYNAMIC_DRAW);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
		gl.bindVertexArray(null);
	}

	dispose() {
		const gl = this.gl;
		if (gl) {
			gl.deleteBuffer(this.cornerBuf);
			gl.deleteBuffer(this.posBuf);
			gl.deleteBuffer(this.colorBuf);
			gl.deleteVertexArray(this.vao);
			gl.deleteProgram(this.program);
			const lose = gl.getExtension('WEBGL_lose_context');
			if (lose) lose.loseContext();
		}
		this.gl = null;
		this._positions = new Float32Array(0);
		this._colors = new Uint8Array(0);
		this._capacity = 0;
	}
}
