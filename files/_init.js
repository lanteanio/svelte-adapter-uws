// Initialize SvelteKit's Server BEFORE the ws-handler module is evaluated.
//
// $env/dynamic/private and $env/dynamic/public are runtime-populated by
// SvelteKit's Server.init({ env }) call - until init runs, the resolved
// `private_env` / `public_env` proxies are empty objects. If a user's
// hooks.ws / src/lib/server/* module reads `env.X` at module-load time
// (the default for `import { env } from '$env/dynamic/private'` followed
// by a top-level `env.DATABASE_URL` read), those reads see empty values
// when the ws-handler chunk is evaluated during handler.js's static
// import resolution - because Server.init in handler.js's body runs
// AFTER all imports' modules have been fully evaluated.
//
// Putting Server.init in this side-effect-bearing module and importing
// it in handler.js BEFORE the WS_HANDLER import forces ESM to evaluate
// this module first (imports are evaluated depth-first in source order,
// each module's body completes before the next import is processed).
// Top-level `await server.init(...)` blocks the import chain until the
// env proxies are populated; the next import (WS_HANDLER) then sees a
// fully-initialized SvelteKit runtime.
//
// Pre-existing esbuild fallback path was unaffected because its custom
// $env/dynamic/private resolver substituted `export const env = process.env;`
// directly, sidestepping SvelteKit's runtime indirection. The Vite
// plugin path (next.17 onward) routes through SvelteKit's normal env
// resolution and so requires the explicit init-order fix.

import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { Server } from 'SERVER';
import { manifest, base } from 'MANIFEST';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asset_dir = `${__dirname}/client${base}`;

const _t_init = performance.now();

/** @type {import('@sveltejs/kit').Server} */
export const server = new Server(manifest);

await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => /** @type {ReadableStream} */ (Readable.toWeb(fs.createReadStream(`${asset_dir}/${file}`)))
});

console.log(`SvelteKit server initialized in ${(performance.now() - _t_init).toFixed(1)}ms`);
