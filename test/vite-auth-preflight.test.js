import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { bootViteDev, APP_STATUS } from './helpers/vite-dev.js';

let server;
afterEach(async () => { await server?.close(); server = null; });

function preflight(path, origin = 'http://localhost:3000') {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port: server.port, path, method: 'OPTIONS', headers: {
			origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with'
		} }, response => {
			response.resume();
			response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }));
		});
		req.once('error', reject);
		req.end();
	});
}

describe('Vite auth preflight isolation', () => {
	it.each([undefined, { origin: true, credentials: true }, false])('refuses custom auth preflight without changing app CORS %#', async cors => {
		let calls = 0;
		server = await bootViteDev({ cors, pluginOptions: { authPath: '/custom-auth' }, handler: {
			authenticate() { calls++; return {}; }
		} });
		for (const path of ['/custom-auth', '/custom-auth?next=/home']) {
			const response = await preflight(path);
			expect(response.status).toBe(405);
			expect(response.headers.allow).toBe('POST');
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
			expect(response.headers['access-control-allow-credentials']).toBeUndefined();
		}
		const malformed = await preflight('/custom-auth?bad=#fragment');
		expect(malformed.status).toBe(400);
		expect(malformed.headers['access-control-allow-origin']).toBeUndefined();
		expect(calls).toBe(0);
		for (const path of ['/application', '/__ws/auth', '/custom-auth/', '/custom-auth/child', '/custom-auth.json', '/CUSTOM-AUTH']) {
			const response = await preflight(path);
			expect(response.status, path).toBe(cors === false ? APP_STATUS : 204);
			expect(response.headers['access-control-allow-origin'], path).toBe(cors === false ? undefined : 'http://localhost:3000');
			expect(response.headers['access-control-allow-credentials'], path).toBe(cors?.credentials ? 'true' : undefined);
		}
	});
});
