import { traceOperation, tracingEnabled } from '../tracing.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from '../error-registry.js';

async function invokeMessageHook(hook, ws, context, span) {
	try {
		await hook(ws, context);
	} catch (err) {
		try { span?.recordException?.(err); } catch {}
		// Preserve the cause server-side without exposing it to the client.
		console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.MESSAGE_HOOK), err);
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
