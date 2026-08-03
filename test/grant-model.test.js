// Regression tests for the grant-model fixes: the trackedSubscribe
// subscription cap, wsOpts serialization, the checkSubscribe grant conjunct,
// and the unsubscribe revocation tombstone.
//
// The production dispatch (src/runtime/handler.js, handler/platform.js) is
// built against rollup-injected globals (WS_HANDLER / MANIFEST / ...) and so
// cannot be imported at runtime in vitest - the same restriction
// fatal-sites.test.js works under. Every DECISION those modules make is
// therefore extracted into an importable pure seam in
// src/runtime/utils/ws-symbols.js and driven behaviourally here: the
// pending-subscribe epoch primitives, the observer-lane predicate, and the
// trackedSubscribe cap (also exercised end to end through the real plugins in
// presence.test.js / cursor.test.js). Only the CALL of those seams is pinned
// by source-level guards - a string assertion cannot tell whether a code path
// runs, so it must never be the only thing standing behind a security fix.

import { describe, it, expect, afterEach } from 'vitest';
import { hasUWS } from './helpers/real-runtime.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
	WS_SUBSCRIPTIONS,
	WS_PENDING_SUBSCRIBES,
	MAX_SUBSCRIPTIONS_PER_CONNECTION,
	trackedSubscribe,
	trackedUnsubscribe,
	beginPendingSubscribe,
	settlePendingSubscribe,
	tombstonePendingSubscribe,
	markSideEffectHooks
} from '../src/runtime/utils.js';
// The observer gate lives in the canonical policy module, whose exclusive
// export ownership the surface-policy oracle enforces.
import { deniesUngrantedObserve } from '../src/runtime/utils/subscribe-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handlerSrc = readFileSync(path.join(ROOT, 'src/runtime/handler.js'), 'utf8');
const platformSrc = readFileSync(path.join(ROOT, 'src/runtime/handler/platform.js'), 'utf8');
const indexSrc = readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');

/** Minimal ws stand-in: live socket with a plain userData object. */
function fakeWs(userData = {}) {
	const native = new Set();
	return {
		getUserData: () => userData,
		subscribe: (t) => { native.add(t); return true; },
		unsubscribe: (t) => { native.delete(t); return true; },
		_native: native
	};
}

describe('revocation survives a duplicate subscribe frame', () => {
	// A per-topic flag has ONE slot, so a second subscribe frame arriving
	// after a revocation re-arms it: the already-revoked attempt then lands,
	// finds itself apparently un-revoked, and installs the grant, while the
	// innocent second attempt is denied. Both halves are wrong and the client
	// drives it by sending the same frame twice while the auth hook is parked.
	it('denies the revoked attempt and allows the later one', () => {
		const ud = {};
		const revoked = beginPendingSubscribe(ud, 'private-room');
		expect(tombstonePendingSubscribe(ud, 'private-room')).toBe(true);
		const fresh = beginPendingSubscribe(ud, 'private-room');

		expect(settlePendingSubscribe(ud, 'private-room', revoked)).toBe(false);
		expect(settlePendingSubscribe(ud, 'private-room', fresh)).toBe(true);
	});

	it('cancels every attempt in flight at the moment of revocation', () => {
		const ud = {};
		const a = beginPendingSubscribe(ud, 'room');
		const b = beginPendingSubscribe(ud, 'room');
		expect(tombstonePendingSubscribe(ud, 'room')).toBe(true);

		expect(settlePendingSubscribe(ud, 'room', a)).toBe(false);
		expect(settlePendingSubscribe(ud, 'room', b)).toBe(false);
	});

	it('repeated frames cannot keep a revocation permanently armed', () => {
		const ud = {};
		beginPendingSubscribe(ud, 'room');
		tombstonePendingSubscribe(ud, 'room');
		// Spam more frames; each gets its own token and is unaffected by the
		// revocation that preceded it.
		for (let i = 0; i < 50; i++) {
			const t = beginPendingSubscribe(ud, 'room');
			expect(settlePendingSubscribe(ud, 'room', t)).toBe(true);
		}
	});

	it('drops per-topic state once the last attempt settles', () => {
		const ud = {};
		const t = beginPendingSubscribe(ud, 'room');
		settlePendingSubscribe(ud, 'room', t);
		expect(ud[WS_PENDING_SUBSCRIBES].size).toBe(0);
	});
});

