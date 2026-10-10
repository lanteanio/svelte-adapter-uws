import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { createServer } from 'vite';

const mode = process.argv[2];
assert(['prefixed', 'bare-only'].includes(mode));
process.env.FIXTURE_VARIANT = 'envprefix';
process.env.ORIGIN = 'https://bare.example';
if (mode === 'prefixed') process.env.TEST_APP_ORIGIN = 'https://prefixed.example';
else delete process.env.TEST_APP_ORIGIN;
const clients = [];
process.chdir(fileURLToPath(new URL('../fixture/', import.meta.url)));
const server = await createServer({
	root: fileURLToPath(new URL('../fixture/', import.meta.url)),
	logLevel: 'silent',
	server: { host: '127.0.0.1', allowedHosts: true, hmr: false, ws: false, watch: null },
	optimizeDeps: { noDiscovery: true, include: [] }
});
try {
	await new Promise((resolve, reject) => {
		server.httpServer.once('error', reject);
		server.httpServer.listen(0, '127.0.0.1', resolve);
	});
	const port = server.httpServer.address().port;
	const host = 'attacker.example';
	const allowedOrigin = mode === 'prefixed' ? 'https://prefixed.example' : 'http://' + host;
	async function auth(origin) {
		return new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, path: '/__ws/auth', method: 'POST',
				headers: { host, origin, 'content-length': '0', 'x-auth-echo': '1' } }, response => {
				let body = '';
				response.on('data', chunk => { body += chunk; });
				response.once('error', reject);
				response.once('end', () => resolve({ status: response.statusCode, body }));
			});
			req.once('error', reject);
			req.end();
		});
	}
	async function upgrade(origin) {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { host, origin } });
			clients.push(ws);
			ws.once('open', () => resolve(101));
			ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
			ws.once('error', reject);
		});
	}
	assert.equal((await auth('https://bare.example')).status, 403);
	assert.equal(await upgrade('https://bare.example'), 403);
	if (mode === 'prefixed') {
		assert.equal((await auth('http://' + host)).status, 403);
		assert.equal(await upgrade('http://' + host), 403);
	}
	const accepted = await auth(allowedOrigin);
	assert.equal(accepted.status, 200);
	assert.equal(new URL(JSON.parse(accepted.body).requestUrl).origin, allowedOrigin);
	assert.equal(await upgrade(allowedOrigin), 101);
	console.log('vite-env-prefix: ' + mode + ' passed');
} finally {
	for (const client of clients) client.terminate();
	await server.close();
}
