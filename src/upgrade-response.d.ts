/**
 * Wrap an `upgrade` hook's return value so response headers ride the 101
 * Switching Protocols handshake response (e.g. a `Set-Cookie` for session
 * rotation). Return this instead of the bare userData when the handshake
 * needs response headers.
 *
 * Import it from this subpath - a tiny module that pulls in nothing but the
 * shared header-safety predicate - not from the package root (the root is the
 * build-time adapter and would pull build tooling into a runtime bundle):
 *
 * ```js
 * import { upgradeResponse } from 'svelte-adapter-uws/upgrade-response';
 * ```
 *
 * Warning (Cloudflare): attaching `Set-Cookie` to the 101 response is rejected
 * by Cloudflare Tunnel and some other strict edge proxies. The WebSocket opens,
 * then closes with code 1006 before any frames are exchanged. For session-cookie
 * refresh use the `authenticate` hook instead, which refreshes cookies over a
 * normal HTTP response and works behind every proxy. This helper remains
 * supported for non-cookie response headers and for deployments that do not sit
 * behind strict proxies.
 *
 * @example Custom non-cookie headers (safe):
 * ```js
 * import { upgradeResponse } from 'svelte-adapter-uws/upgrade-response';
 *
 * export function upgrade({ cookies }) {
 *   const session = validateSession(cookies.session_id);
 *   if (!session) return false;
 *   return upgradeResponse({ userId: session.userId }, { 'x-session-version': '2' });
 * }
 * ```
 *
 * @template UserData
 * @param userData Data attached to `ws.getUserData()`.
 * @param headers Headers to set on the 101 response. Optional, so headers can be
 * attached conditionally (`upgradeResponse(ud, refresh ? h : undefined)`) without
 * failing the upgrade.
 * @throws {TypeError} when a header name is not a valid RFC 7230 token, a value
 * contains a control character (CR, LF and NUL split or truncate the 101
 * response on the wire; the accepted class is Node's own - tab, printable ASCII
 * and the high range - so a value this helper accepts is one Node and the
 * cookie serializer in this package accept too), or a value is not a string. Validating here rather than at write
 * time is what makes the failure useful: uWS refuses a non-string only after the
 * 101 status line has already been corked, so the client would otherwise be left
 * holding a half-written handshake instead of getting a clean refusal.
 */
export function upgradeResponse<UserData>(
	userData: UserData,
	headers?: Record<string, string | string[]>
): { __upgradeResponse: true; userData: UserData; headers: Record<string, string | string[]> | undefined };
