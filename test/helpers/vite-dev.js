// A real Vite dev server running the uws() plugin, for the suites that pin what
// the plugin's middlewares do with the requests Vite hands them.
//
// A stand-in for `server.middlewares` misses what Vite's connect does to a
// request on the way in: it matches a mount without regard to case and with
// anything after a `/` or `.`, strips the mount from `req.url`, and keeps the
// whole target in `req.originalUrl`. This runs Vite's own.
//
// `allowedHosts: true` because Vite drops its host check when it serves
// `server.https`, the configuration in which a browser speaks HTTP/2 to it; the
// plugin's own gates then stand alone, and those are what the suites probe.
// `tls: { key, cert }` sets `server.https`, so Vite itself listens through
// `http2.createSecureServer({ allowHTTP1: true })`. `h2: true` adds a
// cleartext HTTP/2 listener over the same middleware stack, which gives the
// middlewares node's http2 compatibility request without a certificate.
//
// The handler module is the one piece not loaded the real way: Vite's SSR
// module runner needs `Module.registerHooks`, which the vmForks pool does not
// provide, so `ssrLoadModule` hands back the caller's hooks instead, once
// `ready` settles (for a test of the window before the handler has loaded). A
// post hook stands in for the application, registered the way SvelteKit
// registers its own middleware, and answers APP_STATUS, so a test can tell a
// request the plugin passed on from one it answered.

import { createServer } from 'vite';
import { createServer as createH2Server } from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import uws from '../../src/vite.js';

/** A status nothing in the plugin answers. */
export const APP_STATUS = 299;

/**
 * Boot the plugin inside a real Vite dev server. The plugin reads `ORIGIN` when
 * it is created, so set it before calling this.
 *
 * @param {{
 *   pluginOptions?: Record<string, unknown>,
 *   handler?: Record<string, Function>,
 *   ready?: Promise<unknown>,
 *   h2?: boolean,
 *   cors?: import('vite').CorsOptions | boolean,
 *   tls?: { key: string, cert: string }
 * }} [options]
 */
export async function bootViteDev({ pluginOptions = {}, handler = {}, ready, h2 = false, tls, cors } = {}) {
	// An empty root keeps Vite's static and public-dir middlewares from serving
	// anything in this repository at the paths the suites probe.
	const root = mkdtempSync(join(tmpdir(), 'uws-vite-dev-'));
	/** @type {import('vite').ViteDevServer | null} */
	let server = null;
	/** @type {import('node:http2').Http2Server | null} */
	let h2Server = null;
	/** @type {Set<import('node:http2').Http2Session>} */
	const sessions = new Set();
	const close = async () => {
		for (const session of sessions) session.destroy();
		if (h2Server !== null) await new Promise((resolve) => h2Server.close(() => resolve(undefined)));
		if (server !== null) await server.close();
		rmSync(root, { recursive: true, force: true });
	};

	try {
		server = await createServer({
			configFile: false,
			root,
			logLevel: 'silent',
			clearScreen: false,
			appType: 'custom',
			optimizeDeps: { noDiscovery: true, include: [] },
			server: { host: '127.0.0.1', allowedHosts: true, watch: null, hmr: false, ws: false, https: tls, cors },
			plugins: [
				handlerModule(handler, ready),
				uws({ handler: '/virtual-dev-handler', ...pluginOptions }),
				appStandIn()
			]
		});
		// Not `server.listen()`, which reads port 0 as unset and walks up from
		// 5173. Vite's wrapper around `httpServer.listen` still initializes the
		// server first.
		const httpServer = server.httpServer;
		await new Promise((resolve, reject) => {
			httpServer.once('error', reject);
			httpServer.listen(0, '127.0.0.1', () => {
				httpServer.off('error', reject);
				resolve(undefined);
			});
		});
		const port = /** @type {import('node:net').AddressInfo} */ (httpServer.address()).port;

		let h2Port = null;
		if (h2) {
			h2Server = createH2Server(server.middlewares);
			h2Server.on('session', (session) => {
				sessions.add(session);
				session.once('close', () => sessions.delete(session));
			});
			await new Promise((resolve) => h2Server.listen(0, '127.0.0.1', () => resolve(undefined)));
			h2Port = /** @type {import('node:net').AddressInfo} */ (h2Server.address()).port;
		}
		return { port, h2Port, httpServer, close };
	} catch (err) {
		await close();
		throw err;
	}
}

/**
 * @param {Record<string, Function>} handler
 * @param {Promise<unknown> | undefined} ready
 * @returns {import('vite').Plugin}
 */
function handlerModule(handler, ready) {
	return {
		name: 'test-handler-module',
		enforce: 'pre',
		configureServer: {
			order: 'pre',
			handler(server) {
				server.ssrLoadModule = async () => {
					await ready;
					return { ...handler };
				};
			}
		}
	};
}

/** @returns {import('vite').Plugin} */
function appStandIn() {
	return {
		name: 'test-app-stand-in',
		configureServer(server) {
			return () => {
				server.middlewares.use((req, res) => {
					req.resume();
					res.statusCode = APP_STATUS;
					res.setHeader('content-type', 'text/plain');
					res.end('app');
				});
			};
		}
	};
}
