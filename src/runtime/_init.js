// Initialize SvelteKit before ws-handler-bridge.js dynamically imports the user's
// handler. Static sibling imports can evaluate while this module is awaiting,
// so the bridge depends on this module and imports user code from its body.

import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { monotonicNow } from './runtime.js';
import { server, base } from 'MANIFEST';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asset_dir = `${__dirname}/client${base}`;

const _t_init = monotonicNow();

export { server };

await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => /** @type {ReadableStream} */ (Readable.toWeb(fs.createReadStream(`${asset_dir}/${file}`)))
});

console.log(`[svelte-adapter-uws] SvelteKit server initialized in ${(monotonicNow() - _t_init).toFixed(1)}ms`);
