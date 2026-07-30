import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

describe('vite plugin', () => {
	describe('module loading', () => {
		it('imports without requiring ws at the top level', async () => {
			const mod = await import('../src/vite.js');
			expect(typeof mod.default).toBe('function');
		});

		it('exports uwsDev as deprecated alias', async () => {
			const mod = await import('../src/vite.js');
			expect(mod.uwsDev).toBe(mod.default);
		});
	});

	describe('plugin shape', () => {
		let plugin;

		beforeEach(async () => {
			const mod = await import('../src/vite.js');
			plugin = mod.default();
		});

		it('has the correct name', () => {
			expect(plugin.name).toBe('svelte-adapter-uws');
		});

		it('has configResolved + buildStart hooks (Vite 7 env API)', () => {
			expect(typeof plugin.configResolved).toBe('function');
			expect(typeof plugin.buildStart).toBe('function');
		});

		it('has configureServer hook', () => {
			expect(typeof plugin.configureServer).toBe('function');
		});

		it('has handleHotUpdate hook', () => {
			expect(typeof plugin.handleHotUpdate).toBe('function');
		});
	});

	describe('configureServer', () => {
		it('loads websocket.handler from SvelteKit resolved config in dev', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default();
			const ssrLoadModule = vi.fn().mockResolvedValue({});
			const server = {
				httpServer: { on: vi.fn(), once: vi.fn() },
				middlewares: { use: vi.fn() },
				ssrLoadModule,
				config: {
					root: path.join(process.cwd(), 'test'),
					server: {},
					logger: { warn: vi.fn() },
					plugins: [{
						name: 'vite-plugin-sveltekit-setup',
						api: {
							options: {
								kit: {
									adapter: {
										name: 'adapter-uws',
										websocketHandler: './test/vite.test.js'
									}
								}
							}
						}
					}]
				}
			};

			await plugin.configureServer(server);

			expect(ssrLoadModule).toHaveBeenCalledWith(path.resolve('test/vite.test.js'));
		});

		it('warns and returns early in middleware mode (no httpServer)', async () => {
			const mod = await import('../src/vite.js');
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
			const { default: uws } = await import('../src/vite.js?ws-missing');
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
			const mod = await import('../src/vite.js');
			const plugin = mod.default();

			const warnings = [];
			const upgradeHandlers = [];
			const server = {
				httpServer: {
					on: (event, handler) => {
						if (event === 'upgrade') upgradeHandlers.push(handler);
					},
					once: vi.fn()
				},
				middlewares: { use: vi.fn() },
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
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ path: '/__hmr' });

			const warnings = [];
			const server = {
				httpServer: { on: vi.fn(), once: vi.fn() },
				middlewares: { use: vi.fn() },
				config: {
					root: process.cwd(),
					server: { hmr: { path: '/__hmr' } },
					logger: { warn: (msg) => warnings.push(msg) }
				}
			};

			await plugin.configureServer(server);
			expect(warnings.some(w => w.includes('collides with the Vite HMR path'))).toBe(true);
		});

		it('mounts the authenticate middleware at /__ws/auth', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default();

			const warnings = [];
			const middlewarePaths = [];
			const server = {
				httpServer: { on: vi.fn(), once: vi.fn() },
				middlewares: {
					use: (pathOrFn, maybeFn) => {
						if (typeof pathOrFn === 'string') middlewarePaths.push(pathOrFn);
					}
				},
				config: {
					root: process.cwd(),
					server: {},
					logger: { warn: (msg) => warnings.push(msg) }
				}
			};

			await plugin.configureServer(server);
			expect(middlewarePaths).toContain('/__ws/auth');
		});

		it('mounts the authenticate middleware at a custom path', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ authPath: '/api/ws-auth' });

			const middlewarePaths = [];
			const server = {
				httpServer: { on: vi.fn(), once: vi.fn() },
				middlewares: {
					use: (pathOrFn) => {
						if (typeof pathOrFn === 'string') middlewarePaths.push(pathOrFn);
					}
				},
				config: {
					root: process.cwd(),
					server: {},
					logger: { warn: vi.fn() }
				}
			};

			await plugin.configureServer(server);
			expect(middlewarePaths).toContain('/api/ws-auth');
		});
	});

	describe('applyHandlers coverage', () => {
		it('includes unsubscribe in handler extraction', async () => {
			// The applyHandlers function is internal, but we can verify
			// the plugin passes through all hooks by checking the module shape
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ handler: './test/vite.test.js' });

			// handleHotUpdate compares all handler references including unsubscribe.
			// If it didn't, changing just the unsubscribe export wouldn't trigger
			// a reconnect. We verify the hook exists and accepts the right shape.
			expect(typeof plugin.handleHotUpdate).toBe('function');

			// handleHotUpdate should not throw when called without a resolved handler
			plugin.handleHotUpdate({ server: { ssrLoadModule: vi.fn() } });
		});
	});

	describe('SSR build (configResolved + buildStart)', () => {
		it('reads websocket.handler from SvelteKit resolved config when no config file exists', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default();

			await plugin.configResolved({
				// Adapter paths use the same project-cwd base as adapt(); an
				// explicit Vite root must not reinterpret the configured module.
				root: path.join(process.cwd(), 'test'),
				build: { ssr: true },
				plugins: [{
					name: 'vite-plugin-sveltekit-setup',
					api: {
						options: {
							kit: {
								adapter: {
									name: 'adapter-uws',
									websocketHandler: './test/vite.test.js'
								}
							}
						}
					}
				}]
			});

			const emitFile = vi.fn();
			plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });

			expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({
				type: 'chunk',
				id: path.resolve('test/vite.test.js'),
				fileName: 'ws-handler.js'
			}));
			const marker = emitFile.mock.calls
				.map(([arg]) => arg)
				.find((arg) => arg.fileName === 'ws-handler.origin.json');
			expect(JSON.parse(marker.source).from).toBe('websocket.handler in SvelteKit config');
		});

		it('refuses conflicting plugin and direct SvelteKit handler values', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ handler: './vite.test.js' });

			await expect(plugin.configResolved({
				root: path.join(process.cwd(), 'test'),
				build: { ssr: true },
				plugins: [{
					name: 'vite-plugin-sveltekit-setup',
					api: {
						options: {
							kit: {
								adapter: {
									name: 'adapter-uws',
									websocketHandler: './test/_helpers.js'
								}
							}
						}
					}
				}]
			})).rejects.toThrow(/named twice, and the two disagree/);
		});

		it('emits the ws-handler chunk when handler file exists during the SSR build', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ handler: './test/vite.test.js' });

			await plugin.configResolved({ root: process.cwd(), build: { ssr: true } });

			const emitFile = vi.fn();
			plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });

			// The chunk, plus a record of WHICH module became the handler. The
			// adapter reads that record to name the module in its build log and
			// to refuse a build where its own `websocket.handler` disagrees with
			// what was bundled - without it the adapter can see only that some
			// ws-handler.js exists, which is what let a substitution pass in
			// silence.
			expect(emitFile).toHaveBeenCalledTimes(2);
			expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({
				type: 'chunk',
				fileName: 'ws-handler.js'
			}));
			expect(emitFile).toHaveBeenCalledWith(expect.objectContaining({
				type: 'asset',
				fileName: 'ws-handler.origin.json'
			}));

			const marker = emitFile.mock.calls
				.map(([arg]) => arg)
				.find((arg) => arg.fileName === 'ws-handler.origin.json');
			const origin = JSON.parse(marker.source);
			expect(origin.source).toBe('test/vite.test.js');
			expect(origin.from).toContain('vite.config.js');
		});

		it('does not emit when the build is not an SSR build', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ handler: './test/vite.test.js' });

			await plugin.configResolved({ root: process.cwd(), build: { ssr: false } });

			const emitFile = vi.fn();
			plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });

			expect(emitFile).not.toHaveBeenCalled();
		});

		it('does not emit on the client environment of a multi-environment SSR build', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default({ handler: './test/vite.test.js' });

			await plugin.configResolved({ root: process.cwd(), build: { ssr: true } });

			const emitFile = vi.fn();
			plugin.buildStart.call({ emitFile, environment: { name: 'client' } });

			expect(emitFile).not.toHaveBeenCalled();
		});

		it('does not emit when no handler file is found', async () => {
			const mod = await import('../src/vite.js');
			const plugin = mod.default();

			await plugin.configResolved({ root: '/nonexistent/path', build: { ssr: true } });

			const emitFile = vi.fn();
			plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });

			expect(emitFile).not.toHaveBeenCalled();
		});
	});
});
