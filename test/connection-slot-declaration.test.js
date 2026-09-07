// The runtime's per-connection slots are written with plain assignments, and a
// plain assignment is a [[Set]]: it walks the prototype chain. The userData
// object uWS hands to `open` inherits from uWS.WebSocket, whose chain reaches
// Object.prototype, so an accessor installed there for one of the slot keys
// takes the value and leaves NO own property behind. The keys are reachable by
// construction - they are Symbol.for, so that duplicated module instances
// resolve one slot - which is why this is not a hostile-code-only concern.
//
// A swallowed write is worse than a lost value. Every slot site is a lazy init
// or a transition behind a falsy guard, so the guard never closes and the lane
// redoes its work forever: the subscription Set is rebuilt empty, the coalesce
// buffer is reallocated per message, the wire-id space restarts.
//
// WHY THE END-TO-END CASE ASSERTS OWNERSHIP RATHER THAN INSTALLING AN ACCESSOR.
// Under vitest the userData object is built by the native addon, and its
// prototype chain does NOT reach the Object.prototype this module can see - the
// addon's objects come from a different realm than the transformed test module.
// An accessor installed here is therefore never consulted by a write over
// there, so a case built on one passes whether or not the runtime declares
// anything, which is worth exactly nothing. Ownership is the property the fix
// actually establishes and it is visible across the realm boundary, so that is
// what the live connection is asked for; the interception half is proved on an
// object this module owns, where an accessor does apply.

import { describe, it, expect, afterEach } from 'vitest';
import { createTestServer } from '../src/testing.js';
import {
	CONNECTION_SLOTS, declareConnectionSlots, WS_PLATFORM, WS_COALESCED, WS_SUBSCRIPTIONS,
	setCohortHooks, setSubscriptionAccountingHook, trackedSubscribe, trackedUnsubscribe,
	accountClosedLogicalSubscriptions, isSettledSubscriptionRegistry
} from '../src/runtime/utils.js';
import { WebSocket } from 'ws';

/** @type {Array<{ close(): void }>} */
const servers = [];
/** @type {WebSocket[]} */
const clients = [];

