import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	WS_PLATFORM,
	WS_SUBSCRIPTIONS,
	accountClosedLogicalSubscriptions,
	addLogicalSubscription,
	beginPendingSubscribe,
	registerDerivedTopicPrefix,
	removeLogicalSubscription,
	setSubscriptionAccountingHook,
	settleHeldSubscribe,
	tombstonePendingSubscribe,
	trackedSubscribe,
	trackedUnsubscribe,
	unwindRevokedMembership
} from '../src/runtime/utils/ws-symbols.js';
import { checkTotalSubscriptions } from '../src/runtime/invariants.js';
import { buildFixtureOnce } from './helpers/fixture-build.js';

function fakeWs(ud) {
	const native = new Set();
	return {
		native,
		getUserData: () => ud,
		subscribe(topic) { native.add(topic); return true; },
		unsubscribe(topic) { native.delete(topic); return true; },
		isSubscribed: (topic) => native.has(topic),
		getTopics: () => [...native],
		getBufferedAmount: () => 0,
		getRemoteAddressAsText: () => new ArrayBuffer(0)
	};
}

describe('logical subscription accounting primitive', () => {
	let total = 0;

	afterEach(() => {
		setSubscriptionAccountingHook(null);
		total = 0;
	});

	it('charges mixed wire/platform/tracked adds and duplicate removals exactly once', () => {
		setSubscriptionAccountingHook((delta) => { total += delta; });
		const subscriptions = new Set();
		const ud = { [WS_SUBSCRIPTIONS]: subscriptions };
		const ws = fakeWs(ud);

		// The production wire and platform landings use this primitive. A plugin
		// tracked join racing either lane sees the same Set and contributes zero.
		expect(addLogicalSubscription(subscriptions, 'room')).toBe(true);
		expect(addLogicalSubscription(subscriptions, 'room')).toBe(false);
		expect(trackedSubscribe(ws, 'room')).toBe(true);
		expect(total).toBe(1);
		expect(checkTotalSubscriptions({
			totalSubscriptions: total,
			connections: [{ subscribed: ['room'], bookkeeping: ['room'] }]
		})).toBeNull();

		expect(removeLogicalSubscription(subscriptions, 'room')).toBe(true);
		expect(removeLogicalSubscription(subscriptions, 'room')).toBe(false);
		expect(trackedUnsubscribe(ws, 'room')).toBe(true);
		expect(total).toBe(0);
		expect(total).toBeGreaterThanOrEqual(0);
	});

	it('balances a revoked async hook membership and its cursor/presence-style derived tap', () => {
		setSubscriptionAccountingHook((delta) => { total += delta; });
		const prefix = '__rt941-derived:';
		registerDerivedTopicPrefix(prefix);
		const ud = { [WS_SUBSCRIPTIONS]: new Set() };
		const ws = fakeWs(ud);
		const token = beginPendingSubscribe(ud, 'room', false);

		// A groups/presence/cursor hook can install membership while its outer
		// wire/platform authorization await is parked.
		expect(trackedSubscribe(ws, 'room')).toBe(true);
		expect(trackedSubscribe(ws, prefix + 'room')).toBe(true);
		expect(total).toBe(2);
		expect(tombstonePendingSubscribe(ud, 'room')).toBe(true);
		expect(settleHeldSubscribe(ud, 'room', token)).toBe('deny-unwind');
		unwindRevokedMembership(ws, 'room');

		expect(ud[WS_SUBSCRIPTIONS]).toEqual(new Set());
		expect(total).toBe(0);
		// Repeated cleanup is idempotent and cannot push accounting negative.
		unwindRevokedMembership(ws, 'room');
		expect(total).toBe(0);
	});

	it('charges every still-live membership once on close', () => {
		setSubscriptionAccountingHook((delta) => { total += delta; });
		const subscriptions = new Set();
		addLogicalSubscription(subscriptions, 'wire');
		addLogicalSubscription(subscriptions, 'platform');
		addLogicalSubscription(subscriptions, 'tracked');
		expect(total).toBe(3);
		expect(accountClosedLogicalSubscriptions(subscriptions)).toBe(3);
		expect(total).toBe(0);
	});

	it('settles the registry once, so a repeated close releases nothing', () => {
		setSubscriptionAccountingHook((delta) => { total += delta; });
		const subscriptions = new Set();
		addLogicalSubscription(subscriptions, 'one');
		addLogicalSubscription(subscriptions, 'two');
		expect(total).toBe(2);

		expect(accountClosedLogicalSubscriptions(subscriptions)).toBe(2);
		expect(total).toBe(0);
		// The Set stays populated on purpose - it is the snapshot the app's close
		// hook was handed - so a second call must not read those two entries as
		// two more live memberships to release.
		expect(subscriptions.size).toBe(2);
		expect(accountClosedLogicalSubscriptions(subscriptions)).toBe(0);
		expect(total).toBe(0);
	});

	it('charges neither a release nor a subscribe that lands after close', () => {
		setSubscriptionAccountingHook((delta) => { total += delta; });
		const subscriptions = new Set();
		addLogicalSubscription(subscriptions, 'room');
		expect(accountClosedLogicalSubscriptions(subscriptions)).toBe(1);
		expect(total).toBe(0);

		// Both directions: a late leave must not push the counter below the truth,
		// and a late join must not raise it for a connection that is already gone.
		expect(removeLogicalSubscription(subscriptions, 'room')).toBe(true);
		expect(total).toBe(0);
		expect(addLogicalSubscription(subscriptions, 'room')).toBe(true);
		expect(total).toBe(0);
	});

	it('releases nothing, and does not throw, on a corrupted subscription slot', () => {
		// The close path calls this from a `finally`. A throw here would escape the
		// close callback and abandon the rest of the connection's teardown, so a
		// slot that is not a Set has to be answered rather than raised on - the
		// shape guards on the subscribe/unsubscribe paths are what report it.
		setSubscriptionAccountingHook((delta) => { total += delta; });
		for (const corrupt of [undefined, null, 'room', 7, { size: 3 }, ['room']]) {
			expect(() => accountClosedLogicalSubscriptions(/** @type {any} */ (corrupt))).not.toThrow();
			expect(accountClosedLogicalSubscriptions(/** @type {any} */ (corrupt))).toBe(0);
		}
		expect(total).toBe(0);
	});

	it('keeps charging a live registry that merely emptied itself', () => {
		// The tombstone must key on the close having run, NOT on the Set being
		// empty: a connection that unsubscribes from everything and then subscribes
		// again is still live, and every one of those deltas must still be charged.
		setSubscriptionAccountingHook((delta) => { total += delta; });
		const subscriptions = new Set();
		addLogicalSubscription(subscriptions, 'room');
		expect(removeLogicalSubscription(subscriptions, 'room')).toBe(true);
		expect(subscriptions.size).toBe(0);
		expect(total).toBe(0);
		addLogicalSubscription(subscriptions, 'room');
		expect(total).toBe(1);
		expect(accountClosedLogicalSubscriptions(subscriptions)).toBe(1);
		expect(total).toBe(0);
	});

	it('keeps the existing auditor mismatch and negative diagnostics intact', () => {
		expect(checkTotalSubscriptions({
			totalSubscriptions: 2,
			connections: [{ subscribed: ['one'], bookkeeping: ['one'] }]
		})).toEqual({
			category: 'subs.total-mismatch',
			context: { totalSubscriptions: 2, summed: 1 }
		});
		expect(checkTotalSubscriptions({ totalSubscriptions: -1, connections: [] })).toEqual({
			category: 'subs.total-negative',
			context: { totalSubscriptions: -1 }
		});
	});
});

