/**
 * @typedef {Object} OriginCheckContext
 * @property {'*' | 'same-origin' | string[]} allowedOrigins
 * @property {string} [hostHeader]    - lowercased name of a HOST_HEADER env override (e.g. 'x-forwarded-host')
 * @property {string} [protocolHeader] - lowercased name of a PROTOCOL_HEADER env override
 * @property {string} [portHeader]    - lowercased name of a PORT_HEADER env override
 * @property {string} [pinnedOrigin]  - URL-normalized ORIGIN env value (url.origin); when set, the
 *                                      same-origin branch compares the request Origin against this
 *                                      pin instead of the attacker-controlled Host header
 * @property {boolean} isTls          - true when running under SSLApp
 * @property {boolean} hasUpgradeHook - true when the user supplied an upgrade handler (used to decide whether to accept Origin-less clients)
 */

/**
 * Decide whether a WebSocket upgrade request's Origin should be accepted
 * under the configured policy.
 *
 * Returns `true` when:
 *   - allowedOrigins is '*' (wildcard accepts everything)
 *   - the request has no Origin header AND an upgrade hook is configured
 *     (the hook can authenticate non-browser clients itself)
 *   - allowedOrigins is 'same-origin' AND the Origin matches the pinned
 *     ORIGIN env (`ctx.pinnedOrigin`, URL-normalized scheme+host+port) when
 *     one is configured, else the request's host (PROTOCOL_HEADER /
 *     HOST_HEADER / PORT_HEADER overrides applied; default ports stripped
 *     to allow port-omitted Host comparisons)
 *   - allowedOrigins is an array AND the Origin is a member
 *
 * Returns `false` otherwise. Malformed Origin headers (URL parse failure)
 * are rejected.
 *
 * Pure with respect to inputs - no I/O, no globals, no module state. The
 * env-driven header-name overrides and TLS state are passed via `ctx` so
 * the function is unit-testable and benchable.
 *
 * @param {string | undefined} reqOrigin - The request's Origin header value, if any
 * @param {Record<string, string>} headers - All request headers (lowercased keys)
 * @param {OriginCheckContext} ctx
 * @returns {boolean}
 */
export function isOriginAllowed(reqOrigin, headers, ctx) {
	if (ctx.allowedOrigins === '*') return true;
	if (!reqOrigin) return ctx.hasUpgradeHook;
	if (ctx.allowedOrigins === 'same-origin') {
		try {
			const parsed = new URL(reqOrigin);
			// A configured ORIGIN env is the authoritative pin (the deployment's
			// canonical public origin): compare against it and never against the
			// Host header, which a non-browser client controls. Both sides are
			// URL-normalized (url.origin = scheme://host:port, default port
			// omitted) so the comparison is exact.
			if (ctx.pinnedOrigin) return parsed.origin === new URL(ctx.pinnedOrigin).origin;
			const requestHost = (ctx.hostHeader && headers[ctx.hostHeader]) || headers['host'];
			if (!requestHost) return false;
			const requestScheme = ctx.protocolHeader
				? (headers[ctx.protocolHeader] || (ctx.isTls ? 'https' : 'http'))
				: (ctx.isTls ? 'https' : 'http');
			// Merge PORT_HEADER into the host the same way get_origin() does,
			// so proxies that split host/port across headers still match.
			const requestPort = ctx.portHeader ? headers[ctx.portHeader] : undefined;
			let expectedHost = requestHost;
			if (requestPort) {
				expectedHost = requestHost.replace(/:\d+$/, '') + ':' + requestPort;
			}
			// Strip the default port so "example.com" matches "example.com:443"
			// (URL.host omits the port when it is the default for the scheme).
			// Anchored to the end: an unanchored strip would eat the ':80' inside
			// 'example.com:8080'.
			const defaultPort = requestScheme === 'https' ? '443' : '80';
			expectedHost = expectedHost.replace(new RegExp(':' + defaultPort + '$'), '');
			return parsed.host === expectedHost && parsed.protocol === requestScheme + ':';
		} catch {
			return false;
		}
	}
	if (Array.isArray(ctx.allowedOrigins)) return ctx.allowedOrigins.includes(reqOrigin);
	return false;
}

