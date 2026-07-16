/**
 * Client-side channel for one CRDT document topic: the local replica every
 * read hits, the wire glue that keeps it converged with the server's, and
 * the container facets (map / array / text) a reactive layer wraps.
 *
 * The TRANSPORT is injected (the smooth-channel discipline): the caller
 * supplies `sendUpdate(bytes)` (a reliable no-reply upstream send),
 * `sync(stateVector)` (an awaited request returning the access record, the
 * resolved wire topic, the missing-structs diff, and the server's own state
 * vector), and optionally `close()` (tells the server this mount is gone).
 * Injection keeps this module free of any framework above the adapter and
 * makes the channel drivable by a deterministic harness with a scripted
 * transport.
 *
 * Convergence model - one idempotent commutative merge everywhere:
 *
 *   - A local write applies to the local replica synchronously (there is no
 *     pending state) and emits one opaque update on the wire per transaction.
 *   - A remote update applies with a remote origin, so it is never echoed
 *     back out.
 *   - On every connection 'open' (first connect and every reconnect) the
 *     channel syncs: it sends its state vector, applies the server's diff,
 *     and uploads `encodeStateAsUpdate(localDoc, serverStateVector)` - so the
 *     local replica IS the offline queue and a two-hour offline session
 *     reconnects with one bounded blob, no frame bookkeeping.
 *   - Frames that arrive while the FIRST sync is in flight (before the wire
 *     topic is known) are buffered and replayed after the reply names the
 *     topic; replaying overlap is a no-op because the merge is idempotent.
 *   - After every apply the channel checks the replica's pending-structs
 *     gauge: a dependency gap means a frame was lost somewhere (backpressure,
 *     a dropped JSON fallback, anything) and schedules a debounced resync -
 *     the CRDT analog of ack-famine recovery. The detector needs a causally
 *     LATER struct to arrive and reference the missing one, so it cannot see
 *     a TERMINAL drop (the lost update was the last edit to reach this
 *     replica); a low-frequency background reconcile on the healthy channel
 *     re-runs the same state-vector exchange and closes that path too, so
 *     every silent drop converges without waiting for a reconnect.
 *
 * Read-only mounts: when the access record says `write: false`, the facet
 * mutators throw. A CRDT cannot "reconcile away" local-only edits (nothing
 * deletes them), so silently accepting writes that the server will reject
 * would fork the local view forever; failing fast plus the surfaced
 * `readOnly` flag (so the UI disables inputs) is the honest contract.
 *
 * @module svelte-adapter-uws/plugins/crdt/channel
 */

import * as Y from 'yjs';
import { on, status } from '../../client.js';
import { randomU32, setTimer, clearTimer } from '../../client-runtime.js';
import { onCrdtFrame, CRDT_TOPIC_PREFIX } from './client.js';

/** Transaction origin for updates applied from the wire (never re-sent). */
const REMOTE_ORIGIN = Object.freeze({ crdt: 'remote' });

/** How long a dependency gap may stand before the channel resyncs (ms). */
const PENDING_RESYNC_DEBOUNCE_MS = 250;

/** Retry cadence for a failed sync while the connection stays open (ms). */
const SYNC_RETRY_MS = 1000;

/**
 * Cadence of the healthy-channel background reconcile (ms). The
 * pending-structs detector only sees a loss when a causally-later struct
 * arrives referencing it, so a TERMINAL drop (the lost update had no
 * successor) would otherwise stand until the next reconnect; the reconcile
 * re-runs the state-vector exchange at this cadence to close that path. An
 * in-sync exchange costs one tiny request and an empty diff.
 */
const HEALTHY_RECONCILE_MS = 30000;

/** Pre-sync frame buffer bound; overflow drops oldest (pending-structs heals). */
const PRESYNC_BUFFER_CAP = 256;

