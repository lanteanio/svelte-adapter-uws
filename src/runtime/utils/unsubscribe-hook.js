import { emitOperationalEvent, diagnosticError } from '../diagnostic.js';
import { WS_PLATFORM } from './ws-symbols.js';

/**
 * Invoke the app's `unsubscribe` hook without letting its failure leave the
 * connection's lane.
 *
 * The hook is declared `=> void` and every caller fires it without awaiting,
 * which is the contract: nothing bounds it, nothing waits for it. An app that
 * passes an async function anyway - plausible, since `subscribe` beside it
 * does take a promise - hands the runtime a promise nobody owns, and its
 * rejection is an unhandled rejection, which under Node's default policy ends
 * the worker. A synchronous throw took the message handler down with it.
 *
 * Both are contained here: a throw is caught, a returned thenable gets a
 * rejection handler, and either failure is reported once through the
 * diagnostics channel with the topic and the connection's request id. The
 * contract does not change - the promise is still not awaited, so no
 * in-flight set and no bound appear - and the socket keeps going.
 *
 * @param {unknown} hook - the app's `unsubscribe` export, if any
 * @param {any} ws
 * @param {string} topic
 * @param {{ platform: any }} ctx
 * @returns {void}
 */
export function runUnsubscribeHook(hook, ws, topic, ctx) {
	if (typeof hook !== 'function') return;
	// The attach sits inside the same try as the call: a thenable whose `then`
	// throws synchronously is the one shape that would otherwise leave through
	// the seam the catch is here to close.
	try {
		const result = hook(ws, topic, ctx);
		if (result != null && typeof result.then === 'function') {
			result.then(undefined, (err) => reportUnsubscribeHookFailure(err, ws, topic, ctx));
		}
	} catch (err) {
		reportUnsubscribeHookFailure(err, ws, topic, ctx);
	}
}

/**
 * @param {unknown} err
 * @param {any} ws
 * @param {string} topic
 * @param {{ platform: any }} ctx
 */
function reportUnsubscribeHookFailure(err, ws, topic, ctx) {
	/** @type {Record<string, unknown>} */
	const attributes = { topic, error: diagnosticError(err) };
	// The connection's request id, from the platform the hook was handed or the
	// one the connection holds. The socket may already be closed by the time a
	// rejection lands: the id is a courtesy of the report, not a condition.
	let requestId;
	try {
		requestId = ctx?.platform?.requestId;
		if (typeof requestId !== 'string') requestId = ws?.getUserData?.()?.[WS_PLATFORM]?.requestId;
	} catch { /* closed socket, or a platform that refuses the read */ }
	if (typeof requestId === 'string') attributes.requestId = requestId;
	emitOperationalEvent({
		source: 'svelte-adapter-uws',
		component: 'runtime.subscribe',
		event: 'unsubscribe.hook-failed',
		severity: 'error',
		dataClass: 'pseudonymous',
		message: 'The unsubscribe hook threw or rejected; the connection and its remaining subscriptions are unaffected.',
		attributes
	});
}
