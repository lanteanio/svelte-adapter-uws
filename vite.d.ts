import type { Plugin } from 'vite';
import type { WebSocketOptions } from './index.js';

/**
 * Subset of `WebSocketOptions` that the dev plugin honors. Picked from
 * the adapter's own type so JSDoc and defaults stay in lockstep with
 * production - a flag added to `WebSocketOptions` surfaces here
 * automatically without a second declaration.
 */
type SharedAdapterOptions = Pick<
	WebSocketOptions,
	| 'path'
	| 'handler'
	| 'authPath'
	| 'allowedOrigins'
	| 'allowSystemTopicSubscribe'
	| 'allowNonAsciiTopics'
	| 'authPathRequireOrigin'
>;

export interface UWSPluginOptions extends SharedAdapterOptions {
	/**
	 * Skip the dev plugin's `allowedOrigins` enforcement on WSS upgrades.
	 * The dev plugin enforces origins the same way the production handler
	 * does; set `true` for local dev scenarios that need to accept WSS
	 * from arbitrary origins (e.g. a staging client during integration).
	 *
	 * Production behavior is unaffected by this flag.
	 *
	 * @default false
	 */
	devSkipOriginCheck?: boolean;

	/**
	 * Timeout in milliseconds for `platform.request()` calls when running
	 * under the Vite dev plugin. Production has its own request-timeout
	 * path; this knob only applies in dev.
	 *
	 * @default 5000
	 */
	timeoutMs?: number;
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
