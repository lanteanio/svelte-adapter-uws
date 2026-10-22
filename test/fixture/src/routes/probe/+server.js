import { records, release } from '$lib/probe.js';

// `?id=X` reads the lifecycle records of X; `&release=1` releases its gate first.
export function GET({ url }) {
	const id = url.searchParams.get('id') ?? '';
	if (url.searchParams.has('release')) release(id);
	return Response.json(records(id), { headers: { 'cache-control': 'no-store' } });
}
