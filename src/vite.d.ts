import type { Plugin } from 'vite';
import type { WebSocketOptions } from './index.js';

/**
 * Subset of `WebSocketOptions` that the dev plugin honors. Picked from the
 * adapter's own type so the JSDoc and defaults of a listed flag stay in lockstep
 * with production.
 *
 * NOTE this is an explicit list, not an open door: a flag added to
 * `WebSocketOptions` does NOT appear here until it is named below. That gap is
 * how `authorizeWireSubscribe` came to be read by src/vite.js while being a type
 * error to pass, so a flag the dev server honors must be added in both places.
 * These options are FLAT and are not copied from the adapter's `websocket`
 * object. Repeat security options here when dev must enforce the production
 * posture, e.g. `uws({ authorizeWireSubscribe: true })`.
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
	| 'authorizeWireSubscribe'
	| 'maxPayloadLength'
	| 'messageAdmission'
>;

export interface UWSPluginOptions extends SharedAdapterOptions {
	/**
	 * Maximum inbound WebSocket message size in bytes. This is enforced by
	 * the dev `ws` receiver and reported by `platform.maxPayloadLength`.
	 * Must be a positive integer no greater than 2,147,483,647.
	 *
	 * @default 1048576 (1 MiB)
	 */
	maxPayloadLength?: number;

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
 * The plugin's dev options are separate from `adapter({ websocket: ... })`.
 * Repeat shared security flags explicitly; they are not inherited from
 * `svelte.config.js`.
 *
 * ```js
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import uws from 'svelte-adapter-uws/vite';
 *
 * export default {
 *   plugins: [sveltekit(), uws({ authorizeWireSubscribe: true })]
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
