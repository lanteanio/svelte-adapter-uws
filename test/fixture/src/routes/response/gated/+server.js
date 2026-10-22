import { gate } from '$lib/probe.js';

// One chunk at once, the rest after the test releases `?id=`: a streamed body
// whose second chunk waits on I/O. The first chunk is a string and the second
// an ArrayBuffer, both of which a stream may carry.
export function GET({ url }) {
	const id = url.searchParams.get('id') ?? '';
	let sent = false;
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue('first;');
			},
			async pull(controller) {
				if (sent) return;
				sent = true;
				await gate(id);
				controller.enqueue(new TextEncoder().encode('second').buffer);
				controller.close();
			}
		}),
		{ headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }
	);
}
