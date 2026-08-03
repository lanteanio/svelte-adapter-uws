import { origin, get_origin, body_size_limit } from './config.js';
import { METHODS } from './http-helpers.js';
import { readBody } from './ssr.js';
import { collectRequestHeaders } from '../utils/request-headers.js';
import { wsModule } from '../ws-handler-bridge.js';
import { extractTraceContext, traceOperation, tracingEnabled } from '../tracing.js';
import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';

function runAdminHandler(request, res, state, span) {
	return Promise.resolve()
		.then(() => wsModule.admin(request))
		.then((response) => {
			if (state.aborted) return;
			if (!(response instanceof Response)) {
				sendAdminError(res, 500, 'internal error');
				return;
			}
			return writeAdminResponse(res, response, state);
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
			if (!state.aborted) sendAdminError(res, 500, 'internal error');
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
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendAdminError(res, status, message) {
	res.cork(() => {
		res.writeStatus(String(status));
		res.writeHeader('content-type', 'application/json');
		res.writeHeader('cache-control', 'no-store');
		res.writeHeader('x-content-type-options', 'nosniff');
		res.end(JSON.stringify({ error: message }));
	});
}

/**
 * Write a Web `Response` back to the uWS response. Admin payloads are small
 * fully-buffered JSON, so the whole body is read into one Buffer and written
 * in a single cork (one syscall) - no streaming/backpressure machinery. A
 * default `x-content-type-options: nosniff` is filled in when the handler did
 * not set one, matching the SSR response writer.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {Response} response
 * @param {{ aborted: boolean }} state
 */
async function writeAdminResponse(res, response, state) {
	let body = null;
	try {
		if (response.body) body = Buffer.from(await response.arrayBuffer());
	} catch {
		if (!state.aborted) sendAdminError(res, 500, 'internal error');
		return;
	}
	if (state.aborted) return;
	res.cork(() => {
		res.writeStatus(String(response.status));
		let hasContentTypeOptions = false;
		for (const [key, value] of response.headers) {
			// content-length is implied by the body we write; set-cookie is
			// emitted via getSetCookie() so multiple cookies are not folded.
			if (key === 'content-length' || key === 'set-cookie') continue;
			if (key === 'x-content-type-options') hasContentTypeOptions = true;
			res.writeHeader(key, value);
		}
		if (!hasContentTypeOptions) res.writeHeader('x-content-type-options', 'nosniff');
		for (const cookie of response.headers.getSetCookie()) {
			res.writeHeader('set-cookie', cookie);
		}
		if (body && body.byteLength) res.end(body);
		else res.endWithoutBody(0);
	});
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
	const METHOD = METHODS[method] || method.toUpperCase();

	// Repeated header lines are merged per header class. A repeated framing /
	// identity header cannot be merged into one meaning, and the admin handler
	// authorizes off these headers, so an ambiguous one is refused here rather
	// than handed on as whichever line happened to arrive last.
	/** @type {Record<string, string>} */
	const headers = {};
	if (collectRequestHeaders(req, headers) !== null) {
		sendAdminError(res, 400, 'bad request');
		return;
	}

	// Shared abort flag, mandatory uWS pattern: set onAborted before any async
	// work so an aborted request never writes to a freed response.
	const state = { aborted: false };
	res.onAborted(() => { state.aborted = true; });

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
		if (!state.aborted) sendAdminError(res, 400, 'bad request');
		return;
	}
	const url = query ? `${pathname}?${query}` : pathname;

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

	let request;
	try {
		request = new Request(base_origin + url, {
			method: METHOD,
			headers,
			body,
			// @ts-expect-error - duplex is required when a body stream is attached
			duplex: 'half'
		});
	} catch {
		if (!state.aborted) sendAdminError(res, 400, 'bad request');
		return;
	}

	// === ASYNC PHASE ===
	// Resolve through Promise.resolve so a synchronous throw inside the app
	// handler is caught here too, not just a rejected promise.
	if (!tracingEnabled) {
		void runAdminHandler(request, res, state, null);
		return;
	}
	traceOperation('adapter.http.admin', {
		kind: 'server',
		parent: extractTraceContext(headers),
		attributes: { 'http.request.method': METHOD, 'http.route.type': 'admin' }
	}, (span) => runAdminHandler(request, res, state, span));
}
