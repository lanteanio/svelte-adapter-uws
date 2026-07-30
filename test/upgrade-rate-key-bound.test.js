// The per-IP upgrade rate map bounds BYTES, not just entry count.
//
// WHY THIS EXISTS. Capping the map at 10,000 entries bounds how many keys it
// holds and says nothing about how big they are. The key is not necessarily an
// address: with `ADDRESS_HEADER` configured and `TRUSTED_PROXIES` unset - the
// exact combination that makes the header authoritative - it is the client's
// header value verbatim, behind a length ceiling far above any real address.
// Ten thousand multi-kilobyte keys is tens of megabytes per worker, which is
// the harm the entry cap was supposed to bound, at roughly fifty times the size
// the cap implies.
//
// WHAT MAKES THIS ASSERTION REAL. Map size and heap are not observable from a
// client, so this asserts the bound through its wire-visible CONSEQUENCE: two
// oversized header values that share a prefix must land in the SAME limiter
// bucket. Unbounded, each is its own key and every request is admitted; bounded,
// they share a bucket and the flood rate-limits itself. That is also the
// behaviour the truncation trade-off is chosen for, so the test pins the design
// decision rather than an implementation detail.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, rawUpgrade } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

// The addrhdr fixture variant is built with upgradeRateLimit: 100.
const LIMIT = 100;
// Longer than the 128-character key cap, so everything past it is truncated.
const SHARED_PREFIX = 'x'.repeat(200);

describeUWS('the upgrade rate map bounds its key length (built runtime)', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	beforeAll(async () => {
		server = await startRealRuntime({
			variant: 'addrhdr',
			env: {
				// Make the header authoritative: honored verbatim precisely because
				// no trusted-proxy allowlist is configured.
				ADDRESS_HEADER: 'x-forwarded-for',
				TRUSTED_PROXIES: undefined,
				ORIGIN: undefined,
				CLUSTER_WORKERS: undefined
			}
		});
	}, 400000);

	afterAll(async () => {
		await server?.stop();
	});

	it('collapses oversized rotating identities into one limiter bucket', async () => {
		// Every value is distinct, and every value shares the first 200 characters. An
		// unbounded key makes each one a fresh entry with a fresh window, so all
		// of them are admitted and the map grows one multi-kilobyte key per
		// request. A bounded key truncates them to the same string, so they share
		// one window and the limit applies.
		let refused = 0;
		for (let i = 0; i < LIMIT + 20; i++) {
			const { status } = await rawUpgrade(server.port, { 'x-forwarded-for': `${SHARED_PREFIX}${i}` });
			if (status === '429') refused++;
		}
		expect(
			refused,
			'oversized rotating identities sharing a prefix must share a bucket, or the map grows one large key per request'
		).toBeGreaterThan(0);
	});

	it('does not merge accepted address-header identities after 64 characters', async () => {
		// The single-address-header resolver accepts up to 128 characters. Its
		// limiter must preserve that whole accepted identity: the former
		// 64-character key cap made all of these distinct values share one bucket.
		let refused = 0;
		const sharedPrefix = 'y'.repeat(80);
		for (let i = 0; i < LIMIT + 1; i++) {
			const { status } = await rawUpgrade(server.port, { 'x-forwarded-for': `${sharedPrefix}${i}` });
			if (status === '429') refused++;
		}

		expect(refused, 'accepted identities that differ after character 64 must remain distinct').toBe(0);
	});

	it('still keeps genuinely different addresses in different buckets', async () => {
		// The bound must not overshoot into merging real clients: an address is far
		// below the cap, so distinct ones are never truncated together. Each of
		// these gets its own window and none is refused, which is what proves the
		// truncation above is doing something specific to oversized values rather
		// than collapsing everything.
		let refused = 0;
		for (let i = 0; i < 20; i++) {
			const { status } = await rawUpgrade(server.port, { 'x-forwarded-for': `203.0.113.${i}` });
			if (status === '429') refused++;
		}

		expect(refused, 'distinct real addresses must not share a limiter bucket').toBe(0);
	});
});
