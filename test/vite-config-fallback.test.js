import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import adapter from '../src/index.js';
import uws from '../src/vite.js';

let httpServer;
let configRoot;
const clients = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.terminate();
	if (httpServer) await new Promise(resolve => httpServer.close(resolve));
	httpServer = null;
	if (configRoot) rmSync(configRoot, { recursive: true, force: true });
	configRoot = null;
	vi.unstubAllEnvs();
});

function connect(port, origin) {
	return new Promise((resolve, reject) => {
		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: { origin, host: 'untrusted.example' }
		});
		clients.push(client);
		client.on('message', data => {
			const message = JSON.parse(data.toString());
			if (message.type !== 'welcome') resolve({ status: 101, message });
		});
		client.once('unexpected-response', (_request, response) => {
			response.resume();
			resolve({ status: response.statusCode });
		});
		client.once('error', reject);
	});
}

describe('adapter configuration fallback', () => {
	it('loads handler, metrics and origin prefix from the config without a plugin API', async () => {
		const scratch = resolve('test-results');
		mkdirSync(scratch, { recursive: true });
		configRoot = mkdtempSync(join(scratch, 'vite-fallback-'));
		const handler = join(configRoot, 'handler.mjs');
		const metrics = join(configRoot, 'metrics.mjs');
		writeFileSync(join(configRoot, 'package.json'), '{"type":"module"}');
		writeFileSync(handler, `export function open(ws, ctx) {
			ws.send(JSON.stringify({ handler: 'configured', metrics: ctx.platform.metrics.marker }));
		}`);
		writeFileSync(metrics, "export default { marker: 'configured registry' };\n");
		writeFileSync(join(configRoot, 'svelte.config.js'),
			`import adapter from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
			export default { kit: { adapter: adapter({ envPrefix: 'FALLBACK_', websocket: {
				handler: ${JSON.stringify(handler)}, metrics: ${JSON.stringify(metrics)}
			} }) } };`);
		vi.stubEnv('ORIGIN', 'https://bare.example');
		vi.stubEnv('FALLBACK_ORIGIN', 'https://configured.example');
		httpServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
		const loaded = [];
		await uws({ allowedOrigins: 'same-origin' }).configureServer({
			httpServer,
			middlewares: { stack: [], use() {} },
			config: { root: configRoot, server: {}, plugins: [], logger: { warn() {}, info() {}, error() {} } },
			async ssrLoadModule(id) {
				loaded.push(id);
				return import(pathToFileURL(id).href);
			}
		});
		await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
		const port = httpServer.address().port;
		expect(await connect(port, 'https://bare.example')).toEqual({ status: 403 });
		expect(await connect(port, 'http://untrusted.example')).toEqual({ status: 403 });
		expect(await connect(port, 'https://configured.example')).toEqual({
			status: 101, message: { handler: 'configured', metrics: 'configured registry' }
		});
		expect(loaded).toEqual([metrics, handler]);
	});

	it.each([null, false, true, 1, [], {}, () => 'APP_'])('rejects non-string envPrefix %#', envPrefix => {
		expect(() => adapter({ envPrefix })).toThrow('envPrefix must be a string');
	});

	it.each([undefined, '', 'APP_'])('accepts string prefixes and the default %#', envPrefix => {
		expect(adapter({ envPrefix }).envPrefix).toBe(envPrefix ?? '');
	});
});
