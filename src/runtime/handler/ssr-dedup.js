/**
 * Whether an SSR response may be buffered whole for cross-waiter dedup.
 *
 * The one response that must never be buffered is a Server-Sent-Events stream
 * (`text/event-stream`): it never ends, so `arrayBuffer()` on it would await
 * forever - parking the leader and every concurrent anonymous waiter on the
 * same in-flight promise until the connection drops. Those must stream.
 *
 * Everything else is a finite render we buffer and share. Note we deliberately
 * do NOT require a `content-length`: SvelteKit's dynamically-rendered pages
 * carry none, so gating on that header would silently disable dedup for the
 * exact thundering-herd workload it exists to protect. The never-ending
 * content-type is the only reliable signal, and `writeResponse` already
 * chunk-streams the excluded case without buffering it.
 *
 * Kept in its own dependency-free module so it is unit-testable without pulling
 * in the build-time runtime init chain that `ssr.js` depends on.
 *
 * @param {Response} response
 * @returns {boolean}
 */
export function isDedupBufferable(response) {
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	return !contentType.startsWith('text/event-stream');
}
