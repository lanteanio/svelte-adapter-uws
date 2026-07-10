/**
 * Server-side CRDT document authority: the per-topic replica set behind
 * `live.doc` / `live.map` / `live.array`.
 *
 * One authority instance manages every active document topic for one
 * declaration: a per-topic Yjs replica (the authoritative copy new joiners
 * sync against), reference-counted lifecycle, the durable persistence
 * schedule, and the access-record normalization for the `{read, write,
 * comment}` guard. The wire stays the shipped CRDT codec's concern; this
 * module never frames bytes, it produces and consumes them:
 *
 *   - `acquire(topic)` loads the durable state once per cold topic (concurrent
 *     joiners coalesce on one in-flight load - the hydrate-stampede gate) and
 *     counts a reference.
 *   - `applyUpdate(topic, bytes)` merges an inbound update into the replica
 *     and returns the normalized bytes for the caller to fan out verbatim.
 *   - `diff(topic, stateVector)` answers a joiner's sync with exactly the
 *     structs it lacks; `stateVector(topic)` is the server's own summary so
 *     the client can upload what the SERVER lacks - the two-way exchange that
 *     makes reconnect and offline recovery one idempotent round trip.
 *   - `release(topic)` drops a reference; the last release runs the final
 *     store (edit-then-disconnect is never lost) and unloads the replica.
 *
 * Persistence is scheduled, never inline on the message path: a trailing
 * debounce (`debounceWait`) with a sustained-edit force (`debounceMaxWait`),
 * an update-count compaction trigger (`snapshotEvery`), and the on-empty
 * final store (`persistOnEmpty`). The durable artifact is always the full
 * document state in one blob (`encodeStateAsUpdate`), captured synchronously
 * at schedule time so a consistent point is stored; the host app owns the
 * I/O through the `persist.load` / `persist.store` hooks and this module owns
 * only the schedule. A flapping client cannot multiply `store` calls: the
 * debounce coalesces and the final store runs once per empty transition.
 *
 * The document bytes are opaque to the wire codec but NOT to this module:
 * this is the one place the CRDT library lives server-side. Yjs types never
 * leak through the public surface.
 *
 * @module svelte-adapter-uws/plugins/crdt/replica
 */

import * as Y from 'yjs';
import { monotonicNow, randomU32, setTimer, clearTimer } from '../../runtime/runtime.js';

/**
 * Transaction origin tag for updates applied from the wire, so a hook on the
 * document's own `update` event (none in this module, but a power user can
 * reach the doc in a test) can tell a remote merge from a local mutation.
 * A module-private object reference cannot collide with any app origin.
 */
const REMOTE_ORIGIN = Object.freeze({ crdt: 'remote' });

/**
 * Normalize opaque CRDT bytes: accept a Uint8Array (native) or the JSON
 * `number[]` form, reject anything else. Mirrors the codec's tolerance so the
 * authority and the wire never disagree on what counts as bytes.
 * @param {any} bytes
 * @returns {Uint8Array | null}
 */
function toBytes(bytes) {
	if (bytes instanceof Uint8Array) return bytes;
	if (!Array.isArray(bytes)) return null;
	const out = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return null;
		out[i] = b;
	}
	return out;
}

/**
 * Normalize a guard's return value into the `{read, write, comment}` access
 * record.
 *
 * - A non-object return is read as a boolean gate and widened to all three
 *   rights (`guard: () => user != null` never learns the record shape).
 * - An object return is read as a partial record; a missing right is `false`,
 *   so the safe choice is the default when a field is omitted (`{read: true}`
 *   means read-only).
 *
 * The `comment` right is carried, cached, and surfaced in full, but no
 * comment producer exists in 0.6: comment-tagged updates are not a separate
 * accepted class yet, because the server cannot structurally verify that a
 * client-tagged update touches only comment marks until the rich-text marks
 * layer lands. Guards written against the record today keep working
 * unchanged when that layer activates the right.
 *
 * @param {any} value - whatever the guard returned
 * @returns {{ read: boolean, write: boolean, comment: boolean }}
 */
export function normalizeCrdtAccess(value) {
	if (value !== null && typeof value === 'object') {
		return { read: !!value.read, write: !!value.write, comment: !!value.comment };
	}
	const b = !!value;
	return { read: b, write: b, comment: b };
}

