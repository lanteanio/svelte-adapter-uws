import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';
import { requestWire } from './helpers/http-wire.js';

const describeUWS = hasUWS ? describe : describe.skip;
describeUWS('canonical hosts behind configured proxy headers', () => {
	let server;
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'canonicalproxy', env: {
			ORIGIN: 'https://example.com', CANONICAL_HOST_ALIASES: 'www.example.com:8443',
			HOST_HEADER: 'x-site-host', PORT_HEADER: 'x-site-port', PROTOCOL_HEADER: 'x-site-proto',
			// Existing TRUSTED_PROXIES governs address identity, not these host headers.
			TRUSTED_PROXIES: '192.0.2.1'
		} });
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	it('keeps the existing host-header trust on an unlisted peer and uses the last repeated proxy line', async () => {
		const response = await requestWire(server.port, '/test.txt?keep=%2F', { host: 'container-name', headers: [
			['X-Site-Host', 'attacker.example'], ['X-Site-Host', 'WWW.EXAMPLE.COM:3000'],
			['X-Site-Port', '1234'], ['X-Site-Port', '8443'], ['X-Site-Proto', 'https']
		] });
		expect(response.status).toBe(308);
		expect(response.headers.location).toBe('https://example.com/test.txt?keep=%2F');
		expect(response.body).toBe('');
	});
	it('ignores unconfigured forwarding names and honors the last configured authority', async () => {
		const response = await requestWire(server.port, '/', { headers: [
			['X-Forwarded-Host', 'www.example.com:8443'],
			['X-Site-Host', 'www.example.com:8443'], ['X-Site-Host', 'example.com']
		] });
		expect(response.status).toBe(200);
		expect(response.headers.location).toBeUndefined();
	});
	it('rejects malformed selected proxy inputs instead of redirecting', async () => {
		for (const headers of [
			[['X-Site-Host', 'www.example.com/path']],
			[['X-Site-Host', 'www.example.com'], ['X-Site-Port', '8443/path']],
			[['X-Site-Host', 'www.example.com'], ['X-Site-Port', '8443'], ['X-Site-Proto', 'javascript']]
		]) expect((await requestWire(server.port, '/', { headers })).status).toBe(400);
	});
	it('leaves mounted probes available under the prefixed environment', async () => {
		for (const path of ['/healthz', '/readyz']) {
			const response = await requestWire(server.port, path, { headers: [['X-Site-Host', 'www.example.com:8443']] });
			expect(response.status).toBe(200);
			expect(response.headers.location).toBeUndefined();
		}
	});
});
