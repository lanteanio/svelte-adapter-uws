// ADAPTER-ERR-AUTHENTICATE, ADAPTER-ERR-RESUME-HOOK,
// ADAPTER-ERR-SENDTO-ASYNC-FILTER and the OPEN / DRAIN / CLOSE hook entries,
// driven from the conditions they claim against the built runtime, through the
// hookcrash fixture variant whose hooks fail only on an env-gated token.
//
// The lifecycle entries promise containment on the real transport. The built
// handler runs inside this test process, so a throw that escaped a uWS
// callback would surface here as an unhandled error; what each case requires
// of a contained failure is the 1011 close the client reads, the indexed line
// with the original error, and a bystander and a new connection still served.
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

	it('ADMIN-HANDLER: that one admin request answers 500, and the next one does not', async () => {
		// The entry's consequence is entirely about blast radius - "That one
		// admin request answered 500. Application traffic and WebSocket
		// delivery are unaffected" - and its recovery is that the NEXT request
		// runs the handler again. Both are asserted here in the same process,
		// because an entry claiming containment is worth nothing if the case
		// only ever sees the failure.
		const events = [];
		diagnostic.setOperationalEventSink((record) => { events.push(record); });

		const bystander = await connectRealClient(server.wsUrl);
		try {
			const failed = await fetch(`${server.httpUrl}/__realtime/status`, {
				headers: { 'x-hook-crash': token }
			});
			expect(failed.status, 'the entry promises this one request answers 500').toBe(500);

			const hit = events.find((e) => e.event === 'admin.handler-failed');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.severity).toBe('error');
			// "Read the attached error attribute and fix the admin handler" -
			// guidance that is only actionable if the record carries the throw.
			expect(JSON.stringify(hit.attributes)).toContain('__ADMIN_HOOK_CRASH__');

			// "the next admin request runs the handler again": no latch, no
			// breaker, and the route is not left poisoned by the throw.
			const healthy = await fetch(`${server.httpUrl}/__realtime/status`);
			expect(healthy.status).toBe(200);
			expect((await healthy.json()).ok).toBe(true);

			// "Application traffic and WebSocket delivery are unaffected", on a
			// socket that was already open when the admin handler threw.
			expect(bystander.ws.readyState).toBe(1);
			const page = await fetch(`${server.httpUrl}/`);
			expect(page.status).toBe(200);
		} finally {
			bystander.close();
		}
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

	/**
	 * A real client on one lifecycle lane, its close observed from before the
	 * handshake: a failing open hook closes the connection inside the callback
	 * that accepted it. With `stall`, the client stops reading from the moment
	 * the upgrade answers and resumes shortly after open, so what the server
	 * sends in between backs up in uWS instead of in the kernel.
	 * @param {string} lane
	 * @param {{ stall?: boolean }} [opts]
	 */
	async function laneClient(lane, { stall = false } = {}) {
		const { WebSocket } = await import('ws');
		const ws = new WebSocket(server.wsUrl, { headers: { 'x-request-id': `lifecycle-${lane}-${token}` } });
		ws.on('error', () => {});
		if (stall) ws.once('upgrade', (response) => response.socket.pause());
		let received = 0;
		ws.on('message', (data) => { received += data.length; });
		const closed = new Promise((resolve) => {
			ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), received }));
		});
		await new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('unexpected-response', () => reject(new Error('upgrade refused')));
			ws.once('close', () => reject(new Error('closed before open')));
		});
		if (stall) {
			ws.pause();
			setTimeout(() => ws.resume(), 200);
		}
		return { ws, closed };
	}

	/** @param {Promise<any>} closed @param {number} ms */
	function within(closed, ms) {
		return Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
	}

	/** @param {import('vitest').MockInstance} spy @param {string} id */
	async function consoleLine(spy, id, ms = 3000) {
		const deadline = Date.now() + ms;
		for (;;) {
			const hit = spy.mock.calls.find((c) => String(c[0]).includes('[' + id + ']'));
			if (hit || Date.now() >= deadline) return hit ?? null;
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	/** Other connections are served: the bystander round-trips, and so does a new one. */
	async function workerStillServes(bystander, ref) {
		bystander.send({ type: 'subscribe', topic: 'test-topic', ref });
		expect(
			await bystander.waitFor((m) => m?.type === 'subscribed' && m?.ref === ref, 3000),
			'a connection open before the failure is still served'
		).toBeTruthy();
		const fresh = await connectRealClient(server.wsUrl);
		try {
			expect(await fresh.waitFor((m) => m?.type === 'welcome', 3000), 'a new connection is admitted').toBeTruthy();
		} finally {
			fresh.close();
		}
	}

	for (const mode of ['throws', 'rejects']) {
		it.each([false, true])(`MESSAGE-HOOK (${mode}, logger throws: %s): closes only the failing connection`, async (loggerThrows) => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => { if (loggerThrows) throw new Error('logger unavailable'); });
			const bystander = await connectRealClient(server.wsUrl);
			const offender = await connectRealClient(server.wsUrl);
			try {
				const closed = new Promise(resolve => offender.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
				offender.send({ type: 'message-hook-failure', token, mode });
				expect(await within(closed, 3000)).toEqual({ code: 1011, reason: 'Message handler error' });
				const line = await consoleLine(error, 'ADAPTER-ERR-MESSAGE-HOOK');
				expect(line?.[1]?.message).toBe('__MESSAGE_HOOK_' + mode.toUpperCase() + '__');
				await workerStillServes(bystander, 14);
			} finally {
				offender.close();
				bystander.close();
			}
		});
	}

	for (const [lane, cause, loggerThrows] of [['open-throws', '__OPEN_HOOK_CRASH__'], ['open-rejects', '__OPEN_HOOK_REJECT__']].flatMap(([lane, cause]) => [false, true].map(loggerThrows => [lane, cause, loggerThrows]))) {
		it(`OPEN-HOOK (${lane}, logger throws: ${loggerThrows}): that connection closes 1011, the worker keeps serving`, async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => { if (loggerThrows) throw new Error('logger unavailable'); });
			// The entry says the close hook runs for the failed connection as for
			// any other close; the fixture's close hook reports its lane here.
			const closedLanes = [];
			const onClose = (closedLane) => closedLanes.push(closedLane);
			let bystander = null;
			try {
				process.on('hookcrash:lifecycle-close', onClose);
				bystander = await connectRealClient(server.wsUrl);
				const client = await laneClient(lane);
				const closed = await within(client.closed, 3000);
				expect(closed, 'the failing connection is closed, not left open').toBeTruthy();
				expect(closed.code).toBe(1011);
				expect(closed.reason).toBe('Open handler error');
				const line = await consoleLine(error, 'ADAPTER-ERR-OPEN-HOOK');
				expect(line, 'the indexed line is printed').toBeTruthy();
				expect(String(line[0]).startsWith('[ws] the open hook threw')).toBe(true);
				expect(line[1]?.message, 'printed with the original throw').toBe(cause);
				expect(closedLanes, 'the close hook ran for the failed connection').toEqual([lane]);
				await workerStillServes(bystander, 11);
			} finally {
				process.off('hookcrash:lifecycle-close', onClose);
				bystander?.close();
			}
		});
	}

	it.each([false, true])('DRAIN-HOOK (logger throws: %s): closes 1011 after queued bytes, the worker keeps serving', async (loggerThrows) => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => { if (loggerThrows) throw new Error('logger unavailable'); });
		const bystander = await connectRealClient(server.wsUrl);
		try {
			const client = await laneClient('drain-throws', { stall: true });
			const closed = await within(client.closed, 10000);
			expect(closed, 'the failing connection is closed, not left open').toBeTruthy();
			expect(closed.code).toBe(1011);
			expect(closed.reason).toBe('Drain handler error');
			// The close frame goes out behind what was already queued, so the
			// client reads at least the chunk that backed up before it.
			expect(closed.received).toBeGreaterThanOrEqual(1024 * 1024);
			const line = await consoleLine(error, 'ADAPTER-ERR-DRAIN-HOOK');
			expect(line, 'the indexed line is printed').toBeTruthy();
			expect(line[1]?.message).toBe('__DRAIN_HOOK_CRASH__');
			await workerStillServes(bystander, 12);
		} finally {
			bystander.close();
		}
	}, 30000);

	for (const [lane, cause, loggerThrows] of [['close-throws', '__CLOSE_HOOK_CRASH__'], ['close-rejects', '__CLOSE_HOOK_REJECT__']].flatMap(([lane, cause]) => [false, true].map(loggerThrows => [lane, cause, loggerThrows]))) {
		it(`CLOSE-HOOK (${lane}, logger throws: ${loggerThrows}): only the line, and the worker keeps serving`, async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => { if (loggerThrows) throw new Error('logger unavailable'); });
			const bystander = await connectRealClient(server.wsUrl);
			try {
				const client = await laneClient(lane);
				client.ws.close(1000, 'bye');
				expect(await within(client.closed, 3000)).toBeTruthy();
				const line = await consoleLine(error, 'ADAPTER-ERR-CLOSE-HOOK');
				expect(line, 'the indexed line is printed').toBeTruthy();
				expect(String(line[0]).startsWith('[ws] the close hook threw')).toBe(true);
				expect(line[1]?.message, 'printed with the original throw').toBe(cause);
				await workerStillServes(bystander, 13);
			} finally {
				bystander.close();
			}
		});
	}

	it('the lifecycle lanes stay quiet for a connection that did not opt in', async () => {
		// The control for every case above: the close code and the lines are
		// driven by the failing hook, not by opening and closing.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = await connectRealClient(server.wsUrl);
		expect(await client.waitFor((m) => m?.type === 'welcome', 3000)).toBeTruthy();
		const closed = new Promise((resolve) => client.ws.on('close', (code) => resolve(code)));
		client.ws.close(1000);
		expect(await within(closed, 3000)).not.toBeNull();
		await new Promise((r) => setTimeout(r, 100));
		const lines = error.mock.calls.filter((c) => /\[ADAPTER-ERR-(OPEN|DRAIN|CLOSE)-HOOK\]/.test(String(c[0])));
		expect(lines).toHaveLength(0);
	});
});
