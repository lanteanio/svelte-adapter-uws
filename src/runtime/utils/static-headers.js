/**
 * Header names the static file handler manages itself, which `staticHeaders`
 * must not override. These are written per-response by serveStatic
 * (`content-type`, `content-encoding`, `content-range`, `date`), set by uWS
 * from the body (`content-length`), a conditional-request validator (`etag`),
 * or correctness-sensitive caching/negotiation headers whose value depends on
 * the specific asset (`cache-control` differs for immutable vs mutable assets;
 * `vary` must keep `Accept-Encoding` so compressed variants cache correctly;
 * `accept-ranges` advertises the range support the handler actually
 * implements). `staticHeaders` may ADD any other header - CSP, HSTS,
 * X-Frame-Options, Referrer-Policy, Permissions-Policy, custom `x-*` headers -
 * and may override the adapter's own default `x-content-type-options`.
 * @type {Set<string>}
 */
export const RESERVED_STATIC_HEADER_KEYS = new Set([
	'content-type',
	'content-encoding',
	'content-range',
	'content-length',
	'date',
	'etag',
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
