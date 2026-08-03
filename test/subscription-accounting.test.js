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
});
