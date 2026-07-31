/**
 * Rate limit plugin for svelte-adapter-uws.
 *
 * Fixed-window rate limiter for inbound WebSocket messages.
 * Supports per-IP, per-connection, or custom key extraction,
 * with optional auto-ban when a bucket is exhausted.
 *
 * Fixed-window semantics: the allowance refills in full at each
 * interval boundary, so a client can fire a full window of messages
 * at the end of one interval and another full window at the start of
 * the next - up to 2x `points` inside a short seam. The adapter
 * core's upgrade limiter uses a sliding window to avoid exactly this.
 * If burst smoothness matters, prefer a smaller `points` / `interval`
 * pair with the same average rate.
 *
 * Zero impact on the adapter core - this is a standalone module
 * that you call from your `message` hook to decide whether to
 * process or drop a message.
 *
 * @module svelte-adapter-uws/plugins/ratelimit
 */

import { now } from '../../runtime/runtime.js';

/**
 * @typedef {Object} RateLimitOptions
 * @property {number} points - Allowance per interval. Must be a positive integer.
 * @property {number} interval - Refill interval in milliseconds. Must be positive.
 * @property {number} [blockDuration=0] - If > 0, automatically ban the key for this many
 *   milliseconds when the allowance is exhausted. Subsequent `consume()` calls return
 *   `{ allowed: false }` until the ban expires.
 * @property {'ip' | 'connection' | ((ws: any) => string)} [keyBy='ip'] - How to derive the
 *   rate-limit key from a WebSocket connection.
 *   - `'ip'` (default): uses `userData.remoteAddress`, `userData.ip`, or `'unknown'`
 *   - `'connection'`: each WebSocket object gets its own independent bucket
 *   - `function`: custom extractor, receives the ws and returns a string key
 * @property {(ws: any) => (string | null | undefined)} [tenant] - Optional per-connection
 *   tenant resolver. When set, the bucket key is scoped by the returned tenant id so two
 *   tenants sharing an IP / connection / custom key get independent buckets and a tenant's
 *   `reset` / `ban` / `unban` / `clear` touch only that tenant. Mirrors the `redis/ratelimit`
 *   extension. Return null/undefined for an unscoped connection; omit for a single-tenant
 *   deploy (byte-identical). The id is joined to the key with a NUL, so it stays unambiguous
 *   even when the key is an IPv6 address.
 * @property {number} [maxBuckets=1_000_000] - Hard cap on retained buckets. When the
 *   map crosses this size on a new insert, one entry is evicted to make room. The
 *   lazy expired-entry sweep at 1000+ entries still runs first; the hard cap protects
 *   against sustained DDoS where every entry is unexpired. The victim is the least
 *   active unbanned entry of a sample; see {@link createRateLimit}'s `evictOne` for
 *   what eviction does and does not guarantee about a ban.
 * @property {number} [evictionSample=16] - How many entries an eviction inspects
 *   before choosing its victim. Must be a positive integer. Larger samples choose
 *   better and cost more; the whole map is inspected when it holds fewer entries
 *   than this.
 * @property {(evicted: { key: string, banned: boolean }) => void} [onEvict] - Called
 *   once per eviction with the bucket key that was dropped (tenant-scoped, so it is
 *   `tenantId + '\0' + key` when a `tenant` resolver is set). `banned` is true when
 *   every sampled candidate was still serving a ban and enforcement state had to be
 *   dropped anyway - the case worth alerting on. Called after the call that triggered
 *   the eviction has finished deciding, so a listener that throws cannot change what
 *   that call charged or recorded, only rob its caller of the return value.
 */

/**
 * @typedef {Object} Bucket
 * @property {number} points - Allowance left in the current window.
 * @property {number} resetAt - When the window refills.
 * @property {number} bannedUntil - 0 when the key is not banned.
 * @property {number} prev - Allowance drawn in the window before this one, or 0 when
 *   a whole window went by with nothing drawn. Together with the current window's draw
 *   it is the two-window activity score eviction ranks on.
 * @property {number} banSeq - Order in which this key's current ban was placed, from a
 *   per-limiter counter. 0 when the key has never been banned. Read only to pick the
 *   most recently placed ban when every SAMPLED eviction candidate is banned; a counter
 *   rather than a timestamp because a flood places many bans inside one millisecond.
 */

