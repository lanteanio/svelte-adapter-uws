// A Response that carries framing and Date headers of its own, as a proxied
// `fetch()` Response does from its upstream.
export function GET() {
	return new Response('x'.repeat(2000), {
		headers: {
			'content-type': 'text/plain',
			'transfer-encoding': 'chunked',
			date: 'Mon, 01 Jan 2024 00:00:00 GMT'
		}
	});
}
