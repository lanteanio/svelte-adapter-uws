let cancelled = 0;
let finished = false;
let renders = 0;
const text = 'Grüße '.repeat(400);
const bytes = Uint8Array.of(17, 34, 51, 68, 85, 102, 119, 136);

export async function GET({ url }) {
	const shape = url.searchParams.get('shape') || 'bytes';
	if (shape === 'stats') return Response.json({ cancelled, finished, renders });
	renders++;
	if (url.searchParams.has('defer')) await new Promise(resolve => setTimeout(resolve, 30));
	if (shape === 'large') {
		finished = false;
		let sent = 0;
		return new Response(new ReadableStream({
			async pull(controller) {
				if (sent === 34) {
					await new Promise(resolve => setTimeout(resolve, 400));
				}
				if (sent++ < 40) controller.enqueue('ü'.repeat(8192));
				else { finished = true; controller.close(); }
			}
		}), { headers: { 'content-type': 'text/plain' } });
	}
	if (shape === 'number' || shape === 'object') {
		let timer;
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(shape === 'number' ? 42 : {});
				timer = setTimeout(() => controller.close(), 400);
			},
			cancel() { clearTimeout(timer); cancelled++; }
		}));
	}
	const values = shape === 'string' ? [text]
		: shape === 'buffer' ? [bytes.buffer]
			: shape === 'views' ? [new DataView(bytes.buffer, 1, 3), new Uint16Array(bytes.buffer, 4, 2)]
				: [bytes];
	return new Response(new ReadableStream({
		start(controller) {
			for (const value of values) controller.enqueue(value);
			controller.close();
		}
	}), { headers: { 'content-type': shape === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream' } });
}
export const POST = GET;
