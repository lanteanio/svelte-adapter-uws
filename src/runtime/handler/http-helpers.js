export class PayloadTooLargeError extends Error {
	constructor() { super('Payload too large'); }
}

// Uppercase method lookup - avoids a string allocation from toUpperCase() per SSR request.
// uWS returns lowercase; the Request constructor expects uppercase.
export const METHODS = /** @type {Record<string, string>} */ ({
	get: 'GET', head: 'HEAD', post: 'POST', put: 'PUT',
	delete: 'DELETE', patch: 'PATCH', options: 'OPTIONS'
});

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