/**
 * Validate one numeric knob: undefined adopts the default, anything else must
 * be a finite number >= min.
 * @param {any} v @param {string} label @param {number} min
 * @returns {number | undefined}
 */
function checkKnob(v, label, min) {
	if (v === undefined) return undefined;
	if (!(typeof v === 'number' && Number.isFinite(v) && v >= min)) {
		throw new Error('crdt: ' + label + ' must be a number >= ' + min);
	}
	return v;
}

/**
 * Create the document authority for one CRDT declaration.
 *
 * @param {{
 *   persist?: {
 *     load?: (topic: string) => Promise<Uint8Array | number[] | null | undefined> | Uint8Array | number[] | null | undefined,
 *     store?: (topic: string, bytes: Uint8Array) => Promise<void | boolean> | void | boolean
 *   },
 *   debounceWait?: number,
 *   debounceMaxWait?: number,
 *   snapshotEvery?: number,
 *   persistOnEmpty?: boolean,
 *   gc?: boolean,
 *   onError?: (err: unknown, info: { topic: string, op: 'load' | 'store' }) => void
 * }} [options]
 */
export function createCrdtAuthority(options = {}) {
	if (options === null || typeof options !== 'object') {
		throw new Error('crdt: options must be an object');
	}
	const persist = options.persist;
	if (persist !== undefined && (persist === null || typeof persist !== 'object')) {
		throw new Error('crdt: persist must be an object with load/store hooks');
	}
	if (persist && persist.load !== undefined && typeof persist.load !== 'function') {
		throw new Error('crdt: persist.load must be a function');
	}
	if (persist && persist.store !== undefined && typeof persist.store !== 'function') {
		throw new Error('crdt: persist.store must be a function');
	}
	if (options.onError !== undefined && typeof options.onError !== 'function') {
		throw new Error('crdt: onError must be a function');
	}
	const debounceWait = checkKnob(options.debounceWait, 'debounceWait', 0) ?? 2000;
	const debounceMaxWait = checkKnob(options.debounceMaxWait, 'debounceMaxWait', 0) ?? 10000;
	const snapshotEvery = checkKnob(options.snapshotEvery, 'snapshotEvery', 1) ?? 200;
	const persistOnEmpty = options.persistOnEmpty !== false;
	const gc = options.gc !== false;
	const onError = options.onError;
	const hasStore = !!(persist && typeof persist.store === 'function');

	/**
	 * @typedef {{
	 *   doc: import('yjs').Doc,
	 *   refs: number,
	 *   loading: Promise<void> | null,
	 *   loaded: boolean,
	 *   dirty: boolean,
	 *   updatesSinceStore: number,
	 *   debounceTimer: any,
	 *   maxWaitStart: number | null,
	 *   storing: Promise<void>,
	 *   unloading: boolean
	 * }} TopicRecord
	 */
	/** @type {Map<string, TopicRecord>} */
	const topics = new Map();
	let destroyed = false;

	/** Report a persist I/O failure to the host without throwing into the schedule. */
	function reportError(err, topic, op) {
		if (onError) {
			try { onError(err, { topic, op }); } catch { /* the host's handler must not break the schedule */ }
		}
	}

	function clearSchedule(rec) {
		if (rec.debounceTimer !== null) {
			clearTimer(rec.debounceTimer);
			rec.debounceTimer = null;
		}
		rec.maxWaitStart = null;
	}

	/**
	 * Capture the full state NOW (a consistent point) and chain the host's
	 * `store` behind any in-flight store so writes for one topic never race
	 * each other or arrive out of order. Success completes a deferred on-empty
	 * unload; failure marks the record dirty again and retries at the
	 * `debounceMaxWait` cadence (with the error surfaced through `onError`
	 * each attempt), so an edit-then-silence is never stranded in memory and a
	 * dirty replica is never unloaded.
	 * @param {string} topic @param {TopicRecord} rec
	 * @returns {Promise<void>}
	 */
	function storeNow(topic, rec) {
		clearSchedule(rec);
		rec.dirty = false;
		rec.updatesSinceStore = 0;
		if (!persist || typeof persist.store !== 'function') return rec.storing;
		const blob = Y.encodeStateAsUpdate(rec.doc);
		const chain = rec.storing
			.then(() => persist.store(topic, blob))
			.then((result) => {
				if (destroyed || topics.get(topic) !== rec) return;
				// Only the NEWEST store in the chain owns the lifecycle: an
				// older store settling while a newer captured state is still
				// in flight behind it must neither unload the replica nor
				// decide the empty transition - the newest store's own
				// settlement does.
				if (rec.storing !== chain) return;
				if (result === false) {
					// The host declined to write this captured state (e.g. a
					// cluster instance that does not currently hold the
					// per-topic persist lease). The bytes are NOT durable here,
					// so keep the record dirty and re-probe at the max-wait
					// cadence until a write succeeds - tightening a stale
					// snapshot to debounceMaxWait rather than next-edit. The
					// data is not lost: it lives in this replica and (in a
					// cluster) was relayed to the lease holder, which persists
					// it. On the unload path we still let the replica go - the
					// holder owns the durable write - so a decline never pins a
					// replica in memory.
					rec.dirty = true;
					if (rec.unloading && rec.refs === 0) {
						unload(topic, rec);
					} else if (rec.debounceTimer === null) {
						rec.debounceTimer = setTimer(() => {
							rec.debounceTimer = null;
							if (destroyed || topics.get(topic) !== rec || !rec.dirty) return;
							storeNow(topic, rec);
						}, Math.max(1000, debounceMaxWait));
					}
					return;
				}
				if (rec.unloading && rec.refs === 0) {
					// Edits that landed while the store was in flight re-store
					// before the deferred unload completes; a clean store
					// finishes the empty transition.
					if (rec.dirty) storeNow(topic, rec);
					else unload(topic, rec);
				}
			})
			.catch((err) => {
				reportError(err, topic, 'store');
				if (destroyed || topics.get(topic) !== rec) return;
				// A newer chained store carries a superset of this blob (the
				// full state captured later), so its settlement owns the
				// dirty/retry decision; this older failure is already
				// superseded.
				if (rec.storing !== chain) return;
				rec.dirty = true;
				if (rec.debounceTimer === null) {
					// Retry at the max-wait cadence, floored so a zero
					// max-wait configuration cannot spin a hot retry loop
					// against a down backend.
					rec.debounceTimer = setTimer(() => {
						rec.debounceTimer = null;
						if (destroyed || topics.get(topic) !== rec || !rec.dirty) return;
						storeNow(topic, rec);
					}, Math.max(1000, debounceMaxWait));
				}
			});
		rec.storing = chain;
		return chain;
	}

	/**
	 * Trailing debounce with a sustained-edit force: persist `debounceWait`
	 * after the last edit, but never let a continuously-edited document go
	 * longer than `debounceMaxWait` without a checkpoint.
	 * @param {string} topic @param {TopicRecord} rec
	 */
	function scheduleStore(topic, rec) {
		if (!persist || typeof persist.store !== 'function') return;
		const mono = monotonicNow();
		if (rec.maxWaitStart === null) rec.maxWaitStart = mono;
		if (rec.debounceTimer !== null) clearTimer(rec.debounceTimer);
		const untilMax = rec.maxWaitStart + debounceMaxWait - mono;
		const wait = Math.max(0, Math.min(debounceWait, untilMax));
		rec.debounceTimer = setTimer(() => {
			rec.debounceTimer = null;
			if (destroyed || topics.get(topic) !== rec || !rec.dirty) return;
			storeNow(topic, rec);
		}, wait);
	}

	/** Destroy a record's doc and forget the topic. */
	function unload(topic, rec) {
		clearSchedule(rec);
		if (topics.get(topic) === rec) topics.delete(topic);
		try { rec.doc.destroy(); } catch { /* a destroyed doc must not break unload */ }
	}

	/**
	 * Ensure the topic's replica exists and is loaded, coalescing concurrent
	 * cold joins onto ONE `persist.load` (the hydrate-stampede gate: N
	 * simultaneous joiners to an empty topic produce exactly one load; the
	 * rest await the same promise). A failed load forgets the topic and
	 * rejects every coalesced waiter, so a retry re-attempts the load.
	 * @param {string} topic
	 * @returns {Promise<TopicRecord>}
	 */
	function ensure(topic) {
		if (destroyed) return Promise.reject(new Error('crdt: authority destroyed'));
		let rec = topics.get(topic);
		if (rec) {
			// A re-join during the on-empty store keeps the live replica: the
			// store completes in the background and the unload is cancelled.
			rec.unloading = false;
			if (rec.loaded) return Promise.resolve(rec);
			return rec.loading.then(() => rec);
		}
		const doc = new Y.Doc({ gc });
		// Route the replica's actor id through the injectable RNG so a
		// deterministic harness reproduces identical struct ids run to run.
		doc.clientID = randomU32();
		rec = {
			doc,
			refs: 0,
			loading: null,
			loaded: false,
			dirty: false,
			updatesSinceStore: 0,
			debounceTimer: null,
			maxWaitStart: null,
			storing: Promise.resolve(),
			unloading: false
		};
		topics.set(topic, rec);
		const hasLoad = !!(persist && typeof persist.load === 'function');
		rec.loading = Promise.resolve()
			.then(() => (hasLoad ? persist.load(topic) : null))
			.then((stored) => {
				if (topics.get(topic) !== rec) {
					// The authority was torn down while the load was in
					// flight: every coalesced waiter must REJECT (destroy is
					// terminal), never resolve onto a destroyed replica.
					throw new Error('crdt: authority destroyed');
				}
				if (stored !== null && stored !== undefined) {
					const bytes = toBytes(stored);
					if (bytes === null) throw new Error('crdt: persist.load must return bytes (Uint8Array or number[]) or null');
					Y.applyUpdate(rec.doc, bytes, REMOTE_ORIGIN);
				}
				rec.loaded = true;
				rec.loading = null;
			})
			.catch((err) => {
				// Forget the topic so the NEXT join retries the load; every
				// waiter coalesced on this flight sees the same rejection.
				unload(topic, rec);
				if (!destroyed) reportError(err, topic, 'load');
				throw err;
			});
		return rec.loading.then(() => rec);
	}

	return {
		/**
		 * Load (once) and reference the topic's replica. Every successful
		 * acquire must be paired with one `release`.
		 * @param {string} topic
		 * @returns {Promise<void>}
		 */
		acquire(topic) {
			return ensure(topic).then((rec) => {
				rec.refs++;
			});
		},

		/**
		 * Drop one reference. The last release runs the final on-empty store
		 * (when `persistOnEmpty`, the default) and unloads the replica once
		 * that store has settled - unless a new joiner re-acquired the topic
		 * meanwhile, in which case the replica stays live (a connect/disconnect
		 * flap coalesces instead of multiplying store calls).
		 * @param {string} topic
		 */
		release(topic) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded) return;
			if (rec.refs > 0) rec.refs--;
			if (rec.refs > 0) return;
			rec.unloading = true;
			if (persistOnEmpty && rec.dirty && hasStore) {
				// The unload completes in the store's success path, so a dirty
				// replica is never destroyed before its bytes are durable.
				storeNow(topic, rec);
				return;
			}
			rec.storing.then(() => {
				if (destroyed || topics.get(topic) !== rec) return;
				// Dirty blocks the unload only when an on-empty store could
				// still make the bytes durable: with no store hook there is
				// nothing to write, and with persistOnEmpty off the caller
				// opted out of the final write by contract.
				if (rec.refs === 0 && rec.unloading && (!rec.dirty || !hasStore || !persistOnEmpty)) unload(topic, rec);
			});
		},

		/**
		 * Merge one inbound update into the authoritative replica and return
		 * the normalized bytes for the caller to fan out verbatim (the same
		 * bytes every capable subscriber decodes; design rule: never re-encode
		 * from the replica's own update event, so an applied-remote update is
		 * never re-broadcast to its sender by accident). Returns `null` when
		 * the topic is not loaded or the bytes are malformed - the frame is
		 * dropped and the sender's next sync reconciles.
		 *
		 * Apply + persist-schedule is one synchronous unit: a second update
		 * arriving in the next task sees this one's applied state.
		 * @param {string} topic
		 * @param {Uint8Array | number[]} bytes
		 * @returns {Uint8Array | null}
		 */
		applyUpdate(topic, bytes) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded || destroyed) return null;
			const u8 = toBytes(bytes);
			if (u8 === null || u8.length === 0) return null;
			try {
				Y.applyUpdate(rec.doc, u8, REMOTE_ORIGIN);
			} catch {
				return null; // malformed update: drop, never corrupt the replica
			}
			rec.dirty = true;
			rec.updatesSinceStore++;
			if (rec.updatesSinceStore >= snapshotEvery) {
				storeNow(topic, rec);
			} else {
				scheduleStore(topic, rec);
			}
			return u8;
		},

		/**
		 * The missing-structs diff for a joiner: exactly what a client holding
		 * `stateVector` lacks, independent of how long it was away. A missing,
		 * empty, or malformed state vector yields the full document state -
		 * always correct, because re-applying known structs is a no-op.
		 * @param {string} topic
		 * @param {Uint8Array | number[] | null} [stateVector]
		 * @returns {Uint8Array | null} diff bytes, or null when the topic is not loaded
		 */
		diff(topic, stateVector) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded) return null;
			const sv = stateVector === null || stateVector === undefined ? null : toBytes(stateVector);
			if (sv !== null && sv.length > 0) {
				try {
					return Y.encodeStateAsUpdate(rec.doc, sv);
				} catch {
					// fall through: a malformed vector gets the full state
				}
			}
			return Y.encodeStateAsUpdate(rec.doc);
		},

		/**
		 * The server replica's state vector, sent to a syncing client so it
		 * can upload exactly what the SERVER lacks (the offline-edit flush).
		 * @param {string} topic
		 * @returns {Uint8Array | null} vector bytes, or null when the topic is not loaded
		 */
		stateVector(topic) {
			const rec = topics.get(topic);
			if (!rec || !rec.loaded) return null;
			return Y.encodeStateVector(rec.doc);
		},

		/**
		 * Force the persistence of one topic now (bypassing the debounce), or
		 * of every dirty topic when no topic is given. Resolves when the
		 * host's `store` calls have settled. For graceful shutdown and tests.
		 * @param {string} [topic]
		 * @returns {Promise<void>}
		 */
		persistNow(topic) {
			if (topic !== undefined) {
				const rec = topics.get(topic);
				if (!rec || !rec.loaded || !rec.dirty) return rec ? rec.storing : Promise.resolve();
				return storeNow(topic, rec);
			}
			const waits = [];
			for (const [t, rec] of topics) {
				if (rec.loaded && rec.dirty) waits.push(storeNow(t, rec));
				else waits.push(rec.storing);
			}
			return Promise.all(waits).then(() => undefined);
		},

		/** Whether the topic currently holds a loaded replica. */
		has(topic) {
			const rec = topics.get(topic);
			return !!(rec && rec.loaded);
		},

		/** Live references on the topic (0 when absent). */
		refs(topic) {
			const rec = topics.get(topic);
			return rec ? rec.refs : 0;
		},

		/** Number of loaded topics (diagnostics). */
		size() {
			let n = 0;
			for (const rec of topics.values()) if (rec.loaded) n++;
			return n;
		},

		/**
		 * Erase one topic's replica REGARDLESS of live references: cancel its
		 * persistence schedule and destroy the doc WITHOUT running any store -
		 * an erasure must never write back the state it is erasing. Returns
		 * `true` when a replica (loaded or still loading) was dropped. Live
		 * holders observe the topic as unloaded from the next call on
		 * (`applyUpdate`/`diff` return null, exactly like a never-acquired
		 * topic) and their later `release` calls no-op. A subsequent `acquire`
		 * cold-loads from persistence - deleting the persisted copy is the
		 * `persist`-store owner's half of a whole-document erasure.
		 * @param {string} topic
		 * @returns {boolean}
		 */
		drop(topic) {
			const rec = topics.get(topic);
			if (!rec) return false;
			unload(topic, rec);
			return true;
		},

		/**
		 * Tear the authority down: cancel every schedule and destroy every
		 * replica. Pending edits are NOT stored (call `persistNow()` first for
		 * a graceful path); destroy is the hard-stop for tests and shutdown.
		 */
		destroy() {
			if (destroyed) return;
			destroyed = true;
			for (const [topic, rec] of topics) {
				clearSchedule(rec);
				try { rec.doc.destroy(); } catch { /* ignore */ }
				void topic;
			}
			topics.clear();
		}
	};
}
