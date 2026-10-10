// Exercise app-owned Responses through SvelteKit and the built HTTP writer.
function answer({ url }) {
	if (url.searchParams.get('error') === '1') return Response.error();
	const status = Number(url.searchParams.get('status') || 304);
	const headers = { 'x-response-probe': '1' };
	if (url.searchParams.has('date')) headers.date = url.searchParams.get('date');
	if (url.searchParams.has('length')) headers['content-length'] = url.searchParams.get('length');
	return new Response(url.searchParams.get('body') === '1' ? 'body for HEAD' : null, { status, headers });
}
export const GET = answer;
export const HEAD = answer;
