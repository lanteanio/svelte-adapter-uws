import type { Platform } from '../../index.js';
import type { WebSocket } from 'uWebSockets.js';

export interface PresenceOptions<UserData = unknown, Selected extends Record<string, any> = Record<string, any>> {
	/**
	 * Field in the selected data that uniquely identifies a user.
	 * Used for multi-tab dedup: if two connections share the same key value,
	 * they count as one presence entry. The second tab bumps a ref count
	 * instead of adding a duplicate.
	 *
	 * If the field is missing from the data, each connection is tracked separately.
	 *
	 * @default 'id'
	 */
	key?: keyof Selected & string;

	/**
	 * Extract the public presence data from a connection's userData.
	 * Only the returned fields are broadcast to other clients.
	 *
	 * By default, only the configured {@link PresenceOptions.key} field is
	 * copied, and only when the field name is structurally safe and its value is
	 * a string or finite number. Names, avatars, profiles, transport metadata
	 * and every other field require an explicit `select` allowlist.
	 *
	 * The sensitive-name guard covers the {@link PresenceOptions.key} field too, with no
	 * exemption: the resolved dedup key becomes the roster key in every wire
	 * frame, so a credential-shaped one must not survive the projection.
	 * Nominating `key: 'sessionId'` warns at construction and falls back to
	 * per-connection entries (no multi-tab dedup) rather than broadcasting the
	 * value - dedup on a non-secret identifier, or pass an explicit `select`.
	 *
	 * The cursor plugin follows the same fail-closed rule, with `id` as its sole
	 * default identity field.
	 * An explicit selector is an application-owned policy override and its
	 * return value is used as-is. Prefer an allowlist such as
	 * `select: (ud) => ({ id: ud.id, name: ud.name })`.
	 *
	 * Should return JSON-serializable data (plain objects, arrays, strings,
	 * numbers, booleans, null) since the result is sent over WebSocket.
	 *
	 * @example
	 * ```js
	 * // Custom allowlist - useful when you want strict control over what is shared
	 * select: (userData) => ({ id: userData.id, name: userData.name, avatar: userData.avatar })
	 * ```
	 */
	select?: (userData: UserData) => Selected;

	/**
	 * Interval in milliseconds between heartbeat broadcasts.
	 *
	 * The server periodically publishes a `heartbeat` event to all presence
	 * topics carrying a `{userKey: data}` map of every active user. This
	 * refreshes each entry's `maxAge` timer on the client AND re-adds any
	 * entry the client swept while the user was still present, so live
	 * users do not flicker out when a `diff` is missed (transient
	 * network blip, JS thread saturation).
	 *
	 * Set this to a value shorter than the client's `maxAge`. The 30 s
	 * default fits the 90 s default client `maxAge` with a 3x safety
	 * margin.
	 *
	 * Pass `0` to disable heartbeats entirely. That is not only a traffic
	 * decision: presence diffs carry no sequence, so the heartbeat is the
	 * only thing that re-establishes a roster mid-session. With `0`, a
	 * missed `join` or `leave` diverges silently until the client rejoins,
	 * and a client still running the default `maxAge` sweep empties its
	 * roster roughly 135 s after the last diff even when nothing was
	 * dropped - the sweep has no counterpart that restores an entry. The
	 * opt-out is complete only when clients also pass `maxAge: 0`;
	 * `createPresence` warns once per process when it sees `heartbeat: 0`.
	 *
	 * @default 30000
	 *
	 * @example
	 * ```js
	 * // Slower heartbeat (less wire traffic, larger window for ghost entries)
	 * const presence = createPresence({ heartbeat: 60_000 });
	 * ```
	 *
	 * @example
	 * ```js
	 * // No heartbeat: pair it with maxAge: 0 on every client, or their
	 * // rosters decay to empty on their own.
	 * const presence = createPresence({ heartbeat: 0 });
	 * // client: presence('room', { maxAge: 0 })
	 * ```
	 */
	heartbeat?: number;

	/**
	 * Hard cap on tracked connections. When the cap is reached, the
	 * oldest insertion-order connection state is dropped on the next
	 * `join()` for a new ws. In practice eviction is rare because user
	 * code is expected to call `leave(ws)` on disconnect.
	 *
	 * @default 1_000_000
	 */
	maxConnections?: number;

