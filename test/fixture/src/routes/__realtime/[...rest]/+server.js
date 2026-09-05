// A SvelteKit route sitting INSIDE the reserved admin namespace, so a suite can
// ask the app itself whether it was reached.
//
// The adapter documents `/__realtime/*` as reserved and mounts the admin lane
// ahead of page routing, which an app is entitled to read as "my own routes
// never see this prefix". Nothing proves that from outside: a request that
// skips the admin lane and falls through to SSR answers 404 for a path the app
// has no route for, and a 404 is what a correctly reserved prefix looks like
// too. With a route here the two outcomes separate - if the app answers, the
// reservation did not hold, and the body says which pathname it was handed.
//
// It answers for every method so a non-GET spelling cannot look reserved for
// the wrong reason.

/** @param {{ url: URL, request: Request }} event */
function echo({ url, request }) {
	return new Response(JSON.stringify({ appRouteReached: true, path: url.pathname, method: request.method }), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

export const GET = echo;
export const POST = echo;
export const PUT = echo;
export const DELETE = echo;
export const PATCH = echo;
