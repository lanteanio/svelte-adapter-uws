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
 * Every exact path registered - no `*` and no parameter - which is every path
 * the adapter mounts ahead of the catch-all: the probes, the auth path, the
 * waiting-room pages, and the WebSocket path unless its GET route yields to
 * the application (`yieldsToApp`). One set per module rather than per app:
 * a worker runs one runtime, and its SNI domain routers replay the same
 * paths. @type {Set<string>}
 */
const exactMounts = new Set();

/**
 * The page path SvelteKit answers `path` for. A route-resolution request
 * (`/__route.js`) and a data request (`/__data.json`, `.html__data.json`) are
 * answered for the page in front of the suffix, and a data request for a page
 * spelled with a trailing slash carries that slash in a query parameter,
 * read here as SvelteKit reads it - parsed only when a mount is at stake.
 *
 * `/healthz/` is left to the application, and its data with it. uWS never
 * routes that pathname to the mount, so it is not a spelling the adapter
 * shadows; SvelteKit's router matches it to the same route as `/healthz`, and
 * whether it redirects the page, serves it or both is the application's
 * `trailingSlash`, which the catch-all cannot see. Refusing it would break a
 * page an app serves there on purpose.
 *
 * @param {string} path
 * @param {string | undefined} query
 */
function kitPagePath(path, query) {
	if (path.endsWith('/__route.js')) return path.slice(0, -11) || '/';
	let page;
	if (path.endsWith('/__data.json')) page = path.slice(0, -12);
	else if (path.endsWith('.html__data.json')) page = path.slice(0, -16) + '.html';
	else return path;
	// Parsed behind a `?` of its own: the constructor drops one leading `?`, and
	// a query that itself begins with one (`??name=1`) keeps it in the first
	// name, as the request URL SvelteKit parses does.
	if (query && (exactMounts.has(page + '/') || exactMounts.has(page || '/')) &&
		new URLSearchParams('?' + query).get('x-sveltekit-trailing-slash') === '1') page += '/';
	return page || '/';
}

/**
 * Take a path back out of the exact mounts: its route yields the requests the
 * catch-all could see on to the application, so the path's pages, their data
 * and any spelling that resolves onto it are the application's.
 *
 * @param {string} path
 */
export function yieldsToApp(path) {
	exactMounts.delete(path);
}

/**
 * Whether `path`, read as SvelteKit's router reads it, is an exact mount that
 * the raw target `raw` does not spell. The catch-all refuses such a target: it
 * was routed past the mount on its raw spelling and would reach the app's
 * router as the mounted path. The raw spelling itself reaches the catch-all
 * only for a method the mount does not answer, and goes on to the app.
 *
 * @param {string} path  the raw target, or a resolved or decoded reading of it
 * @param {string} raw  the raw target
 * @param {string} [query]  the raw query, which carries a data request's trailing slash
 */
export function entersExactMount(path, raw, query) {
	const page = kitPagePath(path, query);
	return page !== raw && exactMounts.has(page);
}

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
	// A WebSocket route takes upgrades only; the GET route beside it says whose
	// the path's pages are.
	if (method !== 'ws' && typeof args[0] === 'string' && !/[*:]/.test(args[0])) exactMounts.add(args[0]);
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