describe('a plugin leave path revokes an in-flight subscribe', () => {
	// trackedUnsubscribe is the plugin leave / evict primitive - presence leave,
	// groups leave, a cursor viewport change. It is a revocation exactly as
	// platform.unsubscribe is, so it has to cancel a subscribe still parked in
	// its authorization await. Without that, the parked attempt lands afterwards
	// and re-installs the membership the evict just removed, leaving the socket
	// subscribed to a topic it was thrown out of.

	it('tombstones an in-flight subscribe for the topic it removes', () => {
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = fakeWs(ud);
		const token = beginPendingSubscribe(ud, 'room');

		trackedUnsubscribe(ws, 'room');

		expect(
			settlePendingSubscribe(ud, 'room', token),
			'the parked subscribe must not be allowed to install its grant'
		).toBe(false);
	});

	it('leaves a subscribe to an unrelated topic alone', () => {
		// Scoped per (connection, topic): a leave on one topic must not cancel an
		// unrelated subscribe that happens to be in flight on the same socket.
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = fakeWs(ud);
		const token = beginPendingSubscribe(ud, 'other-room');

		trackedUnsubscribe(ws, 'room');

		expect(
			settlePendingSubscribe(ud, 'other-room', token),
			'a leave on one topic must not cancel a subscribe to another'
		).toBe(true);
	});

	it('still removes an established membership when nothing is in flight', () => {
		// The ordinary case, unchanged: the tombstone is a no-op and the leave
		// still drops both native and registry membership.
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = fakeWs(ud);
		trackedSubscribe(ws, 'room');
		expect(ud[WS_SUBSCRIPTIONS].has('room')).toBe(true);

		expect(trackedUnsubscribe(ws, 'room')).toBe(true);
		expect(ud[WS_SUBSCRIPTIONS].has('room'), 'registry membership must be dropped').toBe(false);
		expect(ws._native.has('room'), 'native membership must be dropped').toBe(false);
	});
});

describe('pending-subscribe primitives (revocation TOCTOU)', () => {
	it('begin opens an attempt; settling it installs the grant (normal path)', () => {
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const token = beginPendingSubscribe(ud, 'room');
		expect(ud[WS_PENDING_SUBSCRIBES].get('room').inflight).toBe(1);
		// Landing: settle returns true -> not revoked -> grant installs.
		expect(settlePendingSubscribe(ud, 'room', token)).toBe(true);
	});

	it('tombstone cancels an in-flight subscribe; settling then reports revoked', () => {
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const token = beginPendingSubscribe(ud, 'room');
		// platform.unsubscribe lands mid-await.
		expect(tombstonePendingSubscribe(ud, 'room')).toBe(true);
		// Landing: settle returns false -> revoked -> grant must be discarded.
		expect(settlePendingSubscribe(ud, 'room', token)).toBe(false);
	});

	it('tombstone is a truthful no-op when nothing is pending', () => {
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		expect(tombstonePendingSubscribe(ud, 'never-subscribed')).toBe(false);
		expect(ud[WS_PENDING_SUBSCRIBES]).toBeUndefined(); // no lazy allocation on the revoke side
	});

	it('tombstone after a completed landing is a no-op (no stale cancellation)', () => {
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const token = beginPendingSubscribe(ud, 'room');
		settlePendingSubscribe(ud, 'room', token); // landed normally
		expect(tombstonePendingSubscribe(ud, 'room')).toBe(false);
	});

	it('tracks topics independently per connection and per topic', () => {
		const udA = {};
		const udB = {};
		beginPendingSubscribe(udA, 'room');
		beginPendingSubscribe(udA, 'other');
		beginPendingSubscribe(udB, 'room');
		expect(tombstonePendingSubscribe(udA, 'room')).toBe(true);
		// udA's other topic and udB's same-named topic are untouched.
		expect(udA[WS_PENDING_SUBSCRIBES].has('other')).toBe(true);
		expect(udB[WS_PENDING_SUBSCRIBES].has('room')).toBe(true);
	});
});

