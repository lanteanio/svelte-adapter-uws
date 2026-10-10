import { counters, staticCache } from './state.js';
import { METHODS, FORBIDDEN_METHODS, send400, send405 } from './http-helpers.js';
import { collectRequestHeaders, isFramingHeader } from '../utils/request-headers.js';
import { acquireState, releaseState, openRequestSignal, closeRequestSignal } from './state-pool.js';
import { resolveTransportAddress, ADMIN_PATH } from './config.js';
import { serveStatic, tryPrerendered, encodedStaticEntry } from './static-assets.js';
import { handleSSR } from './ssr.js';
import { requestDone } from './lifecycle.js';
import { adminRouteMounted } from './admin.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { windowsReservedPath } from '../utils/windows-path.js';
import { invalidRequestTarget } from '../utils/request-target.js';
import { entersExactMount } from './route-registry.js';

// Read once: the platform does not change under a running process.
const WINDOWS = process.platform === 'win32';

// What makes the URL parser drop a segment of a raw path: a dot segment, a
// `%2e` in any case (a dot segment spelled encoded), and the backslash a
// special scheme reads as a separator. The whitespace it strips never gets
// this far: the target check refuses it first. A dot inside a name, as in
// `/__data.json`, changes nothing, so such a path skips the URL parse. See the
// resolution checks below, which are its only readers.
const DROPS_SEGMENT = /(?:^|\/)\.\.?(?:\/|$)|\\|%2e/i;

