// Unit tests for the generic outbound-webhook delivery primitive
// (plugins/webhooks/server.js). Delivery is exercised against a real loopback
// http server with urlMode:'off' (strict mode blocks loopback by design, which
// is itself asserted). Retries use tiny delays so the jittered backoff stays
// sub-frame. No realtime layer, no network beyond loopback.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import {
	deliverWebhook,
	redactUrl,
	createRetryBudget,
	createWebhookBreaker,
	WebhookCircuitOpenError
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

const fastRetry = { attempts: 3, initialDelayMs: 2, maxDelayMs: 4 };

describe('redactUrl', () => {
	it('strips credentials, query, and hash; keeps origin + pathname', () => {
		expect(redactUrl('https://user:pass@example.com/hook?token=abc#frag')).toBe('https://example.com/hook');
		expect(redactUrl('not a url')).toBe('[unparseable-url]');
	});
});

describe('deliverWebhook', () => {
	let srv;
	let port;
	beforeEach(async () => {
		srv = makeServer();
		port = await srv.listen();
	});
	afterEach(async () => {
		await srv.close();
	});

	const url = () => `http://127.0.0.1:${port}/hook`;
	const cfg = (extra) => ({ url: url(), urlMode: 'off', ...extra });

	it('delivers a 2xx and sends the default body + content-type', async () => {
		const r = await deliverWebhook(cfg(), 'topic', 'created', { id: 1 });
		expect(r).toEqual({ ok: true });
		expect(srv.received).toHaveLength(1);
		expect(srv.received[0].headers['content-type']).toBe('application/json');
		expect(JSON.parse(srv.received[0].body)).toEqual({ event: 'created', data: { id: 1 } });
	});

	it('signs with HMAC and attaches a keyed idempotency header when a secret is set', async () => {
		const r = await deliverWebhook(cfg({ secret: 'sekret' }), 'topic', 'e', { n: 2 });
		expect(r.ok).toBe(true);
		const rec = srv.received[0];
		const body = rec.body;
		const expectedSig = 'sha256=' + createHmac('sha256', 'sekret').update(body).digest('hex');
		expect(rec.headers['x-webhook-signature']).toBe(expectedSig);
		const expectedIdem = createHmac('sha256', 'sekret').update('idem\0topic\0e\0' + body).digest('hex');
		expect(rec.headers['idempotency-key']).toBe(expectedIdem);
	});

	it('dual-signs during a key rotation (previousSecret appended)', async () => {
		const r = await deliverWebhook(cfg({ secret: 'new', previousSecret: 'old' }), 't', 'e', {});
		expect(r.ok).toBe(true);
		const body = srv.received[0].body;
		const sig = 'sha256=' + createHmac('sha256', 'new').update(body).digest('hex') +
			',sha256=' + createHmac('sha256', 'old').update(body).digest('hex');
		expect(srv.received[0].headers['x-webhook-signature']).toBe(sig);
	});

	it('uses a plain content hash for the idempotency key without a secret', async () => {
		const r = await deliverWebhook(cfg(), 't', 'e', { a: 1 });
		expect(r.ok).toBe(true);
		const body = srv.received[0].body;
		expect(srv.received[0].headers['idempotency-key']).toBe(createHash('sha256').update('t\0e\0' + body).digest('hex'));
		expect(srv.received[0].headers['x-webhook-signature']).toBeUndefined();
	});

	it('retries a 5xx then succeeds', async () => {
		let n = 0;
		srv.set((_req, res) => { n++; res.writeHead(n < 3 ? 503 : 200); res.end(); });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {});
		expect(r).toEqual({ ok: true });
		expect(n).toBe(3);
	});

	it('retries 429 as well', async () => {
		let n = 0;
		srv.set((_req, res) => { n++; res.writeHead(n < 2 ? 429 : 200); res.end(); });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {});
		expect(r.ok).toBe(true);
		expect(n).toBe(2);
	});

	it('treats a 4xx (not 429) as permanent - no retry', async () => {
		let n = 0;
		srv.set((_req, res) => { n++; res.writeHead(404); res.end(); });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {});
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(1);
		expect(n).toBe(1);
	});

	it('gives up after exhausting attempts on persistent 5xx', async () => {
		srv.set((_req, res) => { res.writeHead(500); res.end(); });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {});
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(3);
	});

	it('follows a redirect, re-gating the new URL', async () => {
		let hits = 0;
		srv.set((req, res) => {
			hits++;
			if (req.url === '/hook') { res.writeHead(302, { location: `http://127.0.0.1:${port}/moved` }); res.end(); }
			else { res.writeHead(200); res.end(); }
		});
		const r = await deliverWebhook(cfg(), 't', 'e', {});
		expect(r).toEqual({ ok: true });
		expect(hits).toBe(2);
		expect(srv.received.map((x) => x.url)).toEqual(['/hook', '/moved']);
	});

	it('opts out of delivery when transform returns null', async () => {
		const r = await deliverWebhook(cfg({ transform: () => null }), 't', 'e', {});
		expect(r).toEqual({ ok: true });
		expect(srv.received).toHaveLength(0);
	});

	it('resolves a function url per event', async () => {
		const r = await deliverWebhook(cfg({ url: (event) => `${url()}?e=${event}` }), 't', 'created', {});
		expect(r.ok).toBe(true);
		expect(srv.received[0].url).toBe('/hook?e=created');
	});
});

