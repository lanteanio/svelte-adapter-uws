/**
 * Per-connection short-id key dictionaries and the delta-coded stamp helpers
 * shared by the binary topic codecs.
 *
 * A dictionaried wire replaces repeated key strings with small per-connection
 * integer ids: the first time a key appears on a connection it is announced
 * inline (the key string travels once); after that a frame carries a 1-2 byte
 * id and the decoder resolves it from a cached id->key map. The keyref is a
 * single varint `v`:
 *
 *   - `v == 0` KEY-ASSIGN: followed by `varint(id)` then the key string.
 *     Binds `id -> key` for this connection, then this occurrence uses `id`.
 *   - `v == 1` INLINE: followed by the key string, with no id binding. The
 *     overflow fallback when the id space is exhausted within a single frame.
 *   - `v >= 2` REF: the id is `v - 2` (0 and 1 are reserved for the escapes
 *     above). No key bytes on the wire.
 *
 * Eviction: ids live in a bounded space (`maxEntries`, default 65536). The
 * dict grows until the cap, then a new key reclaims the least-recently-used
 * entry whose last use predates the current frame (so an id assigned earlier
 * in the same frame is never reused by a later entry in that frame) and takes
 * its id; the decoder re-syncs from the KEY-ASSIGN that carries the reused
 * id. A key that still cannot get an id (a single frame referencing more than
 * `maxEntries` distinct keys) falls back to a full-string INLINE keyref.
 * There is no free-on-remove: a removal leaves the id bound, so a
 * re-appearing key reuses it with no new assign, and LRU reclaims genuinely
 * departed ids at the cap. State is per-connection and discarded when the
 * connection closes; both sides reset on reconnect.
 *
 * The delta-stamp helpers carry a server wall-clock stamp at one byte
 * steady-state: the first stamp a fresh dictionary writes is the absolute
 * epoch-ms value; every later one is the non-negative delta against the
 * dictionary's `lastT` (a backward wall step writes 0 and holds, so both
 * sides stay non-decreasing and in lock-step). The stamp state lives on the
 * dictionaries with the same in-order, reset-on-reconnect,
 * untouched-on-JSON-fallback discipline as the key map - a codec must fully
 * validate a frame BEFORE writing its stamp, so a frame that falls back to
 * JSON leaves both sides' state unchanged.
 *
 * Pure: no clocks, no timers, no imports. Time enters only through the
 * injected `timeSource` a consuming codec binds, so the module bundles for
 * the browser and runs under a deterministic harness unchanged.
 *
 * @module svelte-adapter-uws/files/keydict
 */

/** Default id-space size: 16-bit ids, evicted least-recently-used at the cap. */
export const DEFAULT_MAX_ENTRIES = 65536;

/**
 * Per-connection encoder dictionary: maps each key to a small integer id so a
 * frame carries a 1-2 byte ref rather than the full key string on every entry.
 */
export class KeyEncodeDict {
	/** @param {number} [maxEntries] */
	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		this.maxEntries = maxEntries;
		/** @type {Map<string, { id: number, lastUsed: number }>} */
		this.byKey = new Map();
		this.nextId = 0;
		// Monotonic per-frame counter. `beginFrame()` advances it; an entry's
		// `lastUsed` records the frame it was last referenced, so eviction can
		// skip ids touched in the current frame.
		this.clock = 0;
	}

	/** Advance the per-frame clock. Call once at the start of each encode. */
	beginFrame() {
		this.clock++;
	}

	/**
	 * Write a keyref for `key`: a REF (`varint(id + 2)`) when the key is already
	 * interned, otherwise a KEY-ASSIGN (`varint(0)`, `varint(id)`, key string)
	 * after allocating an id - or an INLINE (`varint(1)`, key string) when the
	 * id space is exhausted for this frame.
	 * @param {import('./wire.js').ByteWriter} w
	 * @param {string} key
	 */
	writeKey(w, key) {
		const entry = this.byKey.get(key);
		if (entry !== undefined) {
			entry.lastUsed = this.clock;
			w.varint(entry.id + 2);
			return;
		}
		const id = this._alloc();
		if (id < 0) {
			w.varint(1);
			w.str(key);
			return;
		}
		this.byKey.set(key, { id, lastUsed: this.clock });
		w.varint(0);
		w.varint(id);
		w.str(key);
	}

	/** @returns {number} a usable id, or -1 when none can be freed this frame. */
	_alloc() {
		if (this.nextId < this.maxEntries) return this.nextId++;
		// At cap: reclaim the least-recently-used id whose last use predates the
		// current frame, so a key this frame just assigned is never evicted by a
		// later key in the same frame.
		let victimKey;
		let victimUsed = Infinity;
		let victimId = -1;
		for (const [k, e] of this.byKey) {
			if (e.lastUsed < this.clock && e.lastUsed < victimUsed) {
				victimUsed = e.lastUsed;
				victimKey = k;
				victimId = e.id;
			}
		}
		if (victimId < 0) return -1;
		this.byKey.delete(victimKey);
		return victimId;
	}
}

/**
 * Per-connection decoder dictionary: the inverse of {@link KeyEncodeDict}.
 * Resolves a keyref back to its key, caching `id -> key` so a REF costs one
 * `Map.get` and no per-entry string decode. Reset on reconnect.
 */
export class KeyDecodeDict {
	constructor() {
		/** @type {Map<number, string>} */
		this.byId = new Map();
	}

	/**
	 * Read a keyref and resolve it to a key, recording any KEY-ASSIGN binding.
	 * Returns null when a REF cannot be resolved (a desync the caller turns into
	 * a dropped frame).
	 * @param {import('./wire.js').ByteReader} r
	 * @returns {string | null}
	 */
	readKey(r) {
		const v = r.varint();
		if (v === 0) {
			const id = r.varint();
			const key = r.str();
			this.byId.set(id, key);
			return key;
		}
		if (v === 1) return r.str();
		const key = this.byId.get(v - 2);
		return key === undefined ? null : key;
	}
}

/**
 * Write the delta-coded server stamp for a frame. Runs only after the frame
 * is fully validated - a JSON fallback never reaches this point, so the stamp
 * state, like the key dictionary, is untouched on fallback.
 * @param {import('./wire.js').ByteWriter} w
 * @param {{ timeSource: () => number, lastT: number }} dict
 */
export function writeDeltaStamp(w, dict) {
	let t = dict.timeSource();
	if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) t = dict.lastT < 0 ? 0 : dict.lastT;
	t = Math.floor(t);
	if (dict.lastT < 0) {
		w.varint(t);
		dict.lastT = t;
		return;
	}
	let d = t - dict.lastT;
	if (d < 0) d = 0;
	w.varint(d);
	dict.lastT += d;
}

/**
 * Read a delta-coded server stamp, mirroring {@link writeDeltaStamp}.
 * @param {import('./wire.js').ByteReader} r
 * @param {{ lastT: number }} dict
 * @returns {number}
 */
export function readDeltaStamp(r, dict) {
	const v = r.varint();
	if (dict.lastT < 0) {
		dict.lastT = v;
		return v;
	}
	dict.lastT += v;
	return dict.lastT;
}
