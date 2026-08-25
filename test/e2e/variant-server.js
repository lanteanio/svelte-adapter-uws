// Starts an already-built fixture VARIANT's production server.
//
// Like prod-server.js, but the build directory arrives as the second
// argument and no build runs here: the spec that spawns this builds its
// variant first, so global setup stays fast for the specs that never need
// one. Exits cleanly when stdin closes, so a dead spawning worker can
// never leave an orphaned listener behind.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

const port = process.argv[2];
const buildDir = process.argv[3];
if (!port || !buildDir) {
	console.error('variant-server: usage: node variant-server.js <port> <build-dir>');
	process.exit(1);
}
process.env.PORT = port;
process.env.HOST = '127.0.0.1';

// Import the built server (starts listening on import)
await import('file:///' + path.join(fixtureDir, buildDir, 'index.js').replace(/\\/g, '/'));

process.stdin.resume();
process.stdin.on('end', () => {
	process.exit(0);
});
