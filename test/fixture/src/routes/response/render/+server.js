import { gate, record } from '$lib/probe.js';

let renders = 0;

// Records each render of `?id=` and holds it at that id's gate, then answers
// with a body that names the render, so two responses that share one render
// carry the same body.
export async function GET({ url }) {
	const id = url.searchParams.get('id') ?? '';
	const n = ++renders;
	record(id, 'rendered');
	await gate(id);
	return new Response(`render ${n}`, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
}
