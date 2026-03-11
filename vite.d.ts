import type { Plugin } from 'vite';

export interface UWSPluginOptions {
	/**
	 * WebSocket endpoint path. Must match the adapter config.
	 * @default '/ws'
	 */
	path?: string;

	/**
	 * Path to a custom WebSocket handler module (same as adapter's `websocket.handler`).
	 * Auto-discovers `src/hooks.ws.{js,ts,mjs}` if not specified.
	 */
	handler?: string;
}

/**
 * Vite plugin for svelte-adapter-uws.
 *
 * Required when using WebSockets. Handles two things:
 * - Dev: spins up a WebSocket server so `event.platform` works during `npm run dev`
 * - Build: injects `hooks.ws` into Vite's SSR pipeline so `$lib`, `$env`, and `$app` resolve correctly
 *
 * ```js
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import uws from 'svelte-adapter-uws/vite';
 *
 * export default {
 *   plugins: [sveltekit(), uws()]
 * };
 * ```
 */
export default function uws(options?: UWSPluginOptions): Plugin;

/** @deprecated Use `uws()` instead. */
export { uws as uwsDev };

/** @deprecated Use `UWSPluginOptions` instead. */
export type UWSDevOptions = UWSPluginOptions;

declare global {
	/** Dev-mode platform object - set by the Vite plugin. Same API as production `event.platform`. */
	var __uws_dev_platform: import('./index.js').Platform | undefined;
}
