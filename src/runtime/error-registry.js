/**
 * Stable search keys for operator-facing adapter failures. Keep messagePrefix
 * equal to the invariant beginning of the emitted text; dynamic host, path,
 * timeout, or native-loader details follow it at runtime.
 */
export const ADAPTER_ERROR_IDS = Object.freeze({
	LISTEN: 'ADAPTER-ERR-LISTEN',
	VITE_LOAD: 'ADAPTER-ERR-VITE-LOAD',
	VITE_RELOAD: 'ADAPTER-ERR-VITE-RELOAD',
	NATIVE_LOAD: 'ADAPTER-ERR-NATIVE-LOAD',
	REQUEST_TIMEOUT: 'ADAPTER-ERR-REQUEST-TIMEOUT',
	REQUEST_CLOSED: 'ADAPTER-ERR-REQUEST-CLOSED'
});

export const ADAPTER_ERROR_REGISTRY = Object.freeze([
	Object.freeze({
		id: ADAPTER_ERROR_IDS.LISTEN,
		code: 'LISTEN_FAILED',
		event: 'runtime.listen.failed',
		component: 'runtime.listener',
		severity: 'fatal',
		problemPrefix: 'Could not bind the server listener on',
		messagePrefix: '[lantean/diagnostic source=svelte-adapter-uws component=runtime.listener event=runtime.listen.failed severity=fatal] runtime.listen.failed: Could not bind the server listener on',
		cause: 'The configured address or port could not be bound, or the process lacks permission.',
		consequence: 'The process never becomes ready and exits with status 1.',
		automaticRecovery: 'None. The adapter does not retry a failed bind.',
		nextAction: 'Check address availability, port conflicts, and bind permissions, then restart the process.',
		sources: Object.freeze(['src/runtime/index.js', 'src/runtime/handler/lifecycle.js']),
		anchor: 'adapter-err-listen',
		help: 'docs/errors.md#adapter-err-listen',
		link: 'https://svti.me/listen-failed'
}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.VITE_LOAD,
		code: null,
		event: 'vite.handler.load-failed',
		component: 'vite.websocket',
		severity: 'error',
		problemPrefix: 'Initial loading of the WebSocket handler',
		messagePrefix: '[lantean/diagnostic source=svelte-adapter-uws component=vite.websocket event=vite.handler.load-failed severity=error] vite.handler.load-failed: Initial loading of the WebSocket handler',
		cause: 'The initial development WebSocket handler or one of its imports failed to load.',
		consequence: 'The Vite HTTP server stays active, but WebSocket upgrades return HTTP 500 until a handler loads.',
		automaticRecovery: 'Vite retries the handler when its module graph changes again.',
		nextAction: 'Fix the reported module error and save the handler or one of its dependencies; a dev-server restart is not required.',
		sources: Object.freeze(['src/vite.js']),
		anchor: 'adapter-err-vite-load',
		help: 'docs/errors.md#adapter-err-vite-load',
		link: 'https://svti.me/ws-handler-load'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.VITE_RELOAD,
		code: null,
		event: 'vite.handler.reload-failed',
		component: 'vite.websocket',
		severity: 'error',
		problemPrefix: 'Hot reloading of the WebSocket handler',
		messagePrefix: '[lantean/diagnostic source=svelte-adapter-uws component=vite.websocket event=vite.handler.reload-failed severity=error] vite.handler.reload-failed: Hot reloading of the WebSocket handler',
		cause: 'A development handler hot reload failed after an earlier handler had loaded.',
		consequence: 'Existing WebSocket connections keep the previous handler, but new upgrades return HTTP 500 until recovery.',
		automaticRecovery: 'Vite retries the handler when its module graph changes again.',
		nextAction: 'Fix the reported module error and save the handler or one of its dependencies; a dev-server restart is not required.',
		sources: Object.freeze(['src/vite.js']),
		anchor: 'adapter-err-vite-reload',
		help: 'docs/errors.md#adapter-err-vite-reload',
		link: 'https://svti.me/ws-handler-load'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.NATIVE_LOAD,
		code: null,
		event: 'install.native-load.failed',
		component: null,
		problemPrefix: null,
		messagePrefix: 'Could not load uWebSockets.js.',
		cause: 'The optional native addon is absent or has no binary for the active Node ABI, CPU, OS, or libc.',
		consequence: 'The adapter cannot install or start, and there is no JavaScript transport fallback.',
		automaticRecovery: 'None. Package installation and process startup stop at this failure.',
		nextAction: 'Install the exact supported archive and a binary for the active OS, CPU, Node ABI, and documented Linux libc floor.',
		sources: Object.freeze(['src/uws-load-hint.js']),
		anchor: 'adapter-err-native-load',
		help: 'docs/errors.md#adapter-err-native-load',
		link: 'https://svti.me/native-load'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.REQUEST_TIMEOUT,
		code: null,
		event: 'websocket.request.timeout',
		component: null,
		problemPrefix: null,
		messagePrefix: 'request timed out',
		cause: 'A platform.request reply did not arrive within timeoutMs; the recipient may already have executed the request.',
		consequence: 'The caller promise rejects while the remote operation outcome remains unknown.',
		automaticRecovery: 'None. The adapter does not retry requests because replay may duplicate an operation.',
		nextAction: 'Reconcile application state first, or retry only through an idempotent operation; then investigate the handler, connection, and measured timeout budget.',
		sources: Object.freeze(['src/runtime/handler/platform.js', 'src/vite.js']),
		anchor: 'adapter-err-request-timeout',
		help: 'docs/errors.md#adapter-err-request-timeout',
		link: 'https://svti.me/request-timeout'
	}),
	Object.freeze({
		id: ADAPTER_ERROR_IDS.REQUEST_CLOSED,
		code: null,
		event: 'websocket.request.connection-closed',
		component: null,
		problemPrefix: null,
		messagePrefix: 'connection closed',
		cause: 'The target WebSocket closed before its pending request produced a reply.',
		consequence: 'The caller promise rejects while the remote operation outcome remains unknown.',
		automaticRecovery: 'None. The adapter does not retry requests because replay may duplicate an operation.',
		nextAction: 'Reconcile application state first, or retry only through an idempotent operation after the connection recovers.',
		sources: Object.freeze(['src/runtime/handler/platform.js', 'src/runtime/handler.js', 'src/vite.js']),
		anchor: 'adapter-err-request-closed',
		help: 'docs/errors.md#adapter-err-request-closed',
		link: 'https://svti.me/request-closed'
	})
]);

const ERROR_BY_ID = new Map(ADAPTER_ERROR_REGISTRY.map((entry) => [entry.id, entry]));

export function adapterErrorDefinition(id) {
	const entry = ERROR_BY_ID.get(id);
	if (!entry) throw new TypeError('Unknown svelte-adapter-uws error id: ' + id);
	return entry;
}

export function adapterErrorHelpSuffix(id) {
	const entry = adapterErrorDefinition(id);
	// A dev console cannot resolve a repo-relative path; entries that
	// carry an absolute link render it instead of the packaged doc route.
	return ' [' + entry.id + '] See: ' + (entry.link ?? entry.help);
}

export function adapterErrorMessage(id, detail = '') {
	const entry = adapterErrorDefinition(id);
	return entry.messagePrefix + detail + adapterErrorHelpSuffix(id);
}

export function adapterErrorProblem(id, detail = '') {
	const entry = adapterErrorDefinition(id);
	if (entry.problemPrefix === null) throw new TypeError('Adapter error id has no operational problem prefix: ' + id);
	return entry.problemPrefix + detail + adapterErrorHelpSuffix(id);
}
