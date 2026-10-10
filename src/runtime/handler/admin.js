import { origin, get_origin, body_size_limit, ADMIN_PATH } from './config.js';
import { METHODS, FORBIDDEN_METHODS, send405, endBodyless } from './http-helpers.js';
import { readBody } from './ssr.js';
import { openRequestSignal, closeRequestSignal } from './state-pool.js';
import { collectRequestHeaders, isFramingHeader } from '../utils/request-headers.js';
import { wsModule } from '../ws-handler-bridge.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

function runAdminHandler(request, res, state, span, headOnly) {
	return Promise.resolve()
		.then(() => wsModule.admin(request))
		.then((response) => {
			if (state.aborted) return;
			if (!(response instanceof Response)) {
				sendAdminError(res, 500, 'internal error', headOnly);
				return;
			}
			return writeAdminResponse(res, response, state, headOnly);
		})
		.catch((err) => {
			try { span?.recordException?.(err); } catch {}
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.admin',
				event: 'admin.handler-failed',
				severity: 'error',
				dataClass: 'pseudonymous',
				message: 'The admin handler failed; the request was answered 500.',
				attributes: { error: diagnosticError(err) }
			});
			if (!state.aborted) sendAdminError(res, 500, 'internal error', headOnly);
		});
}

// Reserved admin / observability route. The app's WebSocket handler may export
// an `admin(request)` function (svelte-realtime's auth-gated introspection
// handler is the canonical one); when present, the adapter mounts it at the
// reserved `/__realtime/*` prefix BEFORE the SSR catch-all so admin traffic
// never hits page routing.
//
// This is pure transport plumbing: it bridges a uWS HTTP request to the
// framework-agnostic Web `Request` -> `Response` contract the app handler
// speaks, and writes the response back. ALL authorization lives in the app
// handler (it is handed the full Request, headers and all, and decides); the
// adapter never inspects or short-circuits the auth decision. A handler that
// throws or rejects yields a generic 500 with no detail leaked to the client.

/**
 * Write a small JSON error body for a transport-level failure (the app handler
 * threw, or the request could not be constructed). The app handler owns all
 * application-level status codes; this only covers the plumbing failing.
 *
 * A HEAD request gets the status and headers and no payload (see
 * `endText` in http-helpers.js for why the bytes must not be written).
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {number} status
 * @param {string} message
 * @param {boolean} [headOnly]
 * @param {boolean} [closeConnection] for a refusal that leaves the
 *   connection's remaining bytes untrustworthy
 */
function sendAdminError(res, status, message, headOnly = false, closeConnection = false) {
	const body = JSON.stringify({ error: message });
	res.cork(() => {
		res.writeStatus(String(status));
		res.writeHeader('content-type', 'application/json');
		res.writeHeader('cache-control', 'no-store');
		res.writeHeader('x-content-type-options', 'nosniff');
		// uWS writes `connection: close` itself for the flag below.
		if (headOnly) res.endWithoutBody(Buffer.byteLength(body), closeConnection);
		else res.end(body, closeConnection);
	});
}

/**
 * Write a Web `Response` back to the uWS response. Admin payloads are small
 * fully-buffered JSON, so the whole body is read into one Buffer and written
 * in a single cork (one syscall) - no streaming/backpressure machinery. A
 * default `x-content-type-options: nosniff` is filled in when the handler did
 * not set one, matching the SSR response writer.
 *
 * A HEAD request takes the handler's headers and the body's length, never its
 * bytes. What a bodyless 204 or 304 says about its length is endBodyless's
 * rule.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {Response} response
 * @param {{ aborted: boolean }} state
 * @param {boolean} [headOnly]
 */
async function writeAdminResponse(res, response, state, headOnly = false) {
	let body = null;
	try {
		if (response.body) body = Buffer.from(await response.arrayBuffer());
	} catch {
		if (!state.aborted) sendAdminError(res, 500, 'internal error', headOnly);
		return;
	}
	if (state.aborted) return;
	res.cork(() => {
		res.writeStatus(String(response.status));
		let hasContentTypeOptions = false;
		for (const [key, value] of response.headers) {
			// Framing belongs to this writer; set-cookie is
			// emitted via getSetCookie() so multiple cookies are not folded.
			if (key === 'content-length' || key === 'transfer-encoding' || key === 'set-cookie' || key === 'date') continue;
			if (key === 'x-content-type-options') hasContentTypeOptions = true;
			res.writeHeader(key, value);
		}
		if (!hasContentTypeOptions) res.writeHeader('x-content-type-options', 'nosniff');
		for (const cookie of response.headers.getSetCookie()) {
			res.writeHeader('set-cookie', cookie);
		}
		if (body && body.byteLength) {
			if (headOnly) res.endWithoutBody(body.byteLength);
			else res.end(body);
		} else {
			endBodyless(res, response.status, response.headers.get('content-length'), headOnly);
		}
	});
}

let mounted = false;

/**
 * Record that the admin route was actually registered. Called by the route
 * registration itself rather than recomputing its condition, so the two cannot
 * disagree about whether the prefix is reserved on this instance.
 */
export function markAdminRouteMounted() {
	mounted = true;
}

/**
 * Is the admin route mounted? The main request edge asks before refusing a
 * target that resolves into the prefix: without the mount both spellings reach
 * the app anyway, so there is no lane for them to disagree about.
 *
 * @returns {boolean}
 */
export function adminRouteMounted() {
	return mounted;
}

/**
 * uWS handler for the reserved `/__realtime/*` route. Reads the request off the
 * stack-allocated `req` synchronously, builds a Web `Request`, hands it to the
 * app's `admin(request)` handler, and writes the resulting `Response` back.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {import('uWebSockets.js').HttpRequest} req
 */
