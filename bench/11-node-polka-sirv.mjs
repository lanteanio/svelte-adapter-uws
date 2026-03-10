// Simulates adapter-node's static file path: Node http + Polka router + sirv.
// sirv serves from a temp directory with a pre-built file (same content as bench 3).
import http from 'node:http';
import polka from 'polka';
import sirv from 'sirv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT || '9001');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create a temp static directory with the same file as bench 3
const staticDir = path.join(__dirname, '_tmp_static');
fs.mkdirSync(staticDir, { recursive: true });
fs.writeFileSync(path.join(staticDir, 'index.html'),
	'<html><body>Hello World</body></html>');

const serve = sirv(staticDir, { dev: false, etag: true });

const httpServer = http.createServer();
polka({ server: httpServer })
	.use(serve)
	.use((req, res) => {
		res.writeHead(404);
		res.end('Not Found');
	})
	.listen(PORT, '0.0.0.0', () => {
		console.log(`[node-polka-sirv] listening on :${PORT}`);
	});
