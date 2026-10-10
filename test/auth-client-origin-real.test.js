import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as client from '../src/client.js';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

describeUWS('auth preflight headers on the built runtime', () => {
	let server;
	let connection;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'authFraction', env: {
			ADDRESS_HEADER: 'x-forwarded-for', ORIGIN: undefined,
			TRUSTED_PROXIES: undefined, CLUSTER_WORKERS: undefined
		} });
	}, 400000);
	afterEach(() => {
		connection?.close();
		connection = undefined;
		globalThis.fetch = originalFetch;
		globalThis.WebSocket = originalWebSocket;
	});
	afterAll(async () => { await server?.stop(); });

	it('the real client authenticates on its header alone before opening a socket', async () => {
		for (const headers of [{}, { 'x-requested-with': 'svelte-adapter-uws' }]) {
			const response = await originalFetch(server.httpUrl + '/__ws/auth', { method: 'POST', headers });
			expect(response.status).toBe(403);
			await response.text();
		}
		const seen = [];
		globalThis.WebSocket = WebSocket;
		globalThis.fetch = async (url, init) => {
			const headers = new Headers(init.headers);
			headers.delete('origin');
			headers.delete('sec-fetch-site');
			headers.set('x-auth-echo', '1');
			headers.set('x-forwarded-for', '198.51.100.60');
			const response = await originalFetch(url, { ...init, headers });
			seen.push({ value: headers.get('x-requested-with'), status: response.status,
				echo: response.ok ? await response.clone().json() : null });
			return response;
		};
		connection = client.connect({ url: server.wsUrl, auth: true });
		let deadline;
		try {
			await Promise.race([client.ready(), new Promise((_, reject) => {
				deadline = setTimeout(() => reject(new Error('authenticated socket did not open: ' + JSON.stringify(seen))), 3000);
			})]);
		} finally { clearTimeout(deadline); }
		expect(seen).toHaveLength(1);
		expect(seen[0].value).toBe('XMLHttpRequest');
		expect(seen[0].status).toBe(200);
		expect(seen[0].echo.headerNames).toContain('x-requested-with');
		expect(seen[0].echo.headerNames).not.toContain('origin');
		expect(seen[0].echo.headerNames).not.toContain('sec-fetch-site');
	});

	it('fractional windows emit an integer Retry-After rounded up before jitter', async () => {
		for (let i = 0; i < 8; i++) {
			const headers = { 'x-requested-with': 'XMLHttpRequest', 'x-forwarded-for': '203.0.113.' + (70 + i) };
			const admitted = await originalFetch(server.httpUrl + '/__ws/auth', { method: 'POST', headers });
			expect(admitted.status).toBe(204);
			await admitted.text();
			const limited = await originalFetch(server.httpUrl + '/__ws/auth', { method: 'POST', headers });
			expect(limited.status).toBe(429);
			const delay = limited.headers.get('retry-after');
			expect(delay).toMatch(/^[0-9]+$/);
			expect(Number(delay)).toBeGreaterThanOrEqual(2);
			expect(Number(delay)).toBeLessThanOrEqual(3);
			await limited.text();
		}
	});
});
