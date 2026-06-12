/**
 * Deterministic randomness for predicted commands.
 *
 * A command that draws randomness must draw the SAME value everywhere the
 * command is applied: on the client's first prediction, on every client
 * replay during reconciliation, and on the server's authoritative apply.
 * Anything else turns every randomised command into a guaranteed
 * misprediction. The contract that makes this hold is seeding: the generator
 * is reseeded from the command's id immediately before each application, so
 * the same command always replays the same draw sequence no matter how many
 * times, or on which side, it runs.
 *
 * Calling `Math.random()` inside an apply function is the documented mistake:
 * it breaks the parity between prediction and authority that reconciliation
 * depends on.
 *
 * The generator is a mulberry32 stream over a golden-ratio-scrambled seed:
 * pure 32-bit integer arithmetic, identical results in every JS engine, a
 * few nanoseconds per draw. One instance is created per consumer and reseeded
 * per command, so the replay loop allocates nothing.
 *
 * Pure: no clocks, no timers, no imports, no global state.
 *
 * @module svelte-adapter-uws/plugins/smooth/random
 */

/**
 * Create a reseedable deterministic generator.
 *
 * @param {number} [seed] initial seed; a consumer that always reseeds per
 *   command may omit it.
 */
export function createSharedRandom(seed = 0) {
	// The raw seed is scrambled with the 32-bit golden-ratio constant so the
	// small sequential integers command ids produce still start well-mixed
	// streams (consecutive ids must not yield correlated first draws).
	let s = (seed ^ 0x9e3779b9) >>> 0;

	function nextU32() {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	}

	return {
		/**
		 * Restart the stream from a new seed. Called with the command id
		 * before each application so predict, replay, and authority draw
		 * identically.
		 * @param {number} next
		 */
		reseed(next) {
			s = (next ^ 0x9e3779b9) >>> 0;
		},

		/** A draw in [0, 1), uniform over 2^32 steps. */
		float() {
			return nextU32() / 4294967296;
		},

		/** A draw over the full unsigned 32-bit range. */
		u32() {
			return nextU32();
		}
	};
}
