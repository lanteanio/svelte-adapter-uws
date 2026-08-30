// @ts-check
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from './error-registry.js';

/**
 * May the primary hand relay traffic to this peer? One predicate for every
 * fan-out lane - the ring forward loop and all three postMessage forwards -
 * so a quarantined worker stops receiving relay traffic everywhere at once.
 * Before this existed only the ring loop consulted the flag, and the
 * encode-failure fallbacks kept feeding a worker already being torn down.
 * @param {{ relayQuarantined: boolean }} meta
 */
export function relayEligible(meta) {
	return !meta.relayQuarantined;
}

/**
 * May the primary write relay bytes into this peer's RING? Everything
 * `relayEligible` asks, plus: has the worker reported its reader live?
 *
 * The ring lane needs the extra question and the postMessage lane must NOT
 * have it. A worker buffers control-lane messages that arrive during boot and
 * replays them in arrival order once its handler graph is up, so a postMessage
 * relay reaches a booting worker intact - and with `CLUSTER_RELAY_RING_KB=0`
 * that lane is the only one there is. The ring has no such replay: bytes
 * written before the reader starts just sit there, and a spill built out of
 * them reads to the age ceiling - a STALL detector - as a worker that stopped
 * draining, which quarantined the still-booting worker into a respawn that
 * landed in the same window, up to restart-limit exhaustion and a whole-process
 * exit. Skipping it costs that worker nothing it was owed: it treats everything
 * from before its attach as a stream it joined mid-flight.
 *
 * @param {{ relayQuarantined: boolean, relayAttached: boolean }} meta
 */
export function relayRingEligible(meta) {
	return meta.relayAttached && relayEligible(meta);
}

/**
 * Report a primary-owned relay incident exactly once, onto the registry of a
 * worker that is NOT the one involved: the involved peer may not drain
 * control messages (or is about to be replaced), and broadcasting would
 * multiply one incident in the cluster-wide sum. A quarantined peer is not a
 * reporter either - its exit was already requested, so a notice landing there
 * dies with it and the incident would count nowhere.
 * @param {Map<any, any>} workers
 * @param {any} involved the worker the incident is about; never the reporter
 * @param {object} message the notice to post
 * @returns {boolean} whether any surviving worker accepted the notice
 */
export function attributeRelayIncident(workers, involved, message) {
	for (const [reporter, meta] of workers) {
		if (reporter === involved || !relayEligible(meta)) continue;
		try {
			reporter.postMessage(message);
			return true;
		} catch { /* try the next surviving reporter */ }
	}
	return false;
}

/**
 * Build the one-shot action for a receiving worker whose relay spill crossed
 * its byte or age ceiling. Kept separate from index.js so the safety policy is
 * executable without booting worker threads or uWebSockets.js.
 *
 * @param {{
 *   worker: any,
 *   meta: { threadId: number, relayQuarantined: boolean },
 *   workers: Map<any, any>,
 *   requestWorkerExit: (worker: any, code: number) => void,
 *   log?: (...args: any[]) => void
 * }} options
 */
export function createRelaySpillQuarantine(options) {
	const { worker, meta, workers, requestWorkerExit, log = console.error } = options;
	return (event) => {
		if (meta.relayQuarantined) return false;
		meta.relayQuarantined = true;
		try {
			log(adapterConsoleLine(
				ADAPTER_ERROR_IDS.RELAY_SPILL_QUARANTINE,
				`worker=${meta.threadId} reason=${event.reason} droppedBytes=${event.droppedBytes} ` +
				`pendingAgeMs=${Math.round(event.pendingAgeMs)}`
			));
		} catch {}

		attributeRelayIncident(workers, worker, {
			type: 'relay-spill-overflow',
			reason: event.reason,
			droppedBytes: event.droppedBytes,
			pendingAgeMs: event.pendingAgeMs
		});
		requestWorkerExit(worker, 1);
		return true;
	};
}
