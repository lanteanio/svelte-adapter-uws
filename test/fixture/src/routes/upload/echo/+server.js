// Streams the request body back as the response body, so the body size limit
// can trip after the response has started.
export function POST({ request }) {
	return new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } });
}
