import { threadId, workerData as threadWorkerData } from 'node:worker_threads';
import { createCursor } from 'svelte-adapter-uws/plugins/cursor';
import { trackedSubscribe, trackedUnsubscribe } from 'svelte-adapter-uws/subscriptions';
import { coalescedBadValue } from './coalesced-probe.js';

const cursors = createCursor({
	throttle: 0,
	topicThrottle: 16,
	select: (userData) => ({ name: userData.token || 'anon' })
});

// Test-only init probe: when ACCEPTOR_INIT_PROBE=1 the per-worker init hook logs a
// marker so the acceptor-init integration test can prove that a clustered acceptor
// worker runs its init BEFORE the primary starts serving (a no-op otherwise).
export async function init({ platform }) {
	// Test-only: hold the boot window open. `start()` binds the listen socket and
	// logs "Listening on" BEFORE it awaits this hook, so a held init is the one
	// place a test can deliver a real signal to a server that is already reachable
	// but whose entry script has not finished - the window a SIGTERM used to meet
	// Node's default disposition in, dying instantly with every cleanup listener
	// still pending (a no-op when the variable is unset).
	const holdMs = Number(process.env.SLOW_INIT_MS || 0);
	if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
	if (process.env.ACCEPTOR_INIT_PROBE === '1') {
		console.log(`__ACCEPTOR_INIT_RAN__ connections=${platform.connections}`);
	}
	if (process.env.GAME_POLICY_INIT_PROBE === '1') {
		// Attempt the game lane from every worker and log role + outcome, so a
		// real-cluster test can prove the compute worker is denied while the
		// socket-owning I/O worker is not - a source assertion cannot. The role
		// comes from the thread's own workerData: that is the same value the
		// production gate reads.
		let outcome;
		try {
			platform.publishGame(null, 'arena:probe', 'tick', {});
			outcome = 'ok';
		} catch (error) {
			outcome = 'error=' + (error instanceof Error ? error.message : String(error));
		}
		console.log(`__GAME_POLICY_INIT__ role=${threadWorkerData?.role} ${outcome}`);
	}
}

/**
 * Hook Responses that each declare a `content-length`, by the `x-auth-response`
 * value that selects them: a body whose declared length is wrong, bodiless
 * 200 and 204 answers, and 304s with a plain and a loosely written length.
 */
const DECLARED_LENGTH_RESPONSES = {
	'declared-body': () => new Response('hello', { headers: { 'content-length': '99' } }),
	'declared-empty': () => new Response(null, { status: 200, headers: { 'content-length': '42' } }),
	'declared-204': () => new Response(null, { status: 204, headers: { 'content-length': '42' } }),
	'304': () => new Response(null, { status: 304, headers: { 'content-length': '42' } }),
	'304-loose': () => new Response(null, { status: 304, headers: { 'content-length': '42abc' } })
};

