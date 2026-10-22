// An event stream that never ends: one event at once, then one every 100 ms
// until the stream is cancelled.
export function GET() {
	let timer;
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode('data: open\n\n'));
				timer = setInterval(() => controller.enqueue(encoder.encode('data: tick\n\n')), 100);
			},
			cancel() {
				clearInterval(timer);
			}
		}),
		{ headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } }
	);
}