describe('production-built subscription accounting wiring', () => {
	const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
	let state;
	let productionPlatform;
	let productionSymbols;

	beforeAll(async () => {
		expect(buildFixtureOnce('default'), 'default fixture failed to build').toBe(true);
		// Importing the real generated handler installs the accounting hook. The
		// three modules below are the files the production build itself imports.
		await import(pathToFileURL(join(fixtureDir, 'build', 'handler.js')).href);
		state = await import(pathToFileURL(join(fixtureDir, 'build', 'handler', 'state.js')).href);
		({ platform: productionPlatform } = await import(pathToFileURL(join(fixtureDir, 'build', 'handler', 'platform.js')).href));
		productionSymbols = await import(pathToFileURL(join(fixtureDir, 'build', 'utils', 'ws-symbols.js')).href);
	}, 180000);

	it('keeps platform, wire-primitive, tracked, unsubscribe, and close deltas balanced', async () => {
		const baseline = state.counters.totalSubscriptions;
		const subscriptions = new Set();
		const ud = {
			[productionSymbols.WS_SUBSCRIPTIONS]: subscriptions,
			[productionSymbols.WS_PLATFORM]: productionPlatform
		};
		const ws = fakeWs(ud);

		expect(await productionPlatform.subscribe(ws, 'platform-room')).toBeNull();
		expect(await productionPlatform.subscribe(ws, 'platform-room')).toBeNull();
		expect(state.counters.totalSubscriptions).toBe(baseline + 1);

		expect(productionSymbols.addLogicalSubscription(subscriptions, 'wire-room')).toBe(true);
		expect(productionSymbols.trackedSubscribe(ws, 'wire-room')).toBe(true);
		expect(productionSymbols.trackedSubscribe(ws, 'tracked-room')).toBe(true);
		expect(productionSymbols.trackedSubscribe(ws, 'tracked-room')).toBe(true);
		expect(state.counters.totalSubscriptions).toBe(baseline + 3);

		expect(productionPlatform.unsubscribe(ws, 'platform-room')).toBe(true);
		expect(productionPlatform.unsubscribe(ws, 'platform-room')).toBe(false);
		expect(productionSymbols.removeLogicalSubscription(subscriptions, 'wire-room')).toBe(true);
		expect(productionSymbols.trackedUnsubscribe(ws, 'wire-room')).toBe(true);
		expect(state.counters.totalSubscriptions).toBe(baseline + 1);

		expect(productionSymbols.accountClosedLogicalSubscriptions(subscriptions)).toBe(1);
		expect(state.counters.totalSubscriptions).toBe(baseline);
		expect(state.counters.totalSubscriptions).toBeGreaterThanOrEqual(0);
	});

	it('does not charge a membership twice when a release lands after close accounting', () => {
		// The close path charges every still-live membership once. A release that
		// lands after it - a plugin leave parked in an await, a revocation that
		// resumes once the socket is already gone - must find nothing left to
		// charge. Charging again drives the per-worker counter below the truth,
		// and once it is below the truth every later audit reports either a
		// negative total or a summed/total mismatch that no membership explains.
		const baseline = state.counters.totalSubscriptions;
		const subscriptions = new Set();
		const ud = {
			[productionSymbols.WS_SUBSCRIPTIONS]: subscriptions,
			[productionSymbols.WS_PLATFORM]: productionPlatform
		};
		const ws = fakeWs(ud);

		expect(productionSymbols.trackedSubscribe(ws, 'room')).toBe(true);
		expect(state.counters.totalSubscriptions).toBe(baseline + 1);

		expect(productionSymbols.accountClosedLogicalSubscriptions(subscriptions)).toBe(1);
		expect(state.counters.totalSubscriptions).toBe(baseline);

		productionPlatform.unsubscribe(ws, 'room');
		expect(state.counters.totalSubscriptions).toBe(baseline);

		// Same question for the tracked plugin lane, which is the one presence and
		// cursor actually use.
		productionSymbols.trackedUnsubscribe(ws, 'room');
		expect(state.counters.totalSubscriptions).toBe(baseline);
	});

	it('leaves the counter agreeing with the auditor predicate after closes with late releases', () => {
		// The two halves come from independent places on purpose: the expected
		// value is summed from the connections' own subscription Sets by the same
		// predicate the consistency auditor runs, and the actual is the worker
		// counter the accounting primitive maintains. A guard that read the
		// counter twice could not fail.
		const baseline = state.counters.totalSubscriptions;
		const open = (index) => {
			const subscriptions = new Set();
			const ud = {
				[productionSymbols.WS_SUBSCRIPTIONS]: subscriptions,
				[productionSymbols.WS_PLATFORM]: productionPlatform
			};
			const ws = fakeWs(ud);
			productionSymbols.trackedSubscribe(ws, 'room-' + index);
			productionSymbols.trackedSubscribe(ws, 'shared');
			return { ws, subscriptions, index };
		};
		const live = [open(0), open(1)];
		const gone = [open(2), open(3)];
		expect(state.counters.totalSubscriptions).toBe(baseline + 8);

		for (const conn of gone) {
			expect(productionSymbols.accountClosedLogicalSubscriptions(conn.subscriptions)).toBe(2);
			// The late plugin cleanup, on both lanes that reach the registry.
			productionPlatform.unsubscribe(conn.ws, 'shared');
			productionSymbols.trackedUnsubscribe(conn.ws, 'room-' + conn.index);
		}

		expect(checkTotalSubscriptions({
			totalSubscriptions: state.counters.totalSubscriptions - baseline,
			connections: live.map((conn) => ({
				subscribed: [...conn.subscriptions],
				bookkeeping: [...conn.subscriptions]
			}))
		})).toBeNull();

		// Hand the counter back. `counters` is the worker-wide singleton the real
		// consistency auditor reads on its timer, so a case that leaves charges
		// standing against connections the auditor cannot see makes it report a
		// mismatch from whatever test happens to be running when the timer fires.
		for (const conn of live) {
			expect(productionSymbols.accountClosedLogicalSubscriptions(conn.subscriptions)).toBe(2);
		}
		expect(state.counters.totalSubscriptions).toBe(baseline);
	});
});
