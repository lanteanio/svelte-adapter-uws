import { gate } from '$lib/probe.js';

// The page streams a promise that settles when the test releases `?id=`.
export function load({ url }) {
	const id = url.searchParams.get('id') ?? '';
	return { later: gate(id).then(() => 'released value') };
}
