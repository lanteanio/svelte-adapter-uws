import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import adapter from 'svelte-adapter-uws';
import uws from 'svelte-adapter-uws/vite';

export default defineConfig({
	plugins: [sveltekit({
		adapter: adapter({ websocket: { handler: './src/socket.js', metrics: './src/metrics.js' } })
	}), uws()]
});
