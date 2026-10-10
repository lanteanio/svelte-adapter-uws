import { gate, streamGates } from '$lib/ssr-stream-gates.js';
const encoder = new TextEncoder();
const text = 'ready finite body '.repeat(400);
export async function GET({ url, request }) {
	const mode = url.searchParams.get('mode');
	const id = url.searchParams.get('id');
	if (mode === 'stats') {
		const state = streamGates.get(id);
		return Response.json(state ? { started: state.started, finished: state.finished, cancelled: state.cancelled, locked: state.body?.locked } : { started: false });
	}
	if (mode === 'release') { streamGates.get(id)?.release(); return new Response('released'); }
	if (request.method === 'POST') await request.arrayBuffer();
	if (mode === 'bytes') return new Response(encoder.encode(text), { headers: { 'content-type': 'text/plain' } });
	if (mode === 'blob') return new Response(new Blob([text], { type: 'text/plain' }));
	if (mode === 'transforms') {
		const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(text)); c.close(); } });
		return new Response(body.pipeThrough(new TransformStream()).pipeThrough(new TransformStream()), { headers: { 'content-type': 'text/plain' } });
	}
	const state = gate(id);
	const body = new ReadableStream({
		start(controller) {
			if (mode === 'turns') {
				controller.enqueue(encoder.encode('shell\n'));
				let remaining = 10000;
				const next = () => {
					if (state.cancelled) return;
					controller.enqueue(encoder.encode('x'));
					if (--remaining) setImmediate(next);
					else { state.finished = true; state.release(); controller.close(); }
				};
				setImmediate(next);
				return;
			}
			if (mode !== 'never-first') controller.enqueue(encoder.encode('shell\n'));
			state.pending.then(() => {
				if (state.cancelled) return;
				if (mode !== 'close') controller.enqueue(encoder.encode('resolved\n'));
				state.finished = true; controller.close();
			});
		},
		cancel() { state.cancelled = true; state.release(); if (mode === 'cancelhang') return new Promise(() => {}); }
	});
	state.body = body;
	return new Response(body, { headers: { 'content-type': (mode === 'sse' || mode === 'cancelhang') ? 'text/event-stream' : 'text/plain' } });
}
export const POST = GET;
