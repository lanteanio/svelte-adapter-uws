// Starts the Vite dev server programmatically.
// Exits cleanly when stdin closes (Playwright teardown), ensuring V8 coverage is flushed.
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');
// Port arrives as argv[2] from global-setup. Fallback E2E_DEV_PORT lets you
// run this script standalone (e.g. `node test/e2e/dev-server.js` with the
// env var set) without re-hardcoding a number that might collide with
// Windows Hyper-V port reservations.
const port = parseInt(process.argv[2] || process.env.E2E_DEV_PORT || '0', 10);
if (!port) {
	console.error('dev-server: pass a port via argv[2] or E2E_DEV_PORT env');
	process.exit(1);
}

const server = await createServer({
	configFile: path.join(fixtureDir, 'vite.config.js'),
	root: fixtureDir,
	server: { port, strictPort: true }
});
await server.listen();
server.printUrls();

process.stdin.resume();
process.stdin.on('end', async () => {
	await server.close();
	process.exit(0);
});