	/**
	 * Hard cap on the active topic registry. When the cap is reached,
	 * the oldest insertion-order topic is dropped on the next `join()`
	 * for a new topic.
	 *
	 * @default 1_000_000
	 */
	maxTopics?: number;

	/**
	 * Binary wire transport for presence frames.
	 *
	 * When `true` (the default), a binary-capable client (one that advertised
	 * `presence.protocol:1`) receives compact `0x03` frames encoded by the
	 * presence codec, and every other client - plus any platform without the
	 * `publishWire`/`sendWire` methods - receives the identical JSON frames.
	 * Fully transparent: the client `presence()` store decodes binary frames back
	 * to the same `{ event, data }` the JSON path produced.
	 *
	 * The codec is stateless: a roster frame is encoded once and fanned out to
	 * all subscribers (encode-once-send-many), which suits presence's
	 * infrequent-but-full-roster broadcasts.
	 *
	 * Set `false` to force JSON for every client - useful to compare wire sizes
	 * or on a platform whose binary methods you do not want exercised.
	 *
	 * @default true
	 */
	binary?: boolean;

	/**
	 * Dynamic field names (set via {@link PresenceTracker.update}) that are
	 * broadcast live but NEVER included in the `state` snapshot or the heartbeat
	 * roster. A (re)joining or swept-then-readded client therefore never inherits
	 * a possibly-stale transient value - a disconnected typer leaves no stuck
	 * indicator. Identity fields (from `select`) and durable `update()` fields not
	 * listed here ride the snapshot normally.
	 *
	 * @example
	 * ```js
	 * const presence = createPresence({ transient: ['typing', 'selection'] });
	 * ```
	 *
	 * @default [] // every update() field is durable
	 */
	transient?: string[];

	/**
	 * Minimum gap in milliseconds between two diff publishes for a topic.
	 *
	 * The byte caps bound how much dynamic state a user can retain; this bounds
	 * how often it is fanned out to every topic subscriber. The default caps a
	 * topic at roughly 60 diff publishes per second. Pass `0` to coalesce only
	 * within the current event-loop iteration and publish on the next tick.
	 *
	 * @default 16
	 */
	topicThrottle?: number;

	/**
	 * Maximum serialized size (bytes) of one `update()` fields blob.
	 *
	 * An over-cap (or unserializable) update is silently dropped - presence is
	 * best-effort fire-and-forget, mirroring the cursor plugin's `maxDataBytes`
	 * (same default, same behavior). Legitimate presence fields are small
	 * (a typing flag, a selection range), so the default is never reached in
	 * practice.
	 *
	 * @default 8192
	 */
	maxFieldsBytes?: number;

	/**
	 * Cumulative serialized-size budget (bytes) for one user's durable
	 * `update()` fields on a topic.
	 *
	 * Durable fields ride every future `state` snapshot and heartbeat, so the
	 * per-frame `maxFieldsBytes` cap alone would still let a client accumulate
	 * unbounded stored state (and unbounded snapshot fan-out) one small frame
	 * at a time. An update that would exceed the budget is dropped whole -
	 * no partial merge.
	 *
	 * @default 65536
	 */
	maxTotalFieldsBytes?: number;

	/**
	 * Maximum number of presence topics tracked for one connection.
	 *
	 * `maxTotalFieldsBytes` is a per-topic/user budget. Without a separate
	 * membership cap, one connection could multiply that budget by the global
	 * one-million-topic registry limit. At the defaults, the two options bound
	 * one connection's retained dynamic fields to about 6.25 MiB. A join beyond
	 * this cap is a silent no-op.
	 *
	 * @default 100
	 */
	maxTopicsPerConnection?: number;

	/**
	 * Allowlist for dynamic fields accepted from wire `presence-update` frames.
	 *
	 * Unset (the default), client frames cannot add any durable or transient
	 * fields. Set this to accept only the listed names. Listing a reserved name
	 * is a deliberate application policy decision; prototype gadget names are
	 * always removed from the allowlist.
	 *
	 * Direct server calls to {@link PresenceTracker.update} retain the existing
	 * reserved-name guard when this option is omitted. When configured, the same
	 * allowlist also applies to direct calls.
	 *
	 * @example
	 * ```js
	 * const presence = createPresence({ clientUpdateFields: ['typing', 'selection'] });
	 * ```
	 *
	 * @default undefined // wire presence-update frames accept no fields
	 */
	clientUpdateFields?: string[];
}