describe('deliverWebhook SSRF gate', () => {
	it('blocks a loopback target in strict mode (default) without sending', async () => {
		const r = await deliverWebhook({ url: 'http://127.0.0.1:9/hook' }, 't', 'e', {});
		expect(r.ok).toBe(false);
		expect(String(r.err.message)).toContain('blocked by SSRF guard');
		expect(r.attempts).toBe(0);
	});

	it('rejects a non-http(s) scheme even in off mode', async () => {
		const r = await deliverWebhook({ url: 'file:///etc/passwd', urlMode: 'off' }, 't', 'e', {});
		expect(r.ok).toBe(false);
		expect(String(r.err.message)).toContain('blocked by SSRF guard');
	});

	it('rejects a url that resolves to a non-string', async () => {
		const r = await deliverWebhook({ url: () => /** @type {any} */ (42), urlMode: 'off' }, 't', 'e', {});
		expect(r.ok).toBe(false);
		expect(String(r.err.message)).toContain('non-string');
	});
});

describe('deliverWebhook with controls (hooks)', () => {
	let srv;
	let port;
	beforeEach(async () => {
		srv = makeServer();
		port = await srv.listen();
	});
	afterEach(async () => {
		await srv.close();
	});

	const url = () => `http://127.0.0.1:${port}/hook`;
	const cfg = (extra) => ({ url: url(), urlMode: 'off', ...extra });

	it('a retry budget stops retries early when out of tokens', async () => {
		srv.set((_req, res) => { res.writeHead(500); res.end(); });
		// capacity 1, no refill: the first retry consumes the only token, the
		// second is denied -> 2 network attempts of the allowed 3.
		const budget = createRetryBudget({ capacity: 1, refillPerSec: 0 });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {}, { budget, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(2);
		expect(srv.received).toHaveLength(2);
	});

	it('a budget that denies every retry leaves exactly one attempt', async () => {
		srv.set((_req, res) => { res.writeHead(503); res.end(); });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {}, { budget: { take: () => false }, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(1);
		expect(srv.received).toHaveLength(1);
	});

	it('a budget error fails open so the retry still proceeds', async () => {
		let n = 0;
		srv.set((_req, res) => { n++; res.writeHead(n < 2 ? 500 : 200); res.end(); });
		const budget = { take: () => { throw new Error('budget backend down'); } };
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {}, { budget, key: 'k' });
		expect(r.ok).toBe(true);
		expect(n).toBe(2);
	});

	it('an open breaker fast-fails without touching the network', async () => {
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		breaker.failure(new Error('prior'), 'k'); // open the circuit
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { breaker, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(0);
		expect(r.err).toBeInstanceOf(WebhookCircuitOpenError);
		expect(srv.received).toHaveLength(0);
	});

	it('a run of delivery failures opens the breaker, then ejects', async () => {
		srv.set((_req, res) => { res.writeHead(500); res.end(); });
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		const first = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {}, { breaker, key: 'k' });
		expect(first.ok).toBe(false);
		expect(first.attempts).toBe(3);
		expect(breaker.stateOf('k')).toBe('broken');
		const before = srv.received.length;
		const second = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {}, { breaker, key: 'k' });
		expect(second.attempts).toBe(0); // ejected, no further network hit
		expect(srv.received.length).toBe(before);
	});

	it('a delivered webhook records success and heals the breaker', async () => {
		const breaker = createWebhookBreaker({ failureThreshold: 5, resetMs: 60000 });
		breaker.failure(new Error('x'), 'k'); // one prior failure, not yet open
		const r = await deliverWebhook(cfg(), 't', 'e', {}, { breaker, key: 'k' });
		expect(r.ok).toBe(true);
		expect(breaker.stateOf('k')).toBe('healthy');
	});

	it('a pre-network rejection (SSRF block) does not trip the breaker', async () => {
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		// strict mode (default) blocks the loopback target before any request -> attempts:0
		const r = await deliverWebhook({ url: url() }, 't', 'e', {}, { breaker, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(0);
		expect(breaker.stateOf('k')).toBe('healthy'); // endpoint health not signalled
	});

	it('a permanent 4xx counts as a delivery failure for the breaker', async () => {
		srv.set((_req, res) => { res.writeHead(404); res.end(); });
		const breaker = createWebhookBreaker({ failureThreshold: 1, resetMs: 60000 });
		const r = await deliverWebhook(cfg({ retry: fastRetry }), 't', 'e', {}, { breaker, key: 'k' });
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(1);
		expect(breaker.stateOf('k')).toBe('broken'); // attempts>0 -> endpoint signalled
	});
});