/**
 * @typedef {Object} ConsumeResult
 * @property {boolean} allowed - Whether the request was permitted.
 * @property {number} remaining - Allowance left in the current window (0 if banned or exhausted).
 * @property {number} resetMs - Milliseconds until the bucket refills or the ban expires.
 */

/**
 * @typedef {Object} RateLimiter
 * @property {(ws: any, cost?: number) => ConsumeResult} consume -
 *   Attempt to consume from the current window's allowance. Returns the result synchronously.
 * @property {(key: string, tenant?: string | null) => void} reset - Clear the bucket for a key.
 * @property {(key: string, duration?: number, tenant?: string | null) => void} ban -
 *   Manually ban a key. Uses `duration` or `blockDuration` or 60 000 ms. Banning a key
 *   the limiter has not seen is an insert, so at `maxBuckets` it evicts another key's
 *   bucket to make room - an app that bans attacker-supplied ids therefore lets the
 *   attacker force one eviction of somebody else's state per ban.
 * @property {(key: string, tenant?: string | null) => void} unban - Remove a ban (the window counter is untouched).
 * @property {(tenant?: string | null) => void} clear - Reset all state, or only one tenant's buckets when a tenant id is given.
 */

/**
 * Create a fixed-window rate limiter.
 *
 * The allowance refills in full at each interval boundary (fixed
 * window, not token bucket): up to 2x `points` can pass inside a
 * short seam across a boundary. See the module header for the sizing
 * guidance.
 *
 * @param {RateLimitOptions} options
 * @returns {RateLimiter}
 *
 * @example
 * ```js
 * // src/lib/server/ratelimit.js
 * import { createRateLimit } from 'svelte-adapter-uws/plugins/ratelimit';
 *
 * export const limiter = createRateLimit({
 *   points: 10,
 *   interval: 1000,
 *   blockDuration: 30000
 * });
 * ```
 *
 * @example
 * ```js
 * // src/hooks.ws.js
 * import { limiter } from '$lib/server/ratelimit';
 *
 * export function message(ws, { data, platform }) {
 *   const { allowed } = limiter.consume(ws);
 *   if (!allowed) return; // drop the message
 *   // ... handle message
 * }
 * ```
 */