// An escape of an ASCII character, which is all a reachable prefix or exact
// mount is made of: uWS matches a mount on the raw target, and a target
// carrying anything but visible ASCII is refused before it is routed. Decoding
// only these reads every escape that could spell such a mount and cannot
// throw, as a decoder for the whole of UTF-8 does on an escape it cannot read.
const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;
/** @param {string} _ @param {string} hex */
const asciiFromEscape = (_, hex) => String.fromCharCode(parseInt(hex, 16));

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

	// A Transfer-Encoding naming anything but chunked was already refused for
	// every route, this one included, by the wrapper the registrations go
	// through. What that ONE lookup cannot see is a framing header sent EMPTY
	// or sent TWICE: a lookup answers the empty string for an absent header and
	// for an empty one alike, and returns the first of a repeat. Both are
	// refused where the whole header set is read, which the SSR lane below does
	// and the static and prerendered answers between here and there do not.
	//
	// That line is priced in bench/39-request-framing-guard-ab.mjs against the
	// built static lane: walking the header list - the only way to see an empty
	// or repeated one - costs about 8% of that answer, where a lookup form
	// costs at most a few percent and measured inside the control arm's own
	// drift on the quietest host tried. Every asset request would pay the walk,
	// forever. Doing the walk INSTEAD of the lane's own seven lookups, reading
	// all nine values in one pass, costs the same - bench/41 put it at about
	// 9.5% - so the lookups are not what makes the walk expensive.

	const pathname = req.getUrl();
	const query = req.getQuery();

	// Two things RFC 9112 does not allow in a target, refused in the path and
	// the query on every lane - the built asset below included: a byte outside
	// visible ASCII and a fragment. uWS hands raw bytes over as decoded
	// characters, where node's parser refuses them, and keeps a `#` in the path
	// it routes on, so `/healthz#frag` would miss the probe and reach the app's
	// router truncated. bench/40 put the query read and the scan inside the
	// noise of a built-asset answer.
	if (invalidRequestTarget(pathname, query)) return send400(res, method === 'head');

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
	// The scans decide almost every request for free, and what bounds them is
	// that a path can arrive in the prefix only by DROPPING a segment - a dot
	// segment (`.`, `..`, or either spelled with `%2e`) or a backslash (a path
	// separator for a special scheme, so `..\` and `\` both count) - or by
	// SPELLING one of the prefix's own characters percent-encoded (`%`).
	// Everything else the parser rewrites only lengthens a segment or encodes
	// a character the prefix does not contain, and the whitespace it strips
	// and the `#` it truncates at are refused by the target check above.
	//
	// The adapter's EXACT mounts - the probes, the auth path, the waiting-room
	// pages, the WebSocket path where a ceiling answers its GETs - are routed
	// on the raw target the same way, so `/x/../healthz` misses the health
	// route and would reach the app's router as `/healthz`, and so would
	// `/healthz/__data.json`, which SvelteKit answers for the path in front of
	// the suffix. A target that resolves, decodes or strips onto one of them
	// without being spelled as it is refused here too.
	if (entersExactMount(pathname, pathname, query)) return send400(res, METHOD === 'HEAD');
	const dropsSegment = DROPS_SEGMENT.test(pathname);
	if (dropsSegment || pathname.includes('%')) {
		let resolved = pathname;
		if (dropsSegment) {
			// Pathname resolution does not depend on the authority, so this uses
			// a fixed base rather than deriving the request's own origin (which
			// reads proxy headers and can throw). Concatenated, not passed as a
			// base, so a `//host` target resolves as a path and not as an
			// authority.
			try { resolved = new URL(RESOLUTION_BASE + pathname).pathname; } catch { /* read as sent */ }
		}
		const guardsPrefix = ADMIN_PREFIX !== null && adminRouteMounted() && !pathname.startsWith(ADMIN_PREFIX);
		if (entersExactMount(resolved, pathname, query)) return send400(res, METHOD === 'HEAD');
		if (guardsPrefix && resolved.startsWith(ADMIN_PREFIX)) return send400(res, METHOD === 'HEAD');
		if (resolved.includes('%')) {
			// Decoded the STRONGER way, `%2F` included, rather than the router's
			// gentler decode, because the two lanes below disagree: the
			// prerendered lookup decodes `%2F`, while SvelteKit's router leaves it
			// encoded. Decoding the stronger way covers both - anything the router
			// would place inside the prefix lands there under this reading too -
			// and what it refuses beyond the router's reading is exactly a target
			// spelling the reserved prefix with an encoded separator, which no app
			// path needs. An escape nothing can decode stays as it is, so a
			// target ending in one is still judged by the rest of its spelling:
			// SvelteKit answers such a path 400 itself, but only after the app's
			// `handle` hook has run on it.
			const decodedPath = resolved.replace(ASCII_ESCAPE, asciiFromEscape);
			if (entersExactMount(decodedPath, pathname, query)) return send400(res, METHOD === 'HEAD');
			if (guardsPrefix && decodedPath.startsWith(ADMIN_PREFIX)) return send400(res, METHOD === 'HEAD');
		}
	}

	// On Windows, only an exact indexed asset may carry a reserved filesystem
	// spelling such as a tilde. This lookup reads an in-memory key, never an
	// alternate stream or an 8.3 alias. Keep it after the mount guards above:
	// decoding a file name must not enter an adapter-owned namespace.
	let reservedFile;
	if (WINDOWS && windowsReservedPath(pathname)) {
		if ((METHOD === 'GET' || METHOD === 'HEAD') && pathname.includes('%')) {
			reservedFile = encodedStaticEntry(pathname);
		}
		if (reservedFile === undefined) return send400(res, METHOD === 'HEAD');
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

		// A static file whose name a browser percent-encodes, asked for that way:
		// the fast path above matched the target as sent. Traced as the static
		// answer it is, and only when there is a file to serve.
		const encodedFile = reservedFile ?? (pathname.includes('%') ? encodedStaticEntry(pathname) : undefined);
		if (encodedFile !== undefined) {
			if (!tracingEnabled) {
				return serveStatic(
					res, encodedFile,
					req.getHeader('accept-encoding'),
					req.getHeader('if-none-match'),
					METHOD === 'HEAD',
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
				attributes: { 'http.request.method': METHOD, 'http.route.type': 'static' }
			}, () => serveStatic(
				res, encodedFile,
				req.getHeader('accept-encoding'),
				req.getHeader('if-none-match'),
				METHOD === 'HEAD',
				req.getHeader('range'),
				req.getHeader('if-range'),
				req.getHeader('if-match'),
				req.getHeader('if-unmodified-since'),
				req.getHeader('if-modified-since')
			));
		}
	}

	const url = query ? `${pathname}?${query}` : pathname;

	// Full header collection - only for SSR paths. Repeated lines are merged per
	// header class; a repeated framing / identity header is ambiguous rather than
	// mergeable, and the request dies here instead of reaching the app with one
	// of two possible meanings.
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguousHeader = collectRequestHeaders(req, headers);
	if (ambiguousHeader !== null) {
		return send400(res, METHOD === 'HEAD', isFramingHeader(ambiguousHeader));
	}

	// Decode remote address eagerly - uWS may reuse the underlying buffer.
	// `effective` applies the opt-in PROXY-protocol substitution; `direct` is
	// always the socket peer and decides ADDRESS_HEADER trust downstream.
	const { direct: directAddress, effective: remoteAddress } = resolveTransportAddress(res);

	// Set onAborted BEFORE any async work (mandatory uWS pattern).
	// readBody reads the state flag directly; the controller is the one the
	// application's `request.signal` comes from, aborted here when the client
	// goes away before its request body has arrived in full, as SvelteKit's
	// Node adapter does - a form action that has its data finishes what it
	// started. Only the SSR lane pays for it - every lane above answered
	// without one.
	const state = acquireState();
	const controller = openRequestSignal();
	state.signal = controller.signal;
	res.onAborted(() => {
		state.aborted = true;
		state.failBody?.();
		if (!state.bodyReceived) controller.abort();
	});

	// === ASYNC PHASE: SSR ===
	counters.inFlightCount++;
	handleSSR(res, METHOD, url, headers, remoteAddress, state, directAddress)
		.finally(() => { closeRequestSignal(controller); releaseState(state); requestDone(); });
}
