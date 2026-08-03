import { counters, staticCache } from './state.js';
import { METHODS, send400 } from './http-helpers.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { acquireState, releaseState } from './state-pool.js';
import { resolveTransportAddress } from './config.js';
import { serveStatic, tryPrerendered } from './static-assets.js';
import { handleSSR } from './ssr.js';
import { requestDone } from './lifecycle.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';

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
	// Minimum work: 1 Map lookup + 4 header reads. No header collection,
	// no query string handling, no remoteAddress decode.
	const staticFile = staticCache.get(pathname);
	if (staticFile && (method === 'get' || method === 'head')) {
		if (!tracingEnabled) {
			return serveStatic(
				res, staticFile,
				req.getHeader('accept-encoding'),
				req.getHeader('if-none-match'),
				method === 'head',
				req.getHeader('range'),
				req.getHeader('if-range')
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
			req.getHeader('if-range')
		));
	}

	// Windows: reject paths with : (Alternate Data Streams) or ~ (8.3 short names)
	if (process.platform === 'win32' && (pathname.includes(':') || pathname.includes('~'))) {
		return send400(res);
	}

	// Build full URL only for SSR - static files never reach here
	const query = req.getQuery();
	const METHOD = METHODS[method] || method.toUpperCase();

	// === PRERENDERED CHECK ===
	// Lightweight: only 4 header reads, no full collection, no remoteAddress decode
	if (METHOD === 'GET' || METHOD === 'HEAD') {
		const served = tracingEnabled
			? traceOperation('adapter.http.prerendered', {
				kind: 'server',
				parent: requestTraceContext(req),
				attributes: { 'http.request.method': METHOD, 'http.route.type': 'prerendered' }
			}, () => tryPrerendered(res, pathname, query ? `?${query}` : '',
				req.getHeader('accept-encoding'), req.getHeader('if-none-match'), METHOD === 'HEAD',
				req.getHeader('range'), req.getHeader('if-range')))
			: tryPrerendered(res, pathname, query ? `?${query}` : '',
				req.getHeader('accept-encoding'), req.getHeader('if-none-match'), METHOD === 'HEAD',
				req.getHeader('range'), req.getHeader('if-range'));
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
