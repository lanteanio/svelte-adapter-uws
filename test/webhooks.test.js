// Delivery-side wiring of the first-attempt admission gate in
// plugins/webhooks/server.js: which deliveries spend a destination's allowance,
// what a denial returns, and that the allowance belongs to the address the SSRF
// gate pinned the socket to rather than to any name the caller chose. Exercised
// against real loopback http servers with urlMode:'off' (strict mode blocks
// loopback by design), so "did not touch the network" is asserted by counting
// received requests rather than by trusting the return value.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import {
	deliverWebhook,
	createWebhookAdmission,
	createWebhookBreaker
} from '../src/plugins/webhooks/server.js';

/** A scripted loopback server: `handler(req, res, body)` decides each response. */
function makeServer() {
	let handler = (_req, res) => { res.writeHead(200); res.end(); };
	const received = [];
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => { body += c; });
		req.on('end', () => {
			received.push({ method: req.method, url: req.url, headers: req.headers, body });
			handler(req, res, body);
		});
	});
	return {
		received,
		set(h) { handler = h; },
		listen() {
			return new Promise((resolve) => {
				server.listen(0, '127.0.0.1', () => resolve(server.address().port));
			});
		},
		close() { return new Promise((r) => server.close(r)); }
	};
}

describe('deliverWebhook admission gate', () => {
	let srv;
	let port;
	beforeEach(async () => {
		srv = makeServer();
		port = await srv.listen();
	});
	afterEach(async () => {
		await srv.close();
	});

	/** The key an allowance is held under: the pinned address and port. */
	const dest = () => `127.0.0.1:${port}`;
	const url = (path = '/hook') => `http://127.0.0.1:${port}` + path;
	const cfg = (extra) => ({ url: url(), urlMode: 'off', ...extra });

	it('spends one unit of the destination allowance per delivery', async () => {
		const admission = createWebhookAdmission({ capacity: 2, refillPerSec: 0 });
		expect((await deliverWebhook(cfg(), 't', 'e', {}, { admission })).ok).toBe(true);
		expect((await deliverWebhook(cfg(), 't', 'e', {}, { admission })).ok).toBe(true);
		const third = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
		expect(third.ok).toBe(false);
		expect(third.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(third.attempts).toBe(0);
		expect(srv.received).toHaveLength(2);
		expect(admission.tokensFor(dest())).toBe(0);
	});

	it('shares one allowance across every name and registration for one address', async () => {
		// The multiplication this closes. Three registrations, three caller keys,
		// three paths, and - the part a URL-keyed allowance misses - three
		// different HOSTNAMES, two of them names that resolve to the same address
		// exactly as a wildcard-DNS record would. One listener, one allowance.
		const admission = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
		const resolve = () => ['127.0.0.1'];
		const first = await deliverWebhook(
			{ url: `http://alias-one.test:${port}/hook-a`, urlMode: 'off', resolve },
			't', 'e', {}, { admission, key: 'reg-a' }
		);
		const second = await deliverWebhook(
			{ url: `http://alias-two.test:${port}/hook-b`, urlMode: 'off', resolve },
			't', 'e', {}, { admission, key: 'reg-b' }
		);
		const third = await deliverWebhook(cfg({ url: url('/hook-c') }), 't', 'e', {}, { admission, key: 'reg-c' });
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(second.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(third.ok).toBe(false);
		expect(third.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(srv.received.map((x) => x.url)).toEqual(['/hook-a']);
		expect(admission.tokensFor(dest())).toBe(0);
	});

	it('keys a destination by the pinned address, not by the name in the url', async () => {
		const seen = [];
		const admission = { take: (d) => { seen.push(d); return true; } };
		await deliverWebhook(
			{ url: `http://alias-one.test:${port}/hook`, urlMode: 'off', resolve: () => ['127.0.0.1'] },
			't', 'e', {}, { admission }
		);
		expect(seen).toEqual([dest()]);
	});

	it('a denial reaches neither the network nor the breaker', async () => {
		const admission = { take: () => false };
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission, breaker, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(r.attempts).toBe(0);
		expect(srv.received).toHaveLength(0);
		expect(breaker.stateOf('k')).toBe('healthy'); // capacity is not endpoint health
	});

	it('costs nothing when the breaker already ejected the endpoint', async () => {
		const admission = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		breaker.failure(new Error('prior'), 'k');
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission, breaker, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.err.code).toBe('WEBHOOK_CIRCUIT_OPEN');
		expect(admission.tokensFor(dest())).toBe(1);
	});

	it('fails open when the admission implementation throws', async () => {
		const admission = { take: () => { throw new Error('admission backend down'); } };
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
		expect(r).toEqual({ ok: true });
		expect(srv.received).toHaveLength(1);
	});

	it('fails open when a shared implementation answers with nothing', async () => {
		// The realistic shared-backend failure that is not a throw: a client that
		// returns nothing on a miss, or a script error surfaced as a null reply.
		// Denying on those would turn one bad minute into a total outbound outage.
		for (const answer of [undefined, null, NaN]) {
			const admission = { take: () => answer };
			const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
			expect(r).toEqual({ ok: true });
		}
		expect(srv.received).toHaveLength(3);
	});

	it('refuses on a definite no, boolean or numeric', async () => {
		for (const answer of [false, 0]) {
			const admission = { take: () => answer };
			const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
			expect(r.ok).toBe(false);
			expect(r.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		}
		expect(srv.received).toHaveLength(0);
	});

	it('accepts an asynchronous (cluster-shared) implementation', async () => {
		const seen = [];
		const admission = { take: async (d) => { seen.push(d); return false; } };
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
		expect(r.ok).toBe(false);
		expect(r.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(seen).toEqual([dest()]);
	});

	it('spends nothing on a url no request can be issued to', async () => {
		// Every one of these is refused before the network: an unparseable url,
		// the opaque-origin schemes (which a url-keyed gate lumps into one shared
		// bucket), and an address the SSRF guard blocks in strict mode. None of
		// them may cost a destination anything.
		const seen = [];
		const admission = { take: (d) => { seen.push(d); return true; } };
		const unreachable = [
			{ url: 'not a url', urlMode: 'off' },
			{ url: 'file:///etc/passwd', urlMode: 'off' },
			{ url: 'data:text/plain,x', urlMode: 'off' },
			{ url: 'gopher://x/1', urlMode: 'off' },
			{ url: 'http://169.254.169.254/latest/meta-data' }
		];
		for (const config of unreachable) {
			const r = await deliverWebhook(config, 't', 'e', {}, { admission });
			expect(r.ok).toBe(false);
			expect(r.attempts).toBe(0);
		}
		expect(seen).toEqual([]);
	});

	it('does not charge a redirect hop to the address it lands on', async () => {
		// A redirect target is chosen by the endpoint being delivered to. Charging
		// it would let anyone who can register a webhook drain a bystander's
		// allowance by answering 302 to that bystander, so the control meant to
		// bound abuse would become a way to deny service to a co-tenant.
		const victim = makeServer();
		const victimPort = await victim.listen();
		const victimDest = `127.0.0.1:${victimPort}`;
		try {
			srv.set((_req, res) => {
				res.writeHead(302, { location: `http://127.0.0.1:${victimPort}/hook` });
				res.end();
			});
			const admission = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
			const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
			expect(r).toEqual({ ok: true });
			expect(victim.received).toHaveLength(1);
			expect(admission.tokensFor(victimDest)).toBe(1);
			// The victim's own delivery is still admitted: its allowance was never
			// spent by someone else's redirect.
			const own = await deliverWebhook(
				{ url: `http://127.0.0.1:${victimPort}/hook`, urlMode: 'off' },
				't', 'e', {}, { admission }
			);
			expect(own).toEqual({ ok: true });
			expect(victim.received).toHaveLength(2);
		} finally {
			await victim.close();
		}
	});

	it('charges one delivery once however many hops it takes', async () => {
		srv.set((req, res) => {
			if (req.url === '/hook') { res.writeHead(302, { location: '/hook-2' }); res.end(); return; }
			res.writeHead(200); res.end();
		});
		const admission = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { admission });
		expect(r).toEqual({ ok: true });
		expect(srv.received.map((x) => x.url)).toEqual(['/hook', '/hook-2']);
		expect(admission.tokensFor(dest())).toBe(0);
	});

	it('leaves delivery unchanged when no admission gate is injected', async () => {
		for (let i = 0; i < 3; i++) {
			expect((await deliverWebhook(cfg(), 't', 'e', {})).ok).toBe(true);
		}
		expect(srv.received).toHaveLength(3);
	});
});
