import { gate } from '$lib/probe.js';

// Two 64 KiB chunks at once, then a source failure once the test releases
// `?id=`: a read error after the response has started, as a proxied upstream
// that resets mid-body produces.
const CHUNK = new Uint8Array(64 * 1024).fill(0x66);

export function GET({ url }) {
	const id = url.searchParams.get('id') ?? '';
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(CHUNK);
				controller.enqueue(CHUNK);
			},
			async pull(controller) {
				await gate(id);
				controller.error(new Error('source failed mid-body'));
			}
		}),
		{ headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } }
	);
}