// Exporting this is what makes the adapter register the auth preflight route
// (`connect({ auth: true })` POSTs it before upgrading), so it is required for
// any test of that endpoint. Accepts everything: the tests here are about the
// door in front of the hook, not about the hook's own decision. The
// cookie-probe lane exists because the adapter's cookie defaults (the Secure
// derivation from the request URL, relative-path resolution) are only
// observable on a real response's Set-Cookie header. The echo and broken-body
// lanes let a suite hold the dev plugin to production by running this same
// function on both.
export function authenticate({ cookies, headers, url, request }) {
	if (headers['x-auth-response'] === 'date') return new Response('dated', { headers: { date: 'Thu, 01 Jan 1970 00:00:00 GMT' } });
	if (headers['x-auth-response'] === 'error') {
		cookies.set('error_cookie', 'must-not-escape', { path: '/' });
		return Response.error();
	}
	if (headers['x-auth-response'] === '304-custom') {
		return new Response(null, { status: 304, headers: { 'content-length': headers['x-auth-length'] || 'abc' } });
	}
	// A hook may answer with its own Response; these lanes return a bodyless
	// 204, and Responses that declare a length of their own, so the wire the
	// adapter writes for that branch is observable too.
	if (headers['x-auth-response'] === '204') return new Response(null, { status: 204 });
	if (Object.hasOwn(DECLARED_LENGTH_RESPONSES, headers['x-auth-response'] ?? '')) {
		return DECLARED_LENGTH_RESPONSES[headers['x-auth-response']]();
	}
	if (headers['x-auth-echo'] === '1') {
		return Response.json(
			{ url, requestUrl: request.url, headerNames: Object.keys(headers).sort() },
			{ headers: { 'x-auth-echo': '1' } }
		);
	}
	// A cookie past ASCII, and on the Response a header value and a Set-Cookie
	// past ASCII, which a Headers value can be only up to U+00FF.
	if (headers['x-auth-non-ascii'] === 'response' || headers['x-auth-non-ascii'] === 'implicit') {
		cookies.set('\u2603', 'v', { path: '/\u2641' });
		if (headers['x-auth-non-ascii'] === 'response') {
			return new Response('ok', { headers: { 'x-text': '\u00e9', 'set-cookie': 'a=\u00e9' } });
		}
	}
	// A hook that reads the request body, so the body cap answers a body sent
	// without a declared length, and reports how many bytes it read.
	if (headers['x-auth-read-body'] === '1') {
		return request.arrayBuffer().then((body) => new Response(null, {
			status: 204,
			headers: { 'x-body-length': String(body.byteLength) }
		}));
	}
	// A Response whose body fails to read, after the hook set a cookie. Its Date
	// is one no server would write today.
	if (headers['x-auth-broken-body'] === '1') {
		cookies.set('probe_session', 'probe-value', { path: '/' });
		return new Response(
			new ReadableStream({ start(controller) { controller.error(new Error('body failed')); } }),
			{ headers: { 'set-cookie': 'sid=granted', 'x-from-hook': '1', date: 'Mon, 01 Jan 2001 00:00:00 GMT' } }
		);
	}
	if (headers['x-set-cookie-probe'] === '1') {
		cookies.set('probe_session', 'probe-value', {
			path: headers['x-cookie-path'] || '/'
		});
	}
	return { userId: 'fixture-user' };
}

export function upgrade({ headers, cookies, url }) {
	const token = cookies?.token;
	if (token === 'reject') return false;
	if (token === 'error') throw new Error('auth error');
	return token ? { token } : {};
}

export function subscribe(ws, topic, { platform }) {
	// Exercise platform.subscribers() and ws wrapper methods
	platform.subscribers(topic);
	ws.isSubscribed(topic);
	ws.getTopics();
	ws.getBufferedAmount();
	ws.getRemoteAddressAsText();
}

export function open(ws, { platform }) {
	// The fixture is also booted with several cluster topologies. This startup
	// pulse is intentionally volatile and needs no replay sequence.
	platform.publish('test-topic', 'connected', { ts: Date.now() }, { seq: false });
	// Exercise platform.connections and topic() helpers
	const _ = platform.connections;
	const t = platform.topic('test-topic');
	t.increment(1, { seq: false });
	t.decrement(1, { seq: false });
}

