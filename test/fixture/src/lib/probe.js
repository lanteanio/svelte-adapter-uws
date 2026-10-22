// Release gates and lifecycle records for the response and abort routes. A
// test holds a route at a gate until it has observed what it needs, then
// releases it, so no assertion depends on timing. Kept on globalThis so the
// routes and hooks.ws.js share one store.
const store = (globalThis.__fixtureProbe ??= { gates: new Map(), records: new Map() });

/** @param {string} id */
function entry(id) {
	let gate = store.gates.get(id);
	if (!gate) {
		let release;
		const promise = new Promise((resolve) => { release = resolve; });
		gate = { promise, release };
		store.gates.set(id, gate);
	}
	return gate;
}

/** Resolves once the test releases `id`. @param {string} id */
export function gate(id) {
	return entry(id).promise;
}

/** @param {string} id */
export function release(id) {
	entry(id).release();
}

/** @param {string} id @param {string} event */
export function record(id, event) {
	const list = store.records.get(id) ?? [];
	list.push(event);
	store.records.set(id, list);
}

/** @param {string} id */
export function records(id) {
	return store.records.get(id) ?? [];
}
