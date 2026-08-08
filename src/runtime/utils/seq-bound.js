// The pure half of the bounded seq-registry design: the factory, its floor
// carry, and the high-water backstop. The design rationale lives with the
// wired singleton in handler/seq-bound.js; this module stays free of the
// runtime graph so unit tests drive it with plain maps and stub probes.

/** How many oldest entries one eviction sweep pass inspects. */
const SCAN_LIMIT = 16;

/**
 * Over-cap inserts waved through after a sweep finds nothing evictable.
 * Small on purpose: it has to amortize the wedged sweep without stalling
 * recovery once the registry becomes evictable again, which on a clustered
 * worker happens as soon as the reporter judges its first topics quiet.
 */
const BLOCKED_BACKOFF = 16;

/**
 * FNV-1a over the topic string, 32-bit. The floor map keys on the hash so an
 * evicted topic costs two numbers, not its name; a collision only merges two
 * floors into their maximum, which inflates and never regresses.
 *
 * @param {string} str
 * @returns {number} unsigned 32-bit hash
 */
export function fnv32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Build a bound over a seq map and its companion seen map. Pure with respect
 * to the supplied structures and probes, so a unit test drives it with plain
 * maps and a stub predicate; the runtime wires the shared registries below.
 *
 * @param {{
 *   seqMap: Map<string, number>,
 *   seenMap: Map<string, number>,
 *   capacity: number,
 *   floorCap: number,
 *   isProtected: (topic: string) => boolean,
 *   onOverCap: (size: number) => void,
 *   scanLimit?: number
 * }} config
 */
