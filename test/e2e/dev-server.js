// Starts the Vite dev server programmatically.
// Exits cleanly when stdin closes (Playwright teardown), ensuring V8 coverage is flushed.
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');
const port = parseInt(process.argv[2] || '49321', 10);

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
