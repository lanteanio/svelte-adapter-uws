export const streamGates = new Map();
export function gate(id) {
	let release;
	const pending = new Promise(resolve => { release = resolve; });
	const state = { pending, release, started: true, finished: false, cancelled: false };
	streamGates.set(id, state);
	return state;
}
