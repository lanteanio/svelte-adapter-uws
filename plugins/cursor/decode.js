/**
 * Pure cursor-store merge semantics for svelte-adapter-uws.
 *
 * The catalog / join / update / bulk / remove merge, the output build, and the
 * maxAge sweep that maintain the client-side cursor Map live here as pure
 * functions over an explicit `state = { positionMap, userMap, timestamps }`.
 * `plugins/cursor/client.js` owns the store, subscription, and viewport
 * reporting; it imports these functions so the merge is a single definition.
 *
 * The wire decode (frame bytes -> `{ event, data }`) is NOT here: a binary
 * `0x03` frame is decoded by `plugins/cursor/codec.js#decodeCursor` into the
 * same `{ event, data }` shape the JSON path dispatches, and that shape is the
 * input these functions consume. So a frame's transport (JSON or binary) makes
 * no difference here.
 *
 * `state` holds three Maps keyed by connection key:
 *   - `positionMap` key -> latest position `data` (from update / bulk).
 *   - `userMap`     key -> user metadata (from catalog / join).
 *   - `timestamps`  key -> ms timestamp of the last position, for the sweep.
 *
 * @module svelte-adapter-uws/plugins/cursor/decode
 */

/**
 * @typedef {object} CursorState
 * @property {Map<string, any>} positionMap key -> latest position data.
 * @property {Map<string, any>} userMap     key -> user metadata.
 * @property {Map<string, number>} timestamps key -> last-position timestamp (ms).
 */

/**
 * Apply one decoded cursor `{ event, data }` to `state`, mutating its Maps in
 * place. Returns `true` when the merged output (the user/position join) may
 * have changed and the caller should re-emit; `false` when the event was a
 * no-op (an unsubscribed null frame, a malformed entry, or a remove that hit
 * nothing). The caller decides how to surface the change - this function never
 * builds the output Map itself.
 *
 * Mirrors the wire shape exactly: `catalog` replaces the user roster, `join`
 * adds one user, `update` / `bulk` set positions and stamp timestamps,
 * `remove` clears a key from all three Maps.
 *
 * @param {CursorState} state
 * @param {{ event: string, data: any } | null} event decoded frame
 * @param {number} [now] timestamp stamped onto positions; defaults to
 *   `Date.now()` so production behavior matches the inline merge and a test
 *   can pin time for a deterministic characterization.
 * @returns {boolean} whether the caller should re-emit the merged output
 */
export function applyEvent(state, event, now = Date.now()) {
	if (event === null) return false;
	const { positionMap, userMap, timestamps } = state;

	if (event.event === 'catalog' && Array.isArray(event.data)) {
		userMap.clear();
		for (const entry of event.data) {
			if (entry && typeof entry.key === 'string') {
				userMap.set(entry.key, entry.user);
			}
		}
		return true;
	}

	if (event.event === 'join' && event.data != null) {
		const { key, user } = event.data;
		if (typeof key === 'string') {
			userMap.set(key, user);
			return true;
		}
		return false;
	}

	if (event.event === 'update' && event.data != null) {
		const { key, data } = event.data;
		if (typeof key === 'string') {
			positionMap.set(key, data);
			timestamps.set(key, now);
			return true;
		}
		return false;
	}

	if (event.event === 'bulk' && Array.isArray(event.data)) {
		for (const entry of event.data) {
			if (entry && typeof entry.key === 'string') {
				positionMap.set(entry.key, entry.data);
				timestamps.set(entry.key, now);
			}
		}
		return true;
	}

	if (event.event === 'remove' && event.data != null) {
		const { key } = event.data;
		if (typeof key !== 'string') return false;
		timestamps.delete(key);
		const hadPosition = positionMap.delete(key);
		const hadUser = userMap.delete(key);
		return hadPosition || hadUser;
	}

	return false;
}

/**
 * Build the public output Map from `state`: a `Map<key, { user, data }>` that
 * skips any position whose user has not yet been seen via catalog / join, so a
 * position frame that races ahead of its roster entry stays hidden until the
 * user arrives.
 *
 * @param {CursorState} state
 * @returns {Map<string, { user: any, data: any }>}
 */
export function mergeOutput(state) {
	const merged = new Map();
	for (const [key, data] of state.positionMap) {
		const user = state.userMap.get(key);
		if (user === undefined) continue;
		merged.set(key, { user, data });
	}
	return merged;
}

/**
 * Drop entries whose last position is older than `maxAge` ms, mutating
 * `state`'s Maps in place. Returns `true` when a position was actually removed
 * (so the caller should re-emit), matching the inline sweep's "changed" signal
 * exactly: a user-only entry whose timestamp expired clears its user metadata
 * but does not on its own request a re-emit (it was never in the output).
 *
 * A non-positive `maxAge` disables the sweep and is a no-op.
 *
 * @param {CursorState} state
 * @param {number} maxAge expiry window in ms
 * @param {number} [now] current time; defaults to `Date.now()`.
 * @returns {boolean} whether a position was removed
 */
export function sweepExpired(state, maxAge, now = Date.now()) {
	if (!maxAge || maxAge <= 0) return false;
	const { positionMap, userMap, timestamps } = state;
	const cutoff = now - maxAge;
	let changed = false;
	for (const [key, ts] of timestamps) {
		if (ts < cutoff) {
			timestamps.delete(key);
			if (positionMap.delete(key)) changed = true;
			userMap.delete(key);
		}
	}
	return changed;
}
