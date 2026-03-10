/**
 * Parse cookies from a Cookie header string.
 * @param {string} [cookieHeader]
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
	/** @type {Record<string, string>} */
	const cookies = {};
	if (!cookieHeader) return cookies;
	for (const pair of cookieHeader.split(';')) {
		const eq = pair.indexOf('=');
		if (eq !== -1) {
			const value = pair.substring(eq + 1).trim();
			// Strip RFC 6265 optional quotes
			const unquoted = value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"'
				? value.slice(1, -1) : value;
			try {
				cookies[pair.substring(0, eq).trim()] = decodeURIComponent(unquoted);
			} catch {
				cookies[pair.substring(0, eq).trim()] = unquoted;
			}
		}
	}
	return cookies;
}
