import { statePool } from './state.js';

const STATE_POOL_MAX = 256;

export function acquireState() {
	const s = statePool.pop();
	if (s) { s.aborted = false; s.responseStarted = false; s.closedByServer = false; return s; }
	return { aborted: false, responseStarted: false, closedByServer: false };
}

/** @param {{ aborted: boolean, responseStarted: boolean, closedByServer: boolean }} s */
export function releaseState(s) {
	if (statePool.length < STATE_POOL_MAX) statePool.push(s);
}
