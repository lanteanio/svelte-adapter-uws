import { traceOperation, tracingEnabled } from '../tracing.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

async function invokeMessageHook(hook, ws, context, span) {
	try {
		await hook(ws, context);
	} catch (err) {
		try { span?.recordException?.(err); } catch {}
		// Logging must not prevent the close when a host replaces console.error.
		try { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.MESSAGE_HOOK), err); }
		catch { /* logger unavailable */ }
		try {
			if (typeof ws.end === 'function') ws.end(1011, 'Message handler error');
			else if (typeof ws.close === 'function') ws.close(1011, 'Message handler error');
		} catch {
			// The socket may have closed while the hook was awaiting. There is
			// nothing left to contain once this connection is already gone.
		}
	}
}

/**
 * Invoke the app/plugin message hook inside the runtime's exception boundary.
 *
 * Socket message callbacks are async on all three server surfaces, but their
 * hosts do not await the returned Promise. Letting a hook throw or reject out
 * of that callback therefore becomes an unhandled rejection and, under Node's
 * default policy, terminates the worker. A bad frame or plugin bug must take
 * down only the connection that triggered it.
 *
 * @param {unknown} hook
 * @param {any} ws
 * @param {any} context
 * @returns {Promise<void>}
 */
export async function runMessageHook(hook, ws, context) {
	if (typeof hook !== 'function') return;
	if (!tracingEnabled) return invokeMessageHook(hook, ws, context, null);
	await traceOperation('adapter.websocket.message', {
		kind: 'server',
		parent: context?.platform?.traceContext,
		attributes: { 'network.protocol.name': 'websocket' }
	}, async (span) => {
		await invokeMessageHook(hook, ws, context, span);
	});
}

function reportOpenHook(err) {
	console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.OPEN_HOOK), err);
}

function reportDrainHook(err) {
	console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.DRAIN_HOOK), err);
}

function reportCloseHook(err) {
	console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.CLOSE_HOOK), err);
}

function lifecycleHookFailed(ws, report, closeReason, err) {
	try { report(err); } catch { /* logger unavailable; still close the connection */ }
	if (closeReason === null) return;
	try {
		ws.end(1011, closeReason);
	} catch {
		// Already closed, by the hook itself or by the client.
	}
}

// The hosts call `open`, `drain` and `close` from a transport callback and
// never await the result. A synchronous throw out of a uWS callback is an
// uncaughtException and a rejection is an unhandled rejection; either one
// ends the worker and every connection on it. A bug in one connection's hook
// must cost that connection only, so the throw and the rejection both land
// here. The hook is still called as a method of the object that holds it and
// still not awaited: an async `open` has never held back the connection's
// first message, and this does not start to. The `then` read and attach sit
// inside the same try as the call, because a returned value whose `then`
// throws would otherwise leave through the seam the catch is here to close.
// An export that is present but not a function is still called, so its
// TypeError is reported for every connection rather than skipped in silence.
function runLifecycleHook(handlers, name, ws, context, report, closeReason) {
	if (handlers?.[name] == null) return;
	try {
		const result = handlers[name](ws, context);
		if (result != null && typeof result.then === 'function') {
			result.then(ignoreFulfilled, (err) => lifecycleHookFailed(ws, report, closeReason, err));
		}
	} catch (err) {
		lifecycleHookFailed(ws, report, closeReason, err);
	}
}

function ignoreFulfilled() {}

/**
 * Invoke the app `open` hook inside the exception boundary. A throw or
 * rejection closes that connection with 1011; the `close` hook then runs for
 * it as for any other close.
 * @param {any} handlers - the object holding the app hooks
 * @param {any} ws
 * @param {any} context
 */
export function runOpenHook(handlers, ws, context) {
	runLifecycleHook(handlers, 'open', ws, context, reportOpenHook, 'Open handler error');
}

/**
 * Invoke the app `drain` hook inside the exception boundary. A throw or
 * rejection closes that connection with 1011.
 * @param {any} handlers - the object holding the app hooks
 * @param {any} ws
 * @param {any} context
 */
export function runDrainHook(handlers, ws, context) {
	runLifecycleHook(handlers, 'drain', ws, context, reportDrainHook, 'Drain handler error');
}

/**
 * Invoke the app `close` hook inside the exception boundary. A throw or
 * rejection is logged and nothing else: the connection is already gone, and
 * the host's own teardown after the hook must still run.
 * @param {any} handlers - the object holding the app hooks
 * @param {any} ws
 * @param {any} context
 */
export function runCloseHook(handlers, ws, context) {
	runLifecycleHook(handlers, 'close', ws, context, reportCloseHook, null);
}
