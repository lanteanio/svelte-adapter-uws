// Server-side tests for the CRDT document authority: access-record
// normalization, the reference-counted replica lifecycle, the coalesced
// (hydrate-stampede-safe) load, update merge + convergence invariants, the
// state-vector diff, and the persistence schedule (debounce, max-wait force,
// update-count compaction, persist-on-empty, store-failure retry). Time and
// timers are scripted through the injectable runtime, the same harness shape
// as the other plugin servers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { createCrdtAuthority, normalizeCrdtAccess } from '../plugins/crdt/replica.js';
import { installFakeRuntimeClock, releaseRuntimeClock } from './_helpers.js';

/** Drain pending microtasks (promise chains between scripted timer steps). */
const tick = async (n = 4) => {
	for (let i = 0; i < n; i++) await Promise.resolve();
};

/** A scratch client doc whose root map holds `entries`, plus its full state. */
function docWith(entries) {
	const doc = new Y.Doc();
	const m = doc.getMap('root');
	doc.transact(() => {
		for (const [k, v] of Object.entries(entries)) m.set(k, v);
	});
	return doc;
}

/** Materialize an authority topic's state into plain JSON via its full diff. */
function readState(auth, topic) {
	const full = auth.diff(topic);
	const scratch = new Y.Doc();
	Y.applyUpdate(scratch, full);
	return scratch.getMap('root').toJSON();
}

/** Capture the incremental update for one transaction on a doc. */
function captureUpdate(doc, fn) {
	let update = null;
	const grab = (u) => { update = u; };
	doc.on('update', grab);
	doc.transact(fn);
	doc.off('update', grab);
	return update;
}

describe('normalizeCrdtAccess', () => {
	it('widens a boolean gate to all three rights', () => {
		expect(normalizeCrdtAccess(true)).toEqual({ read: true, write: true, comment: true });
		expect(normalizeCrdtAccess(false)).toEqual({ read: false, write: false, comment: false });
	});
	it('treats a truthy non-object as a boolean gate', () => {
		expect(normalizeCrdtAccess('editor')).toEqual({ read: true, write: true, comment: true });
		expect(normalizeCrdtAccess(0)).toEqual({ read: false, write: false, comment: false });
		expect(normalizeCrdtAccess(undefined)).toEqual({ read: false, write: false, comment: false });
		expect(normalizeCrdtAccess(null)).toEqual({ read: false, write: false, comment: false });
	});
	it('defaults a missing right to false (the safe choice): {read} means read-only', () => {
		expect(normalizeCrdtAccess({ read: true })).toEqual({ read: true, write: false, comment: false });
		expect(normalizeCrdtAccess({ read: true, write: true })).toEqual({ read: true, write: true, comment: false });
		expect(normalizeCrdtAccess({})).toEqual({ read: false, write: false, comment: false });
	});
	it('coerces record fields to booleans and ignores extras', () => {
		expect(normalizeCrdtAccess({ read: 1, write: '', comment: 'yes', role: 'x' }))
			.toEqual({ read: true, write: false, comment: true });
	});
});

describe('lifecycle and the coalesced load', () => {
	it('loads a cold topic from persist.load and serves its state', async () => {
		const stored = Y.encodeStateAsUpdate(docWith({ title: 'hello' }));
		const load = vi.fn(async () => stored);
		const auth = createCrdtAuthority({ persist: { load } });
		await auth.acquire('board:1');
		expect(load).toHaveBeenCalledTimes(1);
		expect(auth.has('board:1')).toBe(true);
		expect(auth.refs('board:1')).toBe(1);
		expect(readState(auth, 'board:1')).toEqual({ title: 'hello' });
		auth.destroy();
	});

	it('accepts a number[] load result and a null (brand-new) result', async () => {
		const stored = Array.from(Y.encodeStateAsUpdate(docWith({ n: 1 })));
		const auth = createCrdtAuthority({ persist: { load: async (t) => (t === 'a' ? stored : null) } });
		await auth.acquire('a');
		await auth.acquire('b');
		expect(readState(auth, 'a')).toEqual({ n: 1 });
		expect(readState(auth, 'b')).toEqual({});
		auth.destroy();
	});

	it('coalesces concurrent cold joins onto exactly one load (the stampede gate)', async () => {
		let resolveLoad;
		const load = vi.fn(() => new Promise((r) => { resolveLoad = r; }));
		const auth = createCrdtAuthority({ persist: { load } });
		const a = auth.acquire('board:1');
		const b = auth.acquire('board:1');
		const c = auth.acquire('board:1');
		await tick();
		expect(load).toHaveBeenCalledTimes(1);
		resolveLoad(null);
		await Promise.all([a, b, c]);
		expect(auth.refs('board:1')).toBe(3);
		expect(load).toHaveBeenCalledTimes(1);
		auth.destroy();
	});

	it('rejects every coalesced waiter on a failed load, then retries fresh', async () => {
		const load = vi.fn()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce(null);
		const errors = [];
		const auth = createCrdtAuthority({ persist: { load }, onError: (e, info) => errors.push(info.op) });
		const a = auth.acquire('t');
		const b = auth.acquire('t');
		await expect(a).rejects.toThrow('db down');
		await expect(b).rejects.toThrow('db down');
		expect(auth.has('t')).toBe(false);
		expect(errors).toEqual(['load']);
		await auth.acquire('t');
		expect(load).toHaveBeenCalledTimes(2);
		expect(auth.has('t')).toBe(true);
		auth.destroy();
	});

	it('rejects a load result that is not bytes', async () => {
		const auth = createCrdtAuthority({ persist: { load: async () => 'not-bytes' } });
		await expect(auth.acquire('t')).rejects.toThrow('persist.load');
		expect(auth.has('t')).toBe(false);
		auth.destroy();
	});

	it('refuses to acquire after destroy', async () => {
		const auth = createCrdtAuthority();
		auth.destroy();
		await expect(auth.acquire('t')).rejects.toThrow('destroyed');
	});

	it('rejects an in-flight acquire when the authority is destroyed mid-load', async () => {
		let resolveLoad;
		const auth = createCrdtAuthority({ persist: { load: () => new Promise((r) => { resolveLoad = r; }) } });
		const pending = auth.acquire('t');
		await tick();
		auth.destroy();
		resolveLoad(null);
		await expect(pending).rejects.toThrow('destroyed');
	});
});

