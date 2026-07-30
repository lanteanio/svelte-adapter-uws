// The three socket surfaces, driven through the SAME scenarios, asserted to
// give the SAME client-visible answer.
//
// WHY THIS EXISTS, and why the source-scanning oracle is not enough. An
// adversarial pass neutered the shared policy on one surface at a time by
// changing only the ARGUMENTS at a call site - `armed: false`, `held: !isNew`,
// `cancelled: false`, `hasResumeHook: false`. The call stays, so the call counts
// are unchanged; no spelling changes, so no pattern matches; the predicate's own
// truth table is untouched, so it stays green. Fifteen such mutations survived
// every check the project had, including "production's wire-subscribe gate is
// dead". Seven of them also survived all sixteen behavioural suites, because
// each suite drives ONE surface and a mutation applied to one surface is
// invisible to a test that never asks the others.
//
// A source scan cannot see arguments; only behaviour can. And the property that
// makes behaviour cheap to check here is that the three surfaces are supposed to
// AGREE: neutering one makes it disagree with the other two, whatever the
// spelling. So each scenario below runs on all three and the answers are
// compared to each other, not to a hardcoded expectation - though the expected
// answer is pinned too, so that neutering all three the same way is caught as
// well.
//
// Production needs the native binding and a built fixture; when it is absent the
// suite still runs the two in-process surfaces against each other rather than
// skipping wholesale, and says so.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { hasUWS, startRealRuntime, connectRealClient } from './helpers/real-runtime.js';

/** Teardown registered by whichever adapters a scenario booted. */
let teardown = [];

afterEach(async () => {
	for (const fn of teardown.reverse()) {
		try { await fn(); } catch { /* already down */ }
	}
	teardown = [];
});

// The app handler every surface is given: NO `subscribe` and NO `subscribeBatch`
// export, because either one takes the topic decision back from the server-grant
// model and would leave the armed gate inert - a test driving that would pass
// against a server that never denies anything. A `message` hook provides the
// trusted server-side grant, mirroring test/fixture/src/hooks.ws.grant.js so
// production runs the same shape.
function grantHandler() {
	return {
		// Mirrors test/fixture/src/hooks.ws.grant.js, which is what production
		// runs. Both must stay the same shape or the differential is comparing
		// three servers that were asked different questions.
		async resume(ws, { lastSeenSeqs, platform }) {
			platform.send(ws, 'probe', 'resume-topics', { topics: Object.keys(lastSeenSeqs || {}) });
		},
		async message(ws, { data, platform }) {
			let msg;
			try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
			if (msg?.type === 'grant') {
				const denial = await platform.subscribe(ws, msg.topic);
				platform.send(ws, 'probe', 'granted', { topic: msg.topic, denial: denial ?? null });
			}
			if (msg?.type === 'observe-check') {
				const denial = await platform.checkSubscribe(ws, msg.topic, { requireGrant: true });
				platform.send(ws, 'probe', 'observe-result', { topic: msg.topic, ref: msg.ref, denial: denial ?? null });
			}
		}
	};
}

/**
 * A uniform client over whichever transport the surface uses.
 * @param {any} raw - an object with send/waitFor/close
 */
function clientApi(raw) {
	return {
		send: (obj) => raw.send(obj),
		/** The answer to a subscribe with this ref, as {type, reason}. */
		async subscribeAnswer(topic, ref) {
			raw.send({ type: 'subscribe', topic, ref });
			const hit = await raw.waitFor((p) => p?.ref === ref && p?.topic === topic, 2000);
			if (hit === null) return { type: '(no answer)', reason: null };
			const p = hit.parsed ?? hit;
			return { type: p.type, reason: p.reason ?? null };
		},
		/**
		 * Subscribe WITH a recover offset, and report both the answer and whether
		 * any replay history came back. The recover lane was invisible to this
		 * suite, which is why `cancelled: false` and `hasResumeHook: false`
		 * survived every check the project had.
		 */
		async subscribeRecovering(topic, ref) {
			raw.send({ type: 'subscribe', topic, ref, recover: { offset: 0 } });
			const hit = await raw.waitFor((p) => p?.ref === ref && p?.topic === topic, 2000);
			const replay = await raw.waitFor((p) => p?.event === 'resume-topics', 300);
			const p = hit === null ? null : (hit.parsed ?? hit);
			const seen = replay === null ? null : ((replay.parsed ?? replay).data?.topics ?? null);
			return {
				type: p === null ? '(no answer)' : p.type,
				// Only whether THIS topic's history was served - the list may carry
				// other topics from earlier scenarios on the same connection.
				servedHistory: Array.isArray(seen) ? seen.includes(topic) : false
			};
		},
		/** The observer lane, which decides whether a connection may watch a topic. */
		async observe(topic, ref) {
			raw.send({ type: 'observe-check', topic, ref });
			const hit = await raw.waitFor((p) => p?.event === 'observe-result' && p?.data?.ref === ref, 2000);
			return hit === null ? '(no answer)' : ((hit.parsed ?? hit).data?.denial ?? null);
		},
		async grant(topic) {
			raw.send({ type: 'grant', topic });
			const hit = await raw.waitFor((p) => p?.event === 'granted' && (p?.data?.topic === topic), 2000);
			if (hit === null) return { granted: false, denial: '(no answer)' };
			const p = hit.parsed ?? hit;
			return { granted: p.data?.denial === null, denial: p.data?.denial ?? null };
		},
		/** The answer type for one topic of an already-sent batch frame. */
		async awaitTopic(topic, ref) {
			const hit = await raw.waitFor((p) => p?.ref === ref && p?.topic === topic, 2000);
			return hit === null ? '(no answer)' : (hit.parsed ?? hit).type;
		},
		close: () => raw.close()
	};
}

