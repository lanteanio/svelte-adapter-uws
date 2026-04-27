/**
 * Session plugin for svelte-adapter-uws.
 *
 * In-process session store with sliding TTL: every read extends the
 * entry's lifetime by another full ttl window. Designed for the
 * "load on WS upgrade, refresh on activity" pattern - the upgrade
 * handler reads the session by token, and any subsequent read keeps
 * it alive while the user is active.
 *
 * Zero impact on the adapter core - this is a standalone module that
 * holds its own state.
 *
 * @module svelte-adapter-uws/plugins/session
 */

/**
 * @typedef {Object} SessionOptions
 * @property {number} ttl - Time to live in milliseconds. Each get/touch
 *   extends an entry's expiry to `Date.now() + ttl`. Must be positive.
 * @property {number} [maxEntries=10000] - Soft cap on retained entries.
 *   When the map grows past 110% of this cap, expired entries are
 *   pruned in a single pass; if the map is still over cap after
 *   pruning, the oldest entries are evicted regardless. Set higher if
 *   you genuinely have more than 10K concurrent sessions.
 */

/**
 * @template T
 * @typedef {Object} Session
 * @property {(token: string) => T | null} get - Look up by token. Returns
 *   the stored data if present and not yet expired, else `null`. On a
 *   hit, extends the entry's TTL (sliding window). Expired entries are
 *   removed lazily on access.
 * @property {(token: string, data: T) => void} set - Store or replace
 *   data for `token`. Resets the TTL.
 * @property {(token: string) => boolean} delete - Remove an entry.
 *   Returns `true` if the token was present (and not yet expired),
 *   `false` otherwise.
 * @property {(token: string) => boolean} touch - Extend TTL without
 *   reading data. Returns `true` if the entry was present and
 *   refreshed, `false` if the token was missing or already expired.
 * @property {() => number} size - Current number of retained entries
 *   (may include expired entries that have not yet been pruned).
 * @property {() => void} clear - Remove all entries.
 */

/**
 * Create an in-process session store with sliding TTL.
 *
 * @template T
 * @param {SessionOptions} options
 * @returns {Session<T>}
 *
 * @example
 * ```js
 * // src/lib/server/sessions.js
 * import { createSession } from 'svelte-adapter-uws/plugins/session';
 * export const sessions = createSession({ ttl: 30 * 60 * 1000 });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js - load on upgrade, refresh on every message.
 * import { sessions } from '$lib/server/sessions';
 *
 * export function upgrade({ cookies }) {
 *   const token = cookies.session_id;
 *   if (!token) return false;
 *   const session = sessions.get(token);
 *   if (!session) return false;
 *   return { token, userId: session.userId };
 * }
 *
 * export function message(ws) {
 *   sessions.touch(ws.getUserData().token);
 * }
 * ```
 */
export function createSession(options) {
	if (!options || typeof options !== 'object') {
		throw new Error('session: options object is required');
	}
	const { ttl, maxEntries = 10000 } = options;
	if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
		throw new Error('session: ttl must be a positive finite number');
	}
	if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
		throw new Error('session: maxEntries must be a positive integer');
	}

	/**
	 * Insertion-ordered map of token -> { data, expiresAt }.
	 * Insertion order is used as a fallback eviction signal when the
	 * map exceeds `maxEntries` after expired-entry pruning.
	 * @type {Map<string, { data: any, expiresAt: number }>}
	 */
	const entries = new Map();

	function pruneIfFull() {
		if (entries.size <= maxEntries * 1.1) return;
		const now = Date.now();
		for (const [token, entry] of entries) {
			if (entry.expiresAt <= now) entries.delete(token);
		}
		// Hard cap: if still over, evict oldest insertion-order entries.
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}

	return {
		get(token) {
			if (typeof token !== 'string' || token.length === 0) {
				throw new Error('session: token must be a non-empty string');
			}
			const entry = entries.get(token);
			if (!entry) return null;
			const now = Date.now();
			if (entry.expiresAt <= now) {
				entries.delete(token);
				return null;
			}
			entry.expiresAt = now + ttl;
			return entry.data;
		},
		set(token, data) {
			if (typeof token !== 'string' || token.length === 0) {
				throw new Error('session: token must be a non-empty string');
			}
			const expiresAt = Date.now() + ttl;
			// Re-insert to refresh insertion order for LRU-ish eviction
			// when the map is over cap with no expired entries to prune.
			if (entries.has(token)) entries.delete(token);
			entries.set(token, { data, expiresAt });
			pruneIfFull();
		},
		delete(token) {
			if (typeof token !== 'string' || token.length === 0) {
				throw new Error('session: token must be a non-empty string');
			}
			const entry = entries.get(token);
			if (!entry) return false;
			const wasLive = entry.expiresAt > Date.now();
			entries.delete(token);
			return wasLive;
		},
		touch(token) {
			if (typeof token !== 'string' || token.length === 0) {
				throw new Error('session: token must be a non-empty string');
			}
			const entry = entries.get(token);
			if (!entry) return false;
			const now = Date.now();
			if (entry.expiresAt <= now) {
				entries.delete(token);
				return false;
			}
			entry.expiresAt = now + ttl;
			return true;
		},
		size() {
			return entries.size;
		},
		clear() {
			entries.clear();
		}
	};
}
