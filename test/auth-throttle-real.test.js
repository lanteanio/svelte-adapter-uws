// The auth preflight's per-address rate limit answers with Retry-After.
//
// Many clients can sit behind one address, and they share this budget. The
// bundled client now reads a 429 as throttling and waits at least as long as
// the server asks (test/client-real.test.js), so the refusal has to say how
// long: about one limiter window, jittered so those clients do not all come
// back in the same second.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('auth preflight rate limit on the built runtime', () => {
	let server;
	beforeAll(async () => { server = await startRealRuntime({ variant: 'default' }); }, 400000);
	afterAll(async () => { await server?.stop(); });

	it('refuses past the budget with a Retry-After of about one window', async () => {
		// The default budget is 30 per 10 s per address.
		let refused = null;
		for (let i = 0; i < 40 && refused === null; i++) {
			const res = await fetch(`${server.httpUrl}/__ws/auth`, { method: 'POST' });
			if (res.status === 429) refused = res;
		}
		expect(refused, 'the budget was reached').not.toBeNull();
		const retryAfter = Number(refused.headers.get('retry-after'));
		expect(Number.isInteger(retryAfter)).toBe(true);
		expect(retryAfter).toBeGreaterThanOrEqual(10);
		expect(retryAfter).toBeLessThan(10 + 6);
	});
});
