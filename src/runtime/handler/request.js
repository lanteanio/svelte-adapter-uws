import { counters, staticCache } from './state.js';
import { METHODS, FORBIDDEN_METHODS, send400, send405 } from './http-helpers.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { acquireState, releaseState } from './state-pool.js';
import { resolveTransportAddress, ADMIN_PATH } from './config.js';
import { serveStatic, tryPrerendered } from './static-assets.js';
import { handleSSR } from './ssr.js';
import { requestDone } from './lifecycle.js';
import { adminRouteMounted } from './admin.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';

// Characters through which a raw path can reach a DIFFERENT path than the one
// spelled: dot segments in either spelling, the backslash a special scheme
// reads as a separator, the whitespace the URL parser strips, and the percent
// that lets a segment spell any character at all. See the admin-prefix check
// below, which is the only reader.
const MAY_RESOLVE = /[.%\\\t\n\r]/;

// Any authority works: the check compares pathnames, which resolve the same
// under all of them.
const RESOLUTION_BASE = 'http://a';

// The reserved namespace as the MOUNT matches it, derived once. `null` when no
// prefix is configured, so the check is one comparison away from off.
const ADMIN_PREFIX = ADMIN_PATH === false ? null : ADMIN_PATH + '/';

function requestTraceContext(req) {
	return extractTraceContext({
		traceparent: req.getHeader('traceparent'),
		tracestate: req.getHeader('tracestate')
	});
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {import('uWebSockets.js').HttpRequest} req
 */
export function handleRequest(res, req) {
	// === SYNCHRONOUS PHASE ===
	// uWS HttpRequest is stack-allocated - MUST read everything before any await.
	// uWS returns lowercase method; we use lowercase comparisons on the fast path
	// and only the METHODS lookup for SSR where the Request constructor expects it.
	const method = req.getMethod();
	const pathname = req.getUrl();

	// === STATIC FILE FAST PATH ===
	// Minimum work: 1 Map lookup + 7 header reads (negotiation, the entity
	// and date validators, range). No header collection, no query string
	// handling, no remoteAddress decode.
	const staticFile = staticCache.get(pathname);
	if (staticFile && (method === 'get' || method === 'head')) {
		if (!tracingEnabled) {
			return serveStatic(
				res, staticFile,
				req.getHeader('accept-encoding'),
				req.getHeader('if-none-match'),
				method === 'head',
				req.getHeader('range'),
				req.getHeader('if-range'),
				req.getHeader('if-match'),
				req.getHeader('if-unmodified-since'),
				req.getHeader('if-modified-since')
			);
		}
		return traceOperation('adapter.http.static', {
			kind: 'server',
			parent: requestTraceContext(req),
			attributes: { 'http.request.method': method, 'http.route.type': 'static' }
		}, () => serveStatic(
			res, staticFile,
			req.getHeader('accept-encoding'),
			req.getHeader('if-none-match'),
			method === 'head',
			req.getHeader('range'),
			req.getHeader('if-range'),
			req.getHeader('if-match'),
			req.getHeader('if-unmodified-since'),
			req.getHeader('if-modified-since')
		));
	}

	// Windows: reject paths with : (Alternate Data Streams) or ~ (8.3 short names)
	if (process.platform === 'win32' && (pathname.includes(':') || pathname.includes('~'))) {
		return send400(res);
	}

	// Build full URL only for SSR - static files never reach here
	const query = req.getQuery();
	// One map lookup, exactly as before, for every method this adapter carries.
	// Only a method the map does not know pays the forbidden-set check, so the
	// hot path is unchanged.
	const mapped = METHODS[method];
	if (mapped === undefined && FORBIDDEN_METHODS.has(method)) return send405(res);
	const METHOD = mapped || method.toUpperCase();

	// The lane is chosen from the RAW target - uWS matches the request line as
	// sent - while every lane below reads a DIFFERENT spelling of it: the SSR
	// Request resolves the path, and both the prerendered lookup and SvelteKit's
	// own router percent-decode it before matching. So a target spelled outside
	// the reserved admin prefix can still ARRIVE inside it, two ways:
	//
	//   /foo/../__realtime/introspect   resolution drops a segment
	//   /%5f%5frealtime/introspect      decoding spells the prefix
	//
	// Neither matches the mount, so both fall through to the app's own routing
	// inside the namespace the adapter reserves and mounts ahead of page
	// routing. That is the mirror of the escape the admin lane refuses, and it
	// is refused the same way rather than rerouted: a target routed as one path
	// and read as another is ambiguous, and resolving it INTO the admin lane
	// would let a caller reach that lane through a spelling a fronting proxy's
	// ACL does not read as admin.
	//
	// Only while the admin route is actually mounted. The mount is what
	// reserves the prefix; without it both spellings reach the app regardless,
	// and refusing one of them would take away a path the app is serving.
	//
	// AHEAD OF THE PRERENDERED LOOKUP, because that lookup decodes too: a
	// prerendered page inside the prefix would otherwise be served for the
	// encoded spelling before this ever ran. The static fast path above needs no
	// such care - it matches the raw pathname against built asset keys, and an
	// encoded spelling matches none of them.
	//
	// `ADMIN_PREFIX` carries the trailing slash because that is the mount's own
	// test: uWS routes `/__realtime/` and below to the admin lane and leaves the
	// bare prefix on the catch-all, so treating the bare prefix as reserved here
	// would refuse a resolved target whose direct spelling is served.
	//
	// The scan decides almost every request for free, and what bounds it to
	// these five characters is that a path can arrive in the prefix only by
	// DROPPING a segment - a dot segment (`.`, or `%2e`), a backslash (a path
	// separator for a special scheme, so `..\` and `\` both count), or one of
	// the whitespace characters the URL parser strips - or by SPELLING one of
	// the prefix's own characters percent-encoded (`%`). Everything else the
	// parser rewrites only lengthens a segment, and a `#` truncates without
	// touching the head, so neither can carry a target into a prefix its raw
	// form was outside of.
	if (ADMIN_PREFIX !== null && adminRouteMounted() && MAY_RESOLVE.test(pathname) &&
		!pathname.startsWith(ADMIN_PREFIX)) {
		try {
			// Pathname resolution does not depend on the authority, so this uses
			// a fixed base rather than deriving the request's own origin (which
			// reads proxy headers and can throw). Concatenated, not passed as a
			// base, so a `//host` target resolves as a path and not as an
			// authority.
			const resolved = new URL(RESOLUTION_BASE + pathname).pathname;
			if (resolved.startsWith(ADMIN_PREFIX)) return send400(res);
			// Decoded the STRONGER way, with `decodeURIComponent` rather than the
			// router's gentler decode, because the two lanes below disagree: the
			// prerendered lookup decodes this way, while SvelteKit's router
			// leaves `%2F` encoded. Decoding the stronger way covers both -
			// anything the router would place inside the prefix lands there
			// under this reading too - and what it refuses beyond the router's
			// reading is exactly a target spelling the reserved prefix with an
			// encoded separator, which no app path needs.
			//
			// A target neither call can parse is left to the lanes below, which
			// read the same characters and answer for them there; the only
			// decision made here is the prefix one.
			if (resolved.includes('%') && decodeURIComponent(resolved).startsWith(ADMIN_PREFIX)) {
				return send400(res);
			}
		} catch { /* not a path this check can rule on */ }
	}

	// === PRERENDERED CHECK ===
	// Lightweight: only 7 header reads, no full collection, no remoteAddress decode
	if (METHOD === 'GET' || METHOD === 'HEAD') {
		const served = tracingEnabled
			? traceOperation('adapter.http.prerendered', {
				kind: 'server',
				parent: requestTraceContext(req),
				attributes: { 'http.request.method': METHOD, 'http.route.type': 'prerendered' }
			}, () => tryPrerendered(res, pathname, query ? `?${query}` : '',
				req.getHeader('accept-encoding'), req.getHeader('if-none-match'), METHOD === 'HEAD',
				req.getHeader('range'), req.getHeader('if-range'),
				req.getHeader('if-match'), req.getHeader('if-unmodified-since'), req.getHeader('if-modified-since')))
			: tryPrerendered(res, pathname, query ? `?${query}` : '',
				req.getHeader('accept-encoding'), req.getHeader('if-none-match'), METHOD === 'HEAD',
				req.getHeader('range'), req.getHeader('if-range'),
				req.getHeader('if-match'), req.getHeader('if-unmodified-since'), req.getHeader('if-modified-since'));
		if (served) {
			return;
		}
	}

	const url = query ? `${pathname}?${query}` : pathname;

	// Full header collection - only for SSR paths. Repeated lines are merged per
	// header class; a repeated framing / identity header is ambiguous rather than
	// mergeable, and the request dies here instead of reaching the app with one
	// of two possible meanings.
	/** @type {Record<string, string>} */
	const headers = {};
	if (collectRequestHeaders(req, headers) !== null) return send400(res);

	// Decode remote address eagerly - uWS may reuse the underlying buffer.
	// `effective` applies the opt-in PROXY-protocol substitution; `direct` is
	// always the socket peer and decides ADDRESS_HEADER trust downstream.
	const { direct: directAddress, effective: remoteAddress } = resolveTransportAddress(res);

	// Set onAborted BEFORE any async work (mandatory uWS pattern).
	// No AbortController here - readBody uses the state flag directly,
	// avoiding 4-5 object allocations (controller + signal + event target)
	// on every request. GET/HEAD requests (majority of traffic) never
	// need an AbortController at all.
	const state = acquireState();
	res.onAborted(() => {
		state.aborted = true;
	});

	// === ASYNC PHASE: SSR ===
	counters.inFlightCount++;
	handleSSR(res, METHOD, url, headers, remoteAddress, state, directAddress)
		.finally(() => { releaseState(state); requestDone(); });
}
