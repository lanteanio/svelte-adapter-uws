import { WEBSOCKET_VERSION } from '../utils/ws-handshake.js';

const payloadTooLargeErrors = new WeakSet();

export class PayloadTooLargeError extends Error {
	constructor() {
		super('Payload too large');
		payloadTooLargeErrors.add(this);
	}
}

/** @param {unknown} error */
export function isPayloadTooLargeError(error) {
	// Application throws may be revoked proxies or have hostile prototypes.
	return typeof error === 'object' && error !== null && payloadTooLargeErrors.has(error);
}

// Uppercase method lookup - avoids a string allocation from toUpperCase() per SSR request.
// uWS returns lowercase; the Request constructor expects uppercase.
export const METHODS = /** @type {Record<string, string>} */ ({
	get: 'GET', head: 'HEAD', post: 'POST', put: 'PUT',
	delete: 'DELETE', patch: 'PATCH', options: 'OPTIONS'
});

// The fetch specification forbids exactly these three methods, so `new Request()`
// throws a TypeError for them. That throw surfaced as a generic 500 AND emitted a
// full error-severity diagnostic per request, so probing TRACE was a one-line way
// to fill an operator's error log. They can never reach an application route, so
// they are refused at the edge with the status the RFC requires. The list is
// fixed by the specification rather than by what a given Node happens to reject,
// and it is checked only for methods the METHODS map does not carry, so no
// supported method pays for it.
export const FORBIDDEN_METHODS = new Set(['connect', 'trace', 'track']);

// RFC 9110: a 405 response MUST generate an Allow header. These are the methods
// METHODS carries, which is what this adapter can actually deliver to a route.
const ALLOW_HEADER = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Finish a generated response whose payload is a short ASCII text. A HEAD
 * request gets the same status and headers and NO payload: uWS writes whatever
 * `end()` is handed, and a client stops reading a HEAD response at the header
 * terminator (RFC 9112 6.3), so payload bytes written after it sit in the
 * connection buffer and are parsed as the start of the next response on a
 * keep-alive connection. Content-Length still names the entity size, exactly as
 * it does for the GET.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} text ASCII, so its length is its byte length
 * @param {boolean} headOnly
 * @param {boolean} [closeConnection] end the TCP connection with the response,
 *   for a refusal that leaves the connection's remaining bytes untrustworthy
 */
export function endText(res, text, headOnly, closeConnection = false) {
	if (headOnly) res.endWithoutBody(text.length, closeConnection);
	else res.end(text, closeConnection);
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {boolean} [headOnly]
 */
export function send405(res, headOnly = false) {
	res.cork(() => {
		res.writeStatus('405 Method Not Allowed');
		res.writeHeader('allow', ALLOW_HEADER);
		res.writeHeader('content-type', 'text/plain');
		endText(res, 'Method Not Allowed', headOnly);
	});
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {boolean} [headOnly]
 * @param {boolean} [closeConnection] see `endText`
 */
export function send400(res, headOnly = false, closeConnection = false) {
	res.cork(() => {
		res.writeStatus('400 Bad Request');
		res.writeHeader('content-type', 'text/plain');
		// No `connection: close` written here: uWS emits the field itself for a
		// response finished with its close flag, and writing one too puts it on
		// the wire twice.
		endText(res, 'Bad Request', headOnly, closeConnection);
	});
}

/**
 * A WebSocket handshake refused by `webSocketHandshakeRefusal`: 400, or 426
 * naming the version the client should retry with (RFC 6455 4.4).
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {400 | 426} status
 */
export function sendHandshakeRefusal(res, status) {
	if (status === 400) {
		send400(res);
		return;
	}
	res.cork(() => {
		res.writeStatus('426 Upgrade Required');
		res.writeHeader('sec-websocket-version', WEBSOCKET_VERSION);
		res.writeHeader('content-type', 'text/plain');
		res.end('Upgrade Required');
	});
}

/**
 * No HEAD flag: a 413 answers a request body, which a HEAD never carries.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 */
export function send413(res) {
	res.cork(() => {
		res.writeStatus('413 Content Too Large');
		res.writeHeader('content-type', 'text/plain');
		res.end('Content Too Large');
	});
}

/**
 * Finish a response that carries no content, choosing what to say about its
 * length. A 204 never reports one: RFC 9110 8.6 forbids Content-Length there.
 * A 304 reports one only when the app declared it, because the header is
 * permitted on a 304 only when it names the length of the 200's content, and
 * a zero on a 304 for a rendered page is never that. A HEAD is the same
 * case: the header may only name the GET's content length, and the Response
 * carries that only when whoever built it declared it - SvelteKit does for a
 * rendered page, an app answering HEAD itself does by hand - so a HEAD
 * reports the declared length or none. Every other bodyless response names zero, whatever
 * it declared: a length with no bytes behind it would leave the client
 * waiting for them. With no length reported uWS emits neither Content-Length
 * nor Transfer-Encoding.
 *
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {number} status
 * @param {string | null | undefined} declaredLength the response's own
 *   Content-Length header, when it carries one
 * @param {boolean} headOnly the request was a HEAD
 */
export function endBodyless(res, status, declaredLength, headOnly) {
	if (status === 204) res.endWithoutBody();
	else if (status === 304 || headOnly) {
		const length = declaredLength ? parseInt(declaredLength, 10) : NaN;
		if (Number.isSafeInteger(length) && length >= 0) res.endWithoutBody(length);
		else res.endWithoutBody();
	} else res.endWithoutBody(0);
}

/**
 * A network-error Response has status 0, which cannot be written as an HTTP
 * final response. Validate before any application headers or cookies escape.
 *
 * @param {number} status
 */
export function assertResponseStatus(status) {
	if (!(Number.isInteger(status) && status >= 200 && status <= 999)) {
		throw new RangeError('Response has no valid final HTTP status: ' + status);
	}
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} [requestId]
 * @param {boolean} [headOnly]
 */
export function send500(res, requestId, headOnly = false) {
	res.cork(() => {
		res.writeStatus('500 Internal Server Error');
		res.writeHeader('content-type', 'text/plain');
		if (requestId) res.writeHeader('x-request-id', requestId);
		endText(res, 'Internal Server Error', headOnly);
	});
}
