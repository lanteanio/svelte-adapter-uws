// A response whose body source fails after several chunks have streamed. The
// headers and early chunks are on the wire under the app's own status, so no
// error response is possible any more - the runtime must abort the exchange
// rather than end it cleanly, because a clean EOF on a partial body reads as
// a complete response.
const encoder = new TextEncoder();

export function GET() {
	let sent = 0;
	const body = new ReadableStream({
		async pull(controller) {
			if (sent < 3) {
				controller.enqueue(encoder.encode(`chunk-${sent}:${'x'.repeat(1024)}\n`));
				sent += 1;
				return;
			}
			// The delay keeps the failure mid-stream under any pumping
			// strategy: an eager pipe that drains the source ahead of the
			// client-facing writes would otherwise surface the error before
			// the first chunk leaves, turning this into a pre-body failure.
			await new Promise((resolve) => setTimeout(resolve, 150));
			controller.error(new Error('ssr mid-stream probe fault'));
		}
	});
	// Vary on a request header other than Accept-Encoding: the response is
	// personalized, so the request-dedup leader must not buffer it - buffering
	// would await the source's failure and answer 500 before any byte moved,
	// which is the OTHER half of the failure story. This route exists for the
	// streaming half.
	return new Response(body, {
		headers: {
			'content-type': 'text/plain',
			'cache-control': 'no-store',
			'vary': 'accept-language'
		}
	});
}
