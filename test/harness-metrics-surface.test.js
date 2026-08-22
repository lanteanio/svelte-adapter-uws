// The metrics OUTPUT contract, from the harness.
//
// `createTestServer` always accepted a registry as an INPUT and registered its
// own instruments against it. What it did not do was hand that registry back as
// `platform.metrics`, or answer `platform.metricsSnapshot()` - both of which
// exist only in the built production runtime. So the one route the README leads
// with, a `/metrics` endpoint reading `platform.metrics`, was the one route that
// could not be exercised anywhere but a production build: a test for it had to
// be written against a different surface than the code it was testing.
//
// These cases drive the harness platform the way an app route would.

import { describe, it, expect, afterEach } from 'vitest';

/** @type {any} */
let server = null;

afterEach(async () => {
	try { await server?.close?.(); } catch { /* already down */ }
	server = null;
});

/** A registry of the documented shape: it accepts instrument calls and records them. */
function recordingRegistry() {
	/** @type {Array<{ kind: string, name: string }>} */
	const created = [];
	const make = (kind) => (name) => {
		created.push({ kind, name });
		return { inc() {}, set() {}, observe() {} };
	};
	return { created, counter: make('counter'), gauge: make('gauge'), histogram: make('histogram') };
}

describe('the harness exposes the metrics members a route reads', () => {
	it('hands back the registry it was given', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const registry = recordingRegistry();
		server = await createTestServer({ metrics: registry, handler: {} });

		const platform = server.platform ?? server.app?.platform ?? null;
		expect(platform, 'the harness must expose a platform to read this from').toBeTruthy();
		expect(platform.metrics, 'a route reading platform.metrics must find the registry').toBe(registry);
		// It really is the live one: the harness registered against it.
		expect(registry.created.length, 'the harness registers its own instruments').toBeGreaterThan(0);
	});

	it('answers null for metrics when none was supplied, as production does', async () => {
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ handler: {} });
		const platform = server.platform ?? server.app?.platform ?? null;
		expect(platform.metrics).toBeNull();
		await expect(platform.metricsSnapshot()).resolves.toBeNull();
	});

	it('produces a merged snapshot document, not the registry own rendering', async () => {
		// The snapshot is built from the mirror, so it works with a registry that
		// renders nothing back - which the documented shape does not oblige it to
		// do. A snapshot that asked the registry to serialize would fail here.
		const { createTestServer } = await import('../src/testing.js');
		server = await createTestServer({ metrics: recordingRegistry(), handler: {} });
		const platform = server.platform ?? server.app?.platform ?? null;

		const body = await platform.metricsSnapshot();
		expect(typeof body, 'a supplied registry must produce a document').toBe('string');

		// And it must contain the harness's OWN instruments, not merely be
		// non-empty. That is the whole reason the registry is wrapped: the
		// snapshot is collected from the metric mirror, and building instruments
		// straight from the caller's registry leaves the mirror empty. Asserting
		// only "a non-empty string" passes either way - measured, the document is
		// 890 characters with the wrapping and 552 without, and this series is
		// exactly what the difference is made of.
		expect(
			body,
			'the snapshot must carry the instruments this server registered'
		).toContain('upgrade_deferred_depth');
	});
});

// The same two members on the DEV plugin, which is the other half of the same
// contract and the half that was still answering null unconditionally.
//
// The reasoning it used to carry - dev has no build step, therefore no registry
// - reads the option as a build artifact. It is a build-time OPTION, and the
// plugin already resolves the handler from the same adapter config through the
// same Vite resolver. An app that cannot reach its registry under `vite dev`
// cannot develop the one route the README leads with anywhere except a
// production build, which is exactly the gap the harness half closed.
describe('the dev plugin exposes the same metrics members', () => {
	/** @type {any} */
	let httpServer = null;

	afterEach(async () => {
		if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
		httpServer = null;
	});

	/**
	 * Boot the real plugin against a fake Vite server whose config names a
	 * metrics module on the adapter, exactly as an app's SvelteKit config does.
	 *
	 * @param {any} metricsModule what `ssrLoadModule` returns for the metrics path
	 */
	async function bootDevWithMetrics(metricsModule) {
		const { createServer } = await import('node:http');
		const mod = await import('../src/vite.js');
		const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });

		httpServer = createServer();
		await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

		const metricsPath = '/virtual-metrics-registry.js';
		// The platform is reached the way an application reaches it: handed to
		// the handler's `init` hook. There is no back door, and asserting
		// through one would test a surface no app has.
		const captured = { platform: /** @type {any} */ (null) };
		const handlerModule = { init({ platform }) { captured.platform = platform; }, message() {} };
		const viteServer = {
			httpServer,
			middlewares: { use() {} },
			config: {
				root: process.cwd(),
				logger: { warn() {}, info() {}, error() {} },
				server: {},
				plugins: [{
					api: { options: { kit: { adapter: { name: 'adapter-uws', websocketMetrics: metricsPath } } } }
				}]
			},
			async ssrLoadModule(id) {
				if (String(id).includes('virtual-metrics-registry')) return metricsModule;
				return handlerModule;
			}
		};
		await plugin.configureServer(viteServer);
		// The plugin resolves and loads asynchronously inside configureServer's
		// own chain; a few turns are enough for the load and the init hook.
		await new Promise((r) => setTimeout(r, 80));
		return captured;
	}

	it('hands back the registry named on the adapter', async () => {
		const registry = recordingRegistry();
		const { platform } = await bootDevWithMetrics({ default: registry });
		expect(platform, 'the init hook must have been handed a platform').toBeTruthy();
		expect(platform.metrics, 'a route reading platform.metrics in dev must find the registry').toBe(registry);
		expect(typeof await platform.metricsSnapshot(), 'a configured registry must produce a document').toBe('string');
	});

	it('takes the same export the build takes, in the same order', async () => {
		// `default` then `metrics` then `registry`, first non-nullish. A dev that
		// picked differently would serve one object while the build bundles
		// another, which is the class of drift the handler resolution already
		// closed.
		const named = recordingRegistry();
		const { platform } = await bootDevWithMetrics({ metrics: named });
		expect(platform.metrics).toBe(named);
	});

	it('answers null for both when no metrics module is named', async () => {
		const { createServer } = await import('node:http');
		const mod = await import('../src/vite.js');
		const plugin = mod.default({ allowedOrigins: '*', handler: '/virtual-ws-handler' });
		httpServer = createServer();
		await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
		const captured = { platform: /** @type {any} */ (null) };
		await plugin.configureServer({
			httpServer,
			middlewares: { use() {} },
			config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {}, plugins: [] },
			async ssrLoadModule() { return { init({ platform }) { captured.platform = platform; }, message() {} }; }
		});
		await new Promise((r) => setTimeout(r, 80));
		const platform = captured.platform;
		expect(platform, 'the init hook must have been handed a platform').toBeTruthy();
		expect(platform.metrics, 'production answers null when the option is unset; dev must agree').toBeNull();
		await expect(platform.metricsSnapshot()).resolves.toBeNull();
	});
});
