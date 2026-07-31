// Which allowance a delivery spends, when the destination host resolves to more
// than one address. The gate is only a ceiling if the bucket it charges belongs
// to the address the request lands on, and the caller controls both the contents
// and the order of its own DNS answer - so `deliverWebhook` charges EVERY
// address the SSRF gate pinned the socket to. Driven against a real loopback
// server with urlMode:'off' (strict mode blocks loopback by design) and a
// `resolve` seam standing in for the DNS answer; the decoy addresses are
// listed after the real one, so the socket connects to the loopback server and
// the decoys are never dialled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { deliverWebhook, createWebhookAdmission } from '../src/plugins/webhooks/server.js';

/** A loopback server that counts what it received. */
function makeServer() {
	const received = [];
	const server = createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => {
			received.push({ url: req.url });
			res.writeHead(200);
			res.end();
		});
	});
	return {
		received,
		listen() {
			return new Promise((resolve) => {
				server.listen(0, '127.0.0.1', () => resolve(server.address().port));
			});
		},
		close() { return new Promise((r) => server.close(r)); }
	};
}

describe('deliverWebhook admission keying across a multi-address answer', () => {
	let srv;
	let port;
	beforeEach(async () => {
		srv = makeServer();
		port = await srv.listen();
	});
	afterEach(async () => {
		await srv.close();
	});

	/** The bucket the real listener's traffic must be charged to. */
	const dest = () => `127.0.0.1:${port}`;
	/**
	 * Decoy addresses sorting BELOW 127.0.0.1 as strings and below it numerically:
	 * whichever single member of the set a gate might pick, a decoy can be made to
	 * win it. They are never dialled (the real address is first in the answer).
	 */
	const decoy = (n) => `100.64.0.${n}`;
	/** A delivery whose host resolves to the real listener plus decoys. */
	const padded = (...decoys) => ({
		url: `http://padded.test:${port}/hook`,
		urlMode: 'off',
		resolve: () => ['127.0.0.1', ...decoys],
		retry: { attempts: 1 },
		timeoutMs: 2000
	});
	/** An admission gate that records every key it is asked about. */
	const spy = (answer = true) => {
		const seen = [];
		return { seen, take: (d) => { seen.push(d); return answer; } };
	};

	it('charges every address the pin allows the socket to reach', async () => {
		const admission = spy();
		const r = await deliverWebhook(padded(decoy(1)), 't', 'e', {}, { admission });
		expect(r).toEqual({ ok: true });
		expect(srv.received).toHaveLength(1);
		expect(admission.seen).toEqual([`${decoy(1)}:${port}`, dest()]);
	});

	it('cannot mint a fresh allowance for one listener by padding the answer', async () => {
		// The defeat this closes. Every delivery reaches the same listener; only
		// the padding differs. If the charge picked one member of the set, each
		// delivery would key a bucket of its own and the listener's ceiling would
		// never be reached.
		const admission = createWebhookAdmission({ capacity: 1, refillPerSec: 0 });
		const first = await deliverWebhook(padded(decoy(1)), 't', 'e', {}, { admission });
		expect(first).toEqual({ ok: true });

		const second = await deliverWebhook(padded(decoy(2)), 't', 'e', {}, { admission });
		expect(second.ok).toBe(false);
		expect(second.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(second.err.message).toContain(dest());

		// And the plain, unpadded URL for the same listener is over its allowance
		// too: the padded deliveries spent the listener's own bucket, not a decoy's.
		const plain = await deliverWebhook(
			{ url: `http://127.0.0.1:${port}/hook`, urlMode: 'off' },
			't', 'e', {}, { admission }
		);
		expect(plain.ok).toBe(false);
		expect(plain.err.code).toBe('WEBHOOK_ADMISSION_DENIED');

		expect(srv.received).toHaveLength(1);
		expect(admission.tokensFor(dest())).toBe(0);
	});

	it('charges the same buckets whichever order the answer comes back in', async () => {
		// A rotating resolver must not look like a different destination each time.
		const rotated = (addresses) => ({
			url: `http://rotating.test:${port}/hook`,
			urlMode: 'off',
			resolve: () => addresses,
			retry: { attempts: 1 },
			timeoutMs: 2000
		});
		const first = spy();
		await deliverWebhook(rotated(['127.0.0.1', decoy(1)]), 't', 'e', {}, { admission: first });
		const second = spy();
		await deliverWebhook(rotated([decoy(1), '127.0.0.1']), 't', 'e', {}, { admission: second });
		expect(second.seen).toEqual(first.seen);
		expect(first.seen).toEqual([`${decoy(1)}:${port}`, dest()]);
	});

	it('charges a repeated address once', async () => {
		const admission = spy();
		const r = await deliverWebhook(
			{
				url: `http://doubled.test:${port}/hook`,
				urlMode: 'off',
				resolve: () => ['127.0.0.1', '127.0.0.1']
			},
			't', 'e', {}, { admission }
		);
		expect(r).toEqual({ ok: true });
		expect(admission.seen).toEqual([dest()]);
	});

	it('charges exactly the literal when the url carries an ip address', async () => {
		const admission = spy();
		await deliverWebhook({ url: `http://127.0.0.1:${port}/hook`, urlMode: 'off' }, 't', 'e', {}, { admission });
		expect(admission.seen).toEqual([dest()]);
	});

	it('names the address that refused and sends nothing after a part-way refusal', async () => {
		// The residual, pinned as behaviour: the gate can only take, so the unit
		// spent at the address checked before the refusal stays spent. The delivery
		// costs more than it sent - and it sent nothing.
		const seen = [];
		const admission = {
			take: (d) => { seen.push(d); return d !== dest(); }
		};
		const r = await deliverWebhook(padded(decoy(1)), 't', 'e', {}, { admission });
		expect(r.ok).toBe(false);
		expect(r.err.code).toBe('WEBHOOK_ADMISSION_DENIED');
		expect(r.err.message).toContain(dest());
		expect(seen).toEqual([`${decoy(1)}:${port}`, dest()]);
		expect(srv.received).toHaveLength(0);
	});

	it('pins and charges at most the address cap, however wide the answer', async () => {
		// One delivery must not be able to charge an unbounded number of buckets:
		// the pin keeps the first 32 addresses of the answer, and those are exactly
		// the addresses the socket may use and the buckets that are charged.
		const admission = spy();
		const wide = ['127.0.0.1'];
		for (let i = 1; i <= 40; i++) wide.push(decoy(i));
		const r = await deliverWebhook(
			{
				url: `http://wide.test:${port}/hook`,
				urlMode: 'off',
				resolve: () => wide,
				retry: { attempts: 1 },
				timeoutMs: 2000
			},
			't', 'e', {}, { admission }
		);
		expect(r).toEqual({ ok: true });
		expect(srv.received).toHaveLength(1);
		expect(admission.seen).toHaveLength(32);
		expect(admission.seen).toContain(dest());
	});
});
