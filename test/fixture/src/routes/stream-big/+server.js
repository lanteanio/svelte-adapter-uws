// A large streamed body in 64 KiB chunks: `?mb=N` megabytes of one repeated
// byte. Big enough that a client reading slowly builds real backpressure on
// the server's socket, which is the only way the chunk writer's drain path
// runs at all. Vary on a request header other than Accept-Encoding so the
// request-dedup leader streams it rather than buffering it; this route is
// about the streaming write, not about sharing.
const CHUNK = new Uint8Array(64 * 1024).fill(0x62);

export function GET({ url }) {
	const mb = Math.min(64, Math.max(1, Number(url.searchParams.get('mb')) || 4));
	const chunks = mb * 16;
	let sent = 0;
	const body = new ReadableStream({
		pull(controller) {
			if (sent < chunks) {
				controller.enqueue(CHUNK);
				sent += 1;
			} else {
				controller.close();
			}
		}
	});
	return new Response(body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(chunks * CHUNK.byteLength),
			'cache-control': 'no-store',
			'vary': 'accept-language'
		}
	});
}
