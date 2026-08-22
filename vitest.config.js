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
		// Expose `global.gc` to every worker so the real-server leak harness runs
		// instead of gating itself off. Nothing else supplied the flag, so its
		// `uWS && gc` condition was never satisfiable and the non-deterministic
		// memory dimension went uncovered on every platform while the summary line
		// still read green. Set here rather than in NODE_OPTIONS because an inline
		// environment assignment in an npm script does not carry across Windows.
		// The flag only publishes the collection hook; it does not change how V8
		// collects, so no other suite's behaviour moves. Top-level, not under
		// `poolOptions`: vitest 4 removed that nesting and silently ignores it,
		// which looks identical to the flag working and the suite skipping anyway.
		execArgv: ['--expose-gc'],
		include: ['test/**/*.test.js'],
		// `**/node_modules/**`, not `node_modules/**`: the Svelte 4 profile under
		// test/fixtures/ installs its own dependency tree, and a bare top-level
		// pattern let vitest collect third-party suites out of it (devalue's own
		// tests ran, and failed, as part of this repository's run). Note the
		// singular `test/fixture/**` below does not cover `test/fixtures/` - the
		// same one-letter gap that once let that profile commit its build output.
		exclude: ['source/**', '**/node_modules/**', 'bench/**', 'test/e2e/**', 'test/fixture/**', 'test/fixtures/**'],
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
		setupFiles: ['./test/helpers/restore-globals.js', './test/helpers/stop-leaked-runtimes.js']
	}
});
