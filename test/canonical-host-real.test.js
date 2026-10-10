import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { hasUWS, startRealRuntime, EVAL_TIME_ENV } from './helpers/real-runtime.js';
import { requestWire } from './helpers/http-wire.js';

const describeUWS = hasUWS ? describe : describe.skip;
describeUWS('canonical hosts on the built HTTP runtime', () => {
	let server;
	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'canonicalhost', env: {
			ORIGIN: 'https://example.com',
			CANONICAL_HOST_ALIASES: ' www.example.com, WWW.EXAMPLE.COM, preview.example.com:8443 '
		} });
	}, 400000);
	afterAll(async () => { await server?.stop(); });

	it.each(['GET', 'HEAD', 'POST', 'PUT', 'DELETE'])('redirects %s before static, prerendered and SSR work', async (method) => {
		for (const target of ['/test.txt?x=%2F&x=two+words', '/prerendered/caf%C3%A9?raw=%2520', '/?keep=%2f']) {
			const response = await requestWire(server.port, target, { method, host: 'WWW.Example.COM' });
			expect(response.status, target).toBe(308);
			expect(response.headers.location, target).toBe('https://example.com' + target);
			expect(response.body).toBe('');
			expect(response.headers['content-length']).toBe('0');
		}
	});

	it('serves the canonical static and prerendered controls without a host redirect', async () => {
		for (const target of ['/test.txt', '/prerendered/caf%C3%A9']) {
			const response = await requestWire(server.port, target);
			expect(response.status, target).toBe(200);
			expect(response.headers.location, target).toBeUndefined();
			expect(response.body.length, target).toBeGreaterThan(0);
		}
	});

	it('matches only listed authorities and exact ports', async () => {
		for (const host of ['example.com', 'www.example.com:443', 'preview.example.com', 'www.example.com.evil', 'other.example.com', '127.0.0.1:' + server.port, 'container-name']) {
			const response = await requestWire(server.port, '/', { host });
			expect(response.status, host).toBe(200);
			expect(response.headers.location, host).toBeUndefined();
			expect(response.body, host).toContain('hello from ssr');
		}
		expect((await requestWire(server.port, '/', { host: 'preview.example.com:8443' })).status).toBe(308);
	});

	it('keeps configured liveness and readiness probes available even for an alias', async () => {
		for (const host of ['www.example.com', '127.0.0.1:' + server.port, 'container-name']) {
			for (const method of ['GET', 'HEAD']) {
				for (const target of ['/alive-canonical', '/ready-canonical']) {
					const response = await requestWire(server.port, target, { host, method });
					expect(response.status, host + target).toBe(200);
					expect(response.headers.location).toBeUndefined();
					if (method === 'HEAD') expect(response.body).toBe('');
				}
			}
		}
	});

	it('redirects an alias while the same canonical SSR request is still in flight', async () => {
		const target = '/slow-hold?ms=250';
		const started = globalThis.__slowHoldStarted ?? 0;
		const canonical = requestWire(server.port, target);
		try {
			await expect.poll(() => globalThis.__slowHoldStarted ?? 0).toBeGreaterThan(started);
			const alias = await requestWire(server.port, target, { host: 'www.example.com' });
			expect(alias.status).toBe(308);
			expect(alias.headers.location).toBe('https://example.com' + target);
		} finally {
			expect((await canonical).status).toBe(200);
		}
	});

	it('ignores unconfigured forwarding and refuses malformed inputs before redirecting', async () => {
		expect((await requestWire(server.port, '/', { headers: [['X-Forwarded-Host', 'www.example.com']] })).status).toBe(200);
		for (const options of [
			{ host: 'www.example.com', headers: [['Host', 'example.com']] },
			{ host: 'www.example.com/path' },
			{ host: 'www.example.com', headers: [['Transfer-Encoding', 'gzip']] },
			{ host: 'www.example.com', headers: [['Content-Length', '']] }
		]) expect((await requestWire(server.port, '/', options)).status).toBe(400);
		for (const target of ['/test.txt#fragment', '/?bad=#fragment']) {
			expect((await requestWire(server.port, target, { host: 'www.example.com' })).status).toBe(400);
		}
		expect((await requestWire(server.port, '/', { host: 'www.example.com', method: 'TRACE' })).status).toBe(405);
	});

	it.each([
		[undefined, 'www.example.com'], ['https://user@example.com', 'www.example.com'],
		['https://example.com/path', 'www.example.com'], ['https://example.com?query', 'www.example.com'],
		['https://example.com#fragment', 'www.example.com'], ['ftp://example.com', 'www.example.com'],
		['https://example.com', 'www.example.com/path'], ['https://example.com', 'user@www.example.com'],
		['https://example.com', 'www.example.com:99999'], ['https://example.com', 'www.example.com:'],
		['https://example.com', 'www.example.com,'], ['https://example.com', 'example.com'],
		['https://example.com', 'example.com:443']
	])('rejects an invalid redirect configuration before starting: %s / %s', (origin, aliases) => {
		const env = { ...process.env };
		for (const key of EVAL_TIME_ENV) delete env[key];
		if (origin !== undefined) env.ORIGIN = origin;
		env.CANONICAL_HOST_ALIASES = aliases;
		const config = pathToFileURL(resolve('test/fixture/build-canonical-host/handler/config.js')).href;
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(config) + ')'], { env, encoding: 'utf8', timeout: 10000 });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/CANONICAL_HOST_ALIASES|Invalid ORIGIN/);
	});
});
