/**
 * WebGPU cursor renderer: reserved backend slot.
 *
 * The renderer interface (see ./canvas2d.js) is fixed so a WebGPU backend
 * drops in as a one-line factory branch once it ships; nothing in the worker
 * or the network layer changes. Until then a forced `gpu: 'webgpu'` must fail
 * loudly at construction - a deployment that asks for a backend it has not
 * tested should find out in CI, not silently degrade in production.
 *
 * @module svelte-adapter-uws/plugins/cursor/render/webgpu
 */

export class WebGPURenderer {
	constructor() {
		throw new Error("cursor renderer: gpu: 'webgpu' is not shipped yet - use 'webgl2', 'canvas2d', or 'auto'");
	}
}
