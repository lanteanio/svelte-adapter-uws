// ADAPTER-ERR-AUTHENTICATE, ADAPTER-ERR-RESUME-HOOK, and
// ADAPTER-ERR-SENDTO-ASYNC-FILTER, driven from the conditions they claim
// against the built runtime, through the hookcrash fixture variant whose
// hooks fail only on an env-gated token.
//
// AUTHENTICATE promises an ordinary 500 on the auth POST with upgrades and
// established connections untouched. RESUME-HOOK promises the harder half:
// the client is still sent `resumed`, so it believes its gap was handled -
// the case must see BOTH the emitted event and the ack. SENDTO-ASYNC-FILTER
// promises fail-closed delivery (count zero) and a once-per-worker warning.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('the hook-failure entries against the built runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	let diagnostic = null;
	const token = randomUUID();

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'hookcrash' });
		process.env.HOOK_CRASH_DRILL_TOKEN = token;
		// The sink must be the module instance the BUILT runtime emits through.
		diagnostic = await import('./fixture/build-hook-crash/diagnostic.js');
	}, 400000);

	afterAll(async () => {
		delete process.env.HOOK_CRASH_DRILL_TOKEN;
		if (server) await server.stop();
	});

	afterEach(() => {
		if (diagnostic) diagnostic.setOperationalEventSink(null);
		vi.restoreAllMocks();
	});

	it('AUTHENTICATE: the failing POST answers 500 while connections and HTTP stay up', async () => {
		const events = [];
		diagnostic.setOperationalEventSink((record) => { events.push(record); });

		// An established connection from BEFORE the failure, the entry's
		// untouched bystander.
		const bystander = await connectRealClient(server.wsUrl);
		try {
			const failed = await fetch(`${server.httpUrl}/__ws/auth`, {
				method: 'POST',
				headers: { 'x-hook-crash': token }
			});
			expect(failed.status).toBe(500);
			const hit = events.find((e) => e.event === 'runtime.authenticate.failed');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.attributes.error).toBeTruthy();

			// The entry scopes the damage to that one POST: the endpoint keeps
			// answering without the crash header, and the bystander still
			// receives traffic.
			const healthy = await fetch(`${server.httpUrl}/__ws/auth`, { method: 'POST' });
			expect(healthy.status).not.toBe(500);
			bystander.send({ type: 'subscribe', topic: 'test-topic', ref: 1 });
			const alive = await bystander.waitFor((m) => m?.type === 'subscribed' && m?.ref === 1, 3000);
			expect(alive, 'the established connection must be untouched').toBeTruthy();
		} finally {
			bystander.close();
		}
	});

	it('RESUME_HOOK: the event is emitted and the client is STILL sent resumed', async () => {
		const events = [];
		diagnostic.setOperationalEventSink((record) => { events.push(record); });
		const client = await connectRealClient(server.wsUrl);
		try {
			client.send({
				type: 'resume',
				sessionId: 'hook-crash-session',
				lastSeenSeqs: { ['crash:' + token]: 1 }
			});
			// The consequence's exact double: the failure is reported AND the
			// ack still goes out, so the client believes its gap was handled.
			const resumed = await client.waitFor((m) => m?.type === 'resumed', 3000);
			expect(resumed, 'the resumed ack is not conditional on the hook').toBeTruthy();
			const hit = events.find((e) => e.event === 'resume.hook-failed');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.attributes.error.message).toContain('__RESUME_HOOK_CRASH__');
		} finally {
			client.close();
		}
	});

	it('SENDTO_ASYNC_FILTER: fail-closed counts and a once-per-worker warning', async () => {
		const error = vi.spyOn(console, 'error');
		const client = await connectRealClient(server.wsUrl);
		try {
			// Subscribed, so a working synchronous filter would have someone
			// to deliver to - zero must mean refused, not empty.
			client.send({ type: 'subscribe', topic: 'test-topic', ref: 1 });
			await client.waitFor((m) => m?.type === 'subscribed' && m?.ref === 1, 3000);
			const nonce = randomUUID();
			client.send({ type: 'sendto-async-drill', token, nonce });
			const reply = await client.waitFor((m) => m?.event === 'sendto-async-drill' && m?.data?.nonce === nonce, 3000);
			expect(reply, 'the drill reply must arrive').toBeTruthy();
			expect(reply.parsed.data.first).toBe(0);
			expect(reply.parsed.data.second).toBe(0);
			// Fail-closed means no delivery either, bound apart from the count.
			expect(await client.waitFor((m) => m?.event === 'dm', 300)).toBeNull();
			const indexed = error.mock.calls.filter((c) => String(c[0]).includes('[ADAPTER-ERR-SENDTO-ASYNC-FILTER]'));
			expect(indexed, 'the warning prints once per worker, not per call').toHaveLength(1);
		} finally {
			client.close();
		}
	});
});
