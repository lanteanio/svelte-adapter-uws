// ADAPTER-ERR-ATTRIBUTION and the attribution contract, driven from the
// conditions they claim against the BUILT runtime, through the attribution
// fixture variant whose resolver behavior is selected per connection by
// upgrade headers.
//
// The registry entry promises the connection is refused with close 1008
// before the application open hook runs, with one indexed error line; the
// contract promises the healthy path stores one frozen result the public
// accessor reads back, and that the unattributed path is untouched. All of
// that is asserted on what the CLIENT observes plus the emitted diagnostic -
// the frames and close code on a real socket.
//
// ONE VARIANT PER TEST FILE, for the reason given in helpers/real-runtime.js.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasUWS, startRealRuntime } from './helpers/real-runtime.js';

const describeUWS = hasUWS ? describe : describe.skip;

/**
 * A real `ws` client that also records its close. The shared connectRealClient
 * resolves on 'open' only; the refusal cases here need the close code and must
 * tolerate frames-then-close orderings.
 * @param {string} wsUrl
 * @param {Record<string, string>} headers
 */
async function connectRecordingClose(wsUrl, headers) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl, { headers });
	/** @type {any[]} */
	const frames = [];
	/** @type {{ code: number, reason: string } | null} */
	let closed = null;
	const closedPromise = new Promise((resolve) => {
		ws.on('close', (code, reason) => {
			closed = { code, reason: reason.toString() };
			resolve(closed);
		});
	});
	ws.on('message', (data) => {
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	return {
		ws,
		frames,
		get closed() { return closed; },
		closedPromise,
		/** @param {unknown} msg */
		send(msg) { ws.send(JSON.stringify(msg)); },
		/**
		 * @param {(f: any) => boolean} predicate
		 * @param {number} [ms]
		 */
		async waitFor(predicate, ms = 3000) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = frames.find(predicate);
				if (hit) return hit;
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		close() { try { ws.terminate(); } catch { /* already gone */ } }
	};
}

describeUWS('attribution against the built runtime', () => {
	/** @type {Awaited<ReturnType<typeof startRealRuntime>> | null} */
	let server = null;
	let diagnostic = null;

	beforeAll(async () => {
		server = await startRealRuntime({ variant: 'attribution' });
		// The sink must be the module instance the BUILT runtime emits through.
		diagnostic = await import('./fixture/build-attribution/diagnostic.js');
	}, 400000);

	afterAll(async () => {
		if (server) await server.stop();
	});

	afterEach(() => {
		if (diagnostic) diagnostic.setOperationalEventSink(null);
	});

	it('the healthy path: one frozen result, readable through the public accessor', async () => {
		const client = await connectRecordingClose(server.wsUrl, {
			'x-attr-mode': 'ok',
			'x-attr-tenant': 'acme',
			'x-attr-principal': 'user_1'
		});
		try {
			expect(await client.waitFor((f) => f.type === 'welcome')).toBeTruthy();
			const nonce = randomUUID();
			client.send({ type: 'attribution-probe', nonce });
			const probe = await client.waitFor((f) => f.event === 'attribution-probe' && f.data?.nonce === nonce);
			expect(probe, 'the probe reply must arrive').toBeTruthy();
			expect(probe.data.attribution).toEqual({ tenantId: 'acme', principalId: 'user_1' });
			expect(probe.data.frozen).toBe(true);
		} finally {
			client.close();
		}
	});

	it('the unattributed path is unchanged: welcome, null accessor, working lane', async () => {
		const client = await connectRecordingClose(server.wsUrl, {});
		try {
			expect(await client.waitFor((f) => f.type === 'welcome')).toBeTruthy();
			const nonce = randomUUID();
			client.send({ type: 'attribution-probe', nonce });
			const probe = await client.waitFor((f) => f.event === 'attribution-probe' && f.data?.nonce === nonce);
			expect(probe.data.attribution).toBeNull();
			expect(probe.data.frozen).toBeNull();
		} finally {
			client.close();
		}
	});

	it('an invalid id closes 1008 before welcome, with the indexed diagnostic', async () => {
		const events = [];
		diagnostic.setOperationalEventSink((record) => { events.push(record); });
		const client = await connectRecordingClose(server.wsUrl, { 'x-attr-mode': 'invalid' });
		try {
			const closed = await client.closedPromise;
			expect(closed.code).toBe(1008);
			expect(client.frames.find((f) => f.type === 'welcome')).toBeUndefined();
			const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.attributes.error.message).toContain('attribution.tenantId');
		} finally {
			client.close();
		}
	});

	it('a throwing resolver closes 1008 with the resolver error attached', async () => {
		const events = [];
		diagnostic.setOperationalEventSink((record) => { events.push(record); });
		const client = await connectRecordingClose(server.wsUrl, { 'x-attr-mode': 'throw' });
		try {
			const closed = await client.closedPromise;
			expect(closed.code).toBe(1008);
			const hit = events.find((e) => e.event === 'runtime.websocket-attribution.failed');
			expect(hit, 'the entry event must be emitted').toBeTruthy();
			expect(hit.attributes.error.message).toContain('__ATTRIBUTION_RESOLVER_CRASH__');
		} finally {
			client.close();
		}
	});

	it('a refused connection runs neither app lifecycle hook; an admitted one runs both', async () => {
		// close mirrors open: a counter paired across open/close must not go
		// negative under attribution refusals. Counters live in the BUILT
		// fixture and are read through the probe lane, so the assertion
		// surface is a client-observed frame from the real runtime.
		const probeVia = async (client) => {
			const nonce = randomUUID();
			client.send({ type: 'lifecycle-probe', nonce });
			const probe = await client.waitFor((f) => f.event === 'lifecycle-probe' && f.data?.nonce === nonce);
			expect(probe, 'the lifecycle probe reply must arrive').toBeTruthy();
			return probe.data;
		};
		const observer = await connectRecordingClose(server.wsUrl, {});
		try {
			expect(await observer.waitFor((f) => f.type === 'welcome')).toBeTruthy();
			const before = await probeVia(observer);

			// Refused: 1008, and neither hook may have moved.
			const refused = await connectRecordingClose(server.wsUrl, { 'x-attr-mode': 'invalid' });
			expect((await refused.closedPromise).code).toBe(1008);
			refused.close();
			const afterRefusal = await probeVia(observer);
			expect(afterRefusal.open).toBe(before.open);
			expect(afterRefusal.close).toBe(before.close);

			// Admitted: both hooks move across the connection's life, so the
			// refusal guard demonstrably keys on the refusal, not on close in
			// general.
			const admitted = await connectRecordingClose(server.wsUrl, {
				'x-attr-mode': 'ok', 'x-attr-tenant': 'acme'
			});
			expect(await admitted.waitFor((f) => f.type === 'welcome')).toBeTruthy();
			admitted.close();
			await admitted.closedPromise;
			// The close hook runs in the server's close callback; poll the
			// counters through the probe until it lands.
			const deadline = Date.now() + 3000;
			let afterClose = await probeVia(observer);
			while (afterClose.close !== before.close + 1 && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 25));
				afterClose = await probeVia(observer);
			}
			expect(afterClose.open).toBe(before.open + 1);
			expect(afterClose.close).toBe(before.close + 1);
		} finally {
			observer.close();
		}
	});
});