export function handleAdminRequest(res, req) {
	// === SYNCHRONOUS PHASE ===
	// uWS HttpRequest is stack-allocated - read everything before any await.
	const method = req.getMethod();
	const pathname = req.getUrl();
	const query = req.getQuery();
	// Same refusal as the main request edge: this route builds a Request too, so
	// a forbidden method would throw here for the same reason.
	const mapped = METHODS[method];
	if (mapped === undefined && FORBIDDEN_METHODS.has(method)) return send405(res);
	const METHOD = mapped || method.toUpperCase();
	// uWS routes HEAD to this `any` mount like every other method; every write
	// below takes this so the payload stays off the wire for it.
	const headOnly = METHOD === 'HEAD';

	// Repeated header lines are merged per header class. A repeated framing /
	// identity header cannot be merged into one meaning, and the admin handler
	// authorizes off these headers, so an ambiguous one is refused here rather
	// than handed on as whichever line happened to arrive last.
	/** @type {Record<string, string>} */
	const headers = {};
	const ambiguousHeader = collectRequestHeaders(req, headers);
	if (ambiguousHeader !== null) {
		sendAdminError(res, 400, 'bad request', headOnly, isFramingHeader(ambiguousHeader));
		return;
	}

	// Shared abort flag, mandatory uWS pattern: set onAborted before any async
	// work so an aborted request never writes to a freed response.
	const state = { aborted: false, bodyReceived: false, failBody: null };
	/** @type {AbortController | null} */
	let controller = null;
	// Aborted as the SSR lane aborts it: on a disconnect before the body arrived.
	res.onAborted(() => { state.aborted = true; state.failBody?.(); if (!state.bodyReceived) controller?.abort(); });

	// `get_origin` derives the base origin from the Host (and proxy) headers
	// when ORIGIN is unset - the zero-config default. It throws on a missing /
	// malformed Host (or PROTOCOL/PORT header), which a client can trivially
	// trigger, so it MUST be guarded: an unguarded throw here escapes the uWS
	// callback as an unhandled synchronous exception (the request would hang).
	// A usable origin is the client's responsibility, so this is a 400.
	let base_origin;
	try {
		base_origin = origin || get_origin(headers);
	} catch {
		if (!state.aborted) sendAdminError(res, 400, 'bad request', headOnly);
		return;
	}
	const url = query ? `${pathname}?${query}` : pathname;

	// The route matched the RAW path, and building a Request NORMALIZES dot
	// segments. So `/__realtime/../reflect` matches `/__realtime/*`, reaches
	// this handler, and hands the app's `admin()` a request whose pathname is
	// `/reflect` - a path outside the prefix that was routed, and outside the
	// namespace the handler's own dispatch and authorization are written
	// against. The path that was ROUTED and the path the handler is TOLD about
	// have to be the same one; when normalization moves it out of the prefix
	// the request is ambiguous, and it is refused rather than resolved in
	// either party's favour.
	//
	// Parsed once here and reused for the Request below, so the comparison
	// costs no extra allocation on a route that is cold by construction. Before
	// the body is read, too: an ambiguous request should not stream one first.
	// A percent-encoded `..%2f` is NOT a segment separator and normalizes to
	// nothing, so it keeps the prefix and passes here, as it should.
	let parsed;
	try {
		parsed = new URL(base_origin + url);
	} catch {
		if (!state.aborted) sendAdminError(res, 400, 'bad request', headOnly);
		return;
	}
	if (ADMIN_PATH !== false &&
		parsed.pathname !== ADMIN_PATH &&
		!parsed.pathname.startsWith(ADMIN_PATH + '/')) {
		if (!state.aborted) sendAdminError(res, 400, 'bad request', headOnly);
		return;
	}

	// GET/HEAD carry no body; other methods stream through readBody under the
	// global body-size cap (the admin router may grow POST endpoints). A
	// declared Content-Length over the cap is refused early with 413 before any
	// body is read, mirroring the SSR handler.
	let contentLengthHint = NaN;
	if (METHOD !== 'GET' && METHOD !== 'HEAD') {
		const cl = parseInt(headers['content-length'], 10);
		if (!isNaN(cl)) {
			if (body_size_limit !== Infinity && cl > body_size_limit) {
				if (!state.aborted) sendAdminError(res, 413, 'payload too large');
				return;
			}
			contentLengthHint = cl;
		}
	}
	const body = (METHOD === 'GET' || METHOD === 'HEAD')
		? undefined
		: readBody(res, body_size_limit, state, contentLengthHint);

	// Opened here, past every early answer above, so a request refused before
	// it reaches the handler never registers one.
	controller = openRequestSignal();
	let request;
	try {
		request = new Request(parsed, {
			method: METHOD,
			headers,
			body,
			signal: controller.signal,
			// @ts-expect-error - duplex is required when a body stream is attached
			duplex: 'half'
		});
	} catch {
		closeRequestSignal(controller);
		if (!state.aborted) sendAdminError(res, 400, 'bad request', headOnly);
		return;
	}

	// === ASYNC PHASE ===
	// Resolve through Promise.resolve so a synchronous throw inside the app
	// handler is caught here too, not just a rejected promise.
	const opened = controller;
	if (!tracingEnabled) {
		void runAdminHandler(request, res, state, null, headOnly).finally(() => closeRequestSignal(opened));
		return;
	}
	traceOperation('adapter.http.admin', {
		kind: 'server',
		parent: extractTraceContext(headers),
		attributes: { 'http.request.method': METHOD, 'http.route.type': 'admin' }
	}, (span) => runAdminHandler(request, res, state, span, headOnly).finally(() => closeRequestSignal(opened)));
}
