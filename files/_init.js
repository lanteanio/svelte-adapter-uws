// Initialize SvelteKit before the bridges dynamically import user modules.
// Static sibling imports can evaluate while server.init() is awaiting.

import 'SHIMS';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { server, base } from 'MANIFEST';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asset_dir = `${__dirname}/client${base}`;

const _t_init = performance.now();

export { server };

await server.init({
	env: /** @type {Record<string, string>} */ (process.env),
	read: (file) => /** @type {ReadableStream} */ (Readable.toWeb(fs.createReadStream(`${asset_dir}/${file}`)))
});

console.log(`SvelteKit server initialized in ${(performance.now() - _t_init).toFixed(1)}ms`);
