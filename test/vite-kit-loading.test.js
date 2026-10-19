import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import uws from '../vite.js';
import { WS_SUBSCRIPTIONS, WS_PLATFORM } from '../files/utils.js';

function viteServer(httpServer, kitVersion, loadModule, root = process.cwd()) {
	const adapter = { name: 'adapter-uws' };
	return {
		httpServer,
		close: vi.fn(async () => {}),
		middlewares: { use: vi.fn((route, middleware) => {
			httpServer.on('request', (req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
		}) },
		config: {
			root,
			server: {},
			logger: { warn: vi.fn() },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: kitVersion === 3 ? { paths: {}, adapter } : { kit: { adapter } } } }]
		},
		ssrLoadModule: vi.fn(loadModule),
		moduleGraph: { invalidateAll: vi.fn() },
		environments: { ssr: { runner: { import: vi.fn(loadModule) } } }
	};
}

// Vite's spelling of a module file: forward slashes on Windows.
const viteId = file => process.platform === 'win32' ? file.replaceAll('\\', '/') : file;

async function hotUpdate(plugin, server) {
	await plugin.hotUpdate.call({ environment: { name: 'client' } }, { type: 'update', file: server.ssrLoadModule.mock.calls[0][0], server });
	await server.config.server.hotUpdateEnvironments(server, async () => {});
}

async function closeLifecycle(plugin, server) {
	if (server.environments) await plugin.closeBundle.call({ environment: server.environments.ssr });
	else await server.close();
}

async function listen(server) {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return `ws://127.0.0.1:${server.address().port}/ws`;
}

function handlerMessage(client) {
	return new Promise((resolve, reject) => {
		const onMessage = (data) => {
			const value = data.toString();
			if (value.startsWith('{"type":"welcome",')) return;
			client.off('message', onMessage);
			client.off('error', reject);
			resolve(value);
		};
		client.on('message', onMessage);
		client.once('error', reject);
	});
}

async function close(server, clients) {
	for (const client of clients) client.terminate();
	if (server.listening) await new Promise((resolve) => server.close(resolve));
}

describe('Vite server module loading', () => {
	it.each([
		[2, 'explicit'], [2, 'discovered'], [3, 'explicit'], [3, 'discovered']
	])('Kit %i loads %s handlers in the route module graph', async (kitVersion, discovery) => {
		const httpServer = createServer();
		const clients = [];
		let finishLoad;
		const loading = new Promise((resolve) => { finishLoad = resolve; });
		const root = path.resolve('test/fixture');
		const server = viteServer(httpServer, kitVersion, () => loading, root);
		const expectedLoader = kitVersion === 3 ? server.environments.ssr.runner.import : server.ssrLoadModule;
		const otherLoader = kitVersion === 3 ? server.ssrLoadModule : server.environments.ssr.runner.import;
		const handler = discovery === 'explicit' ? './custom-handler.ts' : undefined;
		const handlerPath = path.resolve(root, handler || 'src/hooks.ws.js');
		const loadedPath = viteId(handlerPath);
		const plugin = uws({ handler, allowedOrigins: '*' });
		const init = vi.fn();

		try {
			await plugin.configureServer(server);
			expect(expectedLoader).not.toHaveBeenCalled();
			expect(otherLoader).not.toHaveBeenCalled();

			const url = await listen(httpServer);
			await vi.waitFor(() => expect(expectedLoader).toHaveBeenCalledWith(loadedPath));
			const upgrade = once(httpServer, 'upgrade');
			const client = new WebSocket(url);
			clients.push(client);
			const firstMessage = handlerMessage(client);
			const opened = vi.fn();
			client.on('open', opened);
			await upgrade;
			expect(opened).not.toHaveBeenCalled();
			expect(init).not.toHaveBeenCalled();
			finishLoad({ init, open: (ws) => ws.send('initial handler') });
			expect(await firstMessage).toBe('initial handler');
			expect(init).toHaveBeenCalledTimes(1);

			if (kitVersion === 3) return;

			expectedLoader.mockResolvedValue({ init, open: (ws) => ws.send('updated handler') });
			const restarted = once(client, 'close');
			hotUpdate(plugin, server);
			expect((await restarted)[0]).toBe(1012);
			expect(expectedLoader).toHaveBeenCalledTimes(2);
			expect(expectedLoader).toHaveBeenLastCalledWith(loadedPath);
			expect(otherLoader).not.toHaveBeenCalled();

			const nextClient = new WebSocket(url);
			clients.push(nextClient);
			expect(await handlerMessage(nextClient)).toBe('updated handler');
			expect(init).toHaveBeenCalledTimes(2);
		} finally {
			finishLoad({});
			await close(httpServer, clients);
		}
	});

	it.each([{}, { name: 'wrapped-adapter' }])('loads flat Kit 3 options with a compatibility kit property and adapter %j', async (adapter) => {
		const httpServer = createServer();
		const clients = [];
		try {
			const url = await listen(httpServer);
			const server = viteServer(httpServer, 3, async () => ({ open: (ws) => ws.send('ready') }));
			server.config.plugins[0].api.options = { paths: {}, kit: {}, ...(adapter.name ? { adapter } : {}) };
			await uws({ handler: './handler.js', allowedOrigins: '*' }).configureServer(server);
			const client = new WebSocket(url);
			clients.push(client);
			expect(await handlerMessage(client)).toBe('ready');
			expect(server.environments.ssr.runner.import).toHaveBeenCalledOnce();
			expect(server.ssrLoadModule).not.toHaveBeenCalled();
		} finally {
			await close(httpServer, clients);
		}
	});
});

describe('Kit 3 build environments', () => {
	it.each(['ssr', 'client'])('emits server entries only in the SSR environment (%s)', (environment) => {
		const plugin = uws({ handler: './test/vite-kit-loading.test.js' });
		plugin.configResolved({
			root: process.cwd(), command: 'build', build: { ssr: false }, environments: { ssr: {} }
		});
		const emitFile = vi.fn();
		plugin.buildStart.call({ emitFile, environment: { name: environment } });
		if (environment === 'ssr') {
			expect(emitFile).toHaveBeenCalledExactlyOnceWith({
				type: 'chunk', id: path.resolve('test/vite-kit-loading.test.js'), fileName: 'ws-handler.js'
			});
		} else {
			expect(emitFile).not.toHaveBeenCalled();
		}
	});

	it('does not emit entries during development with an SSR environment', () => {
		const plugin = uws({ handler: './test/vite-kit-loading.test.js' });
		plugin.configResolved({
			root: process.cwd(), command: 'serve', build: { ssr: false }, environments: { ssr: {} }
		});
		const emitFile = vi.fn();
		plugin.buildStart.call({ emitFile, environment: { name: 'ssr' } });
		expect(emitFile).not.toHaveBeenCalled();
	});
});

