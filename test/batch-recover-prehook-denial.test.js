// A topic the grant gate denied BEFORE the hooks must never reach the resume
// hook, whatever happens to the app's hook set while the batch is parked.
//
// THE DEFECT THIS PINS. The batch recover pass used to consult the pre-hook
// decision (`authzDenied[i]`) as its first denial clause. A rewrite dropped that
// clause and leaned entirely on `recoverIsRevoked`, which is only equivalent
// while the wire-authorization reading has not moved since the pre-hook pass.
// It can move: `isAuthorizationHook` reads a MUTABLE property on the exported
// hook, so a hook that was marked side-effect-only (the plugins' marking, which
// leaves the grant gate armed) can stop being marked while the batch is parked -
// routinely on the dev server, where saving `hooks.ws.js` reassigns the whole
// handler, and by plain object mutation on this server, where the caller owns
// the handler object.
//
// When that happens the recover pass reads "an app hook owns the topic
// decision", declines to refuse, and serves the REPLAY HISTORY of a topic that
// is then denied at the landing in the same frame. A pre-denied topic is
// filtered out of the hook pass, so `batchDenials` carries nothing for it and
// no other clause catches it.
//
// The window is real but narrow, and the point of this test is that it does not
// need to be wide: the pre-hook decision is authoritative for the frame, and
// re-deriving it from state that can move is the bug.

import { describe, it, expect, afterEach } from 'vitest';
import { WS_HOOK_SIDE_EFFECT_ONLY } from '../src/runtime/utils/ws-symbols.js';

let server = null;
let client = null;

afterEach(async () => {
	try { client?.terminate(); } catch { /* already gone */ }
	client = null;
	await server?.close();
	server = null;
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

async function connect(wsUrl) {
	const { WebSocket } = await import('ws');
	const ws = new WebSocket(wsUrl);
	const frames = [];
	ws.on('message', (d) => frames.push(d.toString()));
	await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
	return {
		ws,
		send: (o) => ws.send(JSON.stringify(o)),
		async waitFor(predicate, ms = 1500) {
			const deadline = Date.now() + ms;
			for (;;) {
				for (const raw of frames) {
					let p = null;
					try { p = JSON.parse(raw); } catch { /* non-JSON */ }
					if (predicate(p)) return p;
				}
				if (Date.now() > deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		},
		all: () => frames.map((r) => { try { return JSON.parse(r); } catch { return null; } })
	};
}

describe('a pre-denied batch topic never reaches the resume hook', () => {
	it('serves no replay history for it even if the app hook set changes mid-await', async () => {
		const { createTestServer } = await import('../src/testing.js');
		const park = deferred();
		let parked = 0;
		/** Topics the resume hook was actually asked to gap-fill. */
		let resumeSaw = null;

		// Marked side-effect-only, exactly as the plugins mark theirs: the grant
		// gate stays ARMED, which is what makes the pre-hook denial happen at all.
		// Armed for the wire frame only. `platform.subscribe` runs the same hook
		// chain, so a hook that parks unconditionally deadlocks the setup grant
		// that opens the window in the first place.
		let arm = false;
		async function subscribeBatch(_ws, topics) {
			if (arm) { arm = false; parked++; await park.promise; }
			return Object.fromEntries(topics.map((t) => [t, null]));
		}
		subscribeBatch[WS_HOOK_SIDE_EFFECT_ONLY] = true;

		const handler = {
			subscribeBatch,
			async resume(ws, { lastSeenSeqs, platform }) {
				resumeSaw = Object.keys(lastSeenSeqs || {});
				platform.send(ws, 'probe', 'resume-topics', { topics: resumeSaw });
			},
			async message(ws, { data, platform }) {
				let msg;
				try { msg = JSON.parse(Buffer.from(data).toString()); } catch { return; }
				if (msg?.type === 'grant') {
					const denial = await platform.subscribe(ws, msg.topic);
					platform.send(ws, 'probe', 'granted', { topic: msg.topic, denial: denial ?? null });
				}
			}
		};

		server = await createTestServer({ authorizeWireSubscribe: true, handler });
		const c = await connect(server.wsUrl);
		client = c.ws;

		// One topic the server grants, so the batch has something that reaches the
		// hook and parks. `secret` is never granted, so the gate denies it before
		// the hook pass and it is filtered out of the hook call.
		c.send({ type: 'grant', topic: 'park-room' });
		expect(await c.waitFor((p) => p?.event === 'granted'), 'the grant must land').not.toBeNull();

		arm = true;
		c.send({
			type: 'subscribe-batch',
			topics: ['park-room', 'secret'],
			ref: 11,
			recover: { 'park-room': { offset: 0 }, secret: { offset: 0 } }
		});

		for (let i = 0; i < 150 && parked === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(parked, 'the batch hook must have parked, or the window never opened').toBe(1);

		// THE FLIP: the hook stops being side-effect-only while parked, so a
		// re-derived reading now says "the app owns the topic decision".
		delete subscribeBatch[WS_HOOK_SIDE_EFFECT_ONLY];
		park.resolve();

		const answer = await c.waitFor((p) => p?.ref === 11 && p?.topic === 'secret');
		expect(answer, 'the denied topic must be answered').not.toBeNull();
		expect(answer.type, 'a topic the gate denied before the hooks stays denied').toBe('subscribe-denied');
		expect(answer.reason).toBe('FORBIDDEN');

		// The load-bearing assertion: the resume hook must never have been asked
		// for it. Asserting on the absence of a replay FRAME alone would pass
		// against a server with no resume hook at all, so this reads what the
		// server actually handed the hook.
		expect(
			resumeSaw === null ? [] : resumeSaw,
			'the resume hook must not be asked to gap-fill a topic denied before the hook pass'
		).not.toContain('secret');

		// And the echo the hook sent, as the client saw it - the same fact from
		// the other side of the socket.
		const echoed = c.all().find((p) => p?.event === 'resume-topics');
		if (echoed) expect(echoed.data.topics, 'no replay history for the denied topic').not.toContain('secret');
	}, 30000);
});
