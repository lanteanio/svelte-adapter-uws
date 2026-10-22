// A body whose chunks are all ready at once and that declares no length:
// `?kb=N` KiB in 16 KiB chunks.
export function GET({ url }) {
	const chunks = Math.max(1, Math.round((Number(url.searchParams.get('kb')) || 48) / 16));
	return new Response(
		new ReadableStream({
			start(controller) {
				for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(16 * 1024).fill(0x72));
				controller.close();
			}
		}),
		{ headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } }
	);
}
