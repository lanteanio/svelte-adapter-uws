/**
 * Wrap upgrade hook return value to include response headers on the 101
 * Switching Protocols response (e.g. Set-Cookie for session refresh).
 *
 * @template T
 * @param {T} userData - Data attached to ws.getUserData()
 * @param {Record<string, string | string[]>} headers - Headers for the 101 response
 * @returns {{ __upgradeResponse: true, userData: T, headers: Record<string, string | string[]> }}
 */
export function upgradeResponse(userData, headers) {
	return { __upgradeResponse: true, userData, headers };
}
