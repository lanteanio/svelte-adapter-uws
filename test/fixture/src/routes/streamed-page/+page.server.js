import { gate } from '$lib/ssr-stream-gates.js';
export function load({ url }) {
	const state = gate(url.searchParams.get('id'));
	return { slow: state.pending.then(() => { state.finished = true; return 'resolved page'; }) };
}
