// The dev server's subscribe-batch LANDING ORDER, driven behaviourally.
//
// src/vite.js settled a batch topic's pending enrolment as the FIRST thing at
// the landing and answered FORBIDDEN whenever that settle came back false.
// Production (src/runtime/handler.js) and the published testing server
// (src/testing.js) both settle LAST, after the topic has failed to be an
// existing membership, a hook denial and the cap - so a revoke followed by a
// legitimate re-grant inside one hook await is acked there and was refused
// here. Replaying the two landing sequences over their whole input space put
// them at odds in three classes, every one of them requiring a revocation
// tombstone: a topic HELD at the landing was denied instead of acked; a hook's
// OWN denial reason was overwritten with FORBIDDEN; and RATE_LIMITED was
// likewise masked. (How many rows that is depends on how the space is
// enumerated - collapsing `armed` and `hasUserHook` into one `wireAuthz` input
// counts fewer than keeping them separate. The classes are the durable
// statement; a single fraction is not.)
//
// This drives the real plugin - a real http.Server, a real `ws` client, a real
// parking `subscribeBatch` hook - and asserts the frame the CLIENT is handed,
// because the divergence is only observable in that frame. A test that called
// the landing helpers directly would have agreed with either ordering.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WS_PLATFORM, WS_PENDING_SUBSCRIBES, WS_SUBSCRIPTIONS, registerDerivedTopicPrefix } from '../src/runtime/utils/ws-symbols.js';

const RT907_DERIVED_PREFIX = '__rt907-observer:';
registerDerivedTopicPrefix(RT907_DERIVED_PREFIX);

/** @type {any} */
let httpServer = null;
/** @type {any} */
let client = null;

