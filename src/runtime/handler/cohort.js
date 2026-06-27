// Cohort membership for shared binary fan-out. A topic published through a
// `shared: true` stateless codec splits its subscribers into two uWS cohort topics
// so one publish is two native app.publish calls instead of a per-connection walk:
// binary-capable clients receive the byte-identical 0x03 frame on `topic\0bin`,
// JSON-only clients receive the envelope on `topic\0json`. The logical `topic` stays
// the WS_SUBSCRIPTIONS anchor (and still carries any ordinary, non-shared publish);
// each client is on `topic` plus exactly one cohort. `\0` can never appear in a user
// topic (isValidWireTopic rejects control bytes), so a cohort name cannot collide
// with a real topic, and the cohort subscriptions are deliberately kept out of
// WS_SUBSCRIPTIONS - they are a transport detail, not logical membership.

import { WS_CAPS, WS_SHARED_COHORTS } from '../utils.js';
import { wireIdAnnounce } from '../wire.js';
import { counters } from './state.js';
import { bumpOut } from './pressure-metrics.js';
import { wireStatePoisoned } from './wire-state.js';
import { acquireSharedWireId, releaseSharedWireId } from './shared-wire-id.js';

/**
 * The two cohort topic names for a shared logical topic.
 * @param {string} topic
 * @returns {{ bin: string, json: string }}
 */
export function cohortTopics(topic) {
	return { bin: topic + '\0bin', json: topic + '\0json' };
}

/**
 * Subscribe a connection to the cohort matching its capabilities for a shared topic,
 * exactly once per (connection, topic). A binary-capable, un-poisoned connection is
 * announced the topic's server-wide wire-id and joins the binary cohort; everyone
 * else joins the JSON cohort. A dropped announce (the client could never resolve the
 * shared id, so the binary frame would be undecodable) demotes the connection to the
 * JSON cohort and releases the id reference it would have held - mirroring the
 * per-connection wire path's announce-drop handling, minus the poison (a stateless
 * shared frame carries no per-connection state, so a later reconnect re-announces
 * cleanly).
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {string} topic
 * @param {string} capability
 */
export function joinSharedCohort(ws, ud, topic, capability) {
	const { bin, json } = cohortTopics(topic);
	const caps = ud[WS_CAPS];
	if (caps && caps.has(capability) && !wireStatePoisoned(ud, capability)) {
		const id = acquireSharedWireId(topic);
		const announce = wireIdAnnounce(topic, id);
		let result;
		try { result = ws.send(announce, false, false); }
		catch { counters.closedWsAborts++; releaseSharedWireId(topic); return; }
		if (result === 2) {
			// Dropped announce: undo the reference and serve this connection JSON.
			releaseSharedWireId(topic);
			try { ws.subscribe(json); } catch { counters.closedWsAborts++; }
			return;
		}
		bumpOut(ws, announce);
		let cohorts = ud[WS_SHARED_COHORTS];
		if (!cohorts) { cohorts = new Set(); ud[WS_SHARED_COHORTS] = cohorts; }
		cohorts.add(topic);
		try { ws.subscribe(bin); } catch { counters.closedWsAborts++; }
	} else {
		try { ws.subscribe(json); } catch { counters.closedWsAborts++; }
	}
}

/**
 * Remove a connection from both cohorts of a shared topic and release its binary-
 * cohort wire-id reference if it held one. Unsubscribing the cohort the connection is
 * not on is a harmless no-op, so no per-connection cohort-side bookkeeping is needed
 * beyond the WS_SHARED_COHORTS ref set. Called on explicit unsubscribe; on close, uWS
 * drops the cohort subscriptions natively and only the ref needs releasing.
 * @param {import('uWebSockets.js').WebSocket<any>} ws
 * @param {any} ud - ws.getUserData()
 * @param {string} topic
 */
export function leaveSharedCohort(ws, ud, topic) {
	const { bin, json } = cohortTopics(topic);
	try { ws.unsubscribe(bin); } catch { counters.closedWsAborts++; }
	try { ws.unsubscribe(json); } catch { counters.closedWsAborts++; }
	const cohorts = ud[WS_SHARED_COHORTS];
	if (cohorts && cohorts.delete(topic)) releaseSharedWireId(topic);
}
