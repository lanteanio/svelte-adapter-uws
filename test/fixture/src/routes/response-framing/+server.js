const states = new Map();
export async function GET({ url }) {
	const mode = url.searchParams.get('mode');
	const id = url.searchParams.get('id');
	if (mode === 'stats') {
		const state = states.get(id);
		return Response.json(state ? { pulls: state.pulls, cancelled: state.cancelled } : null);
	}
	if (mode === 'release') { states.get(id)?.release(); return new Response('released'); }
	if (mode === 'head') {
		let release;
		const pending = new Promise(resolve => { release = resolve; });
		const state = { pulls: 0, cancelled: false, release };
		states.set(id, state);
		const body = new ReadableStream({
			async pull(controller) {
				state.pulls++;
				await pending;
				if (!state.cancelled) { controller.enqueue(new Uint8Array(123).fill(120)); controller.close(); }
			},
			cancel() { state.cancelled = true; release(); }
		}, { highWaterMark: 0 });
		return new Response(body, { headers: { 'content-length': '123', 'content-type': 'text/plain' } });
	}
	const upstream = url.searchParams.get('upstream');
	return upstream ? fetch(upstream) : new Response('relay response', { headers: { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' } });
}
export const POST = GET;
