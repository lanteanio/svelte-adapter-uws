// Server-side tests for the CRDT document authority: access-record
// normalization, the reference-counted replica lifecycle, the coalesced
// (hydrate-stampede-safe) load, update merge + convergence invariants, the
// state-vector diff, the persistence schedule (debounce, max-wait force,
// update-count compaction, persist-on-empty, store-failure retry), and the
// explicit flush (per-topic durable/declined/failed/timed-out reporting, the
// deadline that keeps a wedged store from hanging shutdown, what happens to the
// state of a write the deadline abandoned, and the signal / deadline / attempt
// metadata the host's I/O receives). Time and timers are scripted through the
// injectable runtime, the same harness shape as the other plugin servers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { createCrdtAuthority, normalizeCrdtAccess } from '../src/plugins/crdt/replica.js';
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

describe('drop (whole-document erasure)', () => {
	/** Apply one client edit to a loaded topic so its replica turns dirty. */
	function editTopic(auth, topic, entries) {
		const client = new Y.Doc();
		Y.applyUpdate(client, auth.diff(topic));
		const update = captureUpdate(client, () => {
			const m = client.getMap('root');
			for (const [k, v] of Object.entries(entries)) m.set(k, v);
		});
		auth.applyUpdate(topic, update);
	}

	it('drops a referenced replica without running any store', async () => {
		const store = vi.fn(async () => {});
		const auth = createCrdtAuthority({ persist: { load: async () => null, store } });
		await auth.acquire('board:1');
		editTopic(auth, 'board:1', { secret: 'pii' });

		expect(auth.drop('board:1')).toBe(true);
		expect(auth.has('board:1')).toBe(false);
		// The dirty state was NOT written back - an erasure must never persist
		// the state it is erasing.
		expect(store).not.toHaveBeenCalled();
		// A late release from a live holder no-ops instead of throwing.
		auth.release('board:1');
		auth.destroy();
	});

	it('returns false for an unknown topic', () => {
		const auth = createCrdtAuthority();
		expect(auth.drop('never-acquired')).toBe(false);
		auth.destroy();
	});

	it('a re-acquire after drop cold-loads from persistence', async () => {
		const stored = Y.encodeStateAsUpdate(docWith({ title: 'from-store' }));
		const load = vi.fn(async () => stored);
		const auth = createCrdtAuthority({ persist: { load } });
		await auth.acquire('board:1');
		editTopic(auth, 'board:1', { title: 'edited' });
		auth.drop('board:1');

		await auth.acquire('board:1');
		expect(load).toHaveBeenCalledTimes(2);
		// The in-memory edits died with the drop; the store copy is the truth.
		expect(readState(auth, 'board:1')).toEqual({ title: 'from-store' });
		auth.destroy();
	});

	it('live holders observe the dropped topic as unloaded', async () => {
		const auth = createCrdtAuthority();
		await auth.acquire('board:1');
		auth.drop('board:1');
		expect(auth.stateVector('board:1')).toBeNull();
		expect(auth.diff('board:1')).toBeNull();
		auth.destroy();
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

describe('explicit flush (persistNow)', () => {
	let auth;
	const edit = (topic = 't', key = 'k', value = 1) => {
		const client = docWith({});
		const u = captureUpdate(client, () => client.getMap('root').set(key, value));
		return auth.applyUpdate(topic, u);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		installFakeRuntimeClock();
	});
	afterEach(() => {
		if (auth) auth.destroy();
		auth = null;
		releaseRuntimeClock();
		vi.useRealTimers();
	});

	it('reports the flushed topic as durable when the store lands', async () => {
		auth = createCrdtAuthority({ persist: { load: async () => null, store: async () => {} } });
		await auth.acquire('t');
		edit('t', 'a');
		expect(await auth.persistNow()).toEqual({
			ok: true, durable: ['t'], declined: [], failed: [], timedOut: [], dirty: []
		});
	});

	it('reports a rejecting store instead of resolving as if the bytes were durable', async () => {
		const errors = [];
		auth = createCrdtAuthority({
			persist: { load: async () => null, store: async () => { throw new Error('disk full'); } },
			onError: (e, info) => errors.push(info.op)
		});
		await auth.acquire('t');
		edit('t', 'a');
		const result = await auth.persistNow();
		expect(result.ok).toBe(false);
		expect(result.failed).toEqual(['t']);
		expect(result.durable).toEqual([]);
		expect(result.dirty).toEqual(['t']);
		expect(errors).toEqual(['store']);
	});

	it('reports a declined store as declined, distinct from durable', async () => {
		auth = createCrdtAuthority({ persist: { load: async () => null, store: async () => false } });
		await auth.acquire('t');
		edit('t', 'a');
		const result = await auth.persistNow();
		expect(result.ok).toBe(false);
		expect(result.declined).toEqual(['t']);
		expect(result.durable).toEqual([]);
		expect(result.dirty).toEqual(['t']);
	});

	it('times out a never-settling store instead of waiting forever, and aborts its signal', async () => {
		let handed = null;
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes, info) => { handed = info; return new Promise(() => {}); }
			},
			flushTimeout: 500
		});
		await auth.acquire('t');
		edit('t', 'a');
		let settled = null;
		const flush = auth.persistNow().then((r) => { settled = r; });
		await tick(8);
		expect(settled).toBe(null); // still waiting on the store
		expect(handed.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(600);
		await flush;
		expect(settled.ok).toBe(false);
		expect(settled.timedOut).toEqual(['t']);
		expect(settled.durable).toEqual([]);
		expect(settled.dirty).toEqual(['t']);
		expect(handed.signal.aborted).toBe(true);
	});

	it('puts a timed-out store back on the retry schedule instead of dropping the state', async () => {
		const calls = [];
		auth = createCrdtAuthority({
			// The worst case the deadline exists for: a host that never answers
			// and never honours the abort either.
			persist: {
				load: async () => null,
				store: (topic, bytes) => { calls.push(bytes); return new Promise(() => {}); }
			},
			flushTimeout: 500,
			debounceMaxWait: 2000
		});
		await auth.acquire('t');
		edit('t', 'a');
		let settled = null;
		const flush = auth.persistNow().then((r) => { settled = r; });
		await vi.advanceTimersByTimeAsync(600);
		await flush;
		expect(settled.timedOut).toEqual(['t']);
		expect(calls.length).toBe(1);
		// The capture cleared the dirty flag; abandoning the write has to put it
		// back, or the state sits in memory with nothing left to write it.
		await vi.advanceTimersByTimeAsync(2100);
		await tick(8);
		expect(calls.length).toBe(2); // the schedule tried again
		expect(auth.has('t')).toBe(true);
	});

	it('never reads a store the deadline abandoned as durable, and the next flush really writes', async () => {
		const written = [];
		let stalled = true;
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// A host that honours the abort the obvious way: it gives up on
				// the write - having written nothing - and RESOLVES.
				store: (topic, bytes, info) => new Promise((resolve) => {
					if (!stalled) { written.push(bytes); resolve(); return; }
					info.signal.addEventListener('abort', () => resolve());
				})
			},
			flushTimeout: 500,
			debounceMaxWait: 2000
		});
		await auth.acquire('t');
		edit('t', 'a');
		let first = null;
		const flush = auth.persistNow().then((r) => { first = r; });
		await vi.advanceTimersByTimeAsync(600);
		await flush;
		expect(first.timedOut).toEqual(['t']);
		expect(written).toHaveLength(0);
		await tick(8); // the abandoned write resolves, claiming a write it never did
		stalled = false;
		const second = await auth.persistNow();
		expect(written).toHaveLength(1); // the bytes finally left the process
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, written[0]);
		expect(Object.keys(scratch.getMap('root').toJSON())).toEqual(['a']);
		expect(second).toEqual({
			ok: true, durable: ['t'], declined: [], failed: [], timedOut: [], dirty: []
		});
	});

	it('never issues a write whose signal has already fired', async () => {
		const seen = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes, info) => { seen.push(info.signal.aborted); return new Promise(() => {}); }
			},
			debounceWait: 2000,
			debounceMaxWait: 60000,
			flushTimeout: 500
		});
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(2100); // the scheduled write, wedged
		await tick(8);
		expect(seen).toEqual([false]);
		edit('t', 'b');
		const flush = auth.persistNow(); // a second write, queued behind the wedged one
		await vi.advanceTimersByTimeAsync(600);
		expect((await flush).timedOut).toEqual(['t']);
		await tick(8);
		// Releasing the wedged write lets the queued one start. It was cancelled
		// before it was ever dispatched, so it must not reach the host at all:
		// a write handed a signal that already fired is a write nobody wants.
		expect(seen).toEqual([false]);
	});

	it('an abandoned write never resets the retry count by answering late', async () => {
		const attempts = [];
		let mode = 'fail';
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes, info) => {
					attempts.push(info.attempt);
					if (mode === 'fail') return Promise.reject(new Error('disk full'));
					// Abandons the write on abort and resolves, having written
					// nothing - the shape that looks like success from outside.
					if (mode === 'stall') return new Promise((resolve) => { info.signal.addEventListener('abort', () => resolve()); });
					return Promise.resolve();
				}
			},
			flushTimeout: 500,
			debounceWait: 2000,
			debounceMaxWait: 2000,
			onError: () => {}
		});
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(2100); // scheduled write, rejects
		await tick(8);
		expect(attempts).toEqual([1]);
		mode = 'stall';
		const flush = auth.persistNow();
		await vi.advanceTimersByTimeAsync(600); // budget expires, the write is abandoned
		expect((await flush).timedOut).toEqual(['t']);
		await tick(8); // the abandoned write now resolves
		mode = 'ok';
		await auth.persistNow();
		// Three writes of the same unstored state, two of which did not stick.
		// A write the flush gave up on cannot claim the count back.
		expect(attempts).toEqual([1, 2, 3]);
	});

	it('a short-budget flush does not cancel the write a longer-budget flush is waiting on', async () => {
		const written = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// A legitimately slow but perfectly healthy write.
				store: (topic, bytes, info) => new Promise((resolve, reject) => {
					const t = setTimeout(() => { written.push(bytes); resolve(); }, 800);
					info.signal.addEventListener('abort', () => { clearTimeout(t); reject(info.signal.reason); });
				})
			}
		});
		await auth.acquire('t');
		edit('t', 'a');
		let short = null;
		let long = null;
		const a = auth.persistNow({ timeout: 100 }).then((r) => { short = r; });
		const b = auth.persistNow({ timeout: 5000 }).then((r) => { long = r; });
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.all([a, b]);
		// The short budget answers only for itself.
		expect(short.timedOut).toEqual(['t']);
		// The write it did not own ran to completion for the caller that still
		// had budget for it.
		expect(long.durable).toEqual(['t']);
		expect(long.ok).toBe(true);
		expect(written).toHaveLength(1);
	});

	it('hands a store the longest budget waiting on it, so a host that sizes its own timeout by the deadline does not fail the long flush', async () => {
		const written = [];
		const deadlines = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// A host that does exactly what the deadline documents: it bounds
				// its own I/O by it.
				store: (topic, bytes, info) => new Promise((resolve, reject) => {
					deadlines.push(info.deadline);
					const budget = setTimeout(
						() => reject(new Error('statement timeout')),
						info.deadline - Date.now()
					);
					const write = setTimeout(() => {
						clearTimeout(budget);
						written.push(bytes);
						resolve();
					}, 800);
					info.signal.addEventListener('abort', () => {
						clearTimeout(budget);
						clearTimeout(write);
						reject(info.signal.reason);
					});
				})
			}
		});
		await auth.acquire('t');
		edit('t', 'a');
		const at = Date.now();
		let short = null;
		let long = null;
		const a = auth.persistNow({ timeout: 100 }).then((r) => { short = r; });
		const b = auth.persistNow({ timeout: 5000 }).then((r) => { long = r; });
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.all([a, b]);

		// One write, told the LATER of the two budgets. Stamping it with the
		// arming flush's own 100 ms instead makes the host abort at 96 ms and the
		// long flush fail with nothing written - the short budget deciding for
		// everybody through the hint rather than through the signal.
		expect(deadlines).toEqual([at + 5000]);
		expect(written).toHaveLength(1);
		expect(short.timedOut).toEqual(['t']);
		expect(long.durable).toEqual(['t']);
		expect(long.ok).toBe(true);
	});

	it('does not widen the deadline of a write already dispatched, but keeps that write alive', async () => {
		const deadlines = [];
		let handed = null;
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes, info) => {
					deadlines.push(info.deadline);
					handed = info;
					return new Promise(() => {});
				}
			}
		});
		await auth.acquire('t');
		edit('t', 'a');
		const at = Date.now();
		const short = auth.persistNow({ timeout: 100 });
		await tick(8); // the store is dispatched, holding the 100 ms reading
		const long = auth.persistNow({ timeout: 5000 });
		await vi.advanceTimersByTimeAsync(200);
		expect((await short).timedOut).toEqual(['t']);

		// The residual the deadline documents: a flush that joins after the write
		// went out cannot change the reading the host already took.
		expect(deadlines).toEqual([at + 100]);
		// What the long flush does get is the signal - the short flush is no
		// longer the last waiter, so the write keeps running for it.
		expect(handed.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect((await long).timedOut).toEqual(['t']);
		expect(handed.signal.aborted).toBe(true);
	});

	it('an edit does not restart a topic whose rescheduled write also wedged - only persistNow does', async () => {
		const dispatched = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// Wedged forever, and it ignores the abort as well.
				store: (topic, bytes) => { dispatched.push(bytes); return new Promise(() => {}); }
			},
			flushTimeout: 500,
			debounceWait: 100,
			debounceMaxWait: 1000
		});
		await auth.acquire('t');
		edit('t', 'a');
		const first = auth.persistNow();
		await vi.advanceTimersByTimeAsync(600);
		expect((await first).timedOut).toEqual(['t']);

		await vi.advanceTimersByTimeAsync(1100); // the one rescheduled write
		await tick(8);
		expect(dispatched).toHaveLength(2);

		// Traffic alone does not recover it: the edit's own capture queues behind
		// the wedged write and is never dispatched. An operator told that the next
		// edit heals the topic would schedule no periodic flush and never persist
		// this document again.
		edit('t', 'b');
		await vi.advanceTimersByTimeAsync(3000);
		await tick(8);
		expect(dispatched).toHaveLength(2);

		// Only a flush deadline abandons the wedged write and frees the chain.
		const second = auth.persistNow();
		await vi.advanceTimersByTimeAsync(600);
		expect((await second).timedOut).toEqual(['t']);
		await vi.advanceTimersByTimeAsync(1100);
		await tick(8);
		expect(dispatched).toHaveLength(3);
	});

	it('attempt counts retries of the same unstored state, not writes', async () => {
		const attempts = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// Healthy, just slow: every write lands.
				store: async (topic, bytes, info) => {
					attempts.push(info.attempt);
					await new Promise((r) => { setTimeout(r, 120); });
				}
			},
			snapshotEvery: 1
		});
		await auth.acquire('t');
		for (let i = 0; i < 6; i++) edit('t', 'k' + i);
		await vi.advanceTimersByTimeAsync(3000);
		await tick(8);
		// Sustained editing against a working backend is not a retry storm: a
		// host backing off or paging on `attempt` must not be told otherwise.
		expect(attempts).toEqual([1, 1, 1, 1, 1, 1]);
	});

	it('does not report an error for a store its own teardown cancelled', async () => {
		const errors = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				// The common shape of honouring an abort: reject with the reason.
				store: (topic, bytes, info) => new Promise((resolve, reject) => {
					info.signal.addEventListener('abort', () => reject(info.signal.reason));
				})
			},
			debounceWait: 2000,
			onError: (e, info) => errors.push(info.op)
		});
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(2100);
		await tick(8);
		auth.destroy();
		await tick(8);
		// Shutting down is not a persistence fault; an operator's handler must
		// not page on every clean exit that had writes in flight.
		expect(errors).toEqual([]);
		auth = null;
	});

	it('does not report an error for a load its own drop cancelled', async () => {
		const errors = [];
		auth = createCrdtAuthority({
			persist: {
				load: (topic, info) => new Promise((resolve, reject) => {
					info.signal.addEventListener('abort', () => reject(info.signal.reason));
				})
			},
			onError: (e, info) => errors.push(info.op)
		});
		const joining = auth.acquire('t');
		await tick();
		auth.drop('t');
		await expect(joining).rejects.toThrow();
		await tick(8);
		expect(errors).toEqual([]);
	});

	it('still reports a store the flush deadline cancelled: that host really ran out of budget', async () => {
		const errors = [];
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes, info) => new Promise((resolve, reject) => {
					info.signal.addEventListener('abort', () => reject(info.signal.reason));
				})
			},
			flushTimeout: 500,
			onError: (e, info) => errors.push(info.op)
		});
		await auth.acquire('t');
		edit('t', 'a');
		const flush = auth.persistNow();
		await vi.advanceTimersByTimeAsync(600);
		await flush;
		await tick(8);
		expect(errors).toEqual(['store']);
	});

	it('a topic array throws instead of silently flushing every topic', async () => {
		const writes = [];
		auth = createCrdtAuthority({
			persist: { load: async () => null, store: async (topic) => { writes.push(topic); } }
		});
		await auth.acquire('a');
		await auth.acquire('b');
		edit('a', 'x');
		edit('b', 'x');
		expect(() => auth.persistNow(['a'])).toThrow('crdt: persistNow topic must be a string');
		await tick(8);
		expect(writes).toEqual([]);
	});

	it('waits for a slow store when the caller opts out with Infinity', async () => {
		let releaseStore;
		auth = createCrdtAuthority({
			persist: { load: async () => null, store: () => new Promise((r) => { releaseStore = r; }) },
			flushTimeout: 500
		});
		await auth.acquire('t');
		edit('t', 'a');
		let settled = null;
		const flush = auth.persistNow({ timeout: Infinity }).then((r) => { settled = r; });
		await vi.advanceTimersByTimeAsync(5000);
		expect(settled).toBe(null); // the default budget did not apply
		releaseStore();
		await flush;
		expect(settled.ok).toBe(true);
		expect(settled.durable).toEqual(['t']);
	});

	it('reports each topic of an every-topic flush separately', async () => {
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: async (topic) => {
					if (topic === 'b') throw new Error('disk full');
					if (topic === 'c') return false;
				}
			}
		});
		await auth.acquire('a');
		await auth.acquire('b');
		await auth.acquire('c');
		edit('a', 'x');
		edit('b', 'x');
		edit('c', 'x');
		const result = await auth.persistNow();
		expect(result.ok).toBe(false);
		expect(result.durable).toEqual(['a']);
		expect(result.failed).toEqual(['b']);
		expect(result.declined).toEqual(['c']);
		expect(result.dirty.slice().sort()).toEqual(['b', 'c']);
	});

	it('flushes only the named topic', async () => {
		const writes = [];
		auth = createCrdtAuthority({
			persist: { load: async () => null, store: async (topic) => { writes.push(topic); } }
		});
		await auth.acquire('a');
		await auth.acquire('b');
		edit('a', 'x');
		edit('b', 'x');
		const result = await auth.persistNow('a');
		expect(writes).toEqual(['a']);
		expect(result.durable).toEqual(['a']);
		expect(result.dirty).toEqual([]);
	});

	it('flushing an unknown topic reports an empty, successful flush', async () => {
		auth = createCrdtAuthority({ persist: { load: async () => null, store: async () => {} } });
		expect(await auth.persistNow('never-acquired')).toEqual({
			ok: true, durable: [], declined: [], failed: [], timedOut: [], dirty: []
		});
	});

	it('claims nothing durable when no store hook is configured', async () => {
		auth = createCrdtAuthority();
		await auth.acquire('t');
		await auth.acquire('untouched');
		edit('t', 'a');
		const result = await auth.persistNow();
		expect(result.durable).toEqual([]);
		// Only the topic holding edits is at risk; an unedited one is not dirty.
		expect(result.dirty).toEqual(['t']);
		// An authority with no store hook cannot make bytes durable, so the
		// one-line shutdown check must not wave those edits through.
		expect(result.ok).toBe(false);
	});

	it('ok tracks dirty, so a topic edited during the flush is not reported as a clean shutdown', async () => {
		let releaseStore;
		auth = createCrdtAuthority({
			persist: { load: async () => null, store: () => new Promise((r) => { releaseStore = r; }) }
		});
		await auth.acquire('t');
		edit('t', 'a');
		const flush = auth.persistNow({ timeout: Infinity });
		await tick();
		edit('t', 'b'); // an edit the in-flight capture does not contain
		releaseStore();
		const result = await flush;
		expect(result.durable).toEqual(['t']);
		expect(result.dirty).toEqual(['t']);
		expect(result.ok).toBe(false);
	});

	it('hands the store a signal, the flush deadline and a retry-counting attempt', async () => {
		const infos = [];
		let failNext = true;
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: async (topic, bytes, info) => {
					infos.push({ deadline: info.deadline, attempt: info.attempt, aborted: info.signal.aborted });
					if (failNext) { failNext = false; throw new Error('disk full'); }
				}
			},
			debounceWait: 2000,
			debounceMaxWait: 5000
		});
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(2100); // the scheduled store: nobody is waiting
		await tick(8);
		expect(infos[0]).toEqual({ deadline: null, attempt: 1, aborted: false });
		await vi.advanceTimersByTimeAsync(5100); // the retry after the failure
		await tick(8);
		expect(infos[1].attempt).toBe(2);
		expect(infos[1].deadline).toBe(null);
		// A durable store restarts the count; an explicit flush carries its
		// deadline through to the host so its own I/O can respect it.
		edit('t', 'b');
		const at = Date.now();
		await auth.persistNow({ timeout: 1000 });
		expect(infos[2].attempt).toBe(1);
		expect(infos[2].deadline).toBe(at + 1000);
	});

	it('aborts an in-flight store when the authority is destroyed', async () => {
		let handed = null;
		auth = createCrdtAuthority({
			persist: {
				load: async () => null,
				store: (topic, bytes, info) => { handed = info; return new Promise(() => {}); }
			},
			debounceWait: 2000
		});
		await auth.acquire('t');
		edit('t', 'a');
		await vi.advanceTimersByTimeAsync(2100);
		await tick();
		expect(handed.signal.aborted).toBe(false);
		auth.destroy();
		expect(handed.signal.aborted).toBe(true);
		auth = null;
	});

	it('aborts an in-flight load when the topic is erased', async () => {
		let handed = null;
		auth = createCrdtAuthority({
			persist: { load: (topic, info) => { handed = info; return new Promise(() => {}); } }
		});
		void auth.acquire('t');
		await tick();
		expect(handed.signal.aborted).toBe(false);
		auth.drop('t');
		expect(handed.signal.aborted).toBe(true);
	});

	it('rejects a malformed flush budget or topic eagerly', async () => {
		expect(() => createCrdtAuthority({ flushTimeout: -1 })).toThrow('flushTimeout');
		expect(() => createCrdtAuthority({ flushTimeout: 'soon' })).toThrow('flushTimeout');
		auth = createCrdtAuthority();
		expect(() => auth.persistNow(5)).toThrow('topic');
		expect(() => auth.persistNow(['a', 'b'])).toThrow('topic');
		expect(() => auth.persistNow('t', 'later')).toThrow('options');
		expect(() => auth.persistNow('t', ['later'])).toThrow('options');
		expect(() => auth.persistNow({ timeout: -1 })).toThrow('timeout');
		expect(() => auth.persistNow('t', { timeout: 'later' })).toThrow('timeout');
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