export function createSeqBound({ seqMap, seenMap, capacity, floorCap, isProtected, onOverCap, scanLimit = SCAN_LIMIT }) {
	/** @type {Map<number, number>} fnv32(topic) -> highest evicted counter */
	const floors = new Map();
	// Installed by the cross-worker reporter when it runs; see the quiet-lane
	// note on evictOldestUnprotected. Null on a worker with no sibling.
	let quietProbe = null;
	// The backstop for everything the floor map can no longer name: the
	// highest COUNTER any forgotten topic reached. It is one number, it only
	// ever rises, and it is the reason eviction can never corrupt a resuming
	// client - see the tier note in handler/seq-bound.js.
	let highWater = 0;
	// Over-cap inserts still to wave through before the next sweep attempt,
	// counted PER LANE so a wedge in one registry does not suppress sweeps in
	// the other. A sweep that comes back empty is the expensive one - two
	// full windows of judgments plus their rotations - and if that registry
	// is genuinely wedged (everything subscribed, or nothing judged quiet
	// yet) the NEXT insert would pay it again for the same answer. Backing
	// off makes that cost amortized instead of per-insert; the price is at
	// most this many extra entries above the ceiling before the sweep runs
	// again, which is noise against the arrival overshoot already documented
	// for a clustered worker.
	let blockedSkipSeq = 0;
	let blockedSkipSeen = 0;

	function recordFloor(topic, lastSeq) {
		const key = fnv32(topic);
		const prev = floors.get(key);
		if (prev === undefined || lastSeq > prev) floors.set(key, lastSeq);
		if (floors.size > floorCap) {
			// Absorb every carried floor into the scalar BEFORE dropping the
			// map: the exact per-topic floors are a memory optimisation, and
			// the high-water mark is what keeps the guarantee once they are
			// gone. Every floor here is counter-derived (see evict), so the
			// mark stays inside this worker's own numbering and no counter
			// can repeat a number an evicted topic already used.
			for (const value of floors.values()) {
				if (value > highWater) highWater = value;
			}
			floors.clear();
		}
	}

	/**
	 * Forget one topic in both registries, carrying its counter forward.
	 * Deleting from the seen map in the same breath is what keeps the two
	 * registries' memberships from drifting as the bound works.
	 */
	function evict(topic) {
		const last = seqMap.get(topic);
		if (last !== undefined) {
			// The COUNTER value only, never the observed one. What this floor
			// protects is the numbering this worker itself issues; an
			// externally-authored seq recorded for the same topic belongs to
			// an authority that keeps issuing its own numbers wherever it
			// lives, and is not this bound's to preserve. Carrying it would
			// also leak that seq space into the worker-wide mark and start
			// every future topic near it - five varint bytes per frame
			// instead of one, on every topic, to protect a client that a
			// local counter could never have served correctly anyway.
			recordFloor(topic, last);
			seqMap.delete(topic);
		}
		// A topic present only in the observed map has no counter of this
		// worker's to protect at all, so it records no floor.
		seenMap.delete(topic);
	}

	/**
	 * Sweep the front of `from` for a victim that is neither the entry just
	 * admitted, nor busy, nor protected, and evict it. Returns false when the
	 * bounded sweep found nothing evictable, which the caller answers by
	 * admitting over the cap rather than taking a watermark someone is using.
	 *
	 * Two judgments pass a candidate over:
	 *
	 * - The quiet probe answers POSITIVELY - "the reporter has classified
	 *   this topic as quiet" - and anything else, including a topic the
	 *   reporter has never judged, is left alone. Forgetting a BUSY topic is
	 *   what a sibling worker reads as a one-sided ACTIVE-lane disagreement,
	 *   and the active lane is the one that carries restart authority, so
	 *   under sustained cap pressure that would drive a kill loop. A negated
	 *   is-it-active test would read an unjudged topic as evictable, and a
	 *   busy topic first inserted between two reporter ticks is exactly that:
	 *   evicted on sight, re-learned, evicted again - the same loop with
	 *   extra steps.
	 * - `isProtected` covers live subscribers and open resume buffers.
	 *
	 * Everything passed over is ROTATED TO THE TAIL, which is what makes the
	 * sweep a sweep. Insertion order is not recency: a topic inserted long
	 * ago and republished every tick sits at the head while being the busiest
	 * topic on the worker. A scan that restarted at the head each time would
	 * re-judge that same unevictable prefix forever - sixteen long-lived busy
	 * topics would nail the window shut and the registries would grow without
	 * limit, which is precisely the failure this bound exists to prevent.
	 * Rotating turns the fixed window into a revolving one, so every entry is
	 * eventually judged, and the order the sweep leaves behind is
	 * least-recently-passed-over rather than oldest-inserted. Registry order
	 * is not observable: the state hash folds entries commutatively and the
	 * activity partition is order-insensitive.
	 */
	function evictOldestUnprotected(from, admitted) {
		// Two passes, because one is not enough on the tick where the
		// unevictable block happens to be sitting at the head: that pass
		// spends its whole budget rotating the block away and would otherwise
		// admit over the cap even though an evictable topic was waiting right
		// behind it. The second pass sees the rotated order and takes it. If
		// BOTH passes come back empty the worker really is holding at least
		// two windows' worth of busy or subscribed topics, and admitting over
		// the cap with a warning is the correct answer.
		for (let pass = 0; pass < 2; pass++) {
			let scanned = 0;
			let victim;
			/** @type {string[]} */
			const passedOver = [];
			for (const candidate of from.keys()) {
				if (candidate === admitted) continue;
				if (++scanned > scanLimit) break;
				if ((quietProbe !== null && !quietProbe(candidate)) || isProtected(candidate)) {
					passedOver.push(candidate);
					continue;
				}
				victim = candidate;
				break;
			}
			// Rotated after the walk, never during it, so the iteration
			// cannot revisit an entry it has already judged.
			for (const topic of passedOver) {
				const value = from.get(topic);
				if (value !== undefined) {
					from.delete(topic);
					from.set(topic, value);
				}
			}
			if (victim !== undefined) {
				evict(victim);
				return true;
			}
			if (passedOver.length === 0) break;
		}
		return false;
	}

	return {
		/** @param {string} topic @returns {number} carried resume floor, 0 when none */
		floorOf(topic) {
			const exact = floors.size === 0 ? undefined : floors.get(fnv32(topic));
			return exact !== undefined && exact > highWater ? exact : highWater;
		},

		/**
		 * Enforce the cap after a NEW topic entered the seq map.
		 * @param {string} topic the entry just admitted - never the victim
		 */
		onInsert(topic) {
			if (capacity === 0 || seqMap.size <= capacity) return;
			if (blockedSkipSeq > 0) {
				blockedSkipSeq--;
				onOverCap(seqMap.size);
				return;
			}
			if (!evictOldestUnprotected(seqMap, topic)) {
				blockedSkipSeq = BLOCKED_BACKOFF;
				onOverCap(seqMap.size);
			}
		},

		/**
		 * Enforce the cap after a NEW topic entered the seen map (relay
		 * receive, numeric-authority publish). The seen map is the wider of
		 * the two - every counter topic also has a seen entry - so its scan
		 * takes counter topics as victims too, through the same protected
		 * eviction that carries their floor. A scan that could only skip them
		 * would jam behind the counter topics at the head of insertion order
		 * and leave this registry effectively unbounded.
		 * @param {string} topic the entry just admitted - never the victim
		 */
		onSeenInsert(topic) {
			if (capacity === 0 || seenMap.size <= capacity) return;
			if (blockedSkipSeen > 0) {
				blockedSkipSeen--;
				onOverCap(seenMap.size);
				return;
			}
			if (!evictOldestUnprotected(seenMap, topic)) {
				blockedSkipSeen = BLOCKED_BACKOFF;
				onOverCap(seenMap.size);
			}
		},

		/**
		 * Install the reporter's quiet-lane judgment as an eviction guard.
		 * Called once by the cross-worker state reporter when it starts,
		 * because only the reporter knows which topics it has classified
		 * quiet, and only a clustered worker has a sibling that could
		 * disagree about them.
		 * @param {(topic: string) => boolean} probe true only when the
		 *   reporter has positively judged this topic quiet
		 */
		useQuietProbe(probe) {
			quietProbe = probe;
		},

		/** @returns {number} the forgotten-counter high-water mark; test and diagnostics surface */
		highWaterMark() {
			return highWater;
		},

		/** @returns {number} floor entries held; test and diagnostics surface */
		floorSize() {
			return floors.size;
		}
	};
}