// ---------------------------------------------------------------------------
// Adapters. Each boots its surface with the wire-subscribe gate ARMED and the
// hook-free handler above, and returns a factory for fresh clients.
// ---------------------------------------------------------------------------

async function bootProduction() {
	const server = await startRealRuntime({ variant: 'grant' });
	teardown.push(() => server.stop());
	return {
		async client() {
			const c = await connectRealClient(server.wsUrl);
			teardown.push(() => c.close());
			return clientApi(c);
		}
	};
}

async function bootTesting() {
	const { createTestServer } = await import('../src/testing.js');
	const server = await createTestServer({ authorizeWireSubscribe: true, handler: grantHandler() });
	teardown.push(() => server.close());
	return {
		async client() {
			const { WebSocket } = await import('ws');
			const ws = new WebSocket(server.wsUrl);
			const frames = [];
			ws.on('message', (d) => frames.push(d.toString()));
			await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
			teardown.push(() => { try { ws.terminate(); } catch { /* gone */ } });
			return clientApi(wsClient(ws, frames));
		}
	};
}

async function bootDev() {
	const mod = await import('../src/vite.js');
	const handler = grantHandler();
	const plugin = mod.default({ allowedOrigins: '*', authorizeWireSubscribe: true, handler: '/virtual-ws-handler' });

	const httpServer = createServer();
	await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
	const port = httpServer.address().port;
	teardown.push(() => new Promise((r) => httpServer.close(() => r(undefined))));

	await plugin.configureServer({
		httpServer,
		middlewares: { use() {} },
		config: { root: process.cwd(), logger: { warn() {}, info() {}, error() {} }, server: {} },
		async ssrLoadModule() { return { default: handler, ...handler }; }
	});

	return {
		async client() {
			const { WebSocket } = await import('ws');
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
			const frames = [];
			ws.on('message', (d) => frames.push(d.toString()));
			await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
			await new Promise((r) => setTimeout(r, 40));
			teardown.push(() => { try { ws.terminate(); } catch { /* gone */ } });
			return clientApi(wsClient(ws, frames));
		}
	};
}

