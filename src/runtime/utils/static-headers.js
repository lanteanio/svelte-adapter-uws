/**
 * Header names the static file handler manages itself, which `staticHeaders`
 * must not override. These are written per-response by serveStatic
 * (`content-type`, `content-encoding`, `content-range`, `date`), set by uWS
 * from the body (`content-length`), a conditional-request validator (`etag`,
 * and `last-modified`, which the date preconditions answer from the file's
 * real modification time), or correctness-sensitive caching/negotiation
 * headers whose value depends on
 * the specific asset (`cache-control` differs for immutable vs mutable assets;
 * `vary` must keep `Accept-Encoding` so compressed variants cache correctly;
 * `accept-ranges` advertises the range support the handler actually
 * implements). `staticHeaders` may ADD any other header - CSP, HSTS,
 * X-Frame-Options, Referrer-Policy, Permissions-Policy, custom `x-*` headers -
 * and may override the adapter's own default `x-content-type-options`.
 * @type {Set<string>}
 */
/**
 * The `content-disposition` value for a downloadable asset, with the filename
 * made safe for the quoted-string it is going into.
 *
 * The quote and the backslash would end or escape that quoted-string. The
 * CONTROL characters matter more and were not being stripped: a filename is
 * legal on POSIX with a newline in it, and a newline written into a header
 * ends the field on the wire - the rest of the name then lands as further
 * headers, or, after a blank line, as a second response body. A build shipping
 * a file named that way is unusual, which is precisely why nothing else caught
 * it.
 *
 * It lives here rather than at its one call site so a test can drive THIS
 * rather than a copy: the rule used to be inline in the static handler, which
 * imports the build's manifest placeholder and therefore cannot be imported by
 * a unit test, so the suite re-implemented the rule and every case passed
 * against its own version while the shipped line went unpinned.
 *
 * @param {string} basename
 * @returns {string}
 */
export function contentDispositionValue(basename) {
	return `attachment; filename="${basename.replace(/[\u0000-\u001f\u007f"\\]/g, '')}"`;
}

export const RESERVED_STATIC_HEADER_KEYS = new Set([
	'content-type',
	'content-encoding',
	'content-range',
	'content-length',
	'date',
	'etag',
	'last-modified',
	'vary',
	'cache-control',
	'accept-ranges'
]);

/**
 * Merge user-configured static response headers into a static entry's
 * precomputed header tuples. Runs once per file at index time (not per
 * request), so the per-request serveStatic write loop is unchanged.
 *
 * User keys are lowercased; reserved keys (see `RESERVED_STATIC_HEADER_KEYS`)
 * are skipped so they can never break transfer / caching / conditional-request
 * correctness. A non-reserved key that already exists in the base tuples (e.g.
 * the default `x-content-type-options`) is replaced in place - user intent wins
 * - and a new key is appended. Returns a new array; the input is not mutated.
 *
 * @param {[string, string][]} baseHeaders - precomputed entry header tuples (lowercased keys)
 * @param {Record<string, string> | null | undefined} staticHeaders
 * @returns {[string, string][]}
 */
export function mergeStaticHeaders(baseHeaders, staticHeaders) {
	if (!staticHeaders) return baseHeaders;
	/** @type {[string, string][]} */
	const merged = baseHeaders.map((t) => [t[0], t[1]]);
	for (const rawKey of Object.keys(staticHeaders)) {
		const key = rawKey.toLowerCase();
		if (RESERVED_STATIC_HEADER_KEYS.has(key)) continue;
		const value = String(staticHeaders[rawKey]);
		const idx = merged.findIndex((t) => t[0] === key);
		if (idx >= 0) merged[idx][1] = value;
		else merged.push([key, value]);
	}
	return merged;
}

/**
 * Resolve a prevalidated custom Cache-Control value for one build output path.
 * Paths are relative to the configured SvelteKit base. A trailing slash is a
 * directory-tree selector; any other pattern is an exact asset selector.
 *
 * @param {string} relPath - slash-separated path relative to the indexed directory
 * @param {{ pattern: string, cacheControl: string }[] | null | undefined} rules
 * @returns {string}
 */
export function resolveStaticCacheControl(relPath, rules) {
	if (!rules?.length) return '';
	const assetPath = relPath[0] === '/' ? relPath : `/${relPath}`;
	let best = '';
	let bestLength = -1;
	for (let index = 0; index < rules.length; index++) {
		const { pattern, cacheControl } = rules[index];
		const matches = pattern.endsWith('/')
			? assetPath.startsWith(pattern)
			: assetPath === pattern;
		if (matches && pattern.length > bestLength) {
			best = cacheControl;
			bestLength = pattern.length;
		}
	}
	return best;
}