describe('update merge and convergence', () => {
	let auth;
	beforeEach(async () => {
		auth = createCrdtAuthority();
		await auth.acquire('t');
	});
	afterEach(() => auth.destroy());

	it('merges an inbound update and returns the normalized bytes for fan-out', () => {
		const client = docWith({});
		const update = captureUpdate(client, () => client.getMap('root').set('a', 1));
		const out = auth.applyUpdate('t', Array.from(update));
		expect(out).toBeInstanceOf(Uint8Array);
		expect(Array.from(out)).toEqual(Array.from(update));
		expect(readState(auth, 't')).toEqual({ a: 1 });
	});

	it('drops malformed bytes without corrupting the replica', () => {
		const client = docWith({});
		const update = captureUpdate(client, () => client.getMap('root').set('a', 1));
		expect(auth.applyUpdate('t', update)).not.toBe(null);
		expect(auth.applyUpdate('t', new Uint8Array([255, 254, 253, 99, 1]))).toBe(null);
		expect(auth.applyUpdate('t', [1, 2, 'x'])).toBe(null);
		expect(auth.applyUpdate('t', 'nope')).toBe(null);
		expect(auth.applyUpdate('t', new Uint8Array(0))).toBe(null);
		expect(readState(auth, 't')).toEqual({ a: 1 });
	});

	it('returns null for an unloaded topic', () => {
		expect(auth.applyUpdate('other', new Uint8Array([0, 0]))).toBe(null);
	});

	it('re-applying the same update is a no-op (idempotent merge)', () => {
		const client = docWith({});
		const update = captureUpdate(client, () => client.getMap('root').set('a', 1));
		auth.applyUpdate('t', update);
		const before = auth.diff('t');
		auth.applyUpdate('t', update);
		expect(Array.from(auth.diff('t'))).toEqual(Array.from(before));
	});

	it('concurrent updates converge regardless of apply order', async () => {
		const auth2 = createCrdtAuthority();
		await auth2.acquire('t');
		const c1 = docWith({});
		const c2 = docWith({});
		const u1 = captureUpdate(c1, () => c1.getMap('root').set('x', 'from-c1'));
		const u2 = captureUpdate(c2, () => c2.getMap('root').set('y', 'from-c2'));
		auth.applyUpdate('t', u1);
		auth.applyUpdate('t', u2);
		auth2.applyUpdate('t', u2);
		auth2.applyUpdate('t', u1);
		expect(readState(auth, 't')).toEqual(readState(auth2, 't'));
		auth2.destroy();
	});
});