export interface PresenceTracker<Selected extends Record<string, any> = Record<string, any>> {
	/**
	 * Add a connection to a topic's presence list.
	 *
	 * Call this from your `subscribe` hook. Automatically ignores `__`-prefixed
	 * internal topics (prevents recursion). Idempotent - calling twice for the
	 * same ws + topic is a no-op.
	 *
	 * What happens:
	 * 1. Adds the user to the topic's presence map
	 * 2. Buffers a `join` entry into the next diff broadcast (microtask-flushed)
	 * 3. Subscribes this ws to the presence channel
	 * 4. Sends the full current snapshot (`state`) to this ws
	 *
	 * @example
	 * ```js
	 * export function subscribe(ws, topic, { platform }) {
	 *   presence.join(ws, topic, platform);
	 * }
	 * ```
	 */
	join(ws: WebSocket<any>, topic: string, platform: Platform): void;

	/**
	 * Remove a connection from all topics.
	 *
	 * Call this from your `close` hook. Handles multi-tab correctly:
	 * if the user has other connections still open, they stay present.
	 * Only buffers a `leave` entry into the next diff when the
	 * last connection closes.
	 *
	 * @example
	 * ```js
	 * export function close(ws, { platform }) {
	 *   presence.leave(ws, platform);
	 * }
	 * ```
	 */
	leave(ws: WebSocket<any>, platform: Platform): void;

	/**
	 * Send the current presence snapshot (`state`) to a connection without joining.
	 *
	 * Use this for observers (admin dashboards, spectators) who want to
	 * see who's present without being counted as present themselves.
	 *
	 * @example
	 * ```js
	 * export function message(ws, { data, platform }) {
	 *   const msg = JSON.parse(Buffer.from(data).toString());
	 *   if (msg.type === 'observe-presence') {
	 *     presence.sync(ws, msg.topic, platform);
	 *   }
	 * }
	 * ```
	 */
	sync(ws: WebSocket<any>, topic: string, platform: Platform): void;

	/**
	 * Set dynamic fields on the present user as a field-level delta.
	 *
	 * Only fields whose value actually changed are merged into the user and
	 * broadcast in the next `diff` under `updates[key]` - so a typing toggle
	 * sends `{ typing: true }`, not the whole user object. The update applies to
	 * the user (per dedup key), so any of a multi-tab user's connections may call
	 * it and every observer sees one change. A connection that is not present on
	 * the topic is a silent no-op, and an update where no field changed is a
	 * no-op.
	 *
	 * Fields listed in the `transient` option are broadcast live to currently
	 * connected subscribers but excluded from the `state` snapshot and heartbeat,
	 * so a reconnecting client never inherits a stale value. Other `update()`
	 * fields are durable and ride the snapshot.
	 *
	 * This method is the trusted server-side path. Server-reserved field names
	 * (the dedup key field, `id`, `role`, `__`-prefixed, `constructor`,
	 * `prototype`, credential-shaped names) are stripped by default. The
	 * `clientUpdateFields` option replaces that guard with an explicit allowlist
	 * and independently gates wire `presence-update` frames. The whole update is
	 * silently dropped when it exceeds `maxFieldsBytes` or the user's
	 * `maxTotalFieldsBytes` cumulative budget.
	 *
	 * @example
	 * ```js
	 * // a typing indicator that self-heals on reconnect (with `transient: ['typing']`)
	 * presence.update(ws, 'room', { typing: true }, platform);
	 * ```
	 */
	update(ws: WebSocket<any>, topic: string, fields: Record<string, any>, platform: Platform): void;

	/**
	 * Get the current presence list for a topic.
	 *
	 * Each entry is the same shape the `state` snapshot puts on the wire: the
	 * identity produced by `select` plus the durable `update()` fields, minus
	 * anything named in `transient`. An SSR render and the client's first
	 * WebSocket snapshot therefore agree, instead of the page appearing
	 * without typing / selection / lock state until the socket opens.
	 *
	 * Returns deep copies when data is JSON-serializable.
	 * Falls back to shared references for non-cloneable data.
	 *
	 * Use in `load()` functions or API routes for SSR.
	 *
	 * @example
	 * ```js
	 * export async function load() {
	 *   return { users: presence.list('room') };
	 * }
	 * ```
	 */
	list(topic: string): Selected[];

