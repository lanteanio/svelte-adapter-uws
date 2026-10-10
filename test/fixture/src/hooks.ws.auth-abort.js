const reads = new Map();

export async function authenticate({ request, headers }) {
	const id = headers['x-body-probe'];
	if (headers['x-body-status'] === '1') return Response.json(reads.get(id) ?? null);
	const method = headers['x-body-reader'];
	if (!method) return {};
	const state = { started: true, settled: false, rejected: false };
	reads.set(id, state);
	try {
		const value = await request[method]();
		state.value = method === 'formData' ? Object.fromEntries(value) : value;
		return Response.json(state.value);
	} catch (error) {
		state.rejected = true;
		state.error = error.message;
		throw error;
	} finally {
		state.settled = true;
	}
}
