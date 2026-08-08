import { threadId, workerData as threadWorkerData } from 'node:worker_threads';
import { createCursor } from 'svelte-adapter-uws/plugins/cursor';

const cursors = createCursor({
	throttle: 0,
	topicThrottle: 16,
	select: (userData) => ({ name: userData.token || 'anon' })
});

// Test-only init probe: when ACCEPTOR_INIT_PROBE=1 the per-worker init hook logs a
// marker so the acceptor-init integration test can prove that a clustered acceptor
// worker runs its init BEFORE the primary starts serving (a no-op otherwise).
export function init({ platform }) {
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

// Exporting this is what makes the adapter register the auth preflight route
// (`connect({ auth: true })` POSTs it before upgrading), so it is required for
// any test of that endpoint. Accepts everything: the tests here are about the
// door in front of the hook, not about the hook's own decision. The
// cookie-probe lane exists because the adapter's cookie defaults (the Secure
// derivation from the request URL, relative-path resolution) are only
// observable on a real response's Set-Cookie header.
export function authenticate({ cookies, headers }) {
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
	if (msg.type === 'echo') {
		platform.send(ws, 'test-topic', 'echo', msg.payload);
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
			} else if (msg.entry === 'batch') {
				platform.publishBatched([{ topic, event, data: { n: 1 }, options }]);
				result = true;
			} else if (msg.entry === 'loop-batch') {
				result = platform.batch([{ topic, event, data: { n: 1 }, options }])[0];
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
