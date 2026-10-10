import { statePool, requestSignals } from './state.js';

const STATE_POOL_MAX = 256;

export function acquireState() {
	const s = statePool.pop();
	if (s) { s.aborted = false; s.responseStarted = false; s.closedByServer = false; s.bodyReceived = false; return s; }
	return { aborted: false, responseStarted: false, closedByServer: false, bodyReceived: false, failBody: null, cancelResponse: null, signal: null };
}

/** @param {{ aborted: boolean, responseStarted: boolean, closedByServer: boolean, bodyReceived: boolean, failBody: (() => void) | null, cancelResponse: (() => void) | null, signal: AbortSignal | null }} s */
export function releaseState(s) {
	// The signal and the body stream belong to the request that just finished;
	// a pooled state must not keep either reachable.
	s.signal = null;
	s.failBody = null;
	s.cancelResponse = null;
	if (statePool.length < STATE_POOL_MAX) statePool.push(s);
}

/**
 * The AbortController an SSR or admin request's `request.signal` comes from,
 * registered while the request is in flight. It aborts when the client goes
 * away before its request body has arrived in full - always, for a request
 * without one - which is when SvelteKit's own Node adapter aborts it, and
 * when shutdown stops waiting for the request. An application that awaits
 * slow work can pass the signal on and stop with it.
 */
export function openRequestSignal() {
	const controller = new AbortController();
	requestSignals.add(controller);
	return controller;
}

/** @param {AbortController} controller */
export function closeRequestSignal(controller) {
	requestSignals.delete(controller);
}