/**
 * CSRF defense for the authenticate POST endpoint. The endpoint accepts
 * session cookies and runs the user's `authenticate` hook (which may refresh
 * cookies, write audit log entries, or bump per-user rate-limit counters).
 * Without an origin-side guard, an attacker page from a third-party origin
 * can issue a credentialed `fetch(..., { credentials: 'include' })` and the
 * victim's cookie rides along, executing those side effects on the victim's
 * behalf.
 *
 * Returns `true` when at least one of the following holds:
 *   - `x-requested-with: XMLHttpRequest` is present. Cross-origin browsers
 *     cannot forge custom headers without first passing a CORS preflight,
 *     and this endpoint never approves one. The adapter client always
 *     stamps this header on its preflight POST.
 *   - `Sec-Fetch-Site: same-origin` is present. Modern browsers stamp this
 *     header on every navigation/fetch automatically; it cannot be forged
 *     from script.
 *   - `Origin` is present and matches the configured `allowedOrigins`
 *     policy via the same logic the WebSocket upgrade uses (see
 *     `isOriginAllowed`). `hasUpgradeHook` is forced false so a missing
 *     `Origin` header is always rejected here, even when the upgrade-side
 *     check would have accepted it (the upgrade hook authenticates
 *     non-browser clients itself; this endpoint must not).
 *
 * Apps that need to accept this endpoint from native (non-browser) clients
 * without these headers can opt out at the call site.
 *
 * @param {Record<string, string | undefined>} headers - request headers (lowercased keys)
 * @param {OriginCheckContext} originCtx - same shape consumed by `isOriginAllowed`
 * @returns {boolean}
 */
export function isAuthOriginAccepted(headers, originCtx) {
	const xrw = (headers['x-requested-with'] || '').toLowerCase();
	if (xrw === 'xmlhttprequest') return true;
	const sfs = (headers['sec-fetch-site'] || '').toLowerCase();
	if (sfs === 'same-origin') return true;
	return isOriginAllowed(headers['origin'], /** @type {Record<string, string>} */ (headers), {
		allowedOrigins: originCtx.allowedOrigins,
		hostHeader: originCtx.hostHeader,
		protocolHeader: originCtx.protocolHeader,
		portHeader: originCtx.portHeader,
		pinnedOrigin: originCtx.pinnedOrigin,
		isTls: originCtx.isTls,
		hasUpgradeHook: false
	});
}

/**
 * @typedef {Object} SafeOriginConfigInput
 * @property {string | string[]} allowedOrigins - resolved value (default 'same-origin')
 * @property {boolean} hasOriginEnv             - true when ORIGIN env is set
 * @property {boolean} hasHostHeader            - true when HOST_HEADER env is set
 * @property {boolean} isTls                    - true when running under SSLApp
 * @property {boolean} hasUpgradeHook           - true when the user supplied an upgrade handler
 * @property {boolean} optOut                   - explicit opt-out for the misconfig case
 */

/**
 * Detect the misconfig "same-origin policy on a public-internet listener
 * with no fronting trust." When `allowedOrigins` is `'same-origin'`, the
 * server compares the request's `Origin` header to its `Host` header. If
 * the deployment terminates TLS itself (SSL_CERT) OR sits behind a proxy
 * that pins those values via a fixed `ORIGIN` env or a trusted
 * `HOST_HEADER`, the comparison is meaningful. Without any of those, both
 * inputs are attacker-controlled and the comparison passes for any
 * non-browser scripted client. When a user `upgrade` hook is present, that
 * hook is the real authentication boundary and the misconfig is harmless;
 * otherwise it leaves the WebSocket fully open.
 *
 * Returns `null` when the configuration is safe. Returns a human-readable
 * error message describing the missing pieces when the misconfig is
 * detected and `optOut` is false. Callers throw the message at startup so
 * the misconfig cannot reach production unnoticed.
 *
 * @param {SafeOriginConfigInput} input
 * @returns {string | null}
 */
export function describeUnsafeSameOriginConfig(input) {
	if (input.allowedOrigins !== 'same-origin') return null;
	if (input.hasOriginEnv || input.hasHostHeader || input.isTls || input.hasUpgradeHook) return null;
	if (input.optOut) return null;
	return (
		"WebSocket upgrade is configured with allowedOrigins: 'same-origin' but " +
		'no host pin is in place: ORIGIN env unset, HOST_HEADER env unset, no ' +
		'SSL_CERT/SSL_KEY for native TLS, and no upgrade() hook to authenticate ' +
		'non-browser clients. The same-origin check then compares two ' +
		'attacker-controlled headers (Origin vs Host) and trivially passes for ' +
		'any non-browser scripted client. Resolve with one of:\n' +
		'  - SSL_CERT + SSL_KEY for native TLS (no proxy needed)\n' +
		'  - ORIGIN=https://example.com (behind a TLS proxy)\n' +
		'  - PROTOCOL_HEADER=x-forwarded-proto + HOST_HEADER=x-forwarded-host (flexible proxy)\n' +
		'  - export an upgrade() hook from hooks.ws.{js,ts} that authenticates the connection itself\n' +
		'  - allowedOrigins: [...] with an explicit allowlist\n' +
		"Apps that have audited this and want the previous warn-only behavior can pass " +
		'`websocket.unsafeSameOriginWithoutHostPin: true` in svelte.config.js.'
	);
}
