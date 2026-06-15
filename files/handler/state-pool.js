import { statePool } from './state.js';

const STATE_POOL_MAX = 256;

export function acquireState() {
	const s = statePool.pop();
	if (s) { s.aborted = false; return s; }
	return { aborted: false };
}

/** @param {{ aborted: boolean }} s */
export function releaseState(s) {
	if (statePool.length < STATE_POOL_MAX) statePool.push(s);
}
