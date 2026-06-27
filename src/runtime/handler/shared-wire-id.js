// Server-wide wire-id table for shared binary fan-out. A stateless codec marked
// `shared: true` (the mega-lobby world-snapshot tier) is fanned out via cohort uWS
// topics so one publish is two native app.publish calls instead of a per-connection
// walk - which only works if every binary subscriber's 0x03 frame is BYTE-IDENTICAL.
// The only per-connection-varying byte in a stateless frame is the topic-id varint,
// so a shared topic gets ONE id server-wide here, announced to each binary client on
// its cohort subscribe.
//
// Id-space partition: the per-connection allocator (wire.js allocWireId) hands out
// ids 1, 2, 3... and NEVER reclaims them - the counter is monotonic, one id per
// distinct topic a connection has ever been sent a binary frame for. A connection
// that is on both ordinary (per-connection-id) topics and shared (global-id) topics
// keeps ONE id -> topic map, so the two id spaces MUST stay disjoint or the client
// resolves the wrong topic. Global ids therefore start at SHARED_WIRE_ID_BASE = 2^32:
// for a per-connection counter to reach that it would need 2^32 live `byName` Map
// entries (~hundreds of GB), exhausting the worker heap long before - so a
// per-connection id can never reach a shared one. (The varint encodes the full value
// with division/multiplication, so a 5-byte id round-trips exactly; the few extra
// header bytes are paid only by the shared tier, against a large snapshot payload.)
// A reclaim-on-unsubscribe free-list for the per-connection allocator would bound the
// counter to the concurrent-subscription cap and make the partition provable rather
// than heap-bounded; it touches the hot per-connection wire path and is deferred.

// First global id. Far above any per-connection id could reach before the worker
// heap is exhausted (the per-connection allocator is monotonic + unreclaimed); also
// well above MAX_SUBSCRIPTIONS_PER_CONNECTION, the concurrent-subscription cap.
export const SHARED_WIRE_ID_BASE = 0x100000000; // 2^32

/**
 * Create an isolated server-wide wire-id table: capability-agnostic topic -> id with
 * a cohort refcount. The real handler uses ONE process/worker-global instance (a
 * client only ever talks to its home worker); the in-process test harness creates one
 * PER server so two test servers never co-mingle ids or refcounts.
 * @returns {{ acquire(topic: string): number, release(topic: string): void, get(topic: string): (number | undefined), reset(): void }}
 */
export function createSharedWireIdTable() {
	/** @type {Map<string, { id: number, refs: number }>} */
	const byTopic = new Map();
	// Monotonic allocator. Never reuses a retired id within a process, so a client
	// still holding a stale announce can never have it re-point to a new topic.
	let nextId = SHARED_WIRE_ID_BASE;
	return {
		acquire(topic) {
			let entry = byTopic.get(topic);
			if (entry === undefined) { entry = { id: nextId++, refs: 0 }; byTopic.set(topic, entry); }
			entry.refs++;
			return entry.id;
		},
		release(topic) {
			const entry = byTopic.get(topic);
			if (entry === undefined) return;
			if (--entry.refs <= 0) byTopic.delete(topic);
		},
		get(topic) {
			const entry = byTopic.get(topic);
			return entry === undefined ? undefined : entry.id;
		},
		reset() { byTopic.clear(); nextId = SHARED_WIRE_ID_BASE; }
	};
}

// Process/worker-global default table for the real handler (one server per worker).
const _default = createSharedWireIdTable();

/**
 * Acquire (allocating on first use) the server-wide wire-id for a shared topic and
 * increment its cohort refcount. Call once per connection that joins the topic's
 * binary cohort; pair with releaseSharedWireId when it leaves (or on close).
 * @param {string} topic
 * @returns {number}
 */
export const acquireSharedWireId = _default.acquire;
/**
 * Release one cohort reference; reclaims the entry (retires the id) on the last one.
 * Safe to call for a topic with no entry.
 * @param {string} topic
 */
export const releaseSharedWireId = _default.release;
/**
 * The server-wide wire-id currently assigned to a shared topic, or undefined when it
 * has no live binary cohort (the publish then skips the binary fan-out).
 * @param {string} topic
 * @returns {number | undefined}
 */
export const getSharedWireId = _default.get;
/** Test seam: clear the default table and reset its allocator. @internal */
export const _resetSharedWireIds = _default.reset;
