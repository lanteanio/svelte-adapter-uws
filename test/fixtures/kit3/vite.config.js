import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import adapter from 'svelte-adapter-uws';
import uws from 'svelte-adapter-uws/vite';

function extraEntries() {
	return {
		name: 'fixture-extra-entries',
		apply: 'build',
		buildStart() {
			if (this.environment?.name !== 'ssr') return;
			for (const [name, source] of [
				['__kit3-a.js', './src/entry-start.js'],
				['__kit3-b.js', './src/entry-release.js']
			]) {
				this.emitFile({ type: 'chunk', id: fileURLToPath(new URL(source, import.meta.url)), fileName: name });
			}
		}
	};
}

export default defineConfig(({ mode }) => {
	const configuredAdapter = adapter({ websocket: { handler: './src/socket.js' } });
	return {
		plugins: [sveltekit({
			appDir: '_kit3',
			alias: mode === 'fallback-alias' ? { '$lib': './src/lib' }
				: mode === 'fallback-wildcard' ? { '$lib/*': './src/fallback-wildcard/*' }
				: mode === 'fallback-both' ? { '$lib': './src/fallback-exact.js', '$lib/*': './src/fallback-wildcard/*' }
				: mode === 'fallback-specific' ? { '$lib/specific': './src/fallback-exact.js' }
				: mode === 'fallback-specific-prefix' ? { '$lib/specific': './src/fallback-wildcard' }
				: mode === 'fallback-specific-both' ? {
					'$lib/specific': './src/fallback-exact.js',
					'$lib/specific/*': './src/fallback-wildcard/*',
					'$lib/*': './src/lib/*'
				} : undefined,
			adapter: mode === 'no-adapter' ? undefined
				: mode === 'wrapped-adapter' ? { ...configuredAdapter, name: 'fixture-wrapper' } : configuredAdapter
		}), ...(mode.startsWith('fallback') ? [] : [uws({ handler: './src/socket.js' })]), ...(mode === 'entries' ? [extraEntries()] : [])]
	};
});
