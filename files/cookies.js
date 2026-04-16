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

const COOKIE_NAME_INVALID = /[\s"(),/:;<=>?@[\\\]{}\u0000-\u001f\u007f]/;
const COOKIE_VALUE_INVALID = /[,;\s\u0000-\u001f\u007f]/;
const VALID_SAMESITE = new Set(['strict', 'lax', 'none']);

/**
 * @typedef {object} CookieSerializeOptions
 * @property {string} [path]
 * @property {string} [domain]
 * @property {Date} [expires]
 * @property {number} [maxAge] - seconds
 * @property {boolean} [httpOnly]
 * @property {boolean} [secure]
 * @property {boolean} [partitioned]
 * @property {'strict' | 'lax' | 'none' | boolean} [sameSite]
 * @property {boolean} [encode] - default true; pass false to skip URI encoding
 */

/**
 * Serialize a cookie name/value/options triple into a Set-Cookie header string.
 * Mirrors the cookie semantics SvelteKit applies via its cookies.set() API so
 * users writing an authenticate hook get the same behavior as in +server.js.
 *
 * @param {string} name
 * @param {string} value
 * @param {CookieSerializeOptions} [options]
 * @returns {string}
 */
export function serializeCookie(name, value, options = {}) {
	if (typeof name !== 'string' || name.length === 0 || COOKIE_NAME_INVALID.test(name)) {
		throw new Error(`Invalid cookie name: '${name}'`);
	}
	const encoded = options.encode === false ? value : encodeURIComponent(value);
	if (COOKIE_VALUE_INVALID.test(encoded)) {
		throw new Error(`Invalid cookie value for '${name}'`);
	}
	let out = name + '=' + encoded;
	if (options.domain !== undefined) out += '; Domain=' + options.domain;
	if (options.path !== undefined) out += '; Path=' + options.path;
	if (options.expires !== undefined) out += '; Expires=' + options.expires.toUTCString();
	if (options.maxAge !== undefined) {
		if (!Number.isFinite(options.maxAge)) {
			throw new Error(`Invalid Max-Age for cookie '${name}': ${options.maxAge}`);
		}
		out += '; Max-Age=' + Math.floor(options.maxAge);
	}
	if (options.httpOnly) out += '; HttpOnly';
	if (options.secure) out += '; Secure';
	if (options.partitioned) out += '; Partitioned';
	if (options.sameSite !== undefined) {
		const raw = options.sameSite === true ? 'strict' : options.sameSite === false ? 'lax' : options.sameSite;
		const normalized = String(raw).toLowerCase();
		if (!VALID_SAMESITE.has(normalized)) {
			throw new Error(`Invalid SameSite for cookie '${name}': ${options.sameSite}`);
		}
		out += '; SameSite=' + normalized[0].toUpperCase() + normalized.slice(1);
	}
	return out;
}

/**
 * Create a SvelteKit-like cookies API for use in the authenticate hook.
 * Reads from the incoming request's Cookie header and accumulates Set-Cookie
 * strings that the caller writes onto the response.
 *
 * @param {string} [cookieHeader] - raw Cookie header from the request
 */
export function createCookies(cookieHeader) {
	const parsed = parseCookies(cookieHeader);
	/** @type {Map<string, string>} keyed by name + path + domain so repeated set() with the same scope overwrites */
	const outgoing = new Map();

	function key(name, path, domain) {
		return name + '\0' + (path || '') + '\0' + (domain || '');
	}

	const api = {
		/** @param {string} name */
		get(name) {
			return parsed[name];
		},
		/** @returns {Record<string, string>} */
		getAll() {
			return { ...parsed };
		},
		/**
		 * @param {string} name
		 * @param {string} value
		 * @param {CookieSerializeOptions} [options]
		 */
		set(name, value, options = {}) {
			outgoing.set(key(name, options.path, options.domain), serializeCookie(name, value, options));
			parsed[name] = value;
		},
		/**
		 * @param {string} name
		 * @param {Pick<CookieSerializeOptions, 'path' | 'domain'>} [options]
		 */
		delete(name, options = {}) {
			api.set(name, '', {
				...options,
				expires: new Date(0),
				maxAge: 0
			});
			delete parsed[name];
		},
		/**
		 * Drain accumulated Set-Cookie headers. Called by the adapter, not the user.
		 * @returns {string[]}
		 */
		_serialize() {
			return [...outgoing.values()];
		}
	};
	return api;
}