afterEach(async () => {
	for (const c of clients.splice(0)) { try { c.terminate(); } catch { /* gone */ } }
	await sleep(30);
	for (const s of servers.splice(0)) { try { s.close(); } catch { /* closed */ } }
	await sleep(30);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function boot(options) {
	const server = await createTestServer(options);
	servers.push(server);
	return server;
}

async function connect(url, topic) {
	const ws = new WebSocket(url);
	clients.push(ws);
	/** @type {any[]} */
	const frames = [];
	ws.on('message', (data, isBinary) => {
		if (isBinary) return;
		try { frames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
	});
	await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
	if (topic) ws.send(JSON.stringify({ type: 'subscribe', topic }));
	await sleep(120);
	return { ws, frames };
}

describe('per-connection slots are written past the prototype chain', () => {
	it('holds every slot as an own property once a connection is open', async () => {
		// The one assertion that distinguishes a declared slot from an assigned
		// one: a slot no lane has touched yet is still own. Without the
		// declaration only the handful of slots that open happens to write are
		// own, and every other write on the connection is still a [[Set]]
		// waiting for an accessor to swallow it.
		const server = await boot();
		const c = await connect(server.wsUrl, 'feed');
		const userData = [...server.wsConnections][0].getUserData();

		const undeclared = CONNECTION_SLOTS
			.filter((slot) => !Object.hasOwn(userData, slot))
			.map((slot) => slot.description);
		expect(undeclared, 'a slot is still reachable through the prototype chain').toEqual([]);

		// Declared, not filled: a slot the connection has not used carries
		// undefined, so the falsy guards that gate lazy allocation still read the
		// way they did before the declaration.
		expect(userData[WS_COALESCED]).toBeUndefined();

		expect(server.platform.publish('feed', 'e', { n: 1 })).toBe(true);
		await sleep(120);
		expect(c.frames.some((f) => f.topic === 'feed' && f.event === 'e')).toBe(true);
	});

	it('takes the write itself when an accessor holds the key', () => {
		// The interception half, on an object this module owns so that the
		// accessor is genuinely on the write's prototype chain. This is the shape
		// of the userData object before uWS re-parents it: a plain object whose
		// chain is Object.prototype.
		const slot = CONNECTION_SLOTS[0];
		/** @type {unknown} */
		let stolen = null;
		Object.defineProperty(Object.prototype, slot, {
			set(v) { stolen = v; },
			get() { return undefined; },
			configurable: true
		});
		try {
			const userData = {};
			// Without the declaration this assignment reaches the setter and
			// creates nothing, which is the whole defect.
			declareConnectionSlots(userData);
			userData[slot] = 'runtime state';

			expect(stolen, 'the slot write reached an inherited setter').toBe(null);
			expect(userData[slot]).toBe('runtime state');
			expect(Object.hasOwn(userData, slot)).toBe(true);
		} finally {
			// @ts-expect-error - deleting a symbol-keyed property off the prototype
			delete Object.prototype[slot];
		}
	});

	it('declares every slot the runtime actually writes', async () => {
		// An oracle independent of the registry: drive a connection, then read the
		// adapter symbols the runtime really put on userData and require each one
		// to be declared. A slot added later with a bare assignment and no
		// registry entry fails here rather than silently reopening the hole.
		const server = await boot({ handler: { close() {} } });
		const c = await connect(server.wsUrl, 'feed');
		server.platform.publish('feed', 'e', { n: 1 });
		await sleep(80);

		const userData = [...server.wsConnections][0].getUserData();
		const declared = new Set(CONNECTION_SLOTS);
		const undeclared = Object.getOwnPropertySymbols(userData)
			.filter((s) => typeof s.description === 'string' && s.description.startsWith('adapter-uws.'))
			.filter((s) => !declared.has(s))
			.map((s) => s.description);

		expect(undeclared, 'a slot the runtime writes is not in CONNECTION_SLOTS').toEqual([]);
		expect(c.frames.some((f) => f.event === 'e')).toBe(true);
	});

	it('leaves an already-populated slot alone, so the double-init guard keeps its evidence', () => {
		// `ws.platform-double-init` refuses a re-entrant open by finding the
		// platform slot already set. Declaring slots must not answer that question
		// before it is asked, so a slot that is already an own property is not
		// touched.
		const live = { marker: 'live platform' };
		const userData = { [WS_PLATFORM]: live };
		declareConnectionSlots(userData);
		expect(userData[WS_PLATFORM]).toBe(live);

		const [firstAbsent] = CONNECTION_SLOTS.filter((s) => s !== WS_PLATFORM);
		expect(Object.hasOwn(userData, firstAbsent)).toBe(true);
		expect(userData[firstAbsent]).toBeUndefined();
	});
});

// The process-wide slots have the same exposure with a wider blast radius: they
// hang off globalThis under Symbol.for keys, so one accessor on
// Object.prototype takes the publication for every module copy at once. Each
// of these keys is written exactly once per process, so an accessor is what a
// bare assignment would meet on first use. The cases install the accessor
// first and then use the slot through its public entry point, so they fail
// against an assignment and pass only when the write defines an own property.
describe('the process-wide slots are defined, not assigned', () => {
	/** Install an accessor on Object.prototype for `key`, run `body`, restore. */
	function underAccessor(key, body) {
		const before = Object.getOwnPropertyDescriptor(globalThis, key);
		if (before) delete globalThis[key];
		/** @type {unknown[]} */
		const stolen = [];
		Object.defineProperty(Object.prototype, key, {
			set(v) { stolen.push(v); },
			get() { return undefined; },
			configurable: true
		});
		try {
			body(stolen);
		} finally {
			// @ts-expect-error - a symbol-keyed accessor on the prototype
			delete Object.prototype[key];
			delete globalThis[key];
			if (before) Object.defineProperty(globalThis, key, before);
		}
	}

	it('the cohort hooks are installed where the fan-out reads them', () => {
		underAccessor(Symbol.for('adapter-uws.cohort-hooks'), (stolen) => {
			const joined = [];
			setCohortHooks((_ws, _ud, topic) => { joined.push(topic); }, null);
			expect(stolen, 'the hooks object reached an inherited setter').toEqual([]);
			expect(Object.hasOwn(globalThis, Symbol.for('adapter-uws.cohort-hooks'))).toBe(true);
			// Through the public path: a tracked subscribe on a connection that
			// holds no registry yet must reach the hook just installed.
			const subs = new Set();
			const ws = { getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }), subscribe() { return true; } };
			trackedSubscribe(ws, 'room:1');
			expect(joined).toEqual(['room:1']);
			setCohortHooks(null, null);
		});
	});

	it('the subscription accounting hook is installed, not swallowed', () => {
		underAccessor(Symbol.for('adapter-uws.subscription-accounting-hook'), (stolen) => {
			const deltas = [];
			expect(setSubscriptionAccountingHook((delta, topic) => { deltas.push([delta, topic]); })).toBe(false);
			expect(stolen).toEqual([]);
			const subs = new Set();
			const ws = { getUserData: () => ({ [WS_SUBSCRIPTIONS]: subs }), subscribe() { return true; }, unsubscribe() { return true; } };
			trackedSubscribe(ws, 'room:2');
			trackedUnsubscribe(ws, 'room:2');
			expect(deltas).toEqual([[1, 'room:2'], [-1, 'room:2']]);
			setSubscriptionAccountingHook(null);
		});
	});

	it('a settled registry stays settled across calls', () => {
		underAccessor(Symbol.for('adapter-uws.settled-subscription-registries'), (stolen) => {
			const subs = new Set(['room:3']);
			// The close path settles the registry; a second release must find it
			// settled, or the membership is charged twice. Under an assignment
			// every call builds a fresh WeakSet and nothing is ever settled.
			expect(accountClosedLogicalSubscriptions(subs)).toBe(1);
			expect(stolen).toEqual([]);
			expect(isSettledSubscriptionRegistry(subs)).toBe(true);
			expect(accountClosedLogicalSubscriptions(subs), 'a settled registry releases nothing twice').toBe(0);
		});
	});
});