function deferred() {
	let resolve, reject;
	const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

describe('development handler lifecycle', () => {
	it.each([2, 3])('keeps Kit %i lifecycle platform calls bound to their subscription hooks', async (kitVersion) => {
		const httpServer = createServer();
		const data = { [WS_SUBSCRIPTIONS]: new Set(['retiring']) };
		const socket = { getUserData: () => data, subscribe: vi.fn(), unsubscribe: vi.fn() };
		let ownerPlatform;
		let denials;
		const handler = {
			async init({ platform }) {
				ownerPlatform = platform;
				data[WS_PLATFORM] = platform;
				denials = [await platform.checkSubscribe(socket, 'private'), await platform.subscribe(socket, 'private')];
			},
			shutdown: vi.fn(({ platform }) => {
				expect(platform).toBe(ownerPlatform);
				expect(platform.unsubscribe(socket, 'retiring')).toBe(true);
			}),
			subscribe: vi.fn(() => false),
			unsubscribe: vi.fn()
		};
		const server = viteServer(httpServer, kitVersion, async () => handler);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(denials).toEqual(['FORBIDDEN', 'FORBIDDEN']));
			expect(handler.subscribe).toHaveBeenCalledTimes(2);
			expect(socket.subscribe).not.toHaveBeenCalled();
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
		expect(handler.shutdown).toHaveBeenCalledOnce();
		expect(handler.unsubscribe).toHaveBeenCalledExactlyOnceWith(socket, 'retiring', { platform: ownerPlatform });
		expect(socket.unsubscribe).toHaveBeenCalledExactlyOnceWith('retiring');
	});

	it.each([
		['subscribe only', { subscribe: vi.fn(() => false) }, 'FORBIDDEN'],
		['subscribeBatch only', { subscribeBatch: vi.fn((ws, topics) => ({ [topics[0]]: 'UNAUTHENTICATED' })) }, 'UNAUTHENTICATED'],
		['both, batch wins', { subscribe: vi.fn(() => true), subscribeBatch: vi.fn((ws, topics) => ({ [topics[0]]: false })) }, 'FORBIDDEN'],
		['batch allows by omission', { subscribe: vi.fn(() => false), subscribeBatch: vi.fn(() => ({})) }, null]
	])('applies development subscription hook precedence: %s', async (_name, hooks, expected) => {
		const httpServer = createServer();
		const data = { [WS_SUBSCRIPTIONS]: new Set() };
		const socket = { getUserData: () => data, subscribe: vi.fn(), unsubscribe: vi.fn() };
		let results;
		const handler = {
			...hooks,
			async init({ platform }) {
				data[WS_PLATFORM] = platform;
				results = [await platform.checkSubscribe(socket, 'room'), await platform.subscribe(socket, 'room')];
			}
		};
		const server = viteServer(httpServer, 2, async () => handler);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(results).toEqual([expected, expected]));
			if (hooks.subscribeBatch) {
				expect(hooks.subscribeBatch).toHaveBeenCalledTimes(2);
				expect(hooks.subscribeBatch).toHaveBeenLastCalledWith(socket, ['room'], { platform: data[WS_PLATFORM] });
				if (hooks.subscribe) expect(hooks.subscribe).not.toHaveBeenCalled();
			} else {
				expect(hooks.subscribe).toHaveBeenCalledTimes(2);
			}
			expect(socket.subscribe).toHaveBeenCalledTimes(expected === null ? 1 : 0);
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('runs the development subscribe hook on the same tick as production', async () => {
		const httpServer = createServer();
		const data = { [WS_SUBSCRIPTIONS]: new Set() };
		const socket = { getUserData: () => data, subscribe: vi.fn(), unsubscribe: vi.fn() };
		const seen = [];
		let results;
		// Production awaits the settled batch probe once before calling the
		// subscribe hook, so the hook runs exactly one microtask after the call.
		const probe = (call) => {
			data.tick = 'sync';
			const result = call();
			data.tick = 0;
			queueMicrotask(() => { data.tick = 1; queueMicrotask(() => { data.tick = 2; }); });
			return result;
		};
		const handler = {
			subscribe: ws => { seen.push(ws.getUserData().tick); return true; },
			async init({ platform }) {
				data[WS_PLATFORM] = platform;
				const checked = await probe(() => platform.checkSubscribe(socket, 'room'));
				const subscribed = await probe(() => platform.subscribe(socket, 'room'));
				results = [checked, subscribed];
			}
		};
		const server = viteServer(httpServer, 2, async () => handler);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(results).toEqual([null, null]));
			expect(seen).toEqual([0, 0]);
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('denies shared-platform subscription checks before and after a failed first development load', async () => {
		const httpServer = createServer();
		const load = deferred();
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const server = viteServer(httpServer, 2, () => load.promise);
		const plugin = uws({ handler: './handler.js' });
		const synthetic = { getUserData: () => ({}) };
		try {
			await plugin.configureServer(server);
			expect(await globalThis.__uws_dev_platform.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			await listen(httpServer);
			await vi.waitFor(() => expect(server.ssrLoadModule).toHaveBeenCalled());
			expect(await globalThis.__uws_dev_platform.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			load.reject(new Error('load failed'));
			await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[adapter-uws] Failed to load or initialize WebSocket handler:', expect.any(Error)));
			expect(await globalThis.__uws_dev_platform.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			expect(await globalThis.__uws_dev_platform.subscribe({ getUserData: () => ({ [WS_SUBSCRIPTIONS]: new Set() }) }, 'room')).toBe('INTERNAL_ERROR');
		} finally {
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('allows development subscription checks when no WebSocket handler file exists', async () => {
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => ({}), path.join(process.cwd(), 'test'));
		const plugin = uws();
		try {
			// Until the server is configured the plugin cannot know whether a handler exists.
			expect(await globalThis.__uws_dev_platform.checkSubscribe({ getUserData: () => ({}) }, 'room')).toBe('INTERNAL_ERROR');
			await plugin.configureServer(server);
			await listen(httpServer);
			expect(server.ssrLoadModule).not.toHaveBeenCalled();
			expect(await globalThis.__uws_dev_platform.checkSubscribe({ getUserData: () => ({}) }, 'room')).toBeNull();
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('denies shared-platform subscription checks after a failed development init', async () => {
		const httpServer = createServer();
		const handler = { subscribe: vi.fn(() => true), shutdown: vi.fn(), init: () => { throw new Error('init failed'); } };
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const server = viteServer(httpServer, 2, async () => handler);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[adapter-uws] Failed to load or initialize WebSocket handler:', expect.any(Error)));
			expect(handler.shutdown).toHaveBeenCalledOnce();
			const synthetic = { getUserData: () => ({}) };
			expect(await globalThis.__uws_dev_platform.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			expect(handler.subscribe).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	const current = () => globalThis.__uws_dev_platform;

	async function reloadThrough(plugin, server, versions, check) {
		for (const [index, next] of versions.entries()) {
			server.ssrLoadModule.mockResolvedValue(next);
			await hotUpdate(plugin, server);
			await vi.waitFor(() => expect(next.init).toHaveBeenCalledOnce());
			await check(index + 1);
		}
	}

	it.each([
		['installed on every init', [1, 1, 1, 1]],
		['guarded by the platform object', [1, 1, 1, 1]],
		['restored in shutdown', [1, 1, 1, 1]],
		['installed after init settles', [1, 1, 1, 1]],
		['guarded outside the platform object', [1, 0, 0, 0]]
	])('keeps at most one development publish wrapper across reloads: %s', async (mode, expected) => {
		const guard = Symbol.for('adapter-uws.test.publish-guard');
		delete globalThis[guard];
		const wrapped = new WeakSet();
		let hits = 0;
		const wrap = (platform) => {
			const previous = platform.publish;
			platform.publish = (...args) => { hits++; return previous(...args); };
			return previous;
		};
		const version = () => {
			let previous;
			return {
				init: vi.fn(({ platform }) => {
					if (mode === 'guarded outside the platform object') {
						if (globalThis[guard]) return;
						globalThis[guard] = true;
					}
					if (mode === 'guarded by the platform object') {
						if (wrapped.has(platform)) return;
						wrapped.add(platform);
					}
					if (mode === 'installed after init settles') setTimeout(() => wrap(platform), 5);
					else previous = wrap(platform);
				}),
				shutdown: mode === 'restored in shutdown' ? ({ platform }) => { platform.publish = previous; } : undefined
			};
		};
		const versions = [version(), version(), version(), version()];
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => versions[0]);
		const plugin = uws({ handler: './handler.js' });
		const publishHits = () => { hits = 0; current().publish('wrapped', 'event', 1); return hits; };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(publishHits()).toBe(expected[0]));
			await reloadThrough(plugin, server, versions.slice(1), async (index) => {
				await new Promise(resolve => setTimeout(resolve, 20));
				expect(publishHits()).toBe(expected[index]);
			});
		} finally {
			delete globalThis[guard];
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('wraps the next development platform once from code outside init', async () => {
		const wrapped = new WeakSet();
		let hits = 0;
		// A library that wraps lazily, the first time it sees a platform.
		const ensureWrapped = (platform) => {
			if (wrapped.has(platform)) return;
			wrapped.add(platform);
			const previous = platform.publish;
			platform.publish = (...args) => { hits++; return previous(...args); };
		};
		const versions = [{ init: vi.fn() }, { init: vi.fn() }, { init: vi.fn() }];
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => versions[0]);
		const plugin = uws({ handler: './handler.js' });
		const publishHits = () => { ensureWrapped(current()); hits = 0; current().publish('wrapped', 'event', 1); return hits; };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(versions[0].init).toHaveBeenCalledOnce());
			expect(publishHits()).toBe(1);
			await reloadThrough(plugin, server, versions.slice(1), () => expect(publishHits()).toBe(1));
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('drops a publish wrapper removed from the development handler source', async () => {
		let hits = 0;
		const first = { init: vi.fn(({ platform }) => { const previous = platform.publish; platform.publish = (...args) => { hits++; return previous(...args); }; }) };
		const second = { init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js' });
		const publishHits = () => { hits = 0; current().publish('wrapped', 'event', 1); return hits; };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(publishHits()).toBe(1));
			await reloadThrough(plugin, server, [second], () => expect(publishHits()).toBe(0));
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('replaces the platform after a failed development init and keeps its custom properties', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const hits = { first: 0, failed: 0 };
		const wrap = (platform, name) => { const previous = platform.publish; platform.publish = (...args) => { hits[name]++; return previous(...args); }; };
		const first = { init: vi.fn(({ platform }) => { wrap(platform, 'first'); platform.decorated = 'first'; }) };
		const failed = { init: vi.fn(({ platform }) => { wrap(platform, 'failed'); platform.partial = true; throw new Error('second failed'); }) };
		const third = { init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js' });
		const publishHits = () => { hits.first = hits.failed = 0; current().publish('wrapped', 'event', 1); return { ...hits }; };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(publishHits()).toEqual({ first: 1, failed: 0 }));
			server.ssrLoadModule.mockResolvedValue(failed);
			await hotUpdate(plugin, server);
			await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[adapter-uws] Failed to load or initialize WebSocket handler:', expect.any(Error)));
			expect(publishHits()).toEqual({ first: 0, failed: 0 });
			expect(current().decorated).toBe('first');
			expect(current().partial).toBe(true);
			await reloadThrough(plugin, server, [third], () => expect(publishHits()).toEqual({ first: 0, failed: 0 }));
			expect(current().decorated).toBe('first');
		} finally {
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it.each([
		['the platform object', () => { const seen = new WeakSet(); return (platform) => !seen.has(platform) && seen.add(platform); }, [1, 1, 1]],
		['a module flag', () => { let done = false; return () => !done && (done = true); }, [1, 2, 3]]
	])('lets the next development init use a custom decoration guarded by %s', async (_name, createGuard, starts) => {
		const once = createGuard();
		const versions = [0, 1, 2].map(() => ({
			init: vi.fn(({ platform }) => {
				if (once(platform)) platform.metrics = { starts: 0 };
				platform.metrics.starts++;
				platform.loads = (platform.loads ?? 0) + 1;
			})
		}));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => versions[0]);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(current().metrics?.starts).toBe(starts[0]));
			await reloadThrough(plugin, server, versions.slice(1), (index) => {
				expect(current().metrics.starts).toBe(starts[index]);
				expect(current().loads).toBe(index + 1);
			});
			expect(error).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('keeps a custom platform property a development init deletes deleted', async () => {
		const first = { init: vi.fn(({ platform }) => { platform.legacy = () => 'first'; }) };
		const second = { init: vi.fn(({ platform }) => { delete platform.legacy; }) };
		const third = { init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(current().legacy?.()).toBe('first'));
			await reloadThrough(plugin, server, [second, third], () => expect(Object.hasOwn(current(), 'legacy')).toBe(false));
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('keeps development shutdown deletions and writes final', async () => {
		let seen;
		const pool = { closed: false };
		const first = {
			init: ({ platform }) => { platform.pool = pool; },
			shutdown: ({ platform }) => { platform.pool.closed = true; delete platform.pool; platform.handoff = 'first'; }
		};
		const second = { init: vi.fn(({ platform }) => { seen = { pool: platform.pool, handoff: platform.handoff }; }) };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(current().pool).toBe(pool));
			await reloadThrough(plugin, server, [second], () => {
				expect(seen).toEqual({ pool: undefined, handoff: 'first' });
				expect(current().handoff).toBe('first');
				expect(Object.hasOwn(current(), 'pool')).toBe(false);
			});
			expect(pool.closed).toBe(true);
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('explains a platform property locked by an earlier development init', async () => {
		const httpServer = createServer();
		const define = ({ platform }) => { Object.defineProperty(platform, 'locked', { value: {} }); };
		const first = { init: vi.fn(define) };
		const second = { init: vi.fn(define) };
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(first.init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(second);
			await hotUpdate(plugin, server);
			await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('carry over to the next development platform')));
			expect(second.init).toHaveBeenCalledOnce();
		} finally {
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it.each(['freeze', 'seal', 'preventExtensions'])('lets the next development init decorate after an earlier init calls Object.%s', async (lock) => {
		let hits = 0;
		const decorate = ({ platform }) => {
			const previous = platform.publish;
			platform.publish = (...args) => { hits++; return previous(...args); };
			Object[lock](platform);
		};
		const versions = [{ init: vi.fn(decorate) }, { init: vi.fn(decorate) }];
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => versions[0]);
		const plugin = uws({ handler: './handler.js' });
		const publishHits = () => { hits = 0; current().publish('wrapped', 'event', 1); return hits; };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(publishHits()).toBe(1));
			await reloadThrough(plugin, server, versions.slice(1), () => expect(publishHits()).toBe(1));
			expect(error).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('denies subscription checks through platforms and connections of a retired development handler', async () => {
		const httpServer = createServer();
		const clients = [];
		let retired;
		const first = {
			init: vi.fn(({ platform }) => { retired = { platform }; }),
			open: (ws) => { retired.connection = ws.getUserData()[WS_PLATFORM]; retired.ws = ws; },
			subscribe: () => true
		};
		const second = { init: vi.fn(), subscribe: () => true };
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		const synthetic = { getUserData: () => ({}) };
		try {
			await plugin.configureServer(server);
			const url = await listen(httpServer);
			await vi.waitFor(() => expect(first.init).toHaveBeenCalledOnce());
			const client = new WebSocket(url);
			clients.push(client);
			await vi.waitFor(() => expect(retired.connection).toBeDefined());
			expect(await retired.connection.checkSubscribe(synthetic, 'room')).toBeNull();
			expect(await retired.platform.checkSubscribe(synthetic, 'room')).toBeNull();
			await reloadThrough(plugin, server, [second], async () => {
				expect(current()).not.toBe(retired.platform);
				expect(await retired.connection.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
				expect(await retired.platform.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
				// The retired socket itself stays with the hooks of the instance that accepted it.
				expect(await current().checkSubscribe(retired.ws, 'room')).toBeNull();
				expect(await current().checkSubscribe(synthetic, 'room')).toBeNull();
			});
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, clients);
		}
	});

	it('denies subscription checks through a platform abandoned after a development init deadline', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const httpServer = createServer();
		const synthetic = { getUserData: () => ({}) };
		let abandoned;
		const initDone = deferred();
		const shutdownGate = deferred();
		const late = [];
		const handler = {
			subscribe: () => true,
			init: vi.fn(({ platform }) => { abandoned = platform; return initDone.promise; }),
			shutdown: vi.fn(async ({ platform }) => { late.push(await platform.checkSubscribe(synthetic, 'late')); await shutdownGate.promise; })
		};
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const server = viteServer(httpServer, 2, async () => handler);
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(await abandoned.checkSubscribe(synthetic, 'room')).toBeNull();
			await vi.advanceTimersByTimeAsync(30000);
			await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('init hook did not finish')));
			expect(current()).not.toBe(abandoned);
			expect(await abandoned.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			// The late shutdown of the expired instance does not reopen its platform.
			initDone.resolve();
			await vi.waitFor(() => expect(late).toEqual(['INTERNAL_ERROR']));
			expect(await abandoned.checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			shutdownGate.resolve();
		} finally {
			initDone.resolve();
			shutdownGate.resolve();
			vi.useRealTimers();
			error.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('keeps a retiring development instance on its own hooks while another reload starts', async () => {
		const release = deferred();
		const results = [];
		const synthetic = { getUserData: () => ({}) };
		const first = {
			subscribe: () => true,
			init: vi.fn(),
			shutdown: vi.fn(async ({ platform }) => { await release.promise; results.push(await platform.checkSubscribe(synthetic, 'room')); })
		};
		const second = { subscribe: () => false, init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js' });
		const pending = [];
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(first.init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(second);
			pending.push(hotUpdate(plugin, server));
			await vi.waitFor(() => expect(first.shutdown).toHaveBeenCalledOnce());
			pending.push(hotUpdate(plugin, server));
			await vi.waitFor(() => expect(server.ssrLoadModule).toHaveBeenCalledTimes(3));
			release.resolve();
			await Promise.all(pending);
			await vi.waitFor(() => expect(second.init).toHaveBeenCalled());
			expect(results).toEqual([null]);
		} finally {
			release.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('allows subscription checks after a reused development plugin restarts without a handler file', async () => {
		const plugin = uws();
		const synthetic = { getUserData: () => ({}) };
		const firstHttp = createServer();
		const handler = { subscribe: () => false, init: vi.fn() };
		const first = viteServer(firstHttp, 2, async () => handler, path.resolve('test/fixture'));
		const secondHttp = createServer();
		const second = viteServer(secondHttp, 2, async () => ({}), path.join(process.cwd(), 'test'));
		try {
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			await plugin.configureServer(first);
			await listen(firstHttp);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('FORBIDDEN');
			await closeLifecycle(plugin, first);
			await close(firstHttp, []);
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			await plugin.configureServer(second);
			await listen(secondHttp);
			expect(second.ssrLoadModule).not.toHaveBeenCalled();
			expect(await current().checkSubscribe(synthetic, 'room')).toBeNull();
		} finally {
			await closeLifecycle(plugin, second);
			await close(firstHttp, []);
			await close(secondHttp, []);
		}
	});

	it('allows development subscription checks when the dev WebSocket server is disabled', async () => {
		const server = viteServer(createServer(), 2, async () => ({ subscribe: () => false }));
		server.httpServer = null;
		const plugin = uws({ handler: './handler.js' });
		await plugin.configureServer(server);
		expect(server.config.logger.warn).toHaveBeenCalledWith(expect.stringContaining('middleware mode'));
		expect(server.ssrLoadModule).not.toHaveBeenCalled();
		expect(await current().checkSubscribe({ getUserData: () => ({}) }, 'room')).toBeNull();
	});

	it('loads a Kit 2 handler file created after the development server started', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'uws-created-handler-'));
		mkdirSync(path.join(root, 'src'));
		const file = path.join(root, 'src', 'hooks.ws.js');
		const handler = { subscribe: () => false, init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => handler, root);
		const plugin = uws();
		const synthetic = { getUserData: () => ({}) };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			expect(await current().checkSubscribe(synthetic, 'room')).toBeNull();
			writeFileSync(file, 'export const created = true;');
			plugin.watchChange(path.join(root, 'src', 'other.js'), { event: 'create' });
			plugin.watchChange(file, { event: 'update' });
			// Vite reports watched ids with forward slashes.
			const id = file.split(path.sep).join('/');
			plugin.watchChange(id, { event: 'create' });
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			// Vite 6+ then reports the same creation to hotUpdate; it must not load again.
			await plugin.hotUpdate.call({ environment: { name: 'client' } }, { type: 'create', file: id, server });
			await server.config.server.hotUpdateEnvironments(server, async () => {});
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(server.ssrLoadModule).toHaveBeenCalledExactlyOnceWith(viteId(file));
			await vi.waitFor(async () => expect(await current().checkSubscribe(synthetic, 'room')).toBe('FORBIDDEN'));
			// Later edits, deletions and re-creations of the handler still reload.
			for (const [type, loads] of [['update', 2], ['delete', 3], ['create', 4]]) {
				await plugin.hotUpdate.call({ environment: { name: 'client' } }, { type, file: id, server });
				await server.config.server.hotUpdateEnvironments(server, async () => {});
				await vi.waitFor(() => expect(server.ssrLoadModule).toHaveBeenCalledTimes(loads));
			}
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		['Vite 5', server => { delete server.environments; server.hot = { send: vi.fn() }; }],
		['Vite 6+ without HMR', server => { server.config.server.hmr = false; }]
	])('loads a Kit 2 handler file created after startup on %s', async (_name, configure) => {
		const root = mkdtempSync(path.join(tmpdir(), 'uws-created-handler-'));
		mkdirSync(path.join(root, 'src'));
		const file = path.join(root, 'src', 'hooks.ws.js');
		const handler = { subscribe: () => false, init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => handler, root);
		configure(server);
		const plugin = uws();
		const synthetic = { getUserData: () => ({}) };
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			writeFileSync(file, 'export const created = true;');
			plugin.watchChange(file.split(path.sep).join('/'), { event: 'create' });
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(server.ssrLoadModule).toHaveBeenCalledExactlyOnceWith(viteId(file));
			await vi.waitFor(async () => expect(await current().checkSubscribe(synthetic, 'room')).toBe('FORBIDDEN'));
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([true, false])('loads a configured Vite 5 handler file created after startup (graph node: %s)', async (hasNode) => {
		const handler = { subscribe: () => false, init: vi.fn() };
		const missing = new Error('Failed to load url ./handler.js');
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => { throw missing; });
		delete server.environments;
		server.hot = { send: vi.fn() };
		// Vite 5 keeps the node its failed import created; deleting the file keeps it too.
		server.moduleGraph.getModulesByFile = vi.fn(() => hasNode ? new Set([{}]) : undefined);
		const plugin = uws({ handler: './handler.js' });
		const file = path.resolve(server.config.root, 'handler.js');
		const synthetic = { getUserData: () => ({}) };
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Failed to load'), missing));
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR');
			// The failed import leaves its graph node under the spelling it was given.
			expect(server.ssrLoadModule).toHaveBeenCalledExactlyOnceWith(viteId(file));
			server.ssrLoadModule.mockResolvedValue(handler);
			plugin.watchChange(file.split(path.sep).join('/'), { event: 'create' });
			if (hasNode) {
				// The reload waits for the broadcast Vite sends after invalidating the node.
				await new Promise(resolve => setTimeout(resolve, 20));
				expect(server.ssrLoadModule).toHaveBeenCalledOnce();
				server.hot.send({ type: 'full-reload' });
			}
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(server.moduleGraph.getModulesByFile).toHaveBeenCalledWith(viteId(file));
			expect(server.ssrLoadModule).toHaveBeenCalledTimes(2);
			await vi.waitFor(async () => expect(await current().checkSubscribe(synthetic, 'room')).toBe('FORBIDDEN'));
		} finally {
			errorLog.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('fails closed after a Vite 5 handler file is deleted and loads it again when recreated', async () => {
		const first = { subscribe: () => false, init: vi.fn(), shutdown: vi.fn() };
		const second = { subscribe: () => {}, init: vi.fn() };
		const missing = new Error('Failed to load url ./handler.js');
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		delete server.environments;
		server.hot = { send: vi.fn() };
		// The handler's graph node holds the cached module until Vite invalidates it.
		const node = { ssrModule: {}, ssrTransformResult: {} };
		server.moduleGraph.getModulesByFile = vi.fn(() => new Set([node]));
		const plugin = uws({ handler: './handler.js' });
		const id = path.resolve(server.config.root, 'handler.js').split(path.sep).join('/');
		const synthetic = { getUserData: () => ({}) };
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(first.init).toHaveBeenCalledOnce());
			expect(await current().checkSubscribe(synthetic, 'room')).toBe('FORBIDDEN');
			server.ssrLoadModule.mockRejectedValue(missing);
			plugin.watchChange(id, { event: 'delete' });
			// A broadcast for another file before the invalidation must not reload.
			server.hot.send({ type: 'update', updates: [] });
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(server.ssrLoadModule).toHaveBeenCalledOnce();
			Object.assign(node, { ssrModule: null, ssrTransformResult: null });
			server.hot.send({ type: 'full-reload' });
			await vi.waitFor(() => expect(first.shutdown).toHaveBeenCalledOnce());
			await vi.waitFor(async () => expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR'));
			server.ssrLoadModule.mockResolvedValue(second);
			plugin.watchChange(id, { event: 'create' });
			server.hot.send({ type: 'full-reload' });
			await vi.waitFor(() => expect(second.init).toHaveBeenCalledOnce());
			await vi.waitFor(async () => expect(await current().checkSubscribe(synthetic, 'room')).toBeNull());
			expect(server.ssrLoadModule).toHaveBeenCalledTimes(3);
			// A settled file event is spent, and only full-reload or update broadcasts reload.
			await plugin.handleHotUpdate({ file: id, server });
			server.hot.send({ type: 'error', err: { message: 'unrelated' } });
			server.hot.send({ type: 'custom', event: 'unrelated' });
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(server.ssrLoadModule).toHaveBeenCalledTimes(3);
			server.hot.send({ type: 'update', updates: [] });
			await vi.waitFor(() => expect(server.ssrLoadModule).toHaveBeenCalledTimes(4));
			server.hot.send({ type: 'update', updates: [] });
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(server.ssrLoadModule).toHaveBeenCalledTimes(4);
		} finally {
			errorLog.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('keeps a Vite 5 handler deletion pending through a reload for another file', async () => {
		const first = { subscribe: () => false, init: vi.fn(), shutdown: vi.fn() };
		const missing = new Error('Failed to load url ./handler.js');
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		delete server.environments;
		server.hot = { send: vi.fn() };
		const dependency = path.resolve(server.config.root, 'dependency.js');
		const node = { ssrModule: {}, ssrTransformResult: {}, ssrImportedModules: [{ file: dependency }] };
		server.moduleGraph.getModulesByFile = vi.fn(() => new Set([node]));
		const plugin = uws({ handler: './handler.js' });
		const id = path.resolve(server.config.root, 'handler.js').split(path.sep).join('/');
		const synthetic = { getUserData: () => ({}) };
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(first.init).toHaveBeenCalledOnce());
			plugin.watchChange(id, { event: 'delete' });
			// An edit of a dependency reloads before Vite invalidates the deleted
			// handler, and that import still returns the cached module.
			await plugin.handleHotUpdate({ file: dependency, server });
			server.hot.send({ type: 'update', updates: [] });
			await vi.waitFor(() => expect(server.ssrLoadModule).toHaveBeenCalledTimes(2));
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(first.shutdown).not.toHaveBeenCalled();
			Object.assign(node, { ssrModule: null, ssrTransformResult: null });
			server.ssrLoadModule.mockRejectedValue(missing);
			server.hot.send({ type: 'full-reload' });
			await vi.waitFor(() => expect(first.shutdown).toHaveBeenCalledOnce());
			await vi.waitFor(async () => expect(await current().checkSubscribe(synthetic, 'room')).toBe('INTERNAL_ERROR'));
		} finally {
			errorLog.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it.runIf(process.platform === 'win32')('matches a Windows handler path and its imports under another spelling', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'uws-spelling-'));
		const file = path.join(root, 'handler.js');
		const dependency = path.join(root, 'shared.js');
		writeFileSync(file, 'export {};');
		writeFileSync(dependency, 'export {};');
		const loaded = [{ init: vi.fn() }, { init: vi.fn() }, { init: vi.fn() }];
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => loaded[0], root);
		delete server.environments;
		server.hot = { send: vi.fn() };
		// Vite keyed the handler under the disk's spelling; the option spells it in capitals.
		server.moduleGraph.getModulesByFile = vi.fn(key => key === viteId(file) ? new Set([{ file: viteId(file), ssrImportedModules: [{ file: viteId(dependency) }] }]) : undefined);
		const plugin = uws({ handler: './HANDLER.JS' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(loaded[0].init).toHaveBeenCalledOnce());
			for (const [index, changed] of [[1, file], [2, dependency.toUpperCase()]]) {
				server.ssrLoadModule.mockResolvedValue(loaded[index]);
				await plugin.handleHotUpdate({ file: changed.split(path.sep).join('/'), server });
				server.hot.send({ type: 'full-reload' });
				await vi.waitFor(() => expect(loaded[index].init).toHaveBeenCalledOnce());
			}
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('matches a Windows handler under a root reached through a junction', async () => {
		const base = mkdtempSync(path.join(tmpdir(), 'uws-junction-'));
		const real = path.join(base, 'real', 'deep', 'app');
		mkdirSync(real, { recursive: true });
		const link = path.join(base, 'link');
		symlinkSync(real, link, 'junction');
		const file = path.join(real, 'handler.js');
		const dependency = path.join(real, 'shared.js');
		writeFileSync(file, 'export {};');
		writeFileSync(dependency, 'export {};');
		const loaded = Array.from({ length: 4 }, () => ({ init: vi.fn(), shutdown: vi.fn() }));
		const httpServer = createServer();
		// Both roots keep the junction; Vite's resolver keyed the handler under the target's disk spelling.
		const server = viteServer(httpServer, 2, async () => loaded[0], link);
		delete server.environments;
		server.hot = { send: vi.fn() };
		const disk = name => viteId(realpathSync.native(path.join(real, name)));
		server.moduleGraph.getModulesByFile = vi.fn(key => key === disk('handler.js') ? new Set([{ file: disk('handler.js'), ssrImportedModules: [{ file: disk('shared.js') }] }]) : undefined);
		const plugin = uws({ handler: './handler.js' });
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			plugin.config({ root: link });
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(loaded[0].init).toHaveBeenCalledOnce());
			expect(server.ssrLoadModule).toHaveBeenCalledWith(viteId(path.join(link, 'handler.js')));
			// The watcher reports the target's spelling for the handler and its imports.
			for (const [index, changed] of [[1, file], [2, dependency]]) {
				server.ssrLoadModule.mockResolvedValue(loaded[index]);
				await plugin.handleHotUpdate({ file: viteId(changed), server });
				server.hot.send({ type: 'full-reload' });
				await vi.waitFor(() => expect(loaded[index].init).toHaveBeenCalledOnce());
			}
			// Keyed under the junction instead, only the disk spellings match the watcher's path.
			const linked = name => viteId(path.join(link, name));
			server.moduleGraph.getModulesByFile = vi.fn(key => key === linked('handler.js') ? new Set([{ file: linked('handler.js'), ssrImportedModules: [{ file: linked('shared.js') }] }]) : undefined);
			server.ssrLoadModule.mockResolvedValue(loaded[3]);
			await plugin.handleHotUpdate({ file: viteId(dependency), server });
			server.hot.send({ type: 'full-reload' });
			await vi.waitFor(() => expect(loaded[3].init).toHaveBeenCalledOnce());
			// A deleted handler still matches through the spelling of its directory.
			rmSync(file);
			server.ssrLoadModule.mockRejectedValue(new Error('Failed to load url ./handler.js'));
			await plugin.handleHotUpdate({ file: viteId(file), server });
			server.hot.send({ type: 'full-reload' });
			await vi.waitFor(() => expect(loaded[3].shutdown).toHaveBeenCalledOnce());
		} finally {
			errorLog.mockRestore();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmdirSync(link);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('matches a Windows handler keyed under Vite\'s own root spelling', async () => {
		const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'uws-vite-root-')));
		writeFileSync(path.join(root, 'handler.js'), 'export {};');
		writeFileSync(path.join(root, 'shared.js'), 'export {};');
		// Until its startup probe ends Vite keeps its root as given; another letter case stands in for an 8.3 name.
		const viteRoot = path.join(path.dirname(root), path.basename(root).toUpperCase());
		const loaded = [{ init: vi.fn() }, { init: vi.fn() }];
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => loaded[0], viteRoot);
		delete server.environments;
		server.hot = { send: vi.fn() };
		const keyed = name => viteId(path.join(viteRoot, name));
		server.moduleGraph.getModulesByFile = vi.fn(key => key === keyed('handler.js') ? new Set([{ file: keyed('handler.js'), ssrImportedModules: [{ file: keyed('shared.js') }] }]) : undefined);
		const plugin = uws({ handler: './handler.js' });
		try {
			plugin.config({ root });
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(loaded[0].init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(loaded[1]);
			await plugin.handleHotUpdate({ file: viteId(path.join(root, 'shared.js')), server });
			server.hot.send({ type: 'full-reload' });
			await vi.waitFor(() => expect(loaded[1].init).toHaveBeenCalledOnce());
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== 'win32')('discovers a POSIX development handler under the resolved root', async () => {
		const base = mkdtempSync(path.join(tmpdir(), 'uws-posix-root-'));
		const real = path.join(base, 'real');
		mkdirSync(path.join(real, 'src'), { recursive: true });
		const link = path.join(base, 'link');
		symlinkSync(real, link);
		const file = path.join(real, 'src', 'hooks.ws.js');
		writeFileSync(file, 'export {};');
		const handler = { init: vi.fn() };
		const httpServer = createServer();
		// Vite 8 resolves a symlinked root and its watcher reports the real paths.
		const server = viteServer(httpServer, 3, async () => handler, real);
		const plugin = uws();
		try {
			plugin.config({ root: link });
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(server.environments.ssr.runner.import).toHaveBeenCalledWith(file);
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('imports a Windows handler outside the root by its configured path', async () => {
		const base = mkdtempSync(path.join(tmpdir(), 'uws-outside-'));
		const real = path.join(base, 'real', 'deep', 'app');
		mkdirSync(real, { recursive: true });
		const link = path.join(base, 'link');
		symlinkSync(real, link, 'junction');
		const outside = path.join(base, 'real', 'shared', 'hooks.ws.js');
		mkdirSync(path.dirname(outside), { recursive: true });
		writeFileSync(outside, 'export {};');
		const handler = { init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => handler, real);
		const plugin = uws({ handler: outside });
		try {
			plugin.config({ root: link });
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(server.ssrLoadModule).toHaveBeenCalledExactlyOnceWith(viteId(outside));
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmdirSync(link);
			rmSync(base, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform === 'win32')('discovers the development handler under the root SvelteKit uses', async () => {
		const root = mkdtempSync(path.join(tmpdir(), 'uws-config-root-'));
		mkdirSync(path.join(root, 'src'));
		const file = path.join(root, 'src', 'hooks.ws.js');
		writeFileSync(file, 'export {};');
		const handler = { init: vi.fn() };
		const httpServer = createServer();
		// Vite 8 resolves its own root; SvelteKit keeps the configured spelling.
		const server = viteServer(httpServer, 2, async () => handler, path.join(root, 'resolved-elsewhere'));
		const plugin = uws();
		try {
			plugin.config({ root });
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(server.ssrLoadModule).toHaveBeenCalledExactlyOnceWith(viteId(file));
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('discards a stale Kit 2 initial import after a reload', async () => {
		const pending = deferred();
		const initial = { init: vi.fn(), shutdown: vi.fn() };
		const newest = { init: vi.fn(), shutdown: vi.fn(), open: ws => ws.send('newest') };
		const httpServer = createServer();
		const clients = [];
		const server = viteServer(httpServer, 2, () => pending.promise);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		try {
			await plugin.configureServer(server);
			const url = await listen(httpServer);
			await vi.waitFor(() => expect(server.ssrLoadModule).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(newest);
			await hotUpdate(plugin, server);
			pending.resolve(initial);
			const client = new WebSocket(url);
			clients.push(client);
			expect(await handlerMessage(client)).toBe('newest');
			expect(initial.init).not.toHaveBeenCalled();
			expect(initial.shutdown).not.toHaveBeenCalled();
			expect(newest.init).toHaveBeenCalledOnce();
		} finally {
			pending.resolve(initial);
			await closeLifecycle(plugin, server);
			await close(httpServer, clients);
		}
		expect(newest.shutdown).toHaveBeenCalledOnce();
	});

	it.each([2, 3])('moves pending Kit %i upgrades and authentication to a newer generation before the old import settles', async (kitVersion) => {
		const pending = deferred();
		const handler = { init: vi.fn(), open: ws => ws.send('newest'), authenticate: () => Response.json({ version: 'newest' }) };
		const httpServer = createServer();
		const clients = [];
		const server = viteServer(httpServer, kitVersion, () => pending.promise);
		let onReload;
		server.environments.ssr.hot = { send: vi.fn() };
		server.environments.ssr.runner.import.mockImplementation(id => id.startsWith('\0')
			? Promise.resolve({ onReload(callback) { onReload = callback; return () => {}; } }) : pending.promise);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		try {
			await plugin.configureServer(server);
			const url = await listen(httpServer);
			const upgrading = once(httpServer, 'upgrade');
			const client = new WebSocket(url);
			clients.push(client);
			const message = handlerMessage(client);
			message.catch(() => {});
			await upgrading;
			const requested = once(httpServer, 'request');
			const authenticated = fetch(url.replace('ws:', 'http:').replace('/ws', '/__ws/auth'), {
				method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' }, signal: AbortSignal.timeout(2000)
			});
			authenticated.catch(() => {});
			await requested;
			if (kitVersion === 2) {
				server.ssrLoadModule.mockResolvedValue(handler);
				hotUpdate(plugin, server);
			} else {
				server.environments.ssr.runner.import.mockResolvedValue(handler);
				server.environments.ssr.hot.send({ type: 'full-reload' });
				onReload(1);
			}
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN));
			expect(await message).toBe('newest');
			expect(await (await authenticated).json()).toEqual({ version: 'newest' });
		} finally {
			pending.resolve({});
			await closeLifecycle(plugin, server);
			await close(httpServer, clients);
		}
	});

	it.each([2, 3])('shares Kit %i init properties with HTTP while retaining owned subscription hooks', async (kitVersion) => {
		const httpServer = createServer();
		const handler = { init: vi.fn(({ platform }) => {
			platform.initMarker = 'ready';
			Object.defineProperty(platform, 'initValue', { value: 42, enumerable: true, configurable: true });
		}) };
		const server = viteServer(httpServer, kitVersion, async () => handler);
		const plugin = uws({ handler: './handler.js' });
		const routePlatform = Object.create(globalThis.__uws_dev_platform);
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			expect(routePlatform.initMarker).toBe('ready');
			expect(globalThis.__uws_dev_platform.initMarker).toBe('ready');
			expect(routePlatform.initValue).toBe(42);
			expect(Object.getOwnPropertyDescriptor(globalThis.__uws_dev_platform, 'initValue')).toEqual({ value: 42, enumerable: true, configurable: true, writable: false });
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('discards an authentication body aborted while initialization is pending', async () => {
		const initialized = deferred();
		const httpServer = createServer();
		const handler = { init: vi.fn(() => initialized.promise), authenticate: vi.fn(() => Response.json({ ready: true })) };
		const server = viteServer(httpServer, 2, async () => handler);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		let abandoned;
		try {
			await plugin.configureServer(server);
			const url = (await listen(httpServer)).replace('ws:', 'http:').replace('/ws', '/__ws/auth');
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			const received = once(httpServer, 'request');
			abandoned = request(url, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest', 'content-length': '100' } });
			abandoned.on('error', () => {});
			abandoned.write('partial body');
			const [incoming] = await received;
			abandoned.destroy();
			await vi.waitFor(() => expect(incoming.aborted).toBe(true));
			initialized.resolve();
			const response = await fetch(url, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' } });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ready: true });
			expect(handler.authenticate).toHaveBeenCalledOnce();
		} finally {
			abandoned?.destroy();
			initialized.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('serializes overlapping initialization and waits for the newest handler', async () => {
		const events = [];
		const finishSecond = deferred();
		const finishThird = deferred();
		const handlers = [1, 2, 3].map(version => ({
			init: vi.fn(async () => {
				events.push(`init:start:${version}`);
				if (version === 2) await finishSecond.promise;
				if (version === 3) await finishThird.promise;
				events.push(`init:end:${version}`);
			}),
			shutdown: vi.fn(async () => { events.push(`shutdown:${version}`); }),
			open: ws => ws.send(String(version))
		}));
		const httpServer = createServer();
		const clients = [];
		const server = viteServer(httpServer, 2, async () => handlers[0]);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		try {
			await plugin.configureServer(server);
			const url = await listen(httpServer);
			await vi.waitFor(() => expect(handlers[0].init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(handlers[1]);
			const second = hotUpdate(plugin, server);
			await vi.waitFor(() => expect(handlers[1].init).toHaveBeenCalledOnce());
			const client = new WebSocket(url);
			clients.push(client);
			const message = handlerMessage(client);
			const opened = vi.fn();
			client.on('open', opened);
			await once(httpServer, 'upgrade');
			server.ssrLoadModule.mockResolvedValue(handlers[2]);
			const third = hotUpdate(plugin, server);
			finishSecond.resolve();
			await second;
			await vi.waitFor(() => expect(handlers[2].init).toHaveBeenCalledOnce());
			expect(opened).not.toHaveBeenCalled();
			finishThird.resolve();
			await third;
			expect(await message).toBe('3');
			expect(events).toEqual([
				'init:start:1', 'init:end:1', 'shutdown:1',
				'init:start:2', 'init:end:2', 'shutdown:2', 'init:start:3', 'init:end:3'
			]);
			hotUpdate(plugin, server);
			const unchanged = new WebSocket(url);
			clients.push(unchanged);
			expect(await handlerMessage(unchanged)).toBe('3');
			expect(handlers[2].init).toHaveBeenCalledOnce();
			expect(handlers[2].shutdown).not.toHaveBeenCalled();
		} finally {
			finishSecond.resolve();
			finishThird.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, clients);
		}
		for (const handler of handlers) expect(handler.shutdown).toHaveBeenCalledOnce();
	});

	it('waits for a custom legacy update coordinator and restores it on close', async () => {
		const finishedUpdates = deferred();
		const httpServer = createServer();
		const first = { init: vi.fn() };
		const next = { init: vi.fn() };
		const server = viteServer(httpServer, 2, async () => first);
		const coordinate = vi.fn(async (currentServer, update) => {
			await finishedUpdates.promise;
			await update(currentServer.environments.ssr);
		});
		server.config.server.hotUpdateEnvironments = coordinate;
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(first.init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(next);
			const update = hotUpdate(plugin, server);
			await vi.waitFor(() => expect(coordinate).toHaveBeenCalledOnce());
			expect(next.init).not.toHaveBeenCalled();
			expect(server.ssrLoadModule).toHaveBeenCalledOnce();
			finishedUpdates.resolve();
			await update;
			await vi.waitFor(() => expect(next.init).toHaveBeenCalledOnce());
		} finally {
			finishedUpdates.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
		expect(server.config.server.hotUpdateEnvironments).toBe(coordinate);
	});

	it('waits for overlapping legacy environment updates before importing the replacement', async () => {
		const updates = [deferred(), deferred()];
		const httpServer = createServer();
		const initial = { init: vi.fn() };
		const newest = { init: vi.fn() };
		const server = viteServer(httpServer, 2, async () => initial);
		let updateIndex = 0;
		server.config.server.hotUpdateEnvironments = () => updates[updateIndex++].promise;
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(initial.init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(newest);
			const first = hotUpdate(plugin, server);
			const second = hotUpdate(plugin, server);
			await vi.waitFor(() => expect(updateIndex).toBe(2));
			updates[0].resolve();
			await first;
			expect(server.ssrLoadModule).toHaveBeenCalledOnce();
			updates[1].resolve();
			await second;
			await vi.waitFor(() => expect(newest.init).toHaveBeenCalledOnce());
			expect(server.ssrLoadModule).toHaveBeenCalledTimes(2);
		} finally {
			for (const update of updates) update.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it.each(['hot', 'ws'])('starts the Vite 5 import after the %s invalidation broadcast and restores its channel', async (channel) => {
		const httpServer = createServer();
		const initial = { init: vi.fn() };
		const newest = { init: vi.fn() };
		const server = viteServer(httpServer, 2, async () => initial);
		delete server.environments;
		const send = vi.fn();
		server[channel] = { send };
		const plugin = uws({ handler: './handler.js' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			await vi.waitFor(() => expect(initial.init).toHaveBeenCalledOnce());
			server.ssrLoadModule.mockResolvedValue(newest);
			await plugin.handleHotUpdate({ file: path.resolve(server.config.root, 'handler.js'), server });
			expect(server.ssrLoadModule).toHaveBeenCalledOnce();
			server[channel].send({ type: 'full-reload' });
			await vi.waitFor(() => expect(newest.init).toHaveBeenCalledOnce());
			expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'full-reload' });
		} finally {
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
		expect(server[channel].send).toBe(send);
	});

	it.each(['import', 'init'])('closes during pending %s without installing callbacks', async (stage) => {
		const pending = deferred();
		const handler = {
			init: vi.fn(() => stage === 'init' ? pending.promise : undefined), shutdown: vi.fn(), open: vi.fn()
		};
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, () => stage === 'import' ? pending.promise : handler);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			if (stage === 'init') await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			const stopped = vi.fn();
			const closing = closeLifecycle(plugin, server).then(stopped);
			await Promise.resolve();
			if (stage === 'init') expect(stopped).not.toHaveBeenCalled();
			pending.resolve(handler);
			await closing;
			await closeLifecycle(plugin, server);
			expect(handler.open).not.toHaveBeenCalled();
			expect(handler.init).toHaveBeenCalledTimes(stage === 'init' ? 1 : 0);
			expect(handler.shutdown).toHaveBeenCalledTimes(stage === 'init' ? 1 : 0);
		} finally {
			pending.resolve(handler);
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('fails closed when a runner reload marker is lost and ignores late markers', async () => {
		const httpServer = createServer();
		const clients = [];
		const handler = { init: vi.fn(), shutdown: vi.fn(), open: ws => ws.send('ready') };
		const server = viteServer(httpServer, 3, async () => handler);
		let onReload;
		const disconnect = vi.fn();
		server.environments.ssr.hot = { send: vi.fn() };
		server.environments.ssr.runner.import.mockImplementation(async id => id.startsWith('\0')
			? { onReload(callback) { onReload = callback; return disconnect; } } : handler);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await plugin.configureServer(server);
			const url = await listen(httpServer);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledOnce());
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			server.environments.ssr.hot.send({ type: 'full-reload' });
			await vi.advanceTimersByTimeAsync(10001);
			vi.useRealTimers();
			expect(handler.shutdown).toHaveBeenCalledOnce();
			expect(errorLog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining('Restart the dev server') }));
			const client = new WebSocket(url);
			clients.push(client);
			expect((await once(client, 'error'))[0].message).toContain('500');
			await onReload(1);
			expect(handler.init).toHaveBeenCalledOnce();
			server.environments.ssr.hot.send({ type: 'full-reload' });
			await onReload(2);
			await vi.waitFor(() => expect(handler.init).toHaveBeenCalledTimes(2));
		} finally {
			vi.useRealTimers();
			await closeLifecycle(plugin, server);
			await close(httpServer, clients);
			errorLog.mockRestore();
		}
		expect(disconnect).toHaveBeenCalledOnce();
	});
});

describe('development WebSocket upgrades', () => {
	const upgradeRequest = (target) => `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
		'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';

	// Records what the upgrade path leaves unhandled. Vitest does not report
	// these itself while another listener is installed, so the listeners also
	// come off when a test times out before its finally block runs.
	function trapUnhandled() {
		const seen = [];
		const record = (error) => { seen.push(String(error)); };
		const release = () => {
			process.removeListener('uncaughtException', record);
			process.removeListener('unhandledRejection', record);
		};
		process.prependListener('uncaughtException', record);
		process.prependListener('unhandledRejection', record);
		onTestFinished(release);
		return { seen, release };
	}

	async function rawClient(httpServer) {
		const client = connect(httpServer.address().port, '127.0.0.1');
		client.on('error', () => {});
		await once(client, 'connect');
		return client;
	}

	// Not events.once: it would attach the error listener under test.
	const closeOrTimeout = (socket) => Promise.race([
		new Promise((resolve) => socket.once('close', () => resolve('closed'))),
		new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000))
	]);

	it.each(['loads', 'runs its upgrade hook'])('survives a client that resets while the handler %s', async (phase) => {
		const loading = deferred();
		const entered = deferred();
		const release = deferred();
		const handler = { upgrade: vi.fn(async () => { entered.resolve(); await release.promise; return false; }) };
		if (phase !== 'loads') loading.resolve(handler);
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, () => loading.promise);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		const trap = trapUnhandled();
		let serverSocket;
		let client;
		httpServer.on('upgrade', (req, socket) => { serverSocket = socket; });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			client = await rawClient(httpServer);
			client.write(upgradeRequest('/ws'));
			if (phase === 'loads') await vi.waitFor(() => expect(serverSocket).toBeDefined());
			else await entered.promise;
			const outcome = closeOrTimeout(serverSocket);
			client.resetAndDestroy();
			expect({ outcome: await outcome, unhandled: trap.seen }).toEqual({ outcome: 'closed', unhandled: [] });
			expect(serverSocket.destroyed).toBe(true);
			loading.resolve(handler);
			release.resolve();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(trap.seen).toEqual([]);
		} finally {
			trap.release();
			serverSocket?.destroy();
			client?.destroy();
			loading.resolve(handler);
			release.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});

	it('survives a client that resets after a superseded upgrade is refused', async () => {
		const entered = deferred();
		const release = deferred();
		const first = { upgrade: vi.fn(async () => { entered.resolve(); await release.promise; return {}; }) };
		const next = { init: vi.fn() };
		const httpServer = createServer();
		const server = viteServer(httpServer, 2, async () => first);
		const plugin = uws({ handler: './handler.js', allowedOrigins: '*' });
		const trap = trapUnhandled();
		let serverSocket;
		let client;
		httpServer.on('upgrade', (req, socket) => { serverSocket = socket; });
		try {
			await plugin.configureServer(server);
			await listen(httpServer);
			client = await rawClient(httpServer);
			client.write(upgradeRequest('/ws'));
			await entered.promise;
			server.ssrLoadModule.mockResolvedValue(next);
			await hotUpdate(plugin, server);
			await vi.waitFor(() => expect(next.init).toHaveBeenCalledOnce());
			const refusal = new Promise((resolve) => client.once('data', (data) => resolve(data.toString())));
			release.resolve();
			// The 503 ends the socket, which stays half open until the reset.
			expect(await refusal).toMatch(/^HTTP\/1\.1 503 /);
			const outcome = closeOrTimeout(serverSocket);
			client.resetAndDestroy();
			expect({ outcome: await outcome, unhandled: trap.seen }).toEqual({ outcome: 'closed', unhandled: [] });
		} finally {
			trap.release();
			serverSocket?.destroy();
			client?.destroy();
			release.resolve();
			await closeLifecycle(plugin, server);
			await close(httpServer, []);
		}
	});
});
