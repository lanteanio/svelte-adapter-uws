// Record-and-replay route registry (src/runtime/handler/route-registry.js).
// A uWS SNI server name carries its OWN empty HTTP router that force-closes
// every request it cannot route, so the TLS hot-reload must replay the app's
// full route set onto each host's domain router after every cert swap. These
// tests drive the registry against a mock app whose `domain()` switches the
// current registration target exactly like uWS's.

import { describe, it, expect } from 'vitest';
import { registerRoute, mirrorRoutes } from '../src/runtime/handler/route-registry.js';

function mockApp() {
	/** @type {Record<string, Array<{ method: string, args: any[] }>>} */
	const routers = { '': [] };
	/** @type {string[]} */
	const domainCalls = [];
	let current = '';
	const record = (method) => (...args) => { routers[current].push({ method, args }); };
	return {
		routers,
		domainCalls,
		domain(host) {
			domainCalls.push(host);
			current = host;
			if (!routers[host]) routers[host] = [];
		},
		get: record('get'),
		post: record('post'),
		any: record('any'),
		ws: record('ws')
	};
}

describe('registerRoute', () => {
	it('applies the registration to the app immediately (main router)', () => {
		const app = mockApp();
		const handler = () => {};
		registerRoute(app, 'get', '/healthz', handler);
		expect(app.routers['']).toEqual([{ method: 'get', args: ['/healthz', handler] }]);
	});

	it('keeps recordings per app - two apps never see each other\'s routes', () => {
		const a = mockApp();
		const b = mockApp();
		registerRoute(a, 'get', '/only-a', () => {});
		registerRoute(b, 'post', '/only-b', () => {});
		mirrorRoutes(a, ['a.example.com']);
		mirrorRoutes(b, ['b.example.com']);
		expect(a.routers['a.example.com'].map((r) => r.args[0])).toEqual(['/only-a']);
		expect(b.routers['b.example.com'].map((r) => r.args[0])).toEqual(['/only-b']);
		expect(a.routers['b.example.com']).toBeUndefined();
		expect(b.routers['a.example.com']).toBeUndefined();
	});
});

describe('mirrorRoutes', () => {
	it('replays every recorded registration, in registration order, onto each host', () => {
		const app = mockApp();
		const h1 = () => {};
		const wsBehavior = { open() {}, message() {} };
		const h2 = () => {};
		registerRoute(app, 'get', '/healthz', h1);
		registerRoute(app, 'ws', '/ws', wsBehavior);
		registerRoute(app, 'any', '/*', h2);
		mirrorRoutes(app, ['a.example.com', 'b.example.com']);
		for (const host of ['a.example.com', 'b.example.com']) {
			expect(app.routers[host]).toEqual([
				{ method: 'get', args: ['/healthz', h1] },
				{ method: 'ws', args: ['/ws', wsBehavior] },
				{ method: 'any', args: ['/*', h2] }
			]);
			// Shared by reference: the domain router dispatches into the exact same
			// closures as the main router.
			expect(app.routers[host][0].args[1]).toBe(h1);
			expect(app.routers[host][1].args[1]).toBe(wsBehavior);
		}
	});

	it('switches the registration target per host and resets it with domain(\'\')', () => {
		const app = mockApp();
		registerRoute(app, 'get', '/x', () => {});
		mirrorRoutes(app, ['a.example.com', 'b.example.com']);
		// Reset MUST come last: routes registered after a mirror (there are none in
		// production, but the invariant is what keeps the main router the target).
		expect(app.domainCalls).toEqual(['a.example.com', 'b.example.com', '']);
	});

	it('never touches domain() when nothing was recorded or no hosts are given', () => {
		const empty = mockApp();
		mirrorRoutes(empty, ['a.example.com']);
		expect(empty.domainCalls).toEqual([]);

		const noHosts = mockApp();
		registerRoute(noHosts, 'get', '/x', () => {});
		mirrorRoutes(noHosts, []);
		expect(noHosts.domainCalls).toEqual([]);
	});

	it('replays again after a swap replaced the domain router (re-mirror on every reload)', () => {
		const app = mockApp();
		registerRoute(app, 'get', '/x', () => {});
		mirrorRoutes(app, ['a.example.com']);
		expect(app.routers['a.example.com']).toHaveLength(1);
		// A cert swap is removeServerName + addServerName: the host comes back with
		// a fresh EMPTY router. Simulate that, then re-mirror.
		app.routers['a.example.com'] = [];
		mirrorRoutes(app, ['a.example.com']);
		expect(app.routers['a.example.com']).toHaveLength(1);
		expect(app.routers['a.example.com'][0].args[0]).toBe('/x');
	});
});
