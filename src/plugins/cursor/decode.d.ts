/**
 * State the cursor store merge operates on: three Maps keyed by connection key.
 */
export interface CursorState {
	/** key -> latest position data (from `update` / `bulk`). */
	positionMap: Map<string, unknown>;
	/** key -> user metadata (from `catalog` / `join`). */
	userMap: Map<string, unknown>;
	/** key -> last-position timestamp in ms (for the maxAge sweep). */
	timestamps: Map<string, number>;
}

/**
 * Apply one decoded cursor `{ event, data }` to `state`, mutating its Maps in
 * place. Returns `true` when the merged output may have changed (re-emit) and
 * `false` for a no-op event. The wire decode (frame bytes -> `{ event, data }`)
 * is owned by `decodeCursor` in `./codec`; this consumes the decoded shape.
 *
 * @param state the store's `{ positionMap, userMap, timestamps }`
 * @param event a decoded cursor frame, or `null` for a no-op
 * @param now timestamp stamped onto positions; defaults to `Date.now()`
 */
export function applyEvent(
	state: CursorState,
	event: { event: string; data: unknown } | null,
	now?: number
): boolean;

/**
 * Build the public output Map from `state`: a `Map<key, { user, data }>` that
 * skips any position whose user has not yet been seen via `catalog` / `join`.
 */
export function mergeOutput(
	state: CursorState
): Map<string, { user: unknown; data: unknown }>;

/**
 * Drop entries whose last position is older than `maxAge` ms, mutating
 * `state`'s Maps in place. Returns `true` when a position was removed. A
 * non-positive `maxAge` is a no-op.
 *
 * @param state the store's `{ positionMap, userMap, timestamps }`
 * @param maxAge expiry window in ms
 * @param now current time; defaults to `Date.now()`
 */
export function sweepExpired(state: CursorState, maxAge: number, now?: number): boolean;