/** A promise plus its resolver, so the test decides when the hook unparks. */
function deferred() {
	/** @type {(v?: any) => void} */
	let resolve = () => {};
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

/**
 * Boot the Vite plugin against a real HTTP server and a real client.
 *
 * Shaped after test/vite-grant-conjunct.test.js: the dev platform is built
 * inside the plugin's `configureServer` closure, so the only way to reach it is
 * to boot the plugin.
 *
 * @param {any} pluginOptions
 * @param {any} handler - the ws handler module the plugin will load
 */
async function bootDev(pluginOptions, handler) {
	const mod = await import('../src/vite.js');
	// A bare ws client sends no Origin header; the origin gate has its own
	// coverage and is not what this exercises.
	const plugin = mod.default({ allowedOrigins: '*', ...pluginOptions, handler: '/virtual-ws-handler' });

	httpServer = createServer();
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const port = httpServer.address().port;

	/** @type {any} */
	let capturedWs = null;
	const appOpen = handler.open;
	const loaded = {
		...handler,
		open(ws) {
			capturedWs = ws;
			appOpen?.(ws);
		}
	};

	const server = {
		httpServer,
		middlewares: { use() {} },
		config: {
			root: process.cwd(),
			logger: { warn() {}, info() {}, error() {} },
			server: {}
		},
		async ssrLoadModule() {
			return { default: loaded, ...loaded };
		}
	};

	await plugin.configureServer(server);

	const wsMod = await import('ws');
	const WebSocket = wsMod.WebSocket ?? wsMod.default;
	client = new WebSocket('ws://127.0.0.1:' + port + '/ws');
	/** @type {any[]} */
	const frames = [];
	client.on('message', (raw) => {
		try { frames.push(JSON.parse(raw.toString())); } catch { /* non-JSON frame */ }
	});
	await new Promise((resolve, reject) => {
		client.on('open', resolve);
		client.on('error', reject);
	});
	await new Promise((r) => setTimeout(r, 60));

	return {
		ws: capturedWs,
		frames,
		/** @param {any} obj */
		send: (obj) => client.send(JSON.stringify(obj)),
		/**
		 * @param {(f: any) => boolean} predicate
		 * @param {number} [ms]
		 */
		async waitFor(predicate, ms = 1000) {
			const deadline = Date.now() + ms;
			for (;;) {
				const hit = frames.find(predicate);
				if (hit) return hit;
				if (Date.now() > deadline) return null;
				await new Promise((r) => setTimeout(r, 10));
			}
		}
	};
}

describe('dev revocation TOCTOU and subscribe-batch landing order (src/vite.js)', () => {
	afterEach(async () => {
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		await new Promise((resolve) => {
			if (!httpServer) return resolve(undefined);
			httpServer.close(() => resolve(undefined));
		});
		httpServer = null;
	});

	it('acks a topic revoked and RE-GRANTED while the batch hook was parked', async () => {
		const park = deferred();
		let entered = 0;
		// Armed for exactly one call. `platform.subscribe` runs the same hook
		// chain (subscribeBatch takes precedence over subscribe), so a hook that
		// parks unconditionally deadlocks the setup grant and the re-grant
		// below - both of which must complete for the window to be set up.
		let arm = false;
		const { ws, send, waitFor } = await bootDev({}, {
			async subscribeBatch(_ws, topics) {
				entered++;
				if (arm) { arm = false; await park.promise; }
				return Object.fromEntries(topics.map((t) => [t, null]));
			}
		});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(platform, 'the dev platform must be reachable from the connection').toBeTruthy();

		// The connection legitimately holds the topic before the batch frame.
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		arm = true;
		entered = 0;
		send({ type: 'subscribe-batch', topics: ['room'], ref: 7 });
		// The hook must actually be parked, or the revoke/re-grant below lands
		// outside the window and the test proves nothing.
		for (let i = 0; i < 100 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(entered, 'the batch hook must have been entered and parked').toBe(1);

		// Revoke, then re-grant - both inside the one await window. The revoke
		// tombstones the batch's pending enrolment; the re-grant puts the
		// membership back, which is what makes the tombstone stale rather than
		// authoritative.
		expect(platform.unsubscribe(ws, 'room')).toBe(true);
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		park.resolve();

		const answer = await waitFor((f) => f?.ref === 7 && f?.topic === 'room');
		expect(answer, 'the batch subscribe must be answered').not.toBeNull();
		expect(
			answer.type,
			'a topic the connection HOLDS at the landing is acked - the stale tombstone from a ' +
			'revoke that was superseded by a re-grant must not deny it, which is what production ' +
			'and src/testing.js both do'
		).toBe('subscribed');
	});

	it('still denies a topic revoked and NOT re-granted while the hook was parked', async () => {
		// The other side of the same ordering: with no re-grant the connection
		// does not hold the topic at the landing, the tombstone is authoritative,
		// and the grant must be discarded. Without this, "settle last" could be
		// satisfied by never consulting the tombstone at all.
		const park = deferred();
		let entered = 0;
		let arm = false;
		const { ws, send, waitFor } = await bootDev({}, {
			async subscribeBatch(_ws, topics) {
				entered++;
				if (arm) { arm = false; await park.promise; }
				return Object.fromEntries(topics.map((t) => [t, null]));
			}
		});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		arm = true;
		entered = 0;
		send({ type: 'subscribe-batch', topics: ['room'], ref: 8 });
		for (let i = 0; i < 100 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(entered, 'the batch hook must have been entered and parked').toBe(1);

		expect(platform.unsubscribe(ws, 'room')).toBe(true);

		park.resolve();

		const answer = await waitFor((f) => f?.ref === 8 && f?.topic === 'room');
		expect(answer, 'the batch subscribe must be answered').not.toBeNull();
		expect(answer.type, 'a revoked topic that was never re-granted must be denied').toBe('subscribe-denied');
		expect(answer.reason).toBe('FORBIDDEN');
		expect(
			ws.getUserData()[WS_SUBSCRIPTIONS].has('room'),
			'the discarded grant must not leave a membership behind'
		).toBe(false);
	});

	it("reports the hook's OWN denial reason for a topic revoked while parked", async () => {
		// The third divergence class, and the one the reorder fixed silently:
		// settling first answered FORBIDDEN before the denial chain ever reached
		// the hook's decision, so an app's reason ('NOT_IN_ROOM' here) was
		// replaced by a generic one whenever a revocation happened to land in the
		// same window. The client is then told the wrong thing about WHY, which
		// is the difference between "retry later" and "ask for an invite".
		const park = deferred();
		let entered = 0;
		let arm = false;
		const { ws, send, waitFor } = await bootDev({}, {
			async subscribeBatch(_ws, topics) {
				entered++;
				if (arm) {
					arm = false;
					await park.promise;
					return Object.fromEntries(topics.map((t) => [t, 'NOT_IN_ROOM']));
				}
				return Object.fromEntries(topics.map((t) => [t, null]));
			}
		});
		const platform = ws.getUserData()[WS_PLATFORM];
		expect(await platform.subscribe(ws, 'room')).toBeNull();

		arm = true;
		entered = 0;
		send({ type: 'subscribe-batch', topics: ['room'], ref: 9 });
		for (let i = 0; i < 100 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(entered, 'the batch hook must have been entered and parked').toBe(1);

		expect(platform.unsubscribe(ws, 'room')).toBe(true);
		park.resolve();

		const answer = await waitFor((f) => f?.ref === 9 && f?.topic === 'room');
		expect(answer, 'the batch subscribe must be answered').not.toBeNull();
		expect(answer.type).toBe('subscribe-denied');
		expect(
			answer.reason,
			"a revocation landing in the window must not overwrite the app hook's own reason"
		).toBe('NOT_IN_ROOM');

		// Settled exactly once on this path: a missed settle leaves the enrolment
		// in flight forever (platform.unsubscribe then answers true for a topic
		// nobody is subscribing), a double settle reads a deleted entry.
		const pending = ws.getUserData()[WS_PENDING_SUBSCRIBES];
		expect(pending === undefined || pending.size === 0, 'no enrolment may be left in flight').toBe(true);
	});

	it('cancels a server-side platform.subscribe parked in its authorization hook', async () => {
		const park = deferred();
		let entered = 0;
		const { ws } = await bootDev({}, {
			async subscribe() {
				entered++;
				await park.promise;
			}
		});
		const platform = ws.getUserData()[WS_PLATFORM];
		const pendingSubscribe = platform.subscribe(ws, 'platform-room');
		for (let i = 0; i < 100 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(entered, 'platform.subscribe must be parked before the revoke').toBe(1);

		expect(
			platform.unsubscribe(ws, 'platform-room'),
			'a revoke that cancels an in-flight grant reports a real removal'
		).toBe(true);
		park.resolve();

		expect(await pendingSubscribe).toBe('FORBIDDEN');
		expect(ws.isSubscribed('platform-room')).toBe(false);
		expect(ws.getUserData()[WS_SUBSCRIPTIONS].has('platform-room')).toBe(false);
		const pending = ws.getUserData()[WS_PENDING_SUBSCRIBES];
		expect(pending === undefined || pending.size === 0, 'platform enrolment must settle exactly once').toBe(true);
	});

	it('cancels a single wire subscribe parked in its authorization hook', async () => {
		const park = deferred();
		let entered = 0;
		const { ws, send, waitFor } = await bootDev({}, {
			async subscribe() {
				entered++;
				await park.promise;
			}
		});
		const platform = ws.getUserData()[WS_PLATFORM];

		send({ type: 'subscribe', topic: 'single-room', ref: 10 });
		for (let i = 0; i < 100 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(entered, 'the single subscribe hook must be parked before the revoke').toBe(1);
		expect(platform.unsubscribe(ws, 'single-room')).toBe(true);
		park.resolve();

		const answer = await waitFor((f) => f?.ref === 10 && f?.topic === 'single-room');
		expect(answer?.type).toBe('subscribe-denied');
		expect(answer?.reason).toBe('FORBIDDEN');
		expect(ws.isSubscribed('single-room')).toBe(false);
		expect(ws.getUserData()[WS_SUBSCRIPTIONS].has('single-room')).toBe(false);
	});

	it('client unsubscribe cancels its parked subscribe and clears derived/write grants', async () => {
		const park = deferred();
		const left = deferred();
		let entered = 0;
		const { ws, send, waitFor } = await bootDev({}, {
			async subscribe() {
				entered++;
				await park.promise;
			},
			unsubscribe() {
				left.resolve();
			}
		});
		const platform = ws.getUserData()[WS_PLATFORM];
		const topic = 'client-room';
		const derivedTopic = `${RT907_DERIVED_PREFIX}${topic}`;

		// Observer-only memberships and the one-topic write grant are both
		// downstream authority derived from the base topic. The wire revoke
		// must remove them even though the base subscribe has not landed yet.
		ws.subscribe(derivedTopic);
		ws.getUserData()[WS_SUBSCRIPTIONS].add(derivedTopic);
		expect(platform.grantPublish(ws, topic)).toBe(true);

		send({ type: 'subscribe', topic, ref: 11 });
		for (let i = 0; i < 100 && entered === 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(entered, 'the subscribe hook must be parked before the client revoke').toBe(1);

		send({ type: 'unsubscribe', topic });
		await left.promise;
		expect(ws.isSubscribed(derivedTopic), 'the observer-only derived tap must be released').toBe(false);
		expect(ws.getUserData()[WS_SUBSCRIPTIONS].has(derivedTopic)).toBe(false);
		expect(platform.publishGrant(ws), 'the base topic write grant must be revoked').toBeNull();

		park.resolve();
		const answer = await waitFor((f) => f?.ref === 11 && f?.topic === topic);
		expect(answer?.type).toBe('subscribe-denied');
		expect(answer?.reason).toBe('FORBIDDEN');
		expect(ws.isSubscribed(topic)).toBe(false);
		expect(ws.getUserData()[WS_SUBSCRIPTIONS].has(topic)).toBe(false);
		const pending = ws.getUserData()[WS_PENDING_SUBSCRIBES];
		expect(pending === undefined || pending.size === 0, 'wire enrolment must settle exactly once').toBe(true);
	});
});
