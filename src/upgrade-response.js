// Response-splitting guard. uWS writes these headers VERBATIM into the 101
// handshake - a CR, LF, or NUL in a value (or a name outside the RFC 7230
// token alphabet) splits the response and lets an app that composes
// untrusted data into a header inject arbitrary response lines. Validated
// here at construction so the failure surfaces inside the app's upgrade
// hook (a throw there takes the adapter's hook-error path: 500, no 101).
//
// The runtime validates independently: it snapshots these headers and checks
// the snapshot it is about to write, because this object belongs to the app and
// stays mutable after construction. Both checks call the one shared predicate,
// so they cannot disagree about what is safe.
import { assertSafeUpgradeHeaders } from './runtime/utils/upgrade-headers.js';

/**
 * Wrap upgrade hook return value to include response headers on the 101
 * Switching Protocols response (e.g. Set-Cookie for session refresh).
 *
 * Throws a TypeError when a header name is not a valid RFC 7230 token, a value
 * contains a byte outside Node's accepted header class (TAB, printable ASCII
 * and the Latin-1 high range), or a value is not a string. CR, LF and NUL split
 * or truncate the 101; the other refused controls would fail at a Node-based
 * proxy after this adapter had accepted them. A non-string is refused here
 * rather than at write time because uWS refuses it
 * AFTER the 101 status line is already corked, and `{'x-ratelimit-remaining': 3}`
 * is the natural app mistake.
 *
 * @template T
 * @param {T} userData - Data attached to ws.getUserData()
 * @param {Record<string, string | string[]>} [headers] - Headers for the 101 response
 * @returns {{ __upgradeResponse: true, userData: T, headers: Record<string, string | string[]> | undefined }}
 */
export function upgradeResponse(userData, headers) {
	// Headers are optional. An app that attaches them conditionally
	// (`upgradeResponse(ud, needsRefresh ? h : undefined)`) must not have its
	// upgrade fail for the no-header case, and the runtime already skips the
	// write when there are none.
	assertSafeUpgradeHeaders(headers);
	return { __upgradeResponse: true, userData, headers };
}
