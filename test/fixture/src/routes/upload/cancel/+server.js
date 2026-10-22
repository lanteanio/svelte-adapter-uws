// Stops reading the request body and answers at once, as an upload size check
// that stops early does: after one chunk, or `?read=0` without reading any.
export async function POST({ url, request }) {
	if (url.searchParams.get('read') === '0') {
		await request.body.cancel();
		return new Response('stopped');
	}
	const reader = request.body.getReader();
	await reader.read();
	await reader.cancel();
	return new Response('stopped');
}
