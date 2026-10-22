import { gate, record } from '$lib/probe.js';

// A body that records when its source is cancelled. `?mode=respond` holds the
// endpoint at the `?id=` gate before it returns, then returns a body that
// never produces a chunk; `?mode=never` returns that body at once;
// `?mode=idle` returns at once with two chunks and then produces nothing more.
export async function GET({ url }) {
	const id = url.searchParams.get('id') ?? '';
	const mode = url.searchParams.get('mode');
	record(id, 'entered');
	if (mode === 'respond') await gate(id);
	return new Response(
		new ReadableStream({
			start(controller) {
				if (mode === 'idle') {
					controller.enqueue(new TextEncoder().encode('idle;'));
					controller.enqueue(new TextEncoder().encode('idle;'));
				}
			},
			cancel() {
				record(id, 'cancelled');
			}
		}),
		{ headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } }
	);
}
