import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import uws from 'svelte-adapter-uws/vite';

// The WS handler is named ONCE, on the adapter in svelte.config.js. The plugin
// reads it from there, so nothing needs passing here - and because every
// handler-bearing variant now relies on that, those builds are a standing check
// that the adapter's `websocket.handler` still survives with the plugin
// installed. If it stops being honored the plugin falls back to auto-discovering
// src/hooks.ws.js, and the `grant` variant's suites fail loudly rather than
// quietly testing a server that enforces nothing.
export default defineConfig({
	plugins: [sveltekit(), uws()]
});
