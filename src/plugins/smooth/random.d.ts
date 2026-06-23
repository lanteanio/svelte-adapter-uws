/**
 * Deterministic reseedable randomness for predicted commands. Reseeded from a
 * command id before each application, so randomness drawn in `apply` is
 * identical on the client's prediction, every reconciliation replay, and the
 * server's authority. Exposed here as its own dependency-free subpath so an app
 * can draw the same reproducible randomness outside `apply` - world generation,
 * spawns, deterministic tests - without pulling in the smooth runtime.
 *
 * @module svelte-adapter-uws/plugins/smooth/random
 */

/** A reseedable deterministic generator: the same seed yields the same draws. */
export interface SharedRandom {
	/** Restart the stream from a new seed. */
	reseed(seed: number): void;
	/** A draw in [0, 1). */
	float(): number;
	/** A draw over the full unsigned 32-bit range. */
	u32(): number;
}

/**
 * Create a reseedable deterministic generator. A consumer that always reseeds
 * per command may omit the initial seed.
 */
export function createSharedRandom(seed?: number): SharedRandom;