describe('trackedSubscribe subscription cap', () => {
	it('refuses a NEW topic when the registry is at MAX_SUBSCRIPTIONS_PER_CONNECTION', () => {
		const subs = new Set();
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) subs.add('filler:' + i);
		const ws = fakeWs({ [WS_SUBSCRIPTIONS]: subs });
		expect(trackedSubscribe(ws, '__presence:room')).toBe(false);
		expect(ws._native.has('__presence:room')).toBe(false); // native membership not created either
		expect(subs.size).toBe(MAX_SUBSCRIPTIONS_PER_CONNECTION);
	});

	it('stays idempotent at the cap for an already-present topic', () => {
		const subs = new Set();
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION - 1; i++) subs.add('filler:' + i);
		subs.add('__cursor:board');
		const ws = fakeWs({ [WS_SUBSCRIPTIONS]: subs });
		expect(trackedSubscribe(ws, '__cursor:board')).toBe(true);
	});

	it('subscribes and registers below the cap', () => {
		const subs = new Set(['existing']);
		const ws = fakeWs({ [WS_SUBSCRIPTIONS]: subs });
		expect(trackedSubscribe(ws, '__presence:room')).toBe(true);
		expect(ws._native.has('__presence:room')).toBe(true);
		expect(subs.has('__presence:room')).toBe(true);
	});

	it('still subscribes when the connection has no registry slot (plugin mock path unchanged)', () => {
		const ws = fakeWs({});
		expect(trackedSubscribe(ws, '__presence:room')).toBe(true);
		expect(ws._native.has('__presence:room')).toBe(true);
	});
});

describe('observer-lane gate (deniesUngrantedObserve)', () => {
	// The real decision behind platform.checkSubscribe({ requireGrant: true }),
	// extracted as a pure predicate precisely so it can be driven directly -
	// the module that calls it is built against rollup-injected globals and
	// cannot be imported here, and a source-string assertion would pass even
	// if the call were dead.
	const granted = new Set(['granted-topic']);

	it('denies a topic the connection was never granted', () => {
		expect(deniesUngrantedObserve(true, false, granted, 'other-tenant')).toBe(true);
	});

	it('allows a topic the connection already holds', () => {
		expect(deniesUngrantedObserve(true, false, granted, 'granted-topic')).toBe(false);
	});

	it('does nothing when wire-subscribe authorization is not armed', () => {
		// The adapter's standalone contract: any client may subscribe to any
		// topic, so the observer lanes must not start denying.
		expect(deniesUngrantedObserve(false, false, granted, 'other-tenant')).toBe(false);
	});

	it('defers to an app subscribe hook, exactly as the wire gate does', () => {
		// An app exporting its own hook is documented as deciding every topic.
		// Hard-denying before that hook runs would silently break the snapshot
		// lanes for the apps that took control of authorization.
		expect(deniesUngrantedObserve(true, true, granted, 'other-tenant')).toBe(false);
	});

	it('fails closed when the grant registry is missing or the wrong shape', () => {
		expect(deniesUngrantedObserve(true, false, undefined, 'any')).toBe(true);
		expect(deniesUngrantedObserve(true, false, {}, 'any')).toBe(true);
		expect(deniesUngrantedObserve(true, false, ['any'], 'any')).toBe(true);
	});
});

