import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('vite plugin', () => {
	describe('module loading', () => {
		it('imports without requiring ws at the top level', async () => {
			const mod = await import('../vite.js');
			expect(typeof mod.default).toBe('function');
		});

		it('exports uwsDev as deprecated alias', async () => {
			const mod = await import('../vite.js');
			expect(mod.uwsDev).toBe(mod.default);
		});
	});

	describe('plugin shape', () => {
		let plugin;

		beforeEach(async () => {
			const mod = await import('../vite.js');
			plugin = mod.default();
		});

		it('has the correct name', () => {
			expect(plugin.name).toBe('svelte-adapter-uws');
		});

		it('has config hook', () => {
			expect(typeof plugin.config).toBe('function');
		});

		it('has configureServer hook', () => {
			expect(typeof plugin.configureServer).toBe('function');
		});

		it('has handleHotUpdate hook', () => {
			expect(typeof plugin.handleHotUpdate).toBe('function');
		});
	});

	describe('configureServer', () => {
		it('warns and returns early in middleware mode (no httpServer)', async () => {
			const mod = await import('../vite.js');
			const plugin = mod.default();

			const warnings = [];
			const server = {
				httpServer: null,
				config: {
					root: process.cwd(),
					server: {},
					logger: { warn: (msg) => warnings.push(msg) }
				}
			};

			await plugin.configureServer(server);
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('middleware mode');
		});

		it('warns and returns early when ws is not installed', async () => {
			vi.doMock('ws', () => { throw new Error('Cannot find package'); });

			// Re-import to pick up the mock
			const { default: uws } = await import('../vite.js?ws-missing');
			const plugin = uws();

			const warnings = [];
			const server = {
				httpServer: { on: vi.fn() },
				config: {
					root: process.cwd(),
					server: {},
					logger: { warn: (msg) => warnings.push(msg) }
				}
			};

			await plugin.configureServer(server);
			expect(warnings.some(w => w.includes('"ws" package is not installed'))).toBe(true);

			vi.doUnmock('ws');
		});

		it('sets up WebSocket server when ws is available', async () => {
			const mod = await import('../vite.js');
			const plugin = mod.default();

			const warnings = [];
			const upgradeHandlers = [];
			const server = {
				httpServer: {
					on: (event, handler) => {
						if (event === 'upgrade') upgradeHandlers.push(handler);
					}
				},
				config: {
					root: process.cwd(),
					server: {},
					logger: { warn: (msg) => warnings.push(msg) }
				}
			};

			await plugin.configureServer(server);

			// Should have registered an upgrade handler
			expect(upgradeHandlers.length).toBe(1);
			// No "ws not installed" warning
			expect(warnings.some(w => w.includes('"ws" package is not installed'))).toBe(false);
		});

		it('warns when ws path collides with HMR path', async () => {
			const mod = await import('../vite.js');
			const plugin = mod.default({ path: '/__hmr' });

			const warnings = [];
			const server = {
				httpServer: { on: vi.fn() },
				config: {
					root: process.cwd(),
					server: { hmr: { path: '/__hmr' } },
					logger: { warn: (msg) => warnings.push(msg) }
				}
			};

			await plugin.configureServer(server);
			expect(warnings.some(w => w.includes('collides with the Vite HMR path'))).toBe(true);
		});
	});

	describe('config hook (SSR build)', () => {
		it('returns rollup input when handler file exists', async () => {
			const mod = await import('../vite.js');
			const plugin = mod.default({ handler: './test/vite.test.js' });

			const result = plugin.config(
				{ root: process.cwd() },
				{ isSsrBuild: true }
			);

			expect(result).toBeTruthy();
			expect(result.build.rollupOptions.input['ws-handler']).toBeTruthy();
		});

		it('returns undefined for non-SSR builds', async () => {
			const mod = await import('../vite.js');
			const plugin = mod.default({ handler: './test/vite.test.js' });

			const result = plugin.config(
				{ root: process.cwd() },
				{ isSsrBuild: false }
			);

			expect(result).toBeUndefined();
		});

		it('returns undefined when no handler file found', async () => {
			const mod = await import('../vite.js');
			const plugin = mod.default();

			const result = plugin.config(
				{ root: '/nonexistent/path' },
				{ isSsrBuild: true }
			);

			expect(result).toBeUndefined();
		});
	});
});
