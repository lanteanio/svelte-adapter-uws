// Record-and-replay registry for the app's route registrations.
//
// uWS SNI server names each carry their OWN router: `addServerName` creates an
// empty per-domain router, and every HTTP request on a connection whose SNI
// matched that name is routed through the domain router INSTEAD of the app's
// main router. An empty domain router force-closes every request (uWS closes
// the socket when no route matches), so any server name the TLS hot-reload
// registers must have the app's full route set replayed onto its domain
// router - and replayed again after every reload, because a cert swap is
// removeServerName + addServerName, which replaces the domain router with a
// fresh empty one.
//
// `registerRoute` both applies a registration to the app now (the main router)
// and records it for later replay; `mirrorRoutes` replays the recorded set
// onto each host's domain router. Handlers are shared by reference - a domain
// router dispatches into the exact same closures as the main router, so
// behavior (SSR, WS upgrade, health, admin) is identical whichever router a
// connection resolves to.

/** @type {WeakMap<object, Array<{ method: string, args: any[] }>>} */
const recordedByApp = new WeakMap();

/**
 * Register a route on the app (its current registration target - the main
 * router at module setup) and record it for later mirroring. Recordings are
 * kept per app, so two apps in one process (or one per test) never see each
 * other's routes.
 *
 * @param {any} app  the uWS app
 * @param {string} method  the registration method ('get' | 'post' | 'any' | 'ws' | ...)
 * @param {...any} args  the registration arguments, recorded by reference
 */
export function registerRoute(app, method, ...args) {
	let recorded = recordedByApp.get(app);
	if (!recorded) {
		recorded = [];
		recordedByApp.set(app, recorded);
	}
	recorded.push({ method, args });
	app[method](...args);
}

/**
 * Replay every recorded registration onto each host's SNI domain router.
 * `app.domain(host)` switches the app's registration target to that host's
 * router; the final `app.domain('')` can never match a registered name, which
 * is uWS's way of switching the target back to the main router. Synchronous
 * throughout - no handshake or request can interleave with the replay.
 *
 * @param {any} app  the uWS app
 * @param {string[]} hosts  the SNI hosts whose domain routers need the routes
 */
export function mirrorRoutes(app, hosts) {
	const recorded = recordedByApp.get(app);
	if (!recorded || recorded.length === 0 || hosts.length === 0) return;
	for (const host of hosts) {
		app.domain(host);
		for (const { method, args } of recorded) app[method](...args);
	}
	app.domain('');
}