describe('grant-model wiring - source guards', () => {
	// The production modules cannot be imported in vitest (rollup-injected
	// globals), so these pin the wiring that makes each fix live: a future
	// refactor that drops the conjunct / tombstone / serialization breaks one
	// of these instead of silently reopening the hole.

	it('platform.subscribe tracks the in-flight subscribe and discards a revoked grant', () => {
		expect(platformSrc).toContain('beginPendingSubscribe(ud, topic, held)');
		expect(/!settlePendingSubscribe\(ud, topic, pendingToken, true\)\) return 'FORBIDDEN'/.test(platformSrc)).toBe(true);
		// The held-at-landing branch reads the membership's provenance: a revoked
		// attempt whose own hook installed it must not ack it.
		expect(platformSrc).toContain('settleHeldSubscribe(ud, topic, pendingToken)');
	});

	it('platform.unsubscribe tombstones the pending subscribe and returns it truthfully', () => {
		expect(platformSrc).toContain('tombstonePendingSubscribe(ud, topic)');
		expect(platformSrc).toContain('if (!subs.has(topic)) return cancelledPending;');
	});

	it('the wire subscribe landing checks the revocation tombstone before ws.subscribe', () => {
		expect(handlerSrc).toContain('beginPendingSubscribe(pendingUd, msg.topic, subs.has(msg.topic))');
		expect(handlerSrc).toContain('if (!settlePendingSubscribe(pendingUd, msg.topic, pendingToken, true)) {');
		expect(handlerSrc).toContain('settleHeldSubscribe(pendingUd, msg.topic, pendingToken)');
	});

	it('checkSubscribe passes requireGrant only from the observer lanes', () => {
		// The plugins opt in; nothing else does. If a future caller starts
		// passing it, that caller is asking for the stricter gate on purpose.
		const presenceSrc = readFileSync(path.join(ROOT, 'src/plugins/presence/server.js'), 'utf8');
		const cursorSrc = readFileSync(path.join(ROOT, 'src/plugins/cursor/server.js'), 'utf8');
		expect(presenceSrc).toContain('checkSubscribe(ws, topic, { requireGrant: true })');
		expect(cursorSrc).toContain('checkSubscribe(ws, topic, { requireGrant: true })');
		expect(platformSrc).toContain('const requireGrant = Boolean(options && options.requireGrant)');
	});

	it('authorizeWireSubscribe is serialized into wsOpts and unknown keys warn at build time', () => {
		// The strict tri-state serializes verbatim: 'strict' survives as the
		// string, true stays boolean, anything else is false. A bare
		// `=== true` would silently downgrade a documented 'strict' build.
		expect(indexSrc).toContain("authorizeWireSubscribe: websocket?.authorizeWireSubscribe === 'strict'");
		expect(indexSrc).toContain('const wsOpts = serializeWsOptions(websocket, adminPath);');
		expect(indexSrc).toContain('unknown websocket option(s)');
	});

	it('trackedSubscribe enforces MAX_SUBSCRIPTIONS_PER_CONNECTION', async () => {
		// Driven, not grepped. This used to assert the source contained the exact
		// string `subs.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return false`,
		// which pinned a SPELLING rather than the behaviour: routing the lane
		// through the shared policy turned it red while the cap still worked, and
		// equally an inline rewrite that dropped the cap entirely could have kept
		// it green. The cap is 1_000_000, so the registry's `size` is stubbed on a
		// real Set rather than allocating a million entries.
		const { trackedSubscribe, WS_SUBSCRIPTIONS } = await import('../src/runtime/utils/ws-symbols.js');
		const { MAX_SUBSCRIPTIONS_PER_CONNECTION } = await import('../src/runtime/utils/caps.js');

		const makeWs = (size, topics = []) => {
			const subs = new Set(topics);
			Object.defineProperty(subs, 'size', { value: size, configurable: true });
			const subscribed = [];
			return {
				subscribed,
				getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }),
				subscribe: (t) => subscribed.push(t)
			};
		};

		const atCap = makeWs(MAX_SUBSCRIPTIONS_PER_CONNECTION);
		expect(trackedSubscribe(atCap, 'new-topic'), 'a new topic at the cap is refused').toBe(false);
		expect(atCap.subscribed, 'a refused topic must not reach ws.subscribe').toEqual([]);

		// Idempotent for a topic already held: no growth, so no refusal.
		const atCapHolding = makeWs(MAX_SUBSCRIPTIONS_PER_CONNECTION, ['held-topic']);
		expect(trackedSubscribe(atCapHolding, 'held-topic'), 'an already-held topic stays idempotent at the cap').toBe(true);

		// And the control: below the cap a new topic is admitted, so the refusal
		// above is the cap talking and not a blanket false.
		const belowCap = makeWs(MAX_SUBSCRIPTIONS_PER_CONNECTION - 1);
		expect(trackedSubscribe(belowCap, 'new-topic'), 'below the cap a new topic is admitted').toBe(true);
		expect(belowCap.subscribed).toEqual(['new-topic']);
	});
});

const describeUWS = hasUWS ? describe : describe.skip;

