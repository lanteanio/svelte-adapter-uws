// The configured metrics registry is ONE instance, shared between the runtime
// and the app graph.
//
// `websocket.metrics` is a module path, and the way it is bundled decides how
// many instances of that module exist per process. Bundled standalone, the
// adapter's counters increment on a copy only `platform.metrics` can reach,
// while a route importing the module directly reads a second, empty copy -
// counters silently frozen at zero, and every module-level side effect run
// twice. The Vite plugin instead emits the registry as a chunk of the app's
// own server build, where Rollup dedupes the module with every route that
// imports it.
//
// The fixture has both read points: /metrics serializes `platform.metrics`,
// /metrics-direct serializes a direct app-graph import of the same module.
// Under the shared-instance contract they are the same object; against a
// standalone bundle the direct route reads empty, which is the defect shape
// this suite exists to refuse.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, rawUpgrade } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/** @param {string} httpUrl @param {string} route @returns {Promise<Map<string, number>>} */
async function scrape(httpUrl, route) {
	const response = await fetch(httpUrl + route);
	expect(response.status).toBe(200);
	const values = new Map();
	for (const line of (await response.text()).split('\n')) {
		const space = line.lastIndexOf(' ');
		if (space > 0) values.set(line.slice(0, space), Number(line.slice(space + 1)));
	}
	return values;
}

describeUWS('metrics registry instance sharing', () => {
	let server;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'metrics' });
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('shows the adapter-written counters through a direct app-graph import of the registry module', async () => {
		// Move adapter-owned counters through real traffic: one HTTP request and
		// one real upgrade, both instrumented by the runtime, not by the app.
		await fetch(server.httpUrl + '/');
		const upgrade = await rawUpgrade(server.port);
		expect(upgrade.status).toBe('101');

		// The platform read point sees them - the already-supported contract,
		// asserted first so a failure below cannot be a runtime that simply
		// stopped instrumenting.
		const viaPlatform = await scrape(server.httpUrl, '/metrics');
		expect(viaPlatform.get('http_requests_total')).toBeGreaterThan(0);

		// The direct import sees the SAME instance. Against a standalone bundle
		// this map has no adapter counter at all: the route's copy of the module
		// is a registry the runtime never wrote to.
		const viaImport = await scrape(server.httpUrl, '/metrics-direct');
		expect(viaImport.get('http_requests_total')).toBeGreaterThan(0);
	});

	it('shows an app-graph write through the platform read point', async () => {
		// The other direction, immune to the runtime's own concurrent counting: a
		// probe counter incremented THROUGH the direct import must be visible on
		// platform.metrics. A "shared" implementation that merely mirrored the
		// adapter's counters into a second instance passes the test above and
		// fails here - the probe exists only if there is one registry object.
		const bumped = await scrape(server.httpUrl, '/metrics-direct?bump=1');
		expect(bumped.get('app_graph_probe_total')).toBeGreaterThan(0);

		const viaPlatform = await scrape(server.httpUrl, '/metrics');
		expect(viaPlatform.get('app_graph_probe_total')).toBe(bumped.get('app_graph_probe_total'));
	});
});
