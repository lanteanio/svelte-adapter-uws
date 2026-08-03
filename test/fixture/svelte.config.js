import adapter from 'svelte-adapter-uws';
import { FIXTURE_VARIANTS } from './variants.js';

// Which build-time adapter configuration to produce. Unset means the default
// variant, so a plain `vite build` here keeps behaving exactly as before.
const name = process.env.FIXTURE_VARIANT || 'default';
const variant = FIXTURE_VARIANTS[name];
if (!variant) {
	throw new Error(`unknown FIXTURE_VARIANT "${name}" (have: ${Object.keys(FIXTURE_VARIANTS).join(', ')})`);
}

export default {
	kit: {
		adapter: adapter({
			out: variant.out,
			tracing: variant.tracing,
			websocket: variant.handler
				? { ...variant.websocket, handler: variant.handler }
				: variant.websocket
		})
	}
};
