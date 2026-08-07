// The consumer's own runnable entry: boots a real adapter server from the
// installed dependency and wires this project's hooks into it. `node
// server.mjs` starts it standalone after an install in this directory; the
// migration rehearsal imports boot() and drives the same server with real
// WebSocket clients. Resolution is deliberately left to this package's own
// node_modules, so whatever version the install landed - the locked 0.5.8
// baseline, or the packed candidate after the documented migration edits -
// is the adapter that runs.
import { presence } from './hooks.ws.js';
import { announce } from './publish.js';

export async function boot() {
	const { createTestServer } = await import('svelte-adapter-uws/testing');
	const server = await createTestServer();
	return {
		server,
		platform: server.platform,
		wsUrl: server.wsUrl,
		presence,
		announce,
		close: () => server.close()
	};
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
	const app = await boot();
	console.log(`adapter-0-5-migration-canary listening on ${app.wsUrl}`);
}