describe('state-vector diff', () => {
	it('serves the full state for a missing/empty vector and the tail for a partial one', async () => {
		const auth = createCrdtAuthority();
		await auth.acquire('t');
		const client = docWith({});
		const u1 = captureUpdate(client, () => client.getMap('root').set('a', 1));
		auth.applyUpdate('t', u1);
		// A client that already holds u1 syncs: the diff must not resend it.
		const sv = Y.encodeStateVector(client);
		const u2 = captureUpdate(client, () => client.getMap('root').set('b', 2));
		auth.applyUpdate('t', u2);
		const tail = auth.diff('t', Array.from(sv));
		const full = auth.diff('t');
		expect(tail.length).toBeLessThan(full.length);
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, Y.encodeStateAsUpdate(client, Y.encodeStateVector(scratch)));
		// applying only the tail on top of u1 yields the full state
		const fromTail = new Y.Doc();
		Y.applyUpdate(fromTail, u1);
		Y.applyUpdate(fromTail, tail);
		expect(fromTail.getMap('root').toJSON()).toEqual({ a: 1, b: 2 });
		auth.destroy();
	});

	it('falls back to the full state for a malformed vector', async () => {
		const auth = createCrdtAuthority();
		await auth.acquire('t');
		const client = docWith({});
		auth.applyUpdate('t', captureUpdate(client, () => client.getMap('root').set('a', 1)));
		const diff = auth.diff('t', new Uint8Array([250, 251, 252]));
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, diff);
		expect(scratch.getMap('root').toJSON()).toEqual({ a: 1 });
		auth.destroy();
	});

	it('returns null diff/stateVector for an unloaded topic and bytes for a loaded one', async () => {
		const auth = createCrdtAuthority();
		expect(auth.diff('t')).toBe(null);
		expect(auth.stateVector('t')).toBe(null);
		await auth.acquire('t');
		expect(auth.diff('t')).toBeInstanceOf(Uint8Array);
		expect(auth.stateVector('t')).toBeInstanceOf(Uint8Array);
		auth.destroy();
	});
});

