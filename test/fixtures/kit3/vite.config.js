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

export default defineConfig(({ mode }) => ({
	plugins: [sveltekit({
		appDir: '_kit3',
		adapter: adapter({ websocket: { handler: './src/socket.js' } })
	}), ...(mode === 'fallback' ? [] : [uws({ handler: './src/socket.js' })]), ...(mode === 'entries' ? [extraEntries()] : [])]
}));
