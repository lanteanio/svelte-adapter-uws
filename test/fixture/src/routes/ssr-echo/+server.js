// Pipes the request body straight back. Under a small BODY_SIZE_LIMIT the
// limit trips while the echo is already streaming, so the response reader
// rejects mid-body with the payload error - the shape that must abort the
// exchange rather than write a 413 into it as a second response.
// No vary opt-out is needed here: request deduplication applies only to GET
// and HEAD, so a POST body pipe always takes the streaming write path.
export function POST({ request }) {
	return new Response(request.body, {
		headers: {
			'content-type': 'application/octet-stream',
			'cache-control': 'no-store'
		}
	});
}
