import adapter from 'svelte-adapter-uws';
import { FIXTURE_VARIANTS } from './variants.js';

// Which build-time adapter configuration to produce. Unset means the default
// variant, so a plain `vite build` here keeps behaving exactly as before.
const name = process.env.FIXTURE_VARIANT || 'default';
const variant = FIXTURE_VARIANTS[name];
if (!variant) {
	throw new Error(`unknown FIXTURE_VARIANT "${name}" (have: ${Object.keys(FIXTURE_VARIANTS).join(', ')})`);
}

// The `consolidated` variant exists to prove the CURRENT `sv create` path,
// where the adapter is passed to `sveltekit(...)` in vite.config.js and this
// file is ignored entirely. Configuring the adapter here as well would make
// that proof vacuous: deleting the consolidated wiring would silently fall back
// to this sidecar, which computes the identical adapter with the identical out
// directory, and the canary would stay green while testing the legacy path.
//
// So this file DECLINES to configure the adapter for that variant. If the
// consolidated wiring is ever removed, the build falls through to adapter-auto
// and produces no runnable `build-consolidated/index.js` - which is exactly the
// failure a current `sv` user hits, and exactly what the canary must catch.
const isConsolidated = variant.configStyle === 'consolidated';

export default {
	kit: isConsolidated ? {} : {
		adapter: adapter({
			out: variant.out,
			tracing: variant.tracing,
			staticDotfiles: variant.staticDotfiles,
			websocket: variant.handler
				? { ...variant.websocket, handler: variant.handler }
				: variant.websocket
		})
	}
};
