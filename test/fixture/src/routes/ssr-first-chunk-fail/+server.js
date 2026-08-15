// A response whose body source fails before its first byte exists. The
// runtime has written nothing yet, so this failure can and must be answered
// with a real error response carrying the request id.
export function GET() {
	const body = new ReadableStream({
		start(controller) {
			controller.error(new Error('ssr pre-body probe fault'));
		}
	});
	// Vary keeps the request-dedup leader from buffering this response, so the
	// failure is met inside the write path's own pre-streaming read rather
	// than in the dedup buffer - the site the error entry documents.
	return new Response(body, {
		headers: {
			'content-type': 'text/plain',
			'cache-control': 'no-store',
			'vary': 'accept-language'
		}
	});
}
