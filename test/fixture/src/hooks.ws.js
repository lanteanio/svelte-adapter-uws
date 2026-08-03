import { workerData as threadWorkerData } from 'node:worker_threads';
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
		platform.publish(msg.topic || 'test-topic', msg.event || 'broadcast', msg.payload, msg.options ?? { seq: false });
	}
	if (msg.type === 'sequence-policy-probe') {
		try {
			const topic = msg.topic || 'sequence-policy:room';
			const event = 'probe';
			const options = msg.options;
			let result;
			if (msg.entry === 'wire') {
				result = platform.publishWire(topic, event, { n: 1 }, {
					capability: 'fixture.sequence:1', schemaVersion: 1, encode: () => null
				}, options);
			} else if (msg.entry === 'wire-batch') {
				result = platform.publishWireBatch(topic, event, [{ data: { n: 1 } }, { data: { n: 2 } }], {
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
			platform.send(ws, 'probe', 'sequence-policy', { nonce: msg.nonce, ok: true, result });
		} catch (error) {
			platform.send(ws, 'probe', 'sequence-policy', {
				nonce: msg.nonce,
				ok: false,
				error: error instanceof Error ? error.message : String(error)
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
