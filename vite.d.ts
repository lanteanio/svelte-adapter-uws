import type { Plugin } from 'vite';

export interface UWSDevOptions {
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
 * Vite plugin for dev mode WebSocket support.
 *
 * Add this to your `vite.config.js` so the client store and
 * `event.platform` work during development:
 *
 * ```js
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import uwsDev from 'svelte-adapter-uws/vite';
 *
 * export default {
 *   plugins: [sveltekit(), uwsDev()]
 * };
 * ```
 *
 * That's it - `event.platform` works identically in dev and production:
 *
 * ```js
 * export async function POST({ platform }) {
 *   platform.publish('todos', 'created', todo);
 * }
 * ```
 *
 * The adapter's `emulate()` hook provides `event.platform` in dev
 * using the platform object created by this Vite plugin.
 */
export default function uwsDev(options?: UWSDevOptions): Plugin;

declare global {
	/** Dev-mode platform object - set by the Vite plugin. Same API as production `event.platform`. */
	var __uws_dev_platform: import('./index.js').Platform | undefined;
}
