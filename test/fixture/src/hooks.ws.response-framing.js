function response(upstream) {
	return upstream ? fetch(upstream) : new Response('relay response', { headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' } });
}
export function authenticate({ headers }) { return response(headers['x-framing-upstream']); }
export function admin(request) { return response(request.headers.get('x-framing-upstream')); }
