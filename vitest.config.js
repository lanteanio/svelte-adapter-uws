import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Disable dep discovery and pre-bundling. The vmForks pool loads modules
	// through Node's own resolver, so Vite's pre-bundling is unused. A
	// one-time dependency-discovery warning may appear on cold cache; subsequent runs
	// are clean.
	optimizeDeps: {
		noDiscovery: true,
		include: []
	},
	server: {
		preTransformRequests: false,
		watch: { ignored: ['**/source/**', '**/bench/**'] },
		fs: { deny: ['source', 'bench/_tmp_static'] }
	},
	test: {
		pool: 'vmForks',
		include: ['test/**/*.test.js'],
		exclude: ['source/**', 'node_modules/**', 'bench/**', 'test/e2e/**', 'test/fixture/**'],
		// Build the fixture variants once, serially, before any worker starts.
		// Without this every suite that needs a build races the others for one
		// on-disk lock, and the losers sleep-poll through somebody else's
		// `vite build` - which on a loaded machine turns into a failure that
		// only reproduces under full parallelism. See the helper.
		globalSetup: ['./test/helpers/global-setup.js'],
		// Restore `globalThis.WebSocket` / `window` after each test FILE. Runs
		// before the file it serves, so it snapshots pristine values; without it a
		// client suite's mock leaks into every later file in serial mode, where one
		// context is shared. See the helper for the failure this closes.
		setupFiles: ['./test/helpers/restore-globals.js']
	}
});