/**
 * Pack two encoded relative positions into one opaque blob (a 4-byte little-endian
 * length prefix for the first, then the two byte runs). Keeps a range anchor a single
 * Uint8Array, consistent with the plugin's opaque-bytes surface. The 4-byte prefix
 * cannot overflow for any real position (an item-based position is a handful of bytes;
 * even a position into an empty type carrying an inline container name stays well under
 * 4 GiB), so the length is always exact - no silent wrap.
 * @param {Uint8Array} startBytes @param {Uint8Array} endBytes @returns {Uint8Array}
 */
function packRangeAnchor(startBytes, endBytes) {
	const out = new Uint8Array(4 + startBytes.length + endBytes.length);
	const n = startBytes.length;
	out[0] = n & 0xff;
	out[1] = (n >>> 8) & 0xff;
	out[2] = (n >>> 16) & 0xff;
	out[3] = (n >>> 24) & 0xff;
	out.set(startBytes, 4);
	out.set(endBytes, 4 + n);
	return out;
}

/**
 * Reverse of packRangeAnchor. Returns null for a malformed blob so a garbage anchor
 * resolves to "no selection" rather than throwing.
 * @param {any} bytes @returns {{ start: Uint8Array, end: Uint8Array } | null}
 */
function unpackRangeAnchor(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
	const startLen = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
	if (4 + startLen > bytes.length) return null;
	return { start: bytes.subarray(4, 4 + startLen), end: bytes.subarray(4 + startLen) };
}

/**
 * Normalize opaque CRDT bytes: a Uint8Array (native) or the JSON `number[]`
 * form. Returns null for anything else so a malformed payload drops instead
 * of corrupting the replica.
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
 * Whether an encoded update carries nothing (zero structs, zero deletes).
 * The empty encoding is exactly `[0, 0]`; when in doubt this returns false
 * and the update is sent - re-applying known structs is a no-op, so the
 * check is an egress saving, never a correctness gate.
 * @param {Uint8Array} u8
 */
function isEmptyUpdate(u8) {
	return u8.length === 2 && u8[0] === 0 && u8[1] === 0;
}

/**
 * Create the channel for one CRDT document topic.
 *
 * @param {{
 *   transport: {
 *     sendUpdate: (bytes: number[]) => void,
 *     sync: (stateVector: number[]) => Promise<{ topic?: string, access?: any, diff?: number[] | Uint8Array, sv?: number[] | Uint8Array } | null | undefined>,
 *     close?: () => void
 *   },
 *   gc?: boolean,
 *   reconcileIntervalMs?: number
 * }} options
 */