	/**
	 * Get the number of unique users present on a topic.
	 *
	 * @example
	 * ```js
	 * export async function GET({ platform }) {
	 *   return json({ online: presence.count('room') });
	 * }
	 * ```
	 */
	count(topic: string): number;

	/** Clear all presence tracking state. */
	clear(): void;

	/**
	 * Drain any buffered `diff` publishes synchronously.
	 *
	 * Diffs are normally microtask-batched: multiple joins / leaves in the
	 * same tick collapse into one broadcast frame. Tests use this to
	 * assert on the wire output without awaiting the microtask queue.
	 * Production code rarely needs it; useful when a caller must make
	 * presence state visible before its own synchronous block returns.
	 *
	 * No-op when there is nothing buffered.
	 */
	flushDiffs(): void;

	/**
	 * Ready-made WebSocket hooks for zero-config presence.
	 *
	 * `subscribe` handles both regular topics (calls `join`) and `__presence:*`
	 * topics (calls `sync` so the client gets the current snapshot immediately).
	 * `unsubscribe` removes the user from a single topic's presence when the
	 * client unsubscribes without disconnecting.
	 * `message` handles the client's `{type:'presence-snapshot', topic}` reconnect
	 * frame by re-emitting the current `state` via `sync`; it accepts the envelope
	 * pre-parsed (`ctx.msg`, or a parsed object in `ctx.data`) or as raw frame
	 * bytes (`ctx.data`), and returns `true` when it owns the frame (so it can be
	 * chained with the cursor hook through one message handler) and `undefined`
	 * otherwise. Wire `message` into your message hook for late-join / reconnect
	 * snapshots to work (see the destructure example below).
	 *
	 * Authorization note: like `subscribe`, `message` does not gate topic access -
	 * a client can request any topic's roster by sending that topic in the
	 * snapshot frame (the roster only ever carries `select`-stripped public
	 * fields, never credentials). If a topic must be limited to a subset of users,
	 * wrap `message` (or `subscribe`) with your own gate, the same way the
	 * `subscribe` example does.
	 * `close` calls `leave` (removes from all topics).
	 *
	 * @example
	 * ```js
	 * // src/hooks.ws.js
	 * import { presence } from '$lib/server/presence';
	 * export const { subscribe, unsubscribe, message, close } = presence.hooks;
	 * ```
	 */
	hooks: {
		subscribe(ws: WebSocket<any>, topic: string, ctx: { platform: Platform }): void;
		unsubscribe(ws: WebSocket<any>, topic: string, ctx: { platform: Platform }): void;
		message(ws: WebSocket<any>, ctx: { data: ArrayBuffer | Uint8Array | Record<string, any>; msg?: any; platform: Platform }): true | void;
		close(ws: WebSocket<any>, ctx: { platform: Platform }): void;
	};
}

/**
 * Create a presence tracker for real-time "who's online" features.
 *
 * @example
 * ```js
 * import { createPresence } from 'svelte-adapter-uws/plugins/presence';
 *
 * export const presence = createPresence({
 *   key: 'id',
 *   select: (userData) => ({ id: userData.id, name: userData.name })
 * });
 * ```
 */
export function createPresence<UserData = unknown, Selected extends Record<string, any> = Record<string, any>>(
	options?: PresenceOptions<UserData, Selected>
): PresenceTracker<Selected>;

/**
 * Build the presence binary wire codec (`presence.protocol:1`, stateless)
 * without creating a tracker.
 *
 * Exported so a cluster-backed presence backend (e.g.
 * `svelte-adapter-uws-extensions/redis/presence`) builds the IDENTICAL codec
 * from one definition - the in-memory and cluster presence backends never drift
 * on the wire. Hand the result to `platform.publishWire` / `platform.sendWire`.
 *
 * Returns `null` when `binary: false` (JSON for every client). The codec is
 * stateless: one roster frame is encoded once and fanned out to all subscribers.
 *
 * @param options - Only `binary` is read.
 */
export function createPresenceWireCodec(
	options?: Pick<PresenceOptions, 'binary'>
): {
	capability: string;
	schemaVersion: number;
	encode: (event: string, data: unknown, state?: unknown) => Uint8Array | null;
} | null;
