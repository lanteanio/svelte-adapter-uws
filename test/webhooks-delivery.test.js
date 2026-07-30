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
	verifyWebhookSignature,
	redactUrl,
	createRetryBudget,
	createWebhookBreaker,
	WebhookCircuitOpenError
} from '../src/plugins/webhooks/server.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';

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
	it('reduces to the origin only - userinfo, query, hash AND path are dropped', () => {
		expect(redactUrl('https://user:pass@example.com/hook?token=abc#frag')).toBe('https://example.com');
		expect(redactUrl('not a url')).toBe('[unparseable-url]');
	});

	it('never leaks a path-carried endpoint credential (Slack-style webhook URL)', () => {
		const secretUrl = 'https://hooks.example.com/services/T000/B000/lIvEsEcReTtOkEn';
		const redacted = redactUrl(secretUrl);
		expect(redacted).toBe('https://hooks.example.com');
		expect(redacted).not.toContain('lIvEsEcReTtOkEn');
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

	it('signs `<timestamp>.<body>` with HMAC, emitting x-webhook-timestamp, and attaches a keyed idempotency header', async () => {
		const r = await deliverWebhook(cfg({ secret: 'sekret' }), 'topic', 'e', { n: 2 });
		expect(r.ok).toBe(true);
		const rec = srv.received[0];
		const body = rec.body;
		const ts = rec.headers['x-webhook-timestamp'];
		expect(ts).toMatch(/^\d+$/);
		const expectedSig = 'sha256=' + createHmac('sha256', 'sekret').update(ts + '.' + body).digest('hex');
		expect(rec.headers['x-webhook-signature']).toBe(expectedSig);
		// A body-only HMAC (the legacy construction) must NOT match - that form
		// is what replayed forever.
		const legacySig = 'sha256=' + createHmac('sha256', 'sekret').update(body).digest('hex');
		expect(rec.headers['x-webhook-signature']).not.toBe(legacySig);
		const expectedIdem = createHmac('sha256', 'sekret').update('idem\0topic\0e\0' + body).digest('hex');
		expect(rec.headers['idempotency-key']).toBe(expectedIdem);
	});

	it('dual-signs during a key rotation (previousSecret appended)', async () => {
		const r = await deliverWebhook(cfg({ secret: 'new', previousSecret: 'old' }), 't', 'e', {});
		expect(r.ok).toBe(true);
		const body = srv.received[0].body;
		const ts = srv.received[0].headers['x-webhook-timestamp'];
		const sig = 'sha256=' + createHmac('sha256', 'new').update(ts + '.' + body).digest('hex') +
			',sha256=' + createHmac('sha256', 'old').update(ts + '.' + body).digest('hex');
		expect(srv.received[0].headers['x-webhook-signature']).toBe(sig);
	});

	describe('documented receiver contract (freshness)', () => {
		// Drives the SHIPPED verifier, not a copy of it. A hand-rolled
		// re-implementation here proves only that the test agrees with itself:
		// the previous one had already drifted from the contract it claimed to
		// check (plain `includes` instead of a constant-time compare, and an
		// acceptance path for a legacy body-only signature the sender never
		// emits), so a receiver following the real contract was untested.
		const verifyDocumented = (headers, body, secrets, nowMs) =>
			verifyWebhookSignature(headers, body, { secrets, nowMs });

		it('a fresh signed delivery verifies; a stale captured pair does not', async () => {
			const r = await deliverWebhook(cfg({ secret: 'sekret' }), 't', 'e', { n: 1 });
			expect(r.ok).toBe(true);
			const rec = srv.received[0];
			const nowMs = Date.now();
			expect(verifyDocumented(rec.headers, rec.body, ['sekret'], nowMs)).toBe(true);
			// Replay the captured pair "later", past the tolerance window.
			expect(verifyDocumented(rec.headers, rec.body, ['sekret'], nowMs + 10 * 60 * 1000)).toBe(false);
		});

		it('refuses a legacy body-only signature - that form is what replayed forever', () => {
			// Deliberate: accepting both constructions would leave replay wide
			// open through the legacy entry while looking fixed. There is no
			// overlap period; receivers upgrade before senders.
			const body = JSON.stringify({ event: 'e', data: {} });
			const legacyHeaders = {
				'x-webhook-signature': 'sha256=' + createHmac('sha256', 'sekret').update(body).digest('hex')
			};
			expect(verifyDocumented(legacyHeaders, body, ['sekret'], Date.now())).toBe(false);
		});

		// A body that is not valid UTF-8 was decoded with `toString('utf8')` before
		// hashing, so every invalid byte became U+FFFD. Two consequences, both real:
		// a sender signing the actual bytes never verified, and two DIFFERENT bodies
		// differing only inside invalid sequences collapsed to one signed string and
		// accepted each other's signature.
		it('verifies a non-UTF-8 body byte-exactly', () => {
			const ts = String(Math.floor(Date.now() / 1000));
			// Lone continuation bytes - invalid UTF-8, and distinct from each other.
			const bodyA = Buffer.from([0x7b, 0x80, 0x7d]);
			const bodyB = Buffer.from([0x7b, 0x81, 0x7d]);
			const sigFor = (buf) =>
				'sha256=' + createHmac('sha256', 'sekret')
					.update(Buffer.concat([Buffer.from(`${ts}.`, 'latin1'), buf]))
					.digest('hex');

			const headersA = { 'x-webhook-timestamp': ts, 'x-webhook-signature': sigFor(bodyA) };
			expect(verifyDocumented(headersA, bodyA, ['sekret'], Date.now())).toBe(true);
			// The property that matters: B must NOT pass A's signature. Under the
			// lossy decode both bodies read as the same replacement string and did.
			expect(verifyDocumented(headersA, bodyB, ['sekret'], Date.now())).toBe(false);
		});

		// The signature header is attacker-controlled and was split unbounded, so a
		// multi-megabyte value allocated one string per comma and then ran a
		// constant-time compare against each, once per configured secret.
		// A receiver passes whatever its framework hands it, and testing only
		// `Buffer.isBuffer` sent every other byte container through `String()`.
		// That is not a near-miss: `String(arrayBuffer)` is the CONSTANT
		// '[object ArrayBuffer]', so the digest stopped covering the body and any
		// two bodies signed each other, while a `Uint8Array` hashed the decimal CSV
		// of its bytes and never verified at all. `await request.arrayBuffer()` is
		// exactly what a SvelteKit receiver has in hand.
		it('verifies the same bytes in every container a receiver can hold', () => {
			const ts = String(Math.floor(Date.now() / 1000));
			const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]);
			const sig = 'sha256=' + createHmac('sha256', 'sekret')
				.update(Buffer.concat([Buffer.from(`${ts}.`, 'latin1'), bytes]))
				.digest('hex');
			const headers = { 'x-webhook-timestamp': ts, 'x-webhook-signature': sig };

			const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			// A view whose window is NOT the whole backing buffer - hashing the
			// buffer instead of the view would take the neighbouring bytes too.
			const padded = Buffer.concat([Buffer.from([0xff, 0xff]), bytes, Buffer.from([0xff])]);
			const view = new Uint8Array(padded.buffer, padded.byteOffset + 2, bytes.length);

			for (const [label, body] of [
				['Buffer', bytes],
				['string', bytes.toString('utf8')],
				['ArrayBuffer', arrayBuffer],
				['Uint8Array', new Uint8Array(arrayBuffer)],
				['offset view', view],
				['DataView', new DataView(arrayBuffer)]
			]) {
				expect(verifyDocumented(headers, body, ['sekret'], Date.now()), label).toBe(true);
			}
		});

		it('fails closed on a body it cannot hash byte-exactly, and on a missing options', () => {
			const ts = String(Math.floor(Date.now() / 1000));
			const bytes = Buffer.from('{"a":1}', 'utf8');
			const sig = 'sha256=' + createHmac('sha256', 'sekret')
				.update(Buffer.concat([Buffer.from(`${ts}.`, 'latin1'), bytes]))
				.digest('hex');
			const headers = { 'x-webhook-timestamp': ts, 'x-webhook-signature': sig };

			// An ALREADY-PARSED body cannot be verified: re-serializing it does not
			// reproduce the sender's bytes. Refused rather than coerced into a string
			// that hashes to something meaningless.
			expect(verifyDocumented(headers, { a: 1 }, ['sekret'], Date.now())).toBe(false);
			expect(verifyDocumented(headers, null, ['sekret'], Date.now())).toBe(false);

			// Every other malformed input answers false; a forgotten third argument
			// used to be the one that threw, turning a receiver typo into a 500.
			expect(() => verifyWebhookSignature(headers, bytes)).not.toThrow();
			expect(verifyWebhookSignature(headers, bytes)).toBe(false);
		});

		it('never throws on malformed containers and refuses non-finite freshness inputs', () => {
			const ts = String(Math.floor(Date.now() / 1000));
			const bytes = Buffer.from('body', 'utf8');
			const signature = (timestamp, body = bytes) =>
				'sha256=' + createHmac('sha256', 'sekret')
					.update(Buffer.concat([Buffer.from(`${timestamp}.`, 'latin1'), body]))
					.digest('hex');
			const headers = {
				'x-webhook-timestamp': ts,
				'x-webhook-signature': signature(ts)
			};

			const detached = new ArrayBuffer(bytes.length);
			new Uint8Array(detached).set(bytes);
			structuredClone(detached, { transfer: [detached] });

			for (const [label, verify] of [
				['null headers', () => verifyWebhookSignature(null, bytes, { secret: 'sekret' })],
				['malformed secrets', () => verifyWebhookSignature(headers, bytes, { secrets: 'sekret', nowMs: Date.now() })],
				['detached ArrayBuffer', () => verifyWebhookSignature(headers, detached, { secret: 'sekret', nowMs: Date.now() })]
			]) {
				expect(verify, label).not.toThrow();
				expect(verify(), label).toBe(false);
			}

			// NaN and Infinity made `age > tolerance` false, so a correctly
			// signed payload from 1970 verified forever instead of failing closed.
			const staleTs = '1';
			const staleHeaders = {
				'x-webhook-timestamp': staleTs,
				'x-webhook-signature': signature(staleTs)
			};
			expect(verifyWebhookSignature(staleHeaders, bytes, {
				secret: 'sekret',
				toleranceSeconds: Number.NaN
			})).toBe(false);
			expect(verifyWebhookSignature(staleHeaders, bytes, {
				secret: 'sekret',
				toleranceSeconds: Number.POSITIVE_INFINITY
			})).toBe(false);
			expect(verifyWebhookSignature(headers, bytes, {
				secret: 'sekret',
				nowMs: Number.NaN
			})).toBe(false);
		});

		it('bounds the timestamp header before parsing or signing it', () => {
			const ts = `0000000${Math.floor(Date.now() / 1000)}`;
			const body = Buffer.from('body', 'utf8');
			const sig = 'sha256=' + createHmac('sha256', 'sekret')
				.update(Buffer.concat([Buffer.from(`${ts}.`, 'latin1'), body]))
				.digest('hex');
			expect(ts.length).toBeGreaterThan(16);
			expect(verifyWebhookSignature({
				'x-webhook-timestamp': ts,
				'x-webhook-signature': sig
			}, body, { secret: 'sekret' })).toBe(false);
		});

		it('refuses an oversized signature header instead of parsing it', () => {
			const ts = String(Math.floor(Date.now() / 1000));
			const body = JSON.stringify({ n: 1 });
			const real = 'sha256=' + createHmac('sha256', 'sekret')
				.update(Buffer.concat([Buffer.from(`${ts}.`, 'latin1'), Buffer.from(body, 'utf8')]))
				.digest('hex');

			// The genuine entry is present, but buried in a header no sender emits.
			const flood = `${real},${'sha256=' + '0'.repeat(64)},`.repeat(500);
			expect(flood.length).toBeGreaterThan(1024);
			expect(
				verifyDocumented({ 'x-webhook-timestamp': ts, 'x-webhook-signature': flood }, body, ['sekret'], Date.now())
			).toBe(false);

			// A rotation-sized header still works - the bound must not break the
			// documented two-entry case.
			const rotation = `${'sha256=' + '0'.repeat(64)},${real}`;
			expect(
				verifyDocumented({ 'x-webhook-timestamp': ts, 'x-webhook-signature': rotation }, body, ['sekret'], Date.now())
			).toBe(true);
		});

		it('refuses a non-numeric timestamp, which is what keeps the delimiter unambiguous', () => {
			// Without the /^\d+$/ check a body containing a dot could be
			// re-split into a different (timestamp, body) pair signing the same
			// bytes. Craft exactly that: sign "1.2" + ".x", present it as
			// timestamp "1" with body "2.x".
			const forgedTs = '1.2';
			const forgedBody = '.x';
			const sig = 'sha256=' + createHmac('sha256', 'sekret').update(forgedTs + '.' + forgedBody).digest('hex');
			expect(verifyDocumented({ 'x-webhook-timestamp': forgedTs, 'x-webhook-signature': sig }, forgedBody, ['sekret'], 1000))
				.toBe(false);
			expect(verifyDocumented({ 'x-webhook-signature': sig }, forgedBody, ['sekret'], 1000)).toBe(false);
		});

		it('accepts either entry during a rotation, and neither when both secrets are wrong', async () => {
			const r = await deliverWebhook(cfg({ secret: 'new', previousSecret: 'old' }), 't', 'e', {});
			expect(r.ok).toBe(true);
			const rec = srv.received[0];
			const nowMs = Date.now();
			expect(verifyDocumented(rec.headers, rec.body, ['new'], nowMs)).toBe(true);
			expect(verifyDocumented(rec.headers, rec.body, ['old'], nowMs)).toBe(true);
			expect(verifyDocumented(rec.headers, rec.body, ['other'], nowMs)).toBe(false);
		});

		it('keeps one timestamp across every retry of a delivery', async () => {
			// The code comment promises this: a per-attempt timestamp would
			// make each retry a differently-signed message, and a receiver
			// deduplicating on the signature would treat them as distinct.
			let n = 0;
			srv.set((_req, res) => { n++; res.writeHead(n < 3 ? 503 : 200); res.end(); });
			const r = await deliverWebhook(cfg({ secret: 'sekret', retry: fastRetry }), 't', 'e', {});
			expect(r.ok).toBe(true);
			expect(srv.received).toHaveLength(3);
			const stamps = srv.received.map((x) => x.headers['x-webhook-timestamp']);
			const sigs = srv.received.map((x) => x.headers['x-webhook-signature']);
			expect(new Set(stamps).size).toBe(1);
			expect(new Set(sigs).size).toBe(1);
			expect(verifyDocumented(srv.received[2].headers, srv.received[2].body, ['sekret'], Date.now())).toBe(true);
		});

		it('uses the exact wall clock when the cached runtime clock is stale', async () => {
			// `now()` is deliberately cached at 1 Hz for hot paths. If the event
			// loop stalls, that cache can be minutes old until its interval runs;
			// signature freshness must not accept or emit against that stale
			// value on the first callback after the stall.
			const wallMs = Date.now();
			const staleMs = wallMs - 10 * 60 * 1000;
			setRuntimeEnv({ clock: { now: () => staleMs, wallEpoch: () => wallMs } });
			try {
				const r = await deliverWebhook(cfg({ secret: 'sekret' }), 't', 'e', {});
				expect(r.ok).toBe(true);
				const rec = srv.received[0];
				expect(rec.headers['x-webhook-timestamp']).toBe(String(Math.floor(wallMs / 1000)));
				expect(verifyWebhookSignature(rec.headers, rec.body, { secret: 'sekret' })).toBe(true);

				const staleTs = String(Math.floor(staleMs / 1000));
				const staleHeaders = {
					'x-webhook-timestamp': staleTs,
					'x-webhook-signature': 'sha256=' + createHmac('sha256', 'sekret')
						.update(staleTs + '.' + rec.body)
						.digest('hex')
				};
				expect(verifyWebhookSignature(staleHeaders, rec.body, { secret: 'sekret' })).toBe(false);
			} finally {
				resetRuntimeEnv();
			}
		});
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

	it('keeps the signature + idempotency headers on a same-origin redirect', async () => {
		srv.set((req, res) => {
			if (req.url === '/hook') { res.writeHead(302, { location: '/moved' }); res.end(); }
			else { res.writeHead(200); res.end(); }
		});
		const r = await deliverWebhook(cfg({ secret: 'sekret' }), 't', 'e', {});
		expect(r).toEqual({ ok: true });
		const source = srv.received.find((x) => x.url === '/hook');
		const target = srv.received.find((x) => x.url === '/moved');
		expect(target.headers['x-webhook-timestamp']).toBe(source.headers['x-webhook-timestamp']);
		expect(target.headers['x-webhook-signature']).toBe(source.headers['x-webhook-signature']);
		expect(target.headers['x-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
		expect(target.headers['x-webhook-timestamp']).toMatch(/^\d+$/);
		expect(target.headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
	});

	it('strips the auth-artifact headers on a cross-origin redirect hop', async () => {
		const other = makeServer();
		const otherPort = await other.listen();
		try {
			srv.set((_req, res) => {
				res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/stolen` });
				res.end();
			});
			const conf = {
				url: url(),
				urlMode: 'off',
				secret: 'sekret',
				retry: { attempts: 1 },
				validateUrl: (u) => u === url() || u === `http://127.0.0.1:${otherPort}/stolen`
			};
			const r = await deliverWebhook(conf, 't', 'e', { secret: 'tenant-data' });
			expect(r).toEqual({ ok: true });
			expect(other.received).toHaveLength(1);
			const hop = other.received[0];
			// The body is still delivered (following the redirect is the
			// feature) but NO auth artifacts cross the origin boundary.
			expect(hop.body).toContain('tenant-data');
			expect(hop.headers['x-webhook-signature']).toBeUndefined();
			expect(hop.headers['x-webhook-timestamp']).toBeUndefined();
			expect(hop.headers['idempotency-key']).toBeUndefined();
			expect(hop.headers['content-type']).toBe('application/json');
		} finally {
			await other.close();
		}
	});

	it('never leaks a path-carried credential into a persisted failure message', async () => {
		const r = await deliverWebhook(
			{ url: 'http://169.254.169.254/services/T000/B000/lIvEsEcReTtOkEn', retry: { attempts: 1 } },
			't', 'e', {}
		);
		expect(r.ok).toBe(false);
		expect(r.err.message).not.toContain('lIvEsEcReTtOkEn');
		expect(r.err.message).toContain('http://169.254.169.254');
	});

	it('opts out of delivery when transform returns null', async () => {
		const r = await deliverWebhook(cfg({ transform: () => null }), 't', 'e', {});
		expect(r).toEqual({ ok: true });
		expect(srv.received).toHaveLength(0);
	});

	describe('validated-pin cache', () => {
		const namedUrl = () => `http://pinned.test:${port}/hook`;

		it('reuses the validated pin across deliveries on one config when pinCacheMs is set', async () => {
			let resolves = 0;
			const config = { url: namedUrl(), urlMode: 'off', pinCacheMs: 60000, resolve: () => { resolves++; return Promise.resolve(['127.0.0.1']); } };
			expect(await deliverWebhook(config, 't', 'e', { n: 1 })).toEqual({ ok: true });
			expect(await deliverWebhook(config, 't', 'e', { n: 2 })).toEqual({ ok: true });
			expect(srv.received).toHaveLength(2);
			expect(resolves).toBe(1);
		});

		it('a custom resolver defaults the cache off (one resolution per delivery)', async () => {
			let resolves = 0;
			const config = { url: namedUrl(), urlMode: 'off', resolve: () => { resolves++; return Promise.resolve(['127.0.0.1']); } };
			await deliverWebhook(config, 't', 'e', {});
			await deliverWebhook(config, 't', 'e', {});
			expect(resolves).toBe(2);
		});

		it('pinCacheMs: 0 disables the cache explicitly', async () => {
			let resolves = 0;
			const config = { url: namedUrl(), urlMode: 'off', pinCacheMs: 0, resolve: () => { resolves++; return Promise.resolve(['127.0.0.1']); } };
			await deliverWebhook(config, 't', 'e', {});
			await deliverWebhook(config, 't', 'e', {});
			expect(resolves).toBe(2);
		});

		it('never caches a failed resolution', async () => {
			let resolves = 0;
			const config = {
				url: namedUrl(),
				urlMode: 'off',
				pinCacheMs: 60000,
				retry: { attempts: 1 },
				resolve: () => {
					resolves++;
					return resolves === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(['127.0.0.1']);
				}
			};
			const first = await deliverWebhook(config, 't', 'e', {});
			expect(first.ok).toBe(false);
			const second = await deliverWebhook(config, 't', 'e', {});
			expect(second).toEqual({ ok: true });
			expect(resolves).toBe(2);
		});

		it('keeps the cache isolated per config object', async () => {
			let a = 0;
			let bCount = 0;
			const configA = { url: namedUrl(), urlMode: 'off', pinCacheMs: 60000, resolve: () => { a++; return Promise.resolve(['127.0.0.1']); } };
			const configB = { url: namedUrl(), urlMode: 'off', pinCacheMs: 60000, resolve: () => { bCount++; return Promise.resolve(['127.0.0.1']); } };
			await deliverWebhook(configA, 't', 'e', {});
			await deliverWebhook(configB, 't', 'e', {});
			expect(a).toBe(1);
			expect(bCount).toBe(1);
		});
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

	it('blocks a named strict-mode target resolving to CGNAT before network I/O', async () => {
		const r = await deliverWebhook({
			url: 'http://metadata.test/hook',
			resolve: async () => ['100.100.100.200'],
			retry: { attempts: 1 },
			timeoutMs: 25
		}, 't', 'e', {});
		expect(r.ok).toBe(false);
		expect(r.attempts).toBe(0);
		expect(String(r.err.message)).toContain('cgnat');
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
