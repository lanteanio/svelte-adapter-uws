// A Response with no body: `?status=` picks the status, `?cl=` a
// Content-Length it declares anyway.
export function GET({ url }) {
	const status = Number(url.searchParams.get('status')) || 200;
	const cl = url.searchParams.get('cl');
	return new Response(null, { status, headers: cl ? { 'content-length': cl } : {} });
}