export function createRateLimit(options) {
	if (!options || typeof options !== 'object') {
		throw new Error('ratelimit: options object is required');
	}

	const {
		points,
		interval,
		blockDuration = 0,
		keyBy = 'ip',
		tenant,
		maxBuckets = 1_000_000,
		evictionSample = 16,
		onEvict = null
	} = options;

	if (!Number.isInteger(points) || points <= 0) {
		throw new Error('ratelimit: points must be a positive integer');
	}
	if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) {
		throw new Error('ratelimit: interval must be a positive number');
	}
	if (typeof blockDuration !== 'number' || !Number.isFinite(blockDuration) || blockDuration < 0) {
		throw new Error('ratelimit: blockDuration must be a non-negative number');
	}
	if (keyBy !== 'ip' && keyBy !== 'connection' && typeof keyBy !== 'function') {
		throw new Error("ratelimit: keyBy must be 'ip', 'connection', or a function");
	}
	if (tenant !== undefined && typeof tenant !== 'function') {
		throw new Error('ratelimit: tenant must be a function (ws) => id | null');
	}
	if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
		throw new Error('ratelimit: maxBuckets must be a positive integer');
	}
	// A sample of 0 or a non-number would make the victim loop never run, so
	// nothing would be evicted and the hard cap would silently stop bounding the
	// map - the guard's own bound disabled by a misconfigured knob.
	if (!Number.isInteger(evictionSample) || evictionSample < 1) {
		throw new Error('ratelimit: evictionSample must be a positive integer');
	}
	if (onEvict != null && typeof onEvict !== 'function') {
		throw new Error('ratelimit: onEvict must be a function');
	}

	/**
	 * Per-key bucket state.
	 * @type {Map<string, Bucket>}
	 */
	const buckets = new Map();

	/**
	 * Rotating position for {@link evictOne}, held ACROSS calls.
	 *
	 * Rotating rather than sampling from the head is what keeps eviction from
	 * targeting the clients worth keeping: insertion order puts the longest-lived
	 * legitimate keys first, so a fresh iterator would offer a flood of one-shot
	 * identities exactly those keys as victims, over and over.
	 *
	 * It is also the cheap way to sample. V8 marks a deleted Map slot with a
	 * tombstone and only compacts when the table rehashes, so at the cap - where
	 * every miss deletes one entry and inserts another - a fresh iterator must
	 * walk an ever-growing run of tombstones before it reaches the first live
	 * entry, which turns a bounded sample into a walk that gets more expensive as
	 * the cap grows. A kept iterator steps over each tombstone at most once.
	 *
	 * A live iterator pins the Map table it was opened on and every later rehash
	 * chains onto that one, so any delete this sampler did not make releases the
	 * cursor - otherwise a cursor stranded by a burst that stopped would retain
	 * superseded tables for the life of the process.
	 *
	 * @type {Iterator<[string, Bucket]> | null}
	 */
	let evictCursor = null;

	/**
	 * Counts bans placed, so eviction can tell which of two bans came later even
	 * when a flood placed both inside the same millisecond.
	 */
	let banSeq = 0;

	/** WeakMap for per-connection keying (avoids leaks). */
	const wsKeys = new WeakMap();
	let connCounter = 0;

	/**
	 * Derive the rate-limit key from a ws.
	 * @param {any} ws
	 * @returns {string}
	 */
	function resolveKey(ws) {
		if (typeof keyBy === 'function') return keyBy(ws);
		if (keyBy === 'connection') {
			let k = wsKeys.get(ws);
			if (!k) {
				k = '__conn:' + (++connCounter);
				wsKeys.set(ws, k);
			}
			return k;
		}
		// 'ip' - try common userData fields
		const ud = typeof ws.getUserData === 'function' ? ws.getUserData() : null;
		if (ud) {
			return String(ud.remoteAddress || ud.ip || ud.address || 'unknown');
		}
		return 'unknown';
	}

	// Scope the bucket key by the connection's tenant (when a `tenant` resolver is set),
	// FIRST and NUL-delimited so it stays unambiguous even for IPv6 keys. Null -> raw key
	// (byte-identical single-tenant key space). Mirrors redis/ratelimit's bucketKey. The id
	// is rejected if it contains the NUL delimiter (the one char that would let two distinct
	// tenants collide on one bucket); the check short-circuits on the null (default) path.
	function bucketKey(rawKey, tenantId) {
		if (tenantId && tenantId.indexOf('\0') !== -1) {
			throw new Error('ratelimit: tenant id must not contain a NUL byte (it is the bucket-key delimiter)');
		}
		return tenantId ? tenantId + '\0' + rawKey : rawKey;
	}

	/** Lazy cleanup when the map grows large. */
	function cleanup(t) {
		if (buckets.size <= 1000) return;
		let deleted = false;
		for (const [key, bucket] of buckets) {
			if (bucket.resetAt <= t && bucket.bannedUntil <= t) {
				buckets.delete(key);
				deleted = true;
			}
		}
		// A sweep that freed nothing cannot have moved the table, so the rotation
		// survives the case it exists for: a flood in which every entry is
		// unexpired and only the hard cap is reclaiming slots.
		if (deleted) evictCursor = null;
	}

	/**
	 * How much of its allowance a bucket has drawn across the current window and
	 * the one before it. Bounded by 2x `points`, and it decays: a bucket that has
	 * gone a whole window without a message scores 0 no matter how busy it once
	 * was. A lifetime counter would instead grow forever, which ranks by age
	 * rather than by activity and leaves an entry that was busy hours ago
	 * un-evictable while a client that arrived a second ago is the first to go.
	 *
	 * Scoring 0 for a bucket whose window has elapsed with nothing drawn since is
	 * exact rather than approximate: such a bucket refills to full on its owner's
	 * next message, and that message would leave it holding the same points, the
	 * same `prev` and the same score as a bucket recreated from scratch. Dropping
	 * it forfeits nothing at all.
	 *
	 * @param {Bucket} bucket
	 * @param {number} t
	 * @returns {number}
	 */
	function activity(bucket, t) {
		const drawn = points - bucket.points;
		if (bucket.resetAt > t) return drawn + bucket.prev;
		// The window ended, so the current one has drawn nothing yet and the
		// bucket's own window is the previous one - but only while less than a
		// full interval has passed, otherwise an empty window sits in between.
		if (bucket.resetAt + interval > t) return drawn;
		return 0;
	}

	/**
	 * Reclaim one slot for a key about to be inserted, and report what was dropped.
	 *
	 * Eviction must not be usable as a way to CLEAR ENFORCEMENT. A key serving a
	 * ban still owes it, and dropping its entry hands it a full fresh allowance on
	 * its next message, so anyone able to mint identities - a new address, a new
	 * value for a custom key - would otherwise push its own banned entry out of the
	 * map and walk straight back in. Two rules answer that:
	 *
	 * - A banned entry is not a candidate at all while any unbanned one is in the
	 *   sample, so an eviction that has an unbanned entry to take always takes it.
	 *   Note what that does NOT say: minted keys still occupy the map, and once
	 *   bans dominate it a sample can come up all-banned, which is the second rule
	 *   below. The guarantee is per eviction, not a promise that churn can never
	 *   reach a ban - `onEvict` reporting `banned: true` is how you learn it did,
	 *   and it means `maxBuckets` is too small for the bans in flight.
	 * - When every sampled candidate is banned something has to go, and it is the
	 *   most recently placed ban of that sample. Picking the soonest-expiring one
	 *   instead would target precisely the oldest ban in the map, which is the one
	 *   an attacker wants gone.
	 *
	 * The second rule decides inside the sample, so read what it guarantees at the
	 * far end: a sampled ban that is not the newest of its sample is never taken,
	 * therefore the ban placed longest ago in the WHOLE map is never taken (any
	 * other sampled ban outranks it, and an unbanned entry is preferred to it
	 * before that). Minting keys that deliberately exhaust themselves to earn a ban
	 * only ever adds bans newer than one already in the map, so a flood cannot
	 * clear the oldest ban. That holds wherever an eviction can see two entries at
	 * once - `evictionSample >= 2` and a cap above one bucket; a sample that lands
	 * on a single entry has no comparison to make and takes it.
	 *
	 * What that does NOT promise: a ban is not indestructible, and the choice is
	 * NOT map-wide. A map saturated with bans has to drop one to admit any new key,
	 * and the one dropped is only the newest of the entries this eviction happened
	 * to walk - newer bans elsewhere in the map are not consulted. So every ban but
	 * the oldest can be evicted, and traffic that first fills the map with a map's
	 * worth of its own bans can then have a ban placed after those taken out from
	 * under it by churn. Each such drop fires `onEvict` with `banned: true`, and
	 * sizing `maxBuckets` above the number of bans expected in flight is what keeps
	 * enforcement intact.
	 *
	 * Among unbanned candidates the victim is the lowest {@link activity} score; an
	 * elapsed window breaks a tie, since dropping such an entry forfeits nothing
	 * that its next message would not have restored anyway. Expiry is only a
	 * tiebreak: letting it win outright would feed eviction every client that
	 * messages more slowly than one interval, which is an ordinary client.
	 *
	 * @param {number} t
	 * @returns {{ key: string, banned: boolean } | null}
	 */
	function evictOne(t) {
		/** @type {string | null} */
		let victim = null;
		let victimScore = Infinity;
		let victimExpired = false;
		/** @type {string | null} */
		let bannedVictim = null;
		let bannedSeq = -1;
		let sampled = 0;
		let wrapped = 0;
		while (sampled < evictionSample && wrapped < 2) {
			if (evictCursor === null) {
				evictCursor = buckets.entries();
				wrapped++;
			}
			const step = evictCursor.next();
			if (step.done) {
				evictCursor = null;
				continue;
			}
			sampled++;
			const [k, bucket] = step.value;
			if (bucket.bannedUntil > t) {
				// Last resort only, and then the most recently placed ban of
				// the entries THIS sample walked - not of the whole map.
				if (bucket.banSeq > bannedSeq) {
					bannedSeq = bucket.banSeq;
					bannedVictim = k;
				}
				continue;
			}
			const score = activity(bucket, t);
			const expired = bucket.resetAt <= t;
			if (score < victimScore || (score === victimScore && expired && !victimExpired)) {
				victimScore = score;
				victimExpired = expired;
				victim = k;
			}
			// Nothing in the rest of the sample can beat an entry that has drawn
			// nothing across both windows and would refill on its next message.
			if (score === 0 && expired) break;
		}
		if (victim !== null) {
			buckets.delete(victim);
			return { key: victim, banned: false };
		}
		// Every sampled entry was still serving a ban. Refusing the insert instead
		// would leave the new key with no bucket and therefore no limit at all, so
		// the memory bound wins and the loss of enforcement is reported.
		if (bannedVictim !== null) {
			buckets.delete(bannedVictim);
			return { key: bannedVictim, banned: true };
		}
		return null;
	}

	return {
		consume(ws, cost = 1) {
			if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
				throw new Error('ratelimit: cost must be a non-negative finite number');
			}
			const key = bucketKey(resolveKey(ws), tenant ? tenant(ws) : null);
			const t = now();

			cleanup(t);

			let bucket = buckets.get(key);
			/** @type {{ key: string, banned: boolean } | null} */
			let evicted = null;
			if (!bucket) {
				// Hard cap: reclaim a slot if the lazy expired-entry sweep
				// above did not free one. Evicting rather than refusing the
				// new key is deliberate - the map is shared, so refusing at
				// the cap would let one flood of fresh keys lock out every
				// other client - and evictOne is what keeps the choice of
				// victim off the buckets worth keeping, and off an active
				// ban for as long as it has anything else to take.
				if (buckets.size >= maxBuckets) evicted = evictOne(t);
				bucket = { points, resetAt: t + interval, bannedUntil: 0, prev: 0, banSeq: 0 };
				buckets.set(key, bucket);
			}

			/** @type {ConsumeResult} */
			let result;

			// Check ban
			if (bucket.bannedUntil > t) {
				result = { allowed: false, remaining: 0, resetMs: bucket.bannedUntil - t };
			} else {
				// Refill if interval elapsed. The window that just ended becomes
				// `prev` so the activity score spans two windows; a window that
				// elapsed with a whole empty one behind it leaves nothing behind.
				if (bucket.resetAt <= t) {
					bucket.prev = bucket.resetAt + interval > t ? points - bucket.points : 0;
					bucket.points = points;
					bucket.resetAt = t + interval;
				}

				// Try to consume
				if (bucket.points >= cost) {
					bucket.points -= cost;
					result = {
						allowed: true,
						remaining: bucket.points,
						resetMs: bucket.resetAt - t
					};
				} else if (blockDuration > 0) {
					// Exhausted - auto-ban if configured
					bucket.bannedUntil = t + blockDuration;
					bucket.banSeq = ++banSeq;
					result = { allowed: false, remaining: 0, resetMs: blockDuration };
				} else {
					result = {
						allowed: false,
						remaining: Math.max(0, bucket.points),
						resetMs: bucket.resetAt - t
					};
				}
			}

			// Reported last, once the map is whole again AND this call has finished
			// deciding: a listener that throws must not be able to leave the new key
			// without its bucket, nor to skip the charge or the ban this call owed.
			if (evicted !== null && onEvict) onEvict(evicted);

			return result;
		},

		reset(key, tenantId) {
			if (buckets.delete(bucketKey(key, tenantId))) evictCursor = null;
		},

		ban(key, duration, tenantId) {
			const dur = duration ?? (blockDuration || 60000);
			const t = now();
			const bk = bucketKey(key, tenantId);
			let bucket = buckets.get(bk);
			/** @type {{ key: string, banned: boolean } | null} */
			let evicted = null;
			if (!bucket) {
				// A ban on an unseen key is an insert like any other, so it is held
				// to the same bound: banning attacker-supplied keys must not be a
				// way to grow the map past the cap.
				if (buckets.size >= maxBuckets) evicted = evictOne(t);
				bucket = { points: 0, resetAt: t + interval, bannedUntil: 0, prev: 0, banSeq: 0 };
				buckets.set(bk, bucket);
			}
			bucket.bannedUntil = t + dur;
			bucket.banSeq = ++banSeq;
			// Reported only once this ban is recorded, so a throwing listener cannot
			// leave the key inserted but unbanned.
			if (evicted !== null && onEvict) onEvict(evicted);
		},

		unban(key, tenantId) {
			const bucket = buckets.get(bucketKey(key, tenantId));
			if (bucket) bucket.bannedUntil = 0;
		},

		// No tenant -> resets all state. Pass a tenant id to drop only that tenant's buckets.
		clear(tenantId) {
			evictCursor = null;
			if (tenantId) {
				const prefix = tenantId + '\0';
				for (const k of buckets.keys()) {
					if (k.startsWith(prefix)) buckets.delete(k);
				}
				return;
			}
			buckets.clear();
			connCounter = 0;
		}
	};
}
