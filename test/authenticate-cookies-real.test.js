// Production-built proof for the authenticate endpoint's Set-Cookie contract.
//
// The cookie defaults this asserts - `Secure` derived from the REAL request
// URL, relative `Path` resolved against it - live in the wiring between
// src/runtime/handler.js's authenticate route and src/runtime/cookies.js.
// Unit tests that call createCookies() by hand cannot see that wiring: drop
// the request-URL argument at the call site and every hand-rolled test stays
// green while production session cookies silently lose `Secure`. So this
// boots the real built runtime and asserts on the Set-Cookie header a real
// HTTP client receives.

import { afterAll, describe, expect, it } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

async function authenticateWithProbe(origin, extraHeaders = {}) {
	const response = await fetch(origin + '/__ws/auth', {
		method: 'POST',
		headers: {
			'x-requested-with': 'XMLHttpRequest',
			'x-set-cookie-probe': '1',
			...extraHeaders
		}
	});
	return { response, setCookies: response.headers.getSetCookie() };
}

describeUWS('authenticate endpoint Set-Cookie contract', () => {
	let server;
	afterAll(async () => { await server?.stop(); });

	it('derives Secure from the real request URL and resolves relative paths against it', async () => {
		server = await startRealRuntime({ variant: 'default' });

		// A non-localhost host (127.0.0.1) over plain HTTP: SvelteKit's rule
		// emits Secure for everything except http://localhost, and the value
		// must come from the request the client actually sent.
		const nonLocalhost = await authenticateWithProbe(server.httpUrl);
		expect(nonLocalhost.response.status).toBe(204);
		expect(nonLocalhost.setCookies).toHaveLength(1);
		const cookie = nonLocalhost.setCookies[0];
		expect(cookie).toContain('probe_session=probe-value');
		expect(cookie).toContain('; Secure');
		expect(cookie).toContain('; HttpOnly');
		expect(cookie).toContain('; SameSite=Lax');
		expect(cookie).toContain('; Path=/');

		// The same server addressed as http://localhost is the one exemption:
		// Secure must be omitted so local development can round-trip cookies.
		// Everything else about the cookie stays identical.
		const localhost = await authenticateWithProbe(
			`http://localhost:${server.port}`
		);
		expect(localhost.response.status).toBe(204);
		expect(localhost.setCookies).toHaveLength(1);
		expect(localhost.setCookies[0]).toContain('probe_session=probe-value');
		expect(localhost.setCookies[0]).not.toContain('; Secure');
		expect(localhost.setCookies[0]).toContain('; HttpOnly');

		// A relative path resolves against the request URL (RFC 3986, the
		// same answer SvelteKit computes) instead of reaching the browser as
		// `Path=sub`, which RFC 6265 clients discard for the default path.
		const relative = await authenticateWithProbe(server.httpUrl, {
			'x-cookie-path': 'sub'
		});
		expect(relative.response.status).toBe(204);
		expect(relative.setCookies).toHaveLength(1);
		expect(relative.setCookies[0]).toContain('; Path=/__ws/sub');
	}, 20_000);
});
