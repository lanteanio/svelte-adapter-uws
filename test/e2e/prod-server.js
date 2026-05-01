// Builds and starts the production server.
// Exits cleanly when stdin closes, ensuring V8 coverage is flushed.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

// Build first
execSync('npx vite build', { cwd: fixtureDir, stdio: 'pipe' });

// Set port via env (the built server reads PORT). Port arrives as
// argv[2] from global-setup; fallback to E2E_PROD_PORT so this script
// works standalone too.
const port = process.argv[2] || process.env.E2E_PROD_PORT;
if (!port) {
	console.error('prod-server: pass a port via argv[2] or E2E_PROD_PORT env');
	process.exit(1);
}
process.env.PORT = port;
process.env.HOST = '127.0.0.1';

// Import the built server (starts listening on import)
await import('file:///' + path.join(fixtureDir, 'build', 'index.js').replace(/\\/g, '/'));

process.stdin.resume();
process.stdin.on('end', () => {
	process.exit(0);
});