describeUWS('the grant conjunct, driven behaviourally on the published test server', () => {
	// The conjunct had no behavioural coverage on either mirror: neutering it in
	// src/testing.js or src/vite.js left the whole suite green, with only a
	// source-string assertion on PRODUCTION's platform.js standing behind it -
	// which this file's own header says must never be the only guard. The
	// distinction matters because `svelte-adapter-uws/testing` is a published
	// export, so an app verifying its own tenancy boundary against it must not
	// get the opposite answer from the one production would give.

	/** @type {any} */
	let server = null;
	/** @type {any} */
	let client = null;

	afterEach(async () => {
		try { client?.terminate(); } catch { /* already gone */ }
		client = null;
		await server?.close();
		server = null;
	});

	/**
	 * Boot an armed server (wire-subscribe authorization on) and return the
	 * server-side socket for a connected client.
	 * @param {any} [handler]
	 * @param {any} [serverOptions]
	 * @returns {Promise<any>}
	 */
	async function bootArmed(handler = {}, serverOptions = {}) {
		const { createTestServer } = await import('../src/testing.js');
		/** @type {any} */
		let capturedWs = null;
		const appOpen = handler.open;
		server = await createTestServer({
			...serverOptions,
			authorizeWireSubscribe: true,
			handler: {
				...handler,
				open(ws) {
					capturedWs = ws;
					appOpen?.(ws);
				}
			}
		});
		const wsMod = await import('ws');
		const WebSocket = wsMod.WebSocket ?? wsMod.default;
		client = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(capturedWs, 'the connection should have reached the open hook').not.toBeNull();
		return capturedWs;
	}

	it('refuses an observer lane for a topic the connection was never granted', async () => {
		const ws = await bootArmed();
		expect(
			await server.platform.checkSubscribe(ws, 'room', { requireGrant: true }),
			'an ungranted topic must be refused under a pure-grant deployment'
		).toBe('FORBIDDEN');

		// Once the grant exists the same call is allowed, so the refusal is the
		// grant set talking and not a blanket denial.
		expect(await server.platform.subscribe(ws, 'room')).toBeNull();
		expect(await server.platform.checkSubscribe(ws, 'room', { requireGrant: true })).toBeNull();
	});

	it('applies the conjunct only under requireGrant', async () => {
		// The ordinary use of checkSubscribe gates BEFORE a grant exists, so the
		// stricter mode must stay opt-in or every normal caller would break.
		const ws = await bootArmed();
		expect(await server.platform.checkSubscribe(ws, 'room')).toBeNull();
	});

	it('applies the wire alphabet only to observer mode', async () => {
		const ws = await bootArmed();
		const hostile = 'room-' + String.fromCharCode(0x202e) + 'private';

		// Ordinary checkSubscribe is a trusted server API and retains its looser
		// contract. Observer mode is fed a client-named snapshot topic and must
		// match the default wire alphabet instead.
		expect(await server.platform.checkSubscribe(ws, hostile)).toBeNull();
		expect(await server.platform.checkSubscribe(ws, hostile, { requireGrant: true })).toBe('INVALID_TOPIC');
	});

	it('honours allowNonAsciiTopics in observer mode', async () => {
		const ws = await bootArmed({}, { allowNonAsciiTopics: true });
		const localized = 'sala-' + String.fromCharCode(0xe1);
		expect(await server.platform.subscribe(ws, localized)).toBeNull();
		expect(await server.platform.checkSubscribe(ws, localized, { requireGrant: true })).toBeNull();
	});

	it('defers to an app subscribe hook rather than the grant set', async () => {
		// With the app shipping its own hook, the hook is the authority - the
		// grant set is not consulted, matching production's precedence.
		const ws = await bootArmed({ subscribe: () => null });
		expect(await server.platform.checkSubscribe(ws, 'never-granted', { requireGrant: true })).toBeNull();
	});

	it('rechecks an observer grant after an async side-effect hook lands', async () => {
		let observerPhase = false;
		let releaseHook;
		let hookStarted;
		const started = new Promise((resolve) => { hookStarted = resolve; });
		const parked = new Promise((resolve) => { releaseHook = resolve; });
		const handler = markSideEffectHooks({
			async subscribe() {
				if (!observerPhase) return;
				hookStarted();
				await parked;
			}
		}, ['subscribe']);
		const ws = await bootArmed(handler);
		// Seed the authoritative grant set directly so setup does not itself run
		// the hook we are about to park. This is the same Set platform.subscribe
		// populates after a successful server-side grant.
		ws.getUserData()[WS_SUBSCRIPTIONS].add('room');
		observerPhase = true;

		const checking = server.platform.checkSubscribe(ws, 'room', { requireGrant: true });
		await started;
		expect(server.platform.unsubscribe(ws, 'room')).toBe(true);
		releaseHook();

		// Pre-fix result was null: requireGrant was read only before the await,
		// so a revoke inside the authorization window returned an allow decision
		// after the connection no longer held the topic.
		expect(await checking).toBe('FORBIDDEN');
	});

	it('admits an observer grant legitimately restored before the async hook lands', async () => {
		let observerPhase = false;
		let releaseHook;
		let hookStarted;
		const started = new Promise((resolve) => { hookStarted = resolve; });
		const parked = new Promise((resolve) => { releaseHook = resolve; });
		const handler = markSideEffectHooks({
			async subscribe() {
				if (!observerPhase) return;
				hookStarted();
				await parked;
			}
		}, ['subscribe']);
		const ws = await bootArmed(handler);
		const grants = ws.getUserData()[WS_SUBSCRIPTIONS];
		grants.add('room');
		observerPhase = true;

		const checking = server.platform.checkSubscribe(ws, 'room', { requireGrant: true });
		await started;
		expect(server.platform.unsubscribe(ws, 'room')).toBe(true);
		grants.add('room');
		releaseHook();

		// The landing uses current authority, not an irreversible cancellation
		// epoch: revoke followed by a legitimate re-grant is allowed.
		expect(await checking).toBeNull();
	});

	it('does not deny a topic whose name is an Object.prototype member', async () => {
		// The batch denial map is keyed by attacker-chosen topic names. Built as a
		// plain {}, an EMPTY map reads back every Object.prototype member as truthy,
		// so a client subscribing to `constructor` / `toString` / `valueOf` was
		// DENIED on the mirrors while production - which builds it null-prototype -
		// allowed it. Restrictive rather than permissive, so no escalation, but a
		// double that refuses what production allows is still lying to the app.
		//
		// Driven over the WIRE. The bug is in what the server does with a
		// client-chosen topic name, so an assertion comparing {} against
		// Object.create(null) inside the test process only restates JavaScript: it
		// passes no matter what the mirrors actually do, which is weaker than the
		// source-string pin this file already disqualifies.
		const { createTestServer } = await import('../src/testing.js');
		// The app hook ALLOWS everything, so any denial can only come from the map.
		server = await createTestServer({ handler: { subscribeBatch: () => ({}) } });
		const wsMod = await import('ws');
		const WebSocket = wsMod.WebSocket ?? wsMod.default;
		client = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});
		/** @type {any[]} */
		const frames = [];
		client.on('message', (raw) => {
			try { frames.push(JSON.parse(String(raw))); } catch { /* non-JSON */ }
		});

		const names = ['constructor', 'toString', 'valueOf', 'ordinary-topic'];
		names.forEach((topic, i) =>
			client.send(JSON.stringify({ type: 'subscribe', topic, ref: i + 1 }))
		);
		await new Promise((r) => setTimeout(r, 120));

		for (let i = 0; i < names.length; i++) {
			const answer = frames.find((f) => f && f.ref === i + 1);
			expect(answer?.type, names[i] + ' must be allowed, as production allows it').toBe(
				'subscribed'
			);
		}
		expect(server.platform.subscribers('constructor')).toBe(1);
	});

	it('does not apply the conjunct when wire-subscribe authorization is unarmed', async () => {
		const { createTestServer } = await import('../src/testing.js');
		/** @type {any} */
		let capturedWs = null;
		server = await createTestServer({ handler: { open(ws) { capturedWs = ws; } } });
		const wsMod = await import('ws');
		const WebSocket = wsMod.WebSocket ?? wsMod.default;
		client = new WebSocket(server.wsUrl);
		await new Promise((resolve, reject) => {
			client.on('open', resolve);
			client.on('error', reject);
		});
		await new Promise((r) => setTimeout(r, 30));
		expect(await server.platform.checkSubscribe(capturedWs, 'room', { requireGrant: true })).toBeNull();
	});
});