/** The `ws`-based client shape the real-runtime helper exposes, for the two in-process surfaces. */
function wsClient(ws, frames) {
	return {
		send: (obj) => ws.send(JSON.stringify(obj)),
		async waitFor(predicate, ms = 500) {
			const deadline = Date.now() + ms;
			for (;;) {
				for (const raw of frames) {
					let parsed = null;
					try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
					if (predicate(parsed, raw)) return { parsed, raw };
				}
				if (Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		close() { try { ws.terminate(); } catch { /* gone */ } }
	};
}

const ADAPTERS = [
	...(hasUWS ? [{ label: 'production', boot: bootProduction }] : []),
	{ label: 'testing', boot: bootTesting },
	{ label: 'dev', boot: bootDev }
];

// ---------------------------------------------------------------------------
// Scenarios. Each returns a plain, comparable answer.
// ---------------------------------------------------------------------------

const SCENARIOS = [
	{
		name: 'an ungranted topic is refused under an armed gate',
		// Kills: `armed: false` and `hasUserHook: true` at the pre-hook gate on
		// any single surface, and `held: true` at either gate.
		expected: { type: 'subscribe-denied', reason: 'FORBIDDEN' },
		async run(surface) {
			const c = await surface.client();
			return c.subscribeAnswer('private-room', 1);
		}
	},
	{
		name: 'a topic the server granted on this connection is admitted',
		// Kills: `held: false` / `held: !isNew` drift at the landing, and any
		// mutation that makes the gate deny unconditionally (which the scenario
		// above would otherwise let pass as "still denying").
		expected: { type: 'subscribed', reason: null },
		async run(surface) {
			const c = await surface.client();
			const g = await c.grant('granted-room');
			expect(g.granted, 'the trusted server-side grant must succeed').toBe(true);
			return c.subscribeAnswer('granted-room', 2);
		}
	},
	{
		name: 'the grant is scoped to the connection that received it',
		// Kills: reading membership from anywhere but THIS connection.
		expected: { type: 'subscribe-denied', reason: 'FORBIDDEN' },
		async run(surface) {
			const owner = await surface.client();
			const g = await owner.grant('scoped-room');
			expect(g.granted).toBe(true);
			const other = await surface.client();
			return other.subscribeAnswer('scoped-room', 3);
		}
	},
	{
		name: 'a re-subscribe to a held topic is acked idempotently',
		// Kills: a landing that answers from the pre-await snapshot rather than
		// current membership.
		expected: { type: 'subscribed', reason: null },
		async run(surface) {
			const c = await surface.client();
			expect((await c.grant('twice-room')).granted).toBe(true);
			await c.subscribeAnswer('twice-room', 4);
			return c.subscribeAnswer('twice-room', 5);
		}
	},
	{
		name: 'a batch mixing a granted and an ungranted topic answers each on its own merits',
		// Kills: the batch lane's pre-hook map and landing being neutered
		// independently of the single lane - the asymmetry that started this.
		expected: { granted: 'subscribed', ungranted: 'subscribe-denied' },
		async run(surface) {
			const c = await surface.client();
			expect((await c.grant('batch-ok')).granted).toBe(true);
			c.send({ type: 'subscribe-batch', topics: ['batch-ok', 'batch-no'], ref: 6 });
			return {
				granted: await c.awaitTopic('batch-ok', 6),
				ungranted: await c.awaitTopic('batch-no', 6)
			};
		}
	},
	{
		name: 'the recover lane refuses history for a topic the gate denies',
		// Kills: `cancelled: false` and `hasResumeHook: false` at the recover
		// site, and any mutation that opens the gap-fill for an ungranted topic.
		// The recover lane was entirely absent from this matrix, which is why
		// those two survived every check the project had.
		expected: { type: 'subscribe-denied', servedHistory: false },
		async run(surface) {
			const c = await surface.client();
			return c.subscribeRecovering('never-granted', 7);
		}
	},
	{
		name: 'the recover lane serves history for a topic the connection holds',
		// The complement, so "refuses everything" cannot pass the scenario above.
		expected: { type: 'subscribed', servedHistory: true },
		async run(surface) {
			const c = await surface.client();
			expect((await c.grant('recover-room')).granted).toBe(true);
			return c.subscribeRecovering('recover-room', 8);
		}
	},
	{
		name: 'the observer lane refuses an ungranted topic and admits a granted one',
		// Kills: `deniesUngrantedObserve(false, ...)`. This lane has NO second
		// line of defence - the gate is the entire answer - and nothing drove it
		// from a client before, so neutering it was invisible.
		expected: { ungranted: 'FORBIDDEN', granted: null },
		async run(surface) {
			const c = await surface.client();
			const ungranted = await c.observe('observer-secret', 20);
			expect((await c.grant('observer-room')).granted).toBe(true);
			const granted = await c.observe('observer-room', 21);
			return { ungranted, granted };
		}
	},
	{
		name: 'the observer lane applies the configured wire topic alphabet',
		// The ordinary Platform method is called by trusted server code and may
		// accept non-ASCII. Observer mode is different: presence/cursor feed it a
		// client-named snapshot topic, so the default wire alphabet must apply on
		// production, Vite and the published test server alike.
		expected: 'INVALID_TOPIC',
		async run(surface) {
			const c = await surface.client();
			return c.observe('observer-\u202eprivate', 22);
		}
	}
];

describe('the three socket surfaces answer identically', () => {
	for (const scenario of SCENARIOS) {
		it(scenario.name, async () => {
			/** @type {Record<string, any>} */
			const answers = {};
			for (const { label, boot } of ADAPTERS) {
				const surface = await boot();
				answers[label] = await scenario.run(surface);
				// Tear down between surfaces so ports and modules do not pile up.
				for (const fn of teardown.reverse()) {
					try { await fn(); } catch { /* already down */ }
				}
				teardown = [];
			}

			const labels = Object.keys(answers);
			expect(labels.length, 'at least two surfaces must run for a differential to mean anything')
				.toBeGreaterThanOrEqual(2);

			// Every surface agrees with the first one. This is the half that
			// catches a single-surface mutation whatever its spelling.
			for (const label of labels.slice(1)) {
				expect(
					answers[label],
					`${label} disagrees with ${labels[0]}: ${JSON.stringify(answers[label])} vs ${JSON.stringify(answers[labels[0]])}`
				).toEqual(answers[labels[0]]);
			}

			// And the agreed answer is the right one, so neutering all three the
			// same way is caught too.
			expect(answers[labels[0]], `all surfaces agree, but on the wrong answer`).toEqual(scenario.expected);
		}, 60000);
	}

	// Guard for the harness. Without the native binding this suite silently
	// becomes a testing-vs-dev comparison and stops covering the runtime that
	// actually ships. The previous version of this check tried to say so through
	// the assertion MESSAGE, which vitest never prints on a pass - so it reported
	// green while production was absent, under a name asserting the opposite.
	// A conditional skip is visible in the reporter; a passing test is not.
	const itProd = hasUWS ? it : it.skip;
	itProd('runs production, not just the two in-process surfaces', () => {
		expect(
			ADAPTERS.map((a) => a.label),
			'production must be in the matrix when uWS is loadable'
		).toContain('production');
	});
});