export function createCrdtChannel(options) {
	if (options === null || typeof options !== 'object') {
		throw new Error('crdt: an options object with a transport is required');
	}
	const transport = options.transport;
	if (!transport || typeof transport.sendUpdate !== 'function' || typeof transport.sync !== 'function') {
		throw new Error('crdt: transport with sendUpdate and sync is required');
	}
	// Background-reconcile cadence. 0 disables (power users running their own
	// reconcile discipline); anything non-numeric or negative falls back to the
	// default rather than silently disabling loss recovery.
	const reconcileIntervalMs = typeof options.reconcileIntervalMs === 'number'
		&& Number.isFinite(options.reconcileIntervalMs)
		&& options.reconcileIntervalMs >= 0
		? options.reconcileIntervalMs
		: HEALTHY_RECONCILE_MS;

	const doc = new Y.Doc({ gc: options.gc !== false });
	// Route the replica's actor id through the injectable RNG so a
	// deterministic harness reproduces identical struct ids run to run.
	doc.clientID = randomU32();
	// This mount's identity on the server: several channels on one connection
	// can resolve to the SAME document (two declarations sharing a topic, or
	// two argument tuples normalizing to one name), and the server counts
	// mounts - not syncs - so one mount's close never severs the others.
	const mountId = randomU32();

	let destroyed = false;
	let synced = false;
	let everSynced = false;
	let degraded = false;
	/**
	 * Connection-epoch generation: bumped on every status transition. A sync
	 * is stamped with the generation it was issued under; a settle from an
	 * older generation is discarded (its reply describes a connection that no
	 * longer exists) and never blocks the current generation's sync - so a
	 * transport whose doomed request never settles cannot wedge the channel.
	 */
	let syncGen = 0;
	/** Generation of the in-flight sync, or -1 when none is in flight. */
	let syncInFlightGen = -1;
	let lastStatus = '';
	/** @type {{ read: boolean, write: boolean, comment: boolean } | null} */
	let access = null;
	/** The resolved wire topic, learned from the first sync reply. */
	let wireTopic = null;
	/** @type {(() => void) | null} */
	let tapUnsub = null;
	/** @type {any} */
	let retryTimer = null;
	/** @type {any} */
	let pendingResyncTimer = null;
	/** @type {any} */
	let reconcileTimer = null;
	/** Frames buffered while the first sync is in flight (topic unknown). */
	/** @type {Array<{ topic: string, bytes: Uint8Array }>} */
	let presyncBuffer = [];
	/** @type {((state: { synced: boolean, degraded: boolean, access: { read: boolean, write: boolean, comment: boolean } | null }) => void) | null} */
	let stateCb = null;
	/** Facet kind per container name, to fail fast on a kind conflict. */
	/** @type {Map<string, string>} */
	const facetKinds = new Map();

	function notifyState() {
		if (stateCb === null || destroyed) return;
		try {
			stateCb({ synced, degraded, access: access === null ? null : { ...access } });
		} catch { /* the reactive layer's callback must not break the channel */ }
	}

	function setDegraded(value) {
		if (degraded === value) return;
		degraded = value;
		notifyState();
	}

	// Forward every locally-originated update upstream. Updates applied from
	// the wire carry REMOTE_ORIGIN and are never re-sent (no echo storm). An
	// update emitted before the channel is synced is deliberately NOT sent:
	// the next sync's two-way state-vector exchange uploads everything the
	// server lacks in one merged blob, so nothing is lost and nothing needs a
	// queue.
	function onDocUpdate(update, origin) {
		if (destroyed || origin === REMOTE_ORIGIN) return;
		if (!synced) return;
		transport.sendUpdate(Array.from(update));
	}
	doc.on('update', onDocUpdate);

	/** Apply remote bytes; a malformed update drops without corrupting the doc. */
	function applyRemote(u8) {
		if (u8.length === 0) return; // an empty diff carries nothing
		try {
			Y.applyUpdate(doc, u8, REMOTE_ORIGIN);
		} catch {
			return; // drop; the pending-structs detector or next sync reconciles
		}
		checkPending();
	}

	/**
	 * A non-null pending set after an apply means a dependency gap: some
	 * earlier update never arrived. Schedule one debounced resync; the
	 * state-vector diff supplies the missing structs regardless of what was
	 * lost or where.
	 */
	function checkPending() {
		if (destroyed || pendingResyncTimer !== null) return;
		if (!doc.store.pendingStructs && !doc.store.pendingDs) return;
		pendingResyncTimer = setTimer(() => {
			pendingResyncTimer = null;
			if (destroyed) return;
			if (doc.store.pendingStructs || doc.store.pendingDs) resync();
		}, PENDING_RESYNC_DEBOUNCE_MS);
	}

	// Binary frames arrive through the sink codec's global observer; route by
	// topic once known, buffer (bounded, copied - the frame's bytes are a view
	// into the socket message) while the first sync is still resolving it.
	const frameUnsub = onCrdtFrame((frame) => {
		if (destroyed) return;
		if (frame.op !== 'update' && frame.op !== 'snapshot') return;
		if (wireTopic !== null) {
			if (frame.topic === wireTopic) applyRemote(frame.bytes);
			return;
		}
		if (syncInFlightGen === -1) return;
		if (presyncBuffer.length >= PRESYNC_BUFFER_CAP) presyncBuffer.shift();
		presyncBuffer.push({ topic: frame.topic, bytes: new Uint8Array(frame.bytes) });
	});

	/**
	 * The JSON tap: a connection without the binary capability - or one whose
	 * crdt wire state was poisoned by a backpressure drop - receives the same
	 * frames as JSON envelopes `{ op, bytes: number[] }`. Both paths converge
	 * on the same apply.
	 */
	function bindTap() {
		if (tapUnsub !== null || wireTopic === null) return;
		tapUnsub = on(wireTopic).subscribe((ev) => {
			if (destroyed || ev === null || typeof ev !== 'object') return;
			if (ev.event !== 'crdt') return;
			const d = ev.data;
			if (d === null || typeof d !== 'object') return;
			if (d.op !== 'update' && d.op !== 'snapshot') return;
			const u8 = toBytes(d.bytes);
			if (u8 !== null) applyRemote(u8);
		});
	}

	function clearRetry() {
		if (retryTimer !== null) {
			clearTimer(retryTimer);
			retryTimer = null;
		}
	}

	function scheduleRetry() {
		if (destroyed || retryTimer !== null) return;
		retryTimer = setTimer(() => {
			retryTimer = null;
			if (destroyed || lastStatus !== 'open') return;
			// Retry while un-synced, degraded, OR while a dependency gap stands.
			// The degraded case covers a failed exchange on an otherwise-synced
			// channel (a background reconcile hitting a server blip): synced stays
			// true there - outbound edits must not pause on a healthy socket - so
			// without this clause nothing would ever clear the degraded latch and
			// the reconcile chain (which skips while degraded) would be disabled
			// until an unrelated reconnect.
			if (!synced || degraded || doc.store.pendingStructs || doc.store.pendingDs) resync();
		}, SYNC_RETRY_MS);
	}

	/** Sentinel: a sync discarded before its request was sent. */
	const SYNC_DISCARDED = Object.freeze({});

	function resync() {
		if (destroyed) return;
		// Dedupe only against an in-flight sync of the CURRENT generation: a
		// doomed sync from a previous connection epoch must never block the
		// new one, however (or whether) it settles.
		if (syncInFlightGen === syncGen) return;
		const gen = syncGen;
		syncInFlightGen = gen;
		let sv;
		try {
			sv = Array.from(Y.encodeStateVector(doc));
		} catch {
			sv = [];
		}
		Promise.resolve()
			.then(() => {
				// Re-check before the request leaves: a destroy (or an epoch
				// flip) in the same task must not send a sync the server would
				// pair with a reference no close will ever release.
				if (destroyed || gen !== syncGen) return SYNC_DISCARDED;
				return transport.sync(sv, mountId);
			})
			.then((reply) => {
				if (syncInFlightGen === gen) syncInFlightGen = -1;
				if (destroyed || reply === SYNC_DISCARDED) return;
				if (gen !== syncGen) return; // a stale epoch's reply: discard
				if (reply === null || reply === undefined || typeof reply !== 'object') {
					setDegraded(true);
					scheduleRetry();
					return;
				}
				if (wireTopic === null && typeof reply.topic === 'string' && reply.topic.length > 0) {
					// The first successful sync names the wire topic; the taps
					// bind once and survive reconnects (stores are name-keyed).
					wireTopic = CRDT_TOPIC_PREFIX + reply.topic;
					bindTap();
				}
				// The server re-runs the guard on every sync (a mid-session
				// downgrade takes effect through this reply), and the background
				// reconcile makes this exchange the standard delivery path for a
				// revocation - so an access CHANGE must always reach the state
				// callback, even on an otherwise-silent healthy reconcile, or the
				// UI keeps inputs enabled while the mutators throw.
				let accessChanged = false;
				if (reply.access !== null && typeof reply.access === 'object') {
					const next = {
						read: !!reply.access.read,
						write: !!reply.access.write,
						comment: !!reply.access.comment
					};
					accessChanged = access === null
						|| access.read !== next.read
						|| access.write !== next.write
						|| access.comment !== next.comment;
					access = next;
				}
				if (reply.diff !== undefined && reply.diff !== null) {
					const diff = toBytes(reply.diff);
					if (diff !== null) applyRemote(diff);
				}
				// Replay anything that raced past the diff while the topic was
				// unknown; overlap is a no-op (idempotent merge).
				if (presyncBuffer.length > 0) {
					const buffered = presyncBuffer;
					presyncBuffer = [];
					for (let i = 0; i < buffered.length; i++) {
						if (buffered[i].topic === wireTopic) applyRemote(buffered[i].bytes);
					}
				}
				if (wireTopic === null) {
					// A reply that never named the topic cannot receive frames:
					// the exchange is incomplete, not synced. Keep recovering.
					setDegraded(true);
					scheduleRetry();
					return;
				}
				// Upload exactly what the server lacks (the offline flush). A
				// read-only mount skips it: the server would reject the bytes.
				if (reply.sv !== undefined && reply.sv !== null && (access === null || access.write)) {
					const serverSv = toBytes(reply.sv);
					if (serverSv !== null && serverSv.length > 0) {
						let mine = null;
						try {
							mine = Y.encodeStateAsUpdate(doc, serverSv);
						} catch { /* malformed server vector: skip the upload, stay correct */ }
						if (mine !== null && !isEmptyUpdate(mine)) transport.sendUpdate(Array.from(mine));
					}
				}
				everSynced = true;
				if (lastStatus !== 'open') {
					// Settled while disconnected: the data applied (correct
					// either way), but the connection it described is gone -
					// outbound sends stay paused and the next open resyncs.
					return;
				}
				const wasSynced = synced;
				synced = true;
				clearRetry();
				if (degraded) {
					setDegraded(false); // notifies with the fresh synced + access values
				} else if (!wasSynced || accessChanged) {
					notifyState();
				}
				// else: a healthy background reconcile that changed nothing - no
				// redundant state callback every cadence tick.
			})
			.catch(() => {
				if (syncInFlightGen === gen) syncInFlightGen = -1;
				if (destroyed || gen !== syncGen) return;
				// A failed sync (offline, server restarting, version skew)
				// leaves the replica on its current basis - still readable,
				// still writable-locally; retry while the connection is open.
				setDegraded(true);
				scheduleRetry();
			});
	}

	// The status store delivers the current value on subscribe, so a channel
	// constructed on an already-open connection syncs immediately. EVERY
	// transition bumps the sync generation (an in-flight sync's reply
	// describes a connection that no longer exists); a transition away from
	// 'open' marks the channel un-synced so outbound updates pause, and the
	// next 'open' runs the recovery exchange.
	const statusUnsub = status.subscribe((s) => {
		const changed = s !== lastStatus;
		lastStatus = s;
		if (destroyed) return;
		if (changed) syncGen++;
		if (s === 'open') {
			synced = false;
			resync();
		} else if (synced) {
			synced = false;
			notifyState();
		}
	});

	/**
	 * The healthy-channel background reconcile: a self-rescheduling tick that
	 * re-runs the sync exchange while the channel is open and synced. This is
	 * what converges a TERMINAL drop - a lost fan-out frame with no causal
	 * successor leaves pendingStructs null, so the loss detector never fires
	 * and, without this, the replica would stay behind until the next
	 * reconnect. Skips itself while un-synced or degraded (the retry loop owns
	 * recovery there) and while a sync is already in flight; each in-sync tick
	 * costs one state-vector request answered with an empty diff.
	 */
	function scheduleReconcile() {
		if (destroyed || reconcileIntervalMs === 0 || reconcileTimer !== null) return;
		reconcileTimer = setTimer(() => {
			reconcileTimer = null;
			if (destroyed) return;
			if (lastStatus === 'open' && synced && !degraded && syncInFlightGen === -1) resync();
			scheduleReconcile();
		}, reconcileIntervalMs);
	}
	scheduleReconcile();

	function assertWritable() {
		if (access !== null && !access.write) {
			throw new Error(
				'crdt: this document is read-only for this connection (the guard returned write: false); ' +
				'check .readOnly before mutating'
			);
		}
	}

	function facetKind(name, kind) {
		const existing = facetKinds.get(name);
		if (existing !== undefined && existing !== kind) {
			throw new Error('crdt: container "' + name + '" is already a ' + existing + '; one name, one kind');
		}
		facetKinds.set(name, kind);
	}

	/**
	 * Wire one observer to a Yjs type, isolating reactive-layer callbacks.
	 * @param {any} type
	 * @param {(event: any) => any} translate
	 */
	function makeOnChange(type, translate) {
		return (cb) => {
			if (typeof cb !== 'function') throw new TypeError('crdt: onChange callback must be a function');
			const observer = (event) => {
				if (destroyed) return;
				let payload;
				try { payload = translate(event); } catch { return; }
				try { cb(payload); } catch { /* one bad consumer must not break the apply */ }
			};
			type.observe(observer);
			return () => { try { type.unobserve(observer); } catch { /* destroyed doc */ } };
		};
	}

	return {
		/**
		 * A keyed container facet. Values are plain JSON values with
		 * replace-on-write semantics (`m.set(k, { ...m.get(k), title })`);
		 * nested collaborative structures are sibling named containers on the
		 * same document, not nested values.
		 * @param {string} [name]
		 */
		map(name = 'root') {
			facetKind(name, 'map');
			const t = doc.getMap(name);
			return {
				get(key) { return t.get(key); },
				has(key) { return t.has(key); },
				get size() { return t.size; },
				keys() { return t.keys(); },
				values() { return t.values(); },
				entries() { return t.entries(); },
				toJSON() { return t.toJSON(); },
				set(key, value) {
					assertWritable();
					doc.transact(() => { t.set(key, value); });
				},
				delete(key) {
					assertWritable();
					doc.transact(() => { t.delete(key); });
				},
				clear() {
					assertWritable();
					doc.transact(() => { t.clear(); });
				},
				/** cb receives the Set of changed keys (read back what you need). */
				onChange: makeOnChange(t, (event) => new Set(event.keysChanged))
			};
		},

		/**
		 * An ordered container facet. Positions are stable under concurrent
		 * insert/delete (each element carries a CRDT identity).
		 * @param {string} [name]
		 */
		array(name = 'root') {
			facetKind(name, 'array');
			const t = doc.getArray(name);
			return {
				at(i) { return t.get(i); },
				get length() { return t.length; },
				toArray() { return t.toArray(); },
				toJSON() { return t.toJSON(); },
				push(...items) {
					assertWritable();
					if (items.length === 0) return;
					doc.transact(() => { t.push(items); });
				},
				insert(index, ...items) {
					assertWritable();
					if (items.length === 0) return;
					doc.transact(() => { t.insert(index, items); });
				},
				delete(index, length = 1) {
					assertWritable();
					doc.transact(() => { t.delete(index, length); });
				},
				/** cb receives the positional delta ({retain}/{insert}/{delete} steps). */
				onChange: makeOnChange(t, (event) => event.changes.delta)
			};
		},

		/**
		 * A collaborative text facet (character-level concurrent insert).
		 * @param {string} [name]
		 */
		text(name = 'root') {
			facetKind(name, 'text');
			const t = doc.getText(name);
			const clampIndex = (i) => {
				const n = Math.floor(Number(i));
				if (!Number.isFinite(n) || n < 0) return 0;
				return n > t.length ? t.length : n;
			};
			return {
				toString() { return t.toString(); },
				get length() { return t.length; },
				insert(index, content) {
					assertWritable();
					doc.transact(() => { t.insert(index, content); });
				},
				delete(index, length = 1) {
					assertWritable();
					doc.transact(() => { t.delete(index, length); });
				},
				/**
				 * Encode a [start, end) range as a position anchor that survives concurrent
				 * edits: a selection highlight stays on the same characters as other users
				 * insert and delete around it. Returns opaque bytes (a packed pair of yjs
				 * relative positions); pass them to resolveRange on any converged replica.
				 * The start binds right and the end binds left, so an insert exactly at
				 * either edge stays outside the range while an insert strictly inside it
				 * extends the range to keep covering the original characters. A read - no
				 * write access required.
				 * @param {number} start @param {number} end @returns {Uint8Array}
				 */
				anchorRange(start, end) {
					const rs = Y.createRelativePositionFromTypeIndex(t, clampIndex(start), 0);
					const re = Y.createRelativePositionFromTypeIndex(t, clampIndex(end), -1);
					return packRangeAnchor(Y.encodeRelativePosition(rs), Y.encodeRelativePosition(re));
				},
				/**
				 * Resolve range anchor bytes (from anchorRange) to current { start, end }
				 * offsets against this replica's text, normalized so start <= end. Returns
				 * null if the blob is malformed or a position cannot be resolved against this
				 * replica (e.g. a different document, or before the first sync), so a stale
				 * selection drops rather than throws. If the anchored text was deleted the
				 * range collapses to a zero-width caret at the deletion point (a caret, not a
				 * ghost) - the natural yjs sticky-anchor behavior.
				 * @param {Uint8Array} bytes @returns {{ start: number, end: number } | null}
				 */
				resolveRange(bytes) {
					const parts = unpackRangeAnchor(bytes);
					if (parts === null) return null;
					// The framing check above validates only the length prefix, not that the
					// two runs are decodable positions. A truncated / mangled / stale-format
					// payload makes yjs decode throw, so guard it and drop to null - the
					// documented fail-safe (never throws on a garbage anchor).
					try {
						const as = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(parts.start), doc);
						const ae = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(parts.end), doc);
						if (as === null || ae === null) return null;
						return as.index <= ae.index
							? { start: as.index, end: ae.index }
							: { start: ae.index, end: as.index };
					} catch {
						return null;
					}
				},
				/** cb fires after each change; read `toString()` for the value. */
				onChange: makeOnChange(t, () => undefined)
			};
		},

		/**
		 * Batch several mutations into ONE transaction = one wire update (the
		 * multi-field atomic edit). Opt-in; each mutator is its own
		 * transaction by default.
		 * @param {() => void} fn
		 */
		transact(fn) {
			if (typeof fn !== 'function') throw new TypeError('crdt: transact requires a function');
			assertWritable();
			doc.transact(fn);
		},

		/** Observe channel state: `{ synced, degraded, access }`. One consumer. */
		onState(cb) {
			if (typeof cb !== 'function') throw new TypeError('crdt: onState callback must be a function');
			stateCb = cb;
			notifyState();
		},

		/** Re-run the sync exchange now (also runs on every 'open'). */
		resync,

		/** The current access record, or null before the first sync reply. */
		get access() {
			return access === null ? null : { ...access };
		},

		/** True when the guard granted read but not write. */
		get readOnly() {
			return access !== null && !access.write;
		},

		/** True after a successful sync on the CURRENT connection. */
		get synced() {
			return synced;
		},

		/** True while the last sync attempt failed and recovery is pending. */
		get degraded() {
			return degraded;
		},

		/** The resolved wire topic, or null before the first sync reply. */
		get topic() {
			return wireTopic;
		},

		destroy() {
			if (destroyed) return;
			destroyed = true;
			// Tell the server this mount is gone so its reference releases
			// now, not at socket close. Lossy by contract: a lost close frame
			// self-heals when the connection drops.
			if (everSynced && typeof transport.close === 'function') {
				try { transport.close(mountId); } catch { /* never throw out of destroy */ }
			}
			statusUnsub();
			frameUnsub();
			if (tapUnsub !== null) tapUnsub();
			tapUnsub = null;
			clearRetry();
			if (pendingResyncTimer !== null) {
				clearTimer(pendingResyncTimer);
				pendingResyncTimer = null;
			}
			if (reconcileTimer !== null) {
				clearTimer(reconcileTimer);
				reconcileTimer = null;
			}
			presyncBuffer = [];
			stateCb = null;
			doc.off('update', onDocUpdate);
			try { doc.destroy(); } catch { /* ignore */ }
		}
	};
}