describe('persistence schedule', () => {
	let stores;
	let auth;
	const edit = (topic = 't', key = 'k', value = Math.floor(1000)) => {
		const client = docWith({});
		const u = captureUpdate(client, () => client.getMap('root').set(key, value));
		return auth.applyUpdate(topic, u);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		installFakeRuntimeClock();
		stores = [];
	});
	afterEach(() => {
		if (auth) auth.destroy();
		auth = null;
		releaseRuntimeClock();
		vi.useRealTimers();
	});

	const makeAuth = (opts = {}) =>
		createCrdtAuthority({
			persist: {
				load: async () => null,
				store: async (topic, bytes) => { stores.push({ topic, bytes }); }
			},
			debounceWait: 2000,
			debounceMaxWait: 5000,
			snapshotEvery: 100,
			...opts
		});

	it('coalesces a burst of edits into one store after debounceWait', async () => {
		auth = makeAuth();
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(500);
		edit('t', 'b');
		await vi.advanceTimersByTimeAsync(500);
		edit('t', 'c');
		expect(stores.length).toBe(0);
		await vi.advanceTimersByTimeAsync(2100);
		expect(stores.length).toBe(1);
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, stores[0].bytes);
		expect(Object.keys(scratch.getMap('root').toJSON()).sort()).toEqual(['a', 'b', 'c']);
	});

	it('forces a checkpoint at debounceMaxWait during sustained editing', async () => {
		auth = makeAuth();
		await auth.acquire('t');
		// keep editing every 1.5s: the trailing debounce never fires on its
		// own, but the max-wait clamp forces one store by t=5000.
		for (let i = 0; i < 4; i++) {
			edit('t', 'k' + i);
			await vi.advanceTimersByTimeAsync(1500);
		}
		expect(stores.length).toBe(1);
	});

	it('compacts immediately every snapshotEvery updates', async () => {
		auth = makeAuth({ snapshotEvery: 3 });
		await auth.acquire('t');
		edit('t', 'a');
		edit('t', 'b');
		expect(stores.length).toBe(0);
		edit('t', 'c');
		await tick();
		expect(stores.length).toBe(1);
	});

	it('runs one final store on the empty transition and unloads', async () => {
		auth = makeAuth();
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t');
		await tick(8);
		expect(stores.length).toBe(1);
		expect(auth.has('t')).toBe(false);
	});

	it('a re-acquire during the on-empty store keeps the replica live', async () => {
		let releaseStore;
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: () => new Promise((r) => { releaseStore = r; })
			}
		});
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t');
		await tick();
		await auth.acquire('t'); // re-join while the final store is in flight
		releaseStore();
		await tick(8);
		expect(auth.has('t')).toBe(true);
		expect(readState(auth, 't')).toEqual({ a: expect.anything() });
	});

	it('an older store settling never unloads while a newer store is chained; the newer settlement owns the lifecycle', async () => {
		const gates = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes) => new Promise((resolve, reject) => { gates.push({ resolve, reject, bytes }); })
			},
			debounceWait: 2000,
			debounceMaxWait: 5000
		});
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t'); // final store, slow in flight
		await tick();
		expect(gates.length).toBe(1);
		await auth.acquire('t'); // flap back while the store is pending
		edit('t', 'b');
		auth.release('t'); // a SECOND final store chains behind the first
		await tick();
		gates[0].resolve(); // the OLDER store settles first: must not unload
		await tick(8);
		expect(auth.has('t')).toBe(true);
		expect(gates.length).toBe(2); // the newer store is now running
		gates[1].reject(new Error('disk full')); // the NEWEST store fails
		await tick(8);
		expect(auth.has('t')).toBe(true); // dirty replica survived; retry armed
		await vi.advanceTimersByTimeAsync(5100);
		await tick(8);
		expect(gates.length).toBe(3);
		gates[2].resolve();
		await tick(8);
		expect(auth.has('t')).toBe(false); // retry succeeded, deferred unload ran
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, gates[2].bytes);
		expect(Object.keys(scratch.getMap('root').toJSON()).sort()).toEqual(['a', 'b']);
	});

	it('never unloads a dirty replica on store failure; retries and then unloads', async () => {
		const calls = [];
		let failNext = true;
		const errors = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: async (topic, bytes) => {
					calls.push(bytes);
					if (failNext) { failNext = false; throw new Error('disk full'); }
				}
			},
			debounceWait: 2000,
			debounceMaxWait: 5000,
			onError: (e, info) => errors.push(info.op)
		});
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t');
		await tick(8);
		expect(calls.length).toBe(1);
		expect(errors).toEqual(['store']);
		expect(auth.has('t')).toBe(true); // dirty replica survived the failure
		await vi.advanceTimersByTimeAsync(5100); // retry cadence
		await tick(8);
		expect(calls.length).toBe(2);
		expect(auth.has('t')).toBe(false); // retry succeeded, deferred unload ran
	});

	it('unloads without storing when no store hook is configured', async () => {
		auth = createCrdtAuthority({ persist: { load: async () => null } });
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t');
		await tick(8);
		expect(auth.has('t')).toBe(false);
	});

	it('a declined store (store returns false) keeps the topic dirty and re-probes at the max-wait cadence', async () => {
		let allow = false;
		const writes = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// Decline until `allow` flips - the cluster "another instance
				// holds the persist lease" path returns false, not a throw.
				store: async (topic, bytes) => {
					if (!allow) return false;
					writes.push({ topic, bytes });
				}
			},
			debounceWait: 2000,
			debounceMaxWait: 5000
		});
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(2100); // first scheduled store
		await tick();
		expect(writes).toHaveLength(0); // declined
		expect(auth.has('t')).toBe(true); // still loaded, still dirty
		// The decline re-probed at max-wait; once the lease frees, it writes.
		allow = true;
		await vi.advanceTimersByTimeAsync(5100);
		await tick(8);
		expect(writes).toHaveLength(1);
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, writes[0].bytes);
		expect(Object.keys(scratch.getMap('root').toJSON())).toEqual(['a']);
	});

	it('a declined final store still unloads the replica (the lease holder owns the durable write)', async () => {
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: async () => false // always declined (never the lease holder)
			}
		});
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t');
		await tick(8);
		// Declined write must NOT pin the replica: a peer instance persists it.
		expect(auth.has('t')).toBe(false);
	});

	it('skips the final store when persistOnEmpty is off', async () => {
		auth = makeAuth({ persistOnEmpty: false });
		await auth.acquire('t');
		edit('t', 'a');
		auth.release('t');
		await tick(8);
		expect(stores.length).toBe(0);
		expect(auth.has('t')).toBe(false);
	});

	it('persistNow forces a store immediately and clears the schedule', async () => {
		auth = makeAuth();
		await auth.acquire('t');
		edit('t', 'a');
		await auth.persistNow('t');
		expect(stores.length).toBe(1);
		await vi.advanceTimersByTimeAsync(10000);
		expect(stores.length).toBe(1); // the pending debounce was consumed
	});

	it('destroy cancels every pending schedule', async () => {
		auth = makeAuth();
		await auth.acquire('t');
		edit('t', 'a');
		auth.destroy();
		await vi.advanceTimersByTimeAsync(10000);
		expect(stores.length).toBe(0);
		auth = null;
	});
});

describe('option validation', () => {
	it('rejects malformed options eagerly', () => {
		expect(() => createCrdtAuthority(null)).toThrow('options');
		expect(() => createCrdtAuthority({ persist: 5 })).toThrow('persist');
		expect(() => createCrdtAuthority({ persist: { load: 1 } })).toThrow('persist.load');
		expect(() => createCrdtAuthority({ persist: { store: 1 } })).toThrow('persist.store');
		expect(() => createCrdtAuthority({ debounceWait: -1 })).toThrow('debounceWait');
		expect(() => createCrdtAuthority({ snapshotEvery: 0 })).toThrow('snapshotEvery');
		expect(() => createCrdtAuthority({ onError: 'x' })).toThrow('onError');
	});
});
