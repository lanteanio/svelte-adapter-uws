import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Disable dep discovery and pre-bundling. The vmForks pool loads modules
	// through Node's own resolver, so Vite's pre-bundling is unused. A
	// one-time dep-scan warning may appear on cold cache; subsequent runs
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
		exclude: ['source/**', 'node_modules/**', 'bench/**']
	}
});
