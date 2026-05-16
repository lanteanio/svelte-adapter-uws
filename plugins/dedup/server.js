/**
 * Dedup plugin for svelte-adapter-uws.
 *
 * In-process "have I seen this id before?" cache with fixed-window TTL.
 * The natural use is wrapping a side-effecting handler so client retries
 * after a flaky disconnect don't double-execute:
 *
 *   if (!dedup.claim(messageId)) return; // already processed; skip
 *   await chargeCustomer(...);
 *
 * The TTL is the deduplication window: an id is considered "fresh"
 * for `ttl` ms after the first claim. Duplicate claims within the
 * window do NOT extend the TTL (semantics match Redis SET NX EX, the
 * eventual distributed swap target).
 *
 * Zero impact on the adapter core - this is a standalone module that
 * holds its own state.
 *
 * @module svelte-adapter-uws/plugins/dedup
 */

/**
 * @typedef {Object} DedupOptions
 * @property {number} ttl - Deduplication window in milliseconds. An id
 *   that was claimed `ttl` ms ago can be claimed again as new. Must be
 *   positive.
 * @property {number} [maxEntries=10000] - Soft cap on retained ids.
 *   When the map grows past 110% of this cap, expired entries are
 *   pruned in a single pass; if the map is still over cap (i.e. all
 *   entries are still inside their windows), the oldest insertion-
 *   order entries are evicted regardless.
 * @property {number} [maxIdLength=256] - Reject ids longer than this many
 *   characters at `claim()` / `has()` / `delete()` entry. Defaults to
 *   256, which is generous for typical message-id / request-id shapes
 *   (UUIDs are 36, ulids 26, base64-encoded random nonces under 64).
 *   The cap prevents a single oversized id from anchoring a large
 *   internal string for `ttl` ms - with `maxEntries: 10000`, an
 *   uncapped 1 MB id pins 10 GB until the TTL elapses. Pass a larger
 *   number if your application actually uses long composite ids.
 */

/**
 * @typedef {Object} Dedup
 * @property {(id: string) => boolean} claim - Try to claim `id` as a
 *   first-sight delivery. Returns `true` if the id was unseen or its
 *   previous claim has expired (and records the new claim with a
 *   fresh TTL). Returns `false` if the id is currently inside its
 *   window from a prior claim.
 * @property {(id: string) => boolean} has - `true` iff `id` was
 *   claimed and is still within its window. Lazy-prunes expired ids
 *   on access.
 * @property {(id: string) => boolean} delete - Explicitly forget an
 *   id. Returns `true` if the id was live (claim would have returned
 *   `false`), `false` if it was missing or already expired (expired
 *   entries are still removed by this call).
 * @property {() => number} size - Current number of retained ids
 *   (may include expired ids that have not yet been pruned).
 * @property {() => void} clear - Forget all ids.
 */

/**
 * Create an in-process dedup cache with fixed-window TTL.
 *
 * @param {DedupOptions} options
 * @returns {Dedup}
 *
 * @example
 * ```js
 * // src/lib/server/dedup.js
 * import { createDedup } from 'svelte-adapter-uws/plugins/dedup';
 * export const messages = createDedup({ ttl: 5 * 60 * 1000 });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - skip side effects on retry of a known id.
 * import { messages } from '$lib/server/dedup';
 *
 * export function message(ws, { data }) {
 *   const msg = JSON.parse(Buffer.from(data).toString());
 *   if (!messages.claim(msg.id)) return; // duplicate, ignore
 *   processMessage(msg);
 * }
 * ```
 */
export function createDedup(options) {
	if (!options || typeof options !== 'object') {
		throw new Error('dedup: options object is required');
	}
	const { ttl, maxEntries = 10000, maxIdLength = 256 } = options;
	if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
		throw new Error('dedup: ttl must be a positive finite number');
	}
	if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
		throw new Error('dedup: maxEntries must be a positive integer');
	}
	if (!Number.isInteger(maxIdLength) || maxIdLength <= 0) {
		throw new Error('dedup: maxIdLength must be a positive integer');
	}

	/**
	 * Insertion-ordered map of id -> expiresAt. Insertion order is
	 * the fallback eviction signal when the map is over cap with no
	 * expired entries to prune.
	 * @type {Map<string, number>}
	 */
	const seen = new Map();

	function pruneIfFull() {
		if (seen.size <= maxEntries * 1.1) return;
		const now = Date.now();
		for (const [id, expiresAt] of seen) {
			if (expiresAt <= now) seen.delete(id);
		}
		while (seen.size > maxEntries) {
			const oldest = seen.keys().next().value;
			if (oldest === undefined) break;
			seen.delete(oldest);
		}
	}

	function validateId(id) {
		if (typeof id !== 'string' || id.length === 0) {
			throw new Error('dedup: id must be a non-empty string');
		}
		if (id.length > maxIdLength) {
			throw new Error(
				'dedup: id length ' + id.length +
				' exceeds maxIdLength ' + maxIdLength
			);
		}
	}

	return {
		claim(id) {
			validateId(id);
			const now = Date.now();
			const prev = seen.get(id);
			if (prev !== undefined && prev > now) return false;
			// Re-insert (delete + set) so insertion order tracks last-claim
			// time for the LRU-ish hard eviction path.
			if (prev !== undefined) seen.delete(id);
			seen.set(id, now + ttl);
			pruneIfFull();
			return true;
		},
		has(id) {
			validateId(id);
			const expiresAt = seen.get(id);
			if (expiresAt === undefined) return false;
			if (expiresAt <= Date.now()) {
				seen.delete(id);
				return false;
			}
			return true;
		},
		delete(id) {
			validateId(id);
			const expiresAt = seen.get(id);
			if (expiresAt === undefined) return false;
			const wasLive = expiresAt > Date.now();
			seen.delete(id);
			return wasLive;
		},
		size() {
			return seen.size;
		},
		clear() {
			seen.clear();
		}
	};
}
