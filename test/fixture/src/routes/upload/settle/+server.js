import { record } from '$lib/probe.js';

// Reads the whole request body and records how that read ended: `rejected`,
// or `resolved:<bytes>`.
export async function POST({ url, request }) {
	const id = url.searchParams.get('id') ?? '';
	record(id, 'entered');
	try {
		const body = await request.arrayBuffer();
		record(id, `resolved:${body.byteLength}`);
		return new Response(String(body.byteLength));
	} catch (error) {
		record(id, 'rejected');
		throw error;
	}
}
