// Regression: MAX_RATE_ENTRIES is enforced at INSERTION time in the per-IP
// upgrade rate limiter, not only by the 60s maintenance sweep. Before the fix, a
// burst of rotating (spoofed) client identities grew upgradeRateMap unbounded
// between sweeps. The fix fails open by design: a NEW key arriving when the map
// is at cap is admitted by EVICTING the least active of a bounded sample, so a
// client that arrives during a flood is never refused because of other
// identities.
//
// WHAT MAKES THIS A REAL REGRESSION TEST. Admission codes alone cannot prove the
// cap: an unbounded map admits every upgrade AND still rate-limits per IP, so a
// suite that only checks 101s and 429s stays green with the insertion-time cap
// deleted. The load-bearing assertion is therefore the eviction COUNTER, read
// from the runtime's own metrics registry over the scrape route - it is zero
// unless the insertion-time eviction actually ran. That is why this boots the
// fixture's metrics variant: with `websocket.metrics` unset the counter is a
// no-op and would read zero either way.
//
// RUNNING THIS REPEATEDLY: each run opens ~10000 real TCP connections to
// localhost. On Windows the default dynamic port range is 16384 ports with a
// ~120s TIME_WAIT, so the client resets (RST) instead of closing gracefully -
// otherwise two or three back-to-back runs exhaust the ephemeral pool and this
// test, plus any other socket-heavy test, starts failing with connect errors
// that look exactly like a real regression. Check with
// `Get-NetTCPConnection -State TimeWait` and give it a minute before believing a
// failure here.
//
// WHAT IS AND IS NOT SCORED. The tallies below are EXACT, so only a protocol
// outcome may enter them. A connection that dies before the server answered
// never reached the rate limiter, and counting it as though it had made the
// exact counts depend on kernel timing: at this connection count the listen
// backlog sheds one occasionally, and a stray RST scored beside the 101s failed
// this file roughly one run in three. The shared helper re-issues such a request
// and throws if it keeps failing, so a socket error can no longer be mistaken
// for an admission decision - and a failure once bytes have arrived still throws
// rather than becoming a tally entry nobody reads.
//
// ADDRESS_HEADER=x-forwarded-for with TRUSTED_PROXIES unset (the documented
// default) lets each request carry its own rate-limit identity, so unique XFF
// values fill the map. The cap is the hardcoded 10000, so the test performs
// ~10000 upgrades.

import { describe, it, expect, afterAll } from 'vitest';
import { hasUWS, startRealRuntime, rawUpgrade } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * One raw WebSocket upgrade request presenting the given X-Forwarded-For.
 * Resolves with the HTTP status code of the response status line.
 *
 * The shared helper owns the request, the TIME_WAIT-avoiding reset and the
 * connect-level retry, so this file cannot drift into scoring a socket error as
 * an admission decision the way its own private copy did.
 * @param {number} port
 * @param {string} xff
 * @returns {Promise<string>}
 */
async function upgradeAs(port, xff) {
	const { status } = await rawUpgrade(port, { 'X-Forwarded-For': xff });
	return status;
}

/** @param {number} port @param {string[]} xffs @param {number} concurrency */
async function runBatch(port, xffs, concurrency = 50) {
	/** @type {Record<string, number>} */
	const codes = {};
	let i = 0;
	async function worker() {
		while (i < xffs.length) {
			const code = await upgradeAs(port, xffs[i++]);
			codes[code] = (codes[code] || 0) + 1;
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
	return codes;
}

/**
 * Read one counter out of the scrape route.
 * @param {string} httpUrl
 * @param {string} name
 * @returns {Promise<number>}
 */
async function readCounter(httpUrl, name) {
	const res = await fetch(`${httpUrl}/metrics`);
	const text = await res.text();
	const line = text.match(new RegExp(`^${name} (-?\\d+(?:\\.\\d+)?)$`, 'm'));
	return line ? Number(line[1]) : 0;
}

describeUWS('upgrade rate map insertion cap', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;

	afterAll(async () => { await server?.stop(); });

	it('bounds the map by evicting at insert, admits new identities at cap, and still rate-limits per IP', async () => {
		server = await startRealRuntime({
			variant: 'metrics',
			env: {
				ADDRESS_HEADER: 'x-forwarded-for',
				TRUSTED_PROXIES: undefined,
				ORIGIN: undefined,
				CLUSTER_WORKERS: undefined
			}
		});
		const { port, httpUrl } = server;

		// The scrape route must work before anything is asserted through it,
		// otherwise a zero counter later would be ambiguous.
		expect(await readCounter(httpUrl, 'upgrade_rate_map_evicted_total')).toBe(0);

		// 1) Under-cap: a few unique identities all upgrade.
		expect(await runBatch(port, ['203.0.113.1', '203.0.113.2', '203.0.113.3'])).toEqual({ '101': 3 });

		// 2) Fill the map to the cap (10000 entries: the 3 above + 9997 here).
		//    Each identity is fresh, so the per-IP sliding limit never fires -
		//    every insert is admitted until the map itself is full.
		const filler = Array.from({ length: 9997 }, (_, k) => `198.51.100.${k % 250}.${k}`);
		expect(await runBatch(port, filler)).toEqual({ '101': 9997 });

		// Nothing has been evicted yet: the map is exactly AT the cap, not past it.
		expect(await readCounter(httpUrl, 'upgrade_rate_map_evicted_total')).toBe(0);

		// 3) At cap a NEW identity is still ADMITTED - the map makes room by
		//    evicting instead of refusing. This is the whole point: the map is
		//    shared, so refusing here would let one host that filled it lock out
		//    every other client until the next sweep.
		expect(await upgradeAs(port, '192.0.2.1')).toBe('101');

		// ... and THIS is what an unbounded map cannot fake: room was made by
		// evicting an entry at insertion time, not by the 60s sweep.
		expect(await readCounter(httpUrl, 'upgrade_rate_map_evicted_total')).toBeGreaterThan(0);

		// 4) It keeps being true past the cap, so a client arriving during a flood
		//    is never collateral damage - and every one of these costs an eviction.
		const late = Array.from({ length: 200 }, (_, k) => `192.0.2.${(k % 200) + 10}`);
		expect(await runBatch(port, late)).toEqual({ '101': 200 });
		expect(await readCounter(httpUrl, 'upgrade_rate_map_evicted_total')).toBeGreaterThan(200);

		// 5) Eviction does not disable the actual rate limiting: one identity
		//    exceeding the per-IP allowance inside its window is still refused.
		//    The fixture configures upgradeRateLimit: 100, so go past it.
		const spammer = Array.from({ length: 160 }, () => '198.51.100.254');
		const codes = await runBatch(port, spammer, 1);
		expect(codes['429']).toBeGreaterThan(0);
		expect(codes['101']).toBeGreaterThan(0);
	}, 400000);
});
