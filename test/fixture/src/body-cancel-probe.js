export async function cancelBodyProbe(request) {
	const mode = request.headers.get('x-cancel-mode');
	const state = { entered: true, cancelled: false, cancel: null, finish: null };
	const probes = globalThis.__cancelBodyProbes ??= new Map();
	probes.set('active', state);
	await new Promise((resolve) => { state.cancel = resolve; });
	if (mode === 'reader') {
		const reader = request.body.getReader();
		await reader.read();
		await reader.cancel();
	} else if (mode === 'iterator') {
		for await (const _chunk of request.body) break;
	} else await request.body.cancel();
	state.cancelled = true;
	await new Promise((resolve) => { state.finish = resolve; });
	return new Response('cancelled');
}
