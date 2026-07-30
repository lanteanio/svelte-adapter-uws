// The auth preflight endpoint is metered, against the REAL built runtime.
//
// WHY THIS EXISTS. The upgrade door enforces a per-IP sliding-window limit. The
// auth preflight beside it - the request `connect({ auth: true })` clients POST
// before upgrading - enforced nothing: only an Origin gate and a body cap stood
// in front of the app's `authenticate` hook, which is typically a credential
// check against a database. So the most expensive thing an app does per
// connection was reachable at raw server capacity from one address, while the
// cheaper door next to it was throttled.
//
// The Origin gate does not bound rate. It is a browser-shaped check, and a
// non-browser client sends whatever Origin header it likes.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

// The fixture builds with the shipped default.
const LIMIT = 30;

describeUWS('the auth preflight is rate limited (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'addrhdr',
			env: {
				// The forwarded header is only authoritative when ADDRESS_HEADER
				// names it. Without this every request resolves to the same
				// loopback socket address and the per-address test below would be
				// asserting something the runtime was never asked to do.
				ADDRESS_HEADER: 'x-forwarded-for',
				ORIGIN: undefined,
				TRUSTED_PROXIES: undefined,
				CLUSTER_WORKERS: undefined
			}
		});
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	/** @param {Record<string,string>} [headers] */
	async function preflight(headers = { 'x-requested-with': 'XMLHttpRequest' }) {
		const res = await fetch(`${server.httpUrl}/__ws/auth`, { method: 'POST', headers });
		// Drain, so the connection is not left half-read.
		await res.text().catch(() => {});
		return res.status;
	}

	it('refuses a flood from one address with 429', async () => {
		let refused = 0;
		let admitted = 0;
		for (let i = 0; i < LIMIT + 15; i++) {
			const status = await preflight();
			if (status === 429) refused++;
			else admitted++;
		}

		expect(admitted, 'the first requests must be served, or the limit is not the thing being tested').toBeGreaterThan(0);
		expect(refused, 'a flood past the limit must be refused').toBeGreaterThan(0);
	});

	it('meters per address, so one flooder does not lock out everyone else', async () => {
		// The identity resolution is shared with the upgrade limiter, so a
		// distinct forwarded address is a distinct bucket. Without this the first
		// test is satisfied by a global cap, which would turn one abusive client
		// into an outage for every other client - the failure mode the upgrade
		// limiter's eviction policy exists to avoid.
		const status = await preflight({
			'x-forwarded-for': '203.0.113.77',
			'x-requested-with': 'XMLHttpRequest'
		});
		expect(status, 'a different client address must still be served').not.toBe(429);
	});

	it('does not let rejected origins spend a shared address budget', async () => {
		const sharedIp = '198.51.100.24';
		for (let i = 0; i < LIMIT + 5; i++) {
			const status = await preflight({ 'x-forwarded-for': sharedIp });
			expect(status, 'an origin rejection must stay an origin rejection').toBe(403);
		}

		const admitted = await preflight({
			'x-forwarded-for': sharedIp,
			'x-requested-with': 'XMLHttpRequest'
		});
		expect(admitted, 'rejected origins must not lock out a legitimate peer behind the same address').toBe(204);
	});
});
