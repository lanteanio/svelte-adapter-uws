/**
 * Parse cookies from a Cookie header string.
 *
 * Backed by `Object.create(null)` so the returned bag has no
 * `Object.prototype` chain. A request with a `__proto__=evil` cookie
 * would otherwise stamp a property on the prototype of the returned
 * `{}`; downstream `cookies.toString` / `cookies.constructor` lookups
 * could then read attacker-controlled values. Returning a null-proto
 * bag closes that prototype-pollution surface at the parse boundary.
 *
 * @param {string} [cookieHeader]
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
	/** @type {Record<string, string>} */
	const cookies = Object.create(null);
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
// Path / Domain attribute values share the cookie-value CHAR class:
// no CTLs (CR/LF would enable response-splitting), no `;` (would close
// the attribute and enable smuggling), no `,` (some servers split
// Set-Cookie on commas), no whitespace, no DEL. Attacker-influenced
// `path` / `domain` strings reach this check before flowing into the
// Set-Cookie header.
const COOKIE_ATTR_INVALID = /[,;\s\u0000-\u001f\u007f]/;
const VALID_SAMESITE = new Set(['strict', 'lax', 'none']);

/**
 * The public contract (`src/index.d.ts` CookieSerializeOptions) requires
 * `path` on `cookies.set()` / `.delete()`; that requirement is enforced by
 * `createCookies`. This internal shape leaves `path` optional because
 * `serializeCookie` is the low-level attribute serializer shared by both.
 *
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
 * `createCookies()` applies the SvelteKit defaults and required-path contract
 * before calling this attribute serializer.
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
	if (options.domain !== undefined) {
		if (typeof options.domain !== 'string' || COOKIE_ATTR_INVALID.test(options.domain)) {
			throw new Error(`Invalid Domain attribute for cookie '${name}'`);
		}
	}
	if (options.path !== undefined) {
		if (typeof options.path !== 'string' || COOKIE_ATTR_INVALID.test(options.path)) {
			throw new Error(`Invalid Path attribute for cookie '${name}'`);
		}
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
	if (options.sameSite !== undefined && options.sameSite !== false) {
		const raw = options.sameSite === true ? 'strict' : options.sameSite;
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
 * The request URL is REQUIRED, exactly as in SvelteKit's own cookie factory:
 * the `Secure` default and relative `Path` resolution are both derived from
 * it. A fallback default here was a fail-open shape - a caller that forgot
 * the argument silently produced session cookies without `Secure`.
 *
 * @param {string | undefined} cookieHeader - raw Cookie header from the request
 * @param {string | URL} requestUrl - request URL; drives the Secure default
 *   and resolves relative cookie paths
 */
export function createCookies(cookieHeader, requestUrl) {
	if (requestUrl === undefined || requestUrl === null || requestUrl === '') {
		throw new Error(
			'createCookies requires the request URL: the Secure default and ' +
			'relative Path resolution are derived from it'
		);
	}
	const parsed = parseCookies(cookieHeader);
	const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
	/** @type {CookieSerializeOptions} */
	const defaults = {
		httpOnly: true,
		sameSite: 'lax',
		secure: !(url.hostname === 'localhost' && url.protocol === 'http:')
	};
	/** @type {Map<string, string>} keyed by name + path + domain so repeated set() with the same scope overwrites */
	const outgoing = new Map();

	function key(name, path, domain) {
		return name + '\0' + (path || '') + '\0' + (domain || '');
	}

	/** @param {CookieSerializeOptions | undefined} options */
	function requirePath(options) {
		if (options?.path === undefined) {
			throw new Error('You must specify a `path` when setting or deleting cookies');
		}
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
		 * @param {CookieSerializeOptions & { path: string }} options
		 */
		set(name, value, options) {
			requirePath(options);
			const resolved = { ...defaults, ...options };
			// SvelteKit resolves a relative path against the request URL
			// before serializing; without this, `Path=sub` reaches the
			// browser, which discards it for the RFC 6265 default path -
			// a silent scope change from what the caller asked for.
			if (typeof resolved.path === 'string' && resolved.path[0] !== '/') {
				resolved.path = new URL(resolved.path, url).pathname;
			}
			outgoing.set(key(name, resolved.path, resolved.domain), serializeCookie(name, value, resolved));
			parsed[name] = value;
		},
		/**
		 * @param {string} name
		 * @param {CookieSerializeOptions & { path: string }} options
		 */
		delete(name, options) {
			requirePath(options);
			api.set(name, '', {
				...options,
				expires: new Date(0), // determinism-allow: fixed Unix-epoch sentinel that forces immediate cookie deletion, not a wall-clock read
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
