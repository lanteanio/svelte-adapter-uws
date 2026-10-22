import { gate, record } from '$lib/probe.js';

// An event stream whose first event waits for the test to release `?id=`;
// each render is recorded.
export function GET({ url }) {
	const id = url.searchParams.get('id') ?? '';
	record(id, 'rendered');
	return new Response(
		new ReadableStream({
			async start(controller) {
				await gate(id);
				controller.enqueue(new TextEncoder().encode('data: open\n\n'));
			}
		}),
		{ headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } }
	);
}
