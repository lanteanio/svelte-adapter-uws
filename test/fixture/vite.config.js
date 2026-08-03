import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import uws from 'svelte-adapter-uws/vite';
import adapter from 'svelte-adapter-uws';
import { FIXTURE_VARIANTS } from './variants.js';

const name = process.env.FIXTURE_VARIANT || 'default';
const variant = FIXTURE_VARIANTS[name];
if (!variant) throw new Error(`unknown FIXTURE_VARIANT "${name}"`);

// Most variants retain the legacy two-file fixture so its compatibility path
// remains tested. The consolidated variant mirrors current `sv create`: once a
// value is passed to sveltekit(...), SvelteKit intentionally ignores
// svelte.config.js, so the adapter must be present here or no runnable build is
// produced.
const directConfig = variant.configStyle === 'consolidated'
	? {
		adapter: adapter({
			out: variant.out,
			tracing: variant.tracing,
			websocket: variant.handler
				? { ...variant.websocket, handler: variant.handler }
				: variant.websocket
		})
	}
	: undefined;

// On legacy variants the WS handler is named once in svelte.config.js and the
// plugin reads it from SvelteKit's resolved config. Handler-bearing variants
// keep that older path live while `consolidated` proves the current path.
export default defineConfig({
	plugins: [sveltekit(directConfig), uws()]
});
