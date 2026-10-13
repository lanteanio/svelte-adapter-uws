import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('prefixed untrusted-proxy warnings on the built runtime', () => {
	let server;
	let warn;
	beforeAll(async () => {
		warn = vi.spyOn(console, 'warn');
		server = await startRealRuntime({ variant: 'hookcrashproxy', env: {
			ADDRESS_HEADER: 'x-forwarded-for', TRUSTED_PROXIES: '192.0.2.1'
		} });
	}, 400000);
	afterAll(async () => { warn?.mockRestore(); await server?.stop(); });

	it('names the prefixed allowlist in both the explanation and remedy, once', async () => {
		for (let i = 0; i < 2; i++) {
			const response = await fetch(server.httpUrl + '/client-address', {
				headers: { 'x-forwarded-for': '198.51.100.1' }
			});
			expect(response.status).toBe(200);
			expect((await response.json()).address).toBe('127.0.0.1');
		}
		const messages = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes('untrusted peer'));
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('not in TEST_PROXY_TRUSTED_PROXIES');
		expect(messages[0]).toContain('to TEST_PROXY_TRUSTED_PROXIES.');
	});
});
