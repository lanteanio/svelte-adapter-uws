export class PayloadTooLargeError extends Error {
	constructor() { super('Payload too large'); }
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

/** @param {import('uWebSockets.js').HttpResponse} res */
export function send405(res) {
	res.cork(() => {
		res.writeStatus('405 Method Not Allowed');
		res.writeHeader('allow', ALLOW_HEADER);
		res.writeHeader('content-type', 'text/plain');
		res.end('Method Not Allowed');
	});
}

/** @param {import('uWebSockets.js').HttpResponse} res */
export function send400(res) {
	res.cork(() => {
		res.writeStatus('400 Bad Request');
		res.writeHeader('content-type', 'text/plain');
		res.end('Bad Request');
	});
}

/** @param {import('uWebSockets.js').HttpResponse} res */
export function send413(res) {
	res.cork(() => {
		res.writeStatus('413 Content Too Large');
		res.writeHeader('content-type', 'text/plain');
		res.end('Content Too Large');
	});
}

/**
 * @param {import('uWebSockets.js').HttpResponse} res
 * @param {string} [requestId]
 */
export function send500(res, requestId) {
	res.cork(() => {
		res.writeStatus('500 Internal Server Error');
		res.writeHeader('content-type', 'text/plain');
		if (requestId) res.writeHeader('x-request-id', requestId);
		res.end('Internal Server Error');
	});
}
