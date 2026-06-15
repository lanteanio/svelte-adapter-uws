import { WS_TOPIC_IDS, WS_WIRE_STATE } from '../utils.js';
import { allocWireId, wireIdAnnounce } from '../wire.js';
import { counters } from './state.js';
import { bumpOut } from './pressure-metrics.js';
import { wsDebug } from './config.js';

/**
 * Resolve (allocating on first use) the per-connection binary topic-id for a
 * topic. On a fresh assignment, announce the `name -> id` mapping to the
 * client in a `{type:'wire-id'}` control frame so an inbound `0x03` frame's
 * numeric id resolves back to the topic name. The announce rides the same
 * socket immediately before the first binary frame for the topic, so ordering
 * guarantees the client records the mapping first - no ack/frame race.
 * Per-connection and reset on reconnect (a reconnect is a new connection with
 * fresh userData).
 *
 * Returns -1 when the announce frame itself was dropped by backpressure
 * (ws.send returned 2): the client never learns the mapping, and the mapping
 * is never re-announced, so every later binary frame for this topic would be
 * undecodable on this connection. Callers must send the JSON envelope for the
 * current frame and poison the capability (see poisonWireState). A send
 * result of 0 (enqueued behind backpressure) still delivers in order and is
 * success here; only 2 is a drop.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {string} topic
 * @returns {number} the topic id, or -1 when the announce was dropped
 */
export function ensureWireId(ws, ud, topic) {
	const { id, isNew } = allocWireId(ud, WS_TOPIC_IDS, topic);
	if (isNew) {
		const announce = wireIdAnnounce(topic, id);
		let result;
		try { result = ws.send(announce, false, false); } catch { counters.closedWsAborts++; return id; }
		if (result === 2) return -1;
		bumpOut(ws, announce);
	}
	return id;
}

/**
 * Resolve (allocating on first use) the per-connection state object for a
 * stateful wire codec, stored under the codec's capability in the
 * `WS_WIRE_STATE` slot. The codec's `wire.state.onAttach(ws)` factory runs once
 * per (connection, capability) - the decision it makes (e.g. which schema
 * version this connection negotiated, read from its `WS_CAPS`) is then fixed for
 * the life of the connection. A factory that throws or returns null degrades
 * that connection to JSON for the frame rather than crashing the publish.
 * Returns null for a stateless codec (no `wire.state`), on attach failure, or
 * for a poisoned capability (see poisonWireState) - a poisoned entry holds a
 * null state and is never re-attached for the life of the connection.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {{ capability: string, state?: { onAttach: (ws: any) => any, onDetach?: (ws: any, state: any) => void } }} wire
 * @returns {any}
 */
export function ensureWireState(ws, ud, wire) {
	if (!wire.state) return null;
	let m = ud[WS_WIRE_STATE];
	if (!m) {
		m = new Map();
		ud[WS_WIRE_STATE] = m;
	}
	let entry = m.get(wire.capability);
	if (entry === undefined) {
		let state = null;
		try {
			state = wire.state.onAttach(ws);
		} catch (err) {
			if (wsDebug) console.error('[ws] wire.state.onAttach threw for', wire.capability, err);
			state = null;
		}
		entry = { state, detach: wire.state.onDetach };
		m.set(wire.capability, entry);
	}
	return entry.state;
}

/**
 * True when this connection's wire for a capability was degraded to JSON by
 * poisonWireState. Checked wherever a binary form would otherwise be chosen
 * for the capability; reads a symbol slot plus one Map entry, so the check is
 * free for connections that were never poisoned.
 * @param {any} ud - ws.getUserData()
 * @param {string} capability
 * @returns {boolean}
 */
export function wireStatePoisoned(ud, capability) {
	const m = ud[WS_WIRE_STATE];
	if (!m) return false;
	const entry = m.get(capability);
	return entry !== undefined && entry.poisoned === true;
}

/**
 * Permanently degrade this connection's wire for one capability to JSON
 * (until reconnect). uWS silently drops a frame past maxBackpressure (send
 * returns 2), and a stateful codec mutates its per-connection encoder state
 * DURING encode (interns dictionary keys, advances delta baselines) - so a
 * dropped frame leaves the client decoder desynced forever: later refs to a
 * never-announced key decode to null (the entity freezes on that connection)
 * and later delta stamps skew. JSON is the recovery tier because dictionary
 * state cannot be resynchronized in-band; the shared envelope carries full
 * keys and absolute values, so the connection stays correct, just
 * unoptimized. Reconnect restores binary: a reconnect is a new connection
 * with fresh userData, a fresh dictionary, and a fresh announce.
 *
 * Disposes the codec's state via its onDetach (exactly once - the sentinel
 * left behind carries no detach, so the close-time sweep skips it), then
 * installs a poisoned entry so ensureWireState returns null and every
 * publish/send path routes the capability to the JSON envelope.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {string} capability
 */
export function poisonWireState(ws, ud, capability) {
	let m = ud[WS_WIRE_STATE];
	if (!m) {
		m = new Map();
		ud[WS_WIRE_STATE] = m;
	}
	const entry = m.get(capability);
	if (entry !== undefined && entry.poisoned === true) return;
	if (entry && typeof entry.detach === 'function') {
		try { entry.detach(ws, entry.state); } catch (err) {
			if (wsDebug) console.error('[ws] wire.state.onDetach threw', err);
		}
	}
	m.set(capability, { state: null, detach: undefined, poisoned: true });
	if (wsDebug) console.log('[ws] wire degraded to JSON for %s (frame dropped by backpressure)', capability);
}

/**
 * Dispose every per-connection wire-codec state on close. Mirrors the
 * `capCounts.adjust(..., null)` release: a codec that holds resources (or just
 * wants its dictionary freed promptly) gets its `onDetach(ws, state)` called
 * exactly once. Safe to call when no stateful codec ever ran.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 */
export function detachWireStates(ws, ud) {
	const m = ud[WS_WIRE_STATE];
	if (!m) return;
	for (const entry of m.values()) {
		if (entry && typeof entry.detach === 'function') {
			try { entry.detach(ws, entry.state); } catch (err) {
				if (wsDebug) console.error('[ws] wire.state.onDetach threw', err);
			}
		}
	}
	m.clear();
}
