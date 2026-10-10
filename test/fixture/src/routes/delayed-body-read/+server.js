// The test sends multiple chunks while the route is suspended. Releasing the
// hold schedules a timer, so body reading begins on a later event-loop turn.
export async function POST({ request, url }) {
	const id = url.searchParams.get('id');
	const states = globalThis.__delayedBodyReads ??= new Map();
	const state = { reading: false, release: null };
	states.set(id, state);
	await new Promise((resolve) => {
		state.release = () => setTimeout(resolve, 20);
	});
	state.reading = true;
	return new Response(await request.arrayBuffer(), {
		headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
	});
}
