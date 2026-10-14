import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import WebSocket from 'ws';
import uws from '../vite.js';

function viteServer(httpServer, kitVersion, loadModule, root = process.cwd()) {
	const adapter = { name: 'adapter-uws' };
	return {
		httpServer,
		middlewares: { use: vi.fn() },
		config: {
			root,
			server: {},
			logger: { warn: vi.fn() },
			plugins: [{ api: { options: kitVersion === 3 ? { adapter } : { kit: { adapter } } } }]
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
			expect(expectedLoader).toHaveBeenCalledWith(handlerPath);
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
			expect(init).toHaveBeenCalledTimes(1);
		} finally {
			finishLoad({});
			await close(httpServer, clients);
		}
	});

	it('loads Kit 3 handlers when the HTTP server is already listening', async () => {
		const httpServer = createServer();
		const clients = [];
		try {
			const url = await listen(httpServer);
			const server = viteServer(httpServer, 3, async () => ({ open: (ws) => ws.send('ready') }));
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
