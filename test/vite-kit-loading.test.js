import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import WebSocket from 'ws';
import uws from '../vite.js';
import { WS_SUBSCRIPTIONS, WS_PLATFORM } from '../files/utils.js';

function viteServer(httpServer, kitVersion, loadModule, root = process.cwd()) {
	const adapter = { name: 'adapter-uws' };
	return {
		httpServer,
		middlewares: { use: vi.fn() },
		config: {
			root,
			server: {},
			logger: { warn: vi.fn() },
			plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: kitVersion === 3 ? { paths: {}, adapter } : { kit: { adapter } } } }]
		},
		ssrLoadModule: vi.fn(loadModule),
		environments: { ssr: { runner: { import: vi.fn(loadModule) } } }
	};
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
		const plugin = uws({ handler, allowedOrigins: '*' });
		const init = vi.fn();

		try {
			await plugin.configureServer(server);
			expect(expectedLoader).toHaveBeenCalledTimes(kitVersion === 3 ? 0 : 1);
			expect(otherLoader).not.toHaveBeenCalled();

			const url = await listen(httpServer);
			await vi.waitFor(() => expect(expectedLoader).toHaveBeenCalledWith(handlerPath));
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
			plugin.handleHotUpdate({ server });
			expect((await restarted)[0]).toBe(1012);
			expect(expectedLoader).toHaveBeenCalledTimes(2);
			expect(expectedLoader).toHaveBeenLastCalledWith(handlerPath);
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
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
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
			await plugin.closeBundle();
			await close(httpServer, []);
		}
		expect(handler.shutdown).toHaveBeenCalledOnce();
		expect(handler.unsubscribe).toHaveBeenCalledExactlyOnceWith(socket, 'retiring', { platform: ownerPlatform });
		expect(socket.unsubscribe).toHaveBeenCalledExactlyOnceWith('retiring');
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
			server.ssrLoadModule.mockResolvedValue(newest);
			await plugin.handleHotUpdate({ server });
			pending.resolve(initial);
			const client = new WebSocket(url);
			clients.push(client);
			expect(await handlerMessage(client)).toBe('newest');
			expect(initial.init).not.toHaveBeenCalled();
			expect(initial.shutdown).not.toHaveBeenCalled();
			expect(newest.init).toHaveBeenCalledOnce();
		} finally {
			pending.resolve(initial);
			await plugin.closeBundle();
			await close(httpServer, clients);
		}
		expect(newest.shutdown).toHaveBeenCalledOnce();
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
			const second = plugin.handleHotUpdate({ server });
			await vi.waitFor(() => expect(handlers[1].init).toHaveBeenCalledOnce());
			const client = new WebSocket(url);
			clients.push(client);
			const message = handlerMessage(client);
			const opened = vi.fn();
			client.on('open', opened);
			await once(httpServer, 'upgrade');
			server.ssrLoadModule.mockResolvedValue(handlers[2]);
			const third = plugin.handleHotUpdate({ server });
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
			await plugin.handleHotUpdate({ server });
			expect(handlers[2].init).toHaveBeenCalledOnce();
			expect(handlers[2].shutdown).not.toHaveBeenCalled();
		} finally {
			finishSecond.resolve();
			finishThird.resolve();
			await plugin.closeBundle();
			await close(httpServer, clients);
		}
		for (const handler of handlers) expect(handler.shutdown).toHaveBeenCalledOnce();
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
			const closing = plugin.closeBundle().then(stopped);
			await Promise.resolve();
			if (stage === 'init') expect(stopped).not.toHaveBeenCalled();
			pending.resolve(handler);
			await closing;
			await plugin.closeBundle();
			expect(handler.open).not.toHaveBeenCalled();
			expect(handler.init).toHaveBeenCalledTimes(stage === 'init' ? 1 : 0);
			expect(handler.shutdown).toHaveBeenCalledTimes(stage === 'init' ? 1 : 0);
		} finally {
			pending.resolve(handler);
			await plugin.closeBundle();
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
			expect(handler.init).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
			await plugin.closeBundle();
			await close(httpServer, clients);
			errorLog.mockRestore();
		}
		expect(disconnect).toHaveBeenCalledOnce();
	});
});
