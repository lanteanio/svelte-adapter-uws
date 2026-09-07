// A body served the way a public asset route serves a first-time visitor: no
// Vary, no Set-Cookie, so an uncredentialed GET is dedup-eligible and the
// leader path runs. The chunks up to `?after=N` go out at once and the rest
// follows after a pause of `?delay=` ms, so a client can tell a leader that
// streams (bytes before the pause ends) from one that holds the whole body
// before writing a byte. `?kb=N` sets the size; the default sits past the
// 512 KiB sharing cap. `?declare=1` adds a Content-Length, the shape a file
// route has. `?renders=1` answers how many bodies this worker has produced.
const CHUNK = new Uint8Array(64 * 1024).fill(0x63);
let renders = 0;

export function GET({ url }) {
	const kb = Math.max(64, Number(url.searchParams.get('kb')) || 1024);
	const delay = Math.max(0, Number(url.searchParams.get('delay')) || 400);
	const after = Math.max(1, Number(url.searchParams.get('after')) || 10);
	if (url.searchParams.has('renders')) {
		return new Response(String(renders), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
	}
	renders += 1;
	const chunks = Math.ceil(kb / 64);
	let sent = 0;
	const body = new ReadableStream({
		async pull(controller) {
			if (sent === after) await new Promise((resolve) => setTimeout(resolve, delay));
			if (sent < chunks) {
				controller.enqueue(CHUNK);
				sent += 1;
			} else {
				controller.close();
			}
		}
	});
	const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' };
	if (url.searchParams.has('declare')) headers['content-length'] = String(chunks * CHUNK.byteLength);
	return new Response(body, { headers });
}