export function message(ws, ctx) {
	// Cursor frames (cursor / cursor-snapshot / cursor-viewport) are claimed
	// by the plugin; everything else falls through to the echo handlers.
	if (cursors.hooks.message(ws, ctx)) return;
	const { data, platform } = ctx;
	const msg = JSON.parse(Buffer.from(data).toString());
	if (Array.isArray(msg) || msg.type === 'envelope-shape-probe') {
		// What the runtime put in `ctx.msg`, reported back so a case can assert
		// it. Both shapes take this branch on purpose: an array must arrive
		// with no pre-parsed envelope (`typeof [] === 'object'`, so it reaches
		// the check that excludes it only if that check names arrays), and an
		// object envelope no control type claims must still arrive with one.
		// The nonce correlates the two answers on a single connection.
		platform.send(ws, 'test-topic', 'envelope-shape', {
			nonce: Array.isArray(msg) ? msg[0]?.nonce : msg.nonce,
			present: ctx.msg !== undefined,
			isArray: Array.isArray(ctx.msg)
		});
		return;
	}
	if (msg.type === 'echo') {
		platform.send(ws, 'test-topic', 'echo', msg.payload);
	}
	if (msg.type === 'end-probe') {
		// ws.end() with the client's own code and reason, so a suite can read
		// what the close rule sends. A refusal is reported back on the socket
		// it left open.
		const reason = Array.isArray(msg.reasonBytes) ? new Uint8Array(msg.reasonBytes) : msg.reason;
		try {
			ws.end(msg.code, reason);
		} catch (err) {
			platform.send(ws, 'probe', 'end-refused', { name: err?.name, message: err?.message });
		}
		return;
	}
	if (msg.type === 'drop-probe') {
		ws.close();
		return;
	}
	if (msg.type === 'request-id-probe') {
		// The request id the connection's platform carries, as the upgrade set it.
		platform.send(ws, 'probe', 'request-id', { requestId: platform.requestId });
		return;
	}
	if (msg.type === 'membership-probe') {
		// Join or leave a topic outside the wire protocol, the accounted way or
		// by writing the registry directly, so a suite can compare the worker's
		// subscription counter with what the registries hold.
		const subs = ws.getUserData()[Symbol.for('adapter-uws.ws.subscriptions')];
		if (msg.mode === 'tracked') trackedSubscribe(ws, msg.topic);
		else if (msg.mode === 'tracked-leave') trackedUnsubscribe(ws, msg.topic);
		else if (msg.mode === 'raw') { ws.subscribe(msg.topic); subs.add(msg.topic); }
		platform.send(ws, 'probe', 'membership-done', { nonce: msg.nonce });
		return;
	}
	if (msg.type === 'coalesce-probe') {
		// The client has stopped reading: back the socket up past the 1 MB
		// maxBackpressure so sendCoalesced holds its values, then queue one JSON
		// can carry and one it cannot. Both flush from the drain callback.
		const chunk = new Uint8Array(1024 * 1024);
		for (let i = 0; i < 64 && ws.getBufferedAmount() <= 1024 * 1024; i++) ws.send(chunk, true);
		platform.sendCoalesced(ws, { key: 'good', topic: 'probe', event: 'coalesced-good', data: { ok: true } });
		platform.sendCoalesced(ws, { key: 'bad', topic: 'probe', event: 'coalesced-bad', data: coalescedBadValue(msg.kind) });
		return;
	}
	if (msg.type === 'coalesce-now-probe') {
		// On an idle socket the value flushes inside the call, so the caller
		// gets the serializer's error.
		try {
			platform.sendCoalesced(ws, { key: 'now', topic: 'probe', event: 'coalesced-now', data: coalescedBadValue(msg.kind) });
		} catch (err) {
			platform.send(ws, 'probe', 'coalesce-threw', { name: err?.name });
		}
		return;
	}
	if (msg.type === 'shared-publish') {
		// A shared stateless codec publish, so the cohort lane runs in the
		// built runtime: the topic splits into a binary and a JSON cohort, and
		// each cohort the split publishes to takes its own native call. The
		// split is reached only while some connection advertises the
		// capability; otherwise the publish takes the JSON fast path.
		platform.publishWire(msg.topic, 'snapshot', { n: msg.n ?? 1 }, {
			capability: 'fixture.shared:1', schemaVersion: 1, shared: true, encode: () => new Uint8Array([msg.n ?? 1])
		});
	}
	if (msg.type === 'broadcast') {
		// `inflate` synthesizes a large payload server-side: the inbound frame
		// cap (1 MB) is far below the relay frame ceiling's default, so a test
		// of that default cannot carry the oversized payload through the client.
		const payload = typeof msg.inflate === 'number'
			? { ...msg.payload, big: 'x'.repeat(msg.inflate) }
			: msg.payload;
		platform.publish(msg.topic || 'test-topic', msg.event || 'broadcast', payload, msg.options ?? { seq: false });
	}
	if (msg.type === 'sequence-policy-probe') {
		// A hostile options object cannot cross the JSON probe boundary, so it is
		// built server-side on request: `seq` answers `false` to its first read
		// and an authoritative number to every later one. A lane that judges one
		// read and stamps another accepts the false and stamps the number - the
		// reply carries the read count so the test can pin one-read-per-call.
		let seqReads = 0;
		try {
			const topic = msg.topic || 'sequence-policy:room';
			const event = 'probe';
			const options = msg.statefulSeq === undefined ? msg.options : {
				relay: undefined,
				get seq() { seqReads += 1; return seqReads === 1 ? false : msg.statefulSeq; }
			};
			let result;
			if (msg.entry === 'wire') {
				result = platform.publishWire(topic, event, { n: 1 }, {
					capability: 'fixture.sequence:1', schemaVersion: 1, encode: () => null
				}, options);
			} else if (msg.entry === 'wire-batch') {
				result = platform.publishWireBatch(topic, event, [{ data: { n: 1 } }, { data: { n: 2 } }], {
					capability: 'fixture.sequence-batch:1', schemaVersion: 1, state: {}, encode: () => null
				}, options);
			} else if (msg.entry === 'wire-batch-one' || msg.entry === 'wire-batch-empty') {
				// The batch contract must not depend on what the array happens to
				// hold: one entry and none at all answer exactly as two do.
				const entries = msg.entry === 'wire-batch-one' ? [{ data: { n: 1 } }] : [];
				result = platform.publishWireBatch(topic, event, entries, {
					capability: 'fixture.sequence-batch:1', schemaVersion: 1, state: {}, encode: () => null
				}, options);
			} else if (msg.entry === 'wire-batch-entry-counter' || msg.entry === 'wire-batch-entry-counter-stateless') {
				// An entry drawing the per-worker COUNTER, which is the other
				// refusal the batch pre-pass carries: a clustered batch cannot
				// take `{ seq: true }` on an entry whatever its options say,
				// because the counter is per worker and the relay is
				// multi-origin. Same two codecs, for the same two pre-passes.
				result = platform.publishWireBatch(topic, event, [{ data: { n: 1 } }, { data: { n: 2 }, seq: true }], {
					capability: 'fixture.sequence-batch:1',
					schemaVersion: 1,
					...(msg.entry === 'wire-batch-entry-counter' ? { state: {} } : {}),
					encode: () => null
				}, options);
			} else if (msg.entry === 'wire-batch-entry-seq' || msg.entry === 'wire-batch-entry-seq-stateless') {
				// A per-ENTRY seq: the clustered spelling of an authoritative
				// batch, where the options renounce the counter and each entry
				// carries the number an external allocator gave it. A codec with
				// `state` takes the stateful snapshot pass and one without it
				// reroutes per entry, so the two kinds drive the two pre-passes
				// that have to refuse it - and neither refusal exists off-cluster,
				// which is why they are asked of a real clustered runtime.
				result = platform.publishWireBatch(topic, event, [{ data: { n: 1 } }, { data: { n: 2 }, seq: 21 }], {
					capability: 'fixture.sequence-batch:1',
					schemaVersion: 1,
					...(msg.entry === 'wire-batch-entry-seq' ? { state: {} } : {}),
					encode: () => null
				}, options);
			} else if (msg.entry === 'batch') {
				platform.publishBatched([{ topic, event, data: { n: 1 }, options }]);
				result = true;
			} else if (msg.entry === 'loop-batch') {
				result = platform.batch([{ topic, event, data: { n: 1 }, options }])[0];
			} else if (msg.entry === 'batch-prefix' || msg.entry === 'loop-batch-prefix') {
				// The offending options ride the LAST message and the two before
				// it are clean, so anything that reaches a subscriber - or moves
				// the topic counter - got there ahead of a refusal the whole call
				// was supposed to take before publishing anything.
				const messages = [
					{ topic, event: 'prefix0', data: { n: 0 } },
					{ topic, event: 'prefix1', data: { n: 1 } },
					{ topic, event: 'prefix2', data: { n: 2 }, options }
				];
				if (msg.entry === 'batch-prefix') { platform.publishBatched(messages); result = true; }
				else result = platform.batch(messages)[0];
			} else {
				result = platform.publish(topic, event, { n: 1 }, options);
			}
			platform.send(ws, 'probe', 'sequence-policy', {
				nonce: msg.nonce,
				ok: true,
				result,
				seqReads: msg.statefulSeq === undefined ? undefined : seqReads
			});
		} catch (error) {
			platform.send(ws, 'probe', 'sequence-policy', {
				nonce: msg.nonce,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				seqReads: msg.statefulSeq === undefined ? undefined : seqReads
			});
		}
	}
	if (msg.type === 'plugin-cluster-probe') {
		// Drives the REAL bundled-plugin publish paths under whatever topology
		// this server booted with. The regression this exists to catch: a
		// bundled plugin publishing without declaring its sequence authority
		// throws in every multi-worker runtime, which is invisible to any test
		// that only probes the fixture's direct publish entries.
		(async () => {
			try {
				if (msg.entry === 'replay-create') {
					const { createReplay } = await import('svelte-adapter-uws/plugins/replay');
					const replay = createReplay({ size: 8 });
					platform.send(ws, 'probe', 'plugin-cluster', {
						nonce: msg.nonce, ok: true, seq: replay.seq('probe-topic')
					});
					return;
				}
				if (msg.entry === 'group-roundtrip') {
					const { createGroup } = await import('svelte-adapter-uws/plugins/groups');
					const group = createGroup('policy-probe-' + msg.nonce);
					await group.join(ws, platform);
					group.publish(platform, 'group-probe', { nonce: msg.nonce });
					return;
				}
				platform.send(ws, 'probe', 'plugin-cluster', {
					nonce: msg.nonce, ok: false, error: 'unknown entry'
				});
			} catch (error) {
				platform.send(ws, 'probe', 'plugin-cluster', {
					nonce: msg.nonce,
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		})();
	}
	if (msg.type === 'divergence-probe') {
		// Force this worker's delivered-seq map ahead of its siblings
		// (an externally sequenced publish with relay off never reaches the
		// other workers), then let the state-hash reporter detect it. The
		// 'diagnostics' entry reads the REAL replicated store through the
		// platform, so a test can assert the production collection round
		// trip end to end.
		try {
			if (msg.entry === 'diverge') {
				// A ONE-SHOT fork ages out of the activity-split comparison after
				// the reporting window and falls to the log-only quiet lane, so a
				// deterministic end-to-end oracle needs what a real diverging
				// deployment has: a stream that keeps moving while forked. Keep
				// republishing with advancing external seqs (relay off, so the
				// fork never heals) for long enough to span several report
				// epochs and the detector's persistence gate.
				let seq = msg.seq || 7;
				platform.publish('divergence:room', 'probe', { n: 1 }, { seq, relay: false });
				const pump = setInterval(() => {
					seq += 1;
					try { platform.publish('divergence:room', 'probe', { n: 1 }, { seq, relay: false }); }
					catch { clearInterval(pump); }
				}, 40);
				if (pump.unref) pump.unref();
				setTimeout(() => clearInterval(pump), 10_000).unref?.();
				platform.send(ws, 'probe', 'divergence', { nonce: msg.nonce, ok: true });
			} else {
				const info = platform.introspect().diagnostics;
				const detail = info.recent.length > 0
					? platform.diagnostic(info.recent[info.recent.length - 1].diagnosticId)
					: null;
				platform.send(ws, 'probe', 'divergence', {
					nonce: msg.nonce, ok: true, retained: info.retained, recent: info.recent, detail
				});
			}
		} catch (error) {
			platform.send(ws, 'probe', 'divergence', {
				nonce: msg.nonce, ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	if (msg.type === 'broadcast-batched') {
		// The wire-level batched lane (platform.publishBatched) relays as ONE
		// frame, so it is a separate relay decision point from `broadcast`
		// above. Acked so a test can tell "refused by the relay" from "the
		// publish itself threw" - the difference between a working ceiling and
		// a broken publish path.
		try {
			const payload = typeof msg.inflate === 'number'
				? { ...msg.payload, big: 'x'.repeat(msg.inflate) }
				: msg.payload;
			platform.publishBatched([
				{ topic: msg.topic || 'test-topic', event: msg.event || 'batched', data: payload, options: { seq: false } }
			]);
			platform.send(ws, 'probe', 'batched-ack', { nonce: msg.nonce, ok: true });
		} catch (error) {
			platform.send(ws, 'probe', 'batched-ack', {
				nonce: msg.nonce,
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	if (msg.type === 'whoami') {
		// Which worker thread owns this connection. A clustered test needs it to
		// place two clients on DIFFERENT workers before asserting anything about
		// cross-worker relay - the topology cannot be observed from outside.
		platform.send(ws, 'probe', 'whoami', { nonce: msg.nonce, threadId });
	}
	if (msg.type === 'sendto') {
		platform.sendTo(
			(ud) => ud.token === msg.token,
			msg.topic || 'test-topic',
			msg.event || 'dm',
			msg.payload
		);
	}
	if (msg.type === 'revoke-topic') {
		// Server-side revocation, the shape a kick / ban / lease expiry uses. Lets
		// a test prove that revoking a topic also releases the observer taps
		// derived from it (the cursor and presence channels), against the real
		// runtime rather than against the in-process mirror.
		const removed = platform.unsubscribe(ws, msg.topic);
		platform.send(ws, 'probe', 'revoked', { topic: msg.topic, removed });
	}
	if (msg.type === 'tap-count') {
		// Server-visible membership for any topic, including the `__`-prefixed
		// derived ones a client can never name in a subscribe frame.
		// The nonce is echoed because the test client's frame matcher rescans every
		// frame it has received: without it, a poll would keep matching the FIRST
		// answer for a topic and never observe the value changing.
		platform.send(ws, 'probe', 'tap-count', {
			topic: msg.topic,
			nonce: msg.nonce,
			count: platform.subscribers(msg.topic)
		});
	}
	if (msg.type === 'cork-test') {
		ws.cork(() => {
			platform.send(ws, 'test-topic', 'corked', msg.payload);
		});
	}
	if (msg.type === 'publish-except-me') {
		// Sender-excluded publish through the wire path. The codec declines
		// every frame, so each subscriber receives the plain JSON envelope -
		// except the sender, which the exclusion withholds it from on every
		// platform implementation. `exclude: false` is the unexcluded control.
		platform.publishWire(
			msg.topic || 'test-topic',
			msg.event || 'poke',
			msg.payload,
			{ capability: 'fixture.unused:1', schemaVersion: 1, encode: () => null },
			msg.exclude === false ? undefined : { excludeWs: ws }
		);
	}
	if (msg.type === 'game-policy-probe') {
		// Real clustered-runtime probe: unlike a source assertion, this reaches
		// workerData -> platform.grantPublish in the built handler. The result is
		// returned on the wire so the test cannot pass while the production guard
		// is disconnected.
		try {
			platform.grantPublish(ws, msg.topic || 'game-policy:room');
			platform.revokePublish(ws);
			platform.send(ws, 'probe', 'game-policy', { ok: true });
		} catch (error) {
			platform.send(ws, 'probe', 'game-policy', {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
}

export function close(ws, ctx) {
	cursors.hooks.close(ws, ctx);
	ctx.platform.publish('test-topic', 'disconnected', { code: ctx.code }, { seq: false });
}
