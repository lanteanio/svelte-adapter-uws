// @ts-check

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
			log(
				'[primary] relay spill quarantining worker=%d reason=%s droppedBytes=%d pendingAgeMs=%d',
				meta.threadId, event.reason, event.droppedBytes, Math.round(event.pendingAgeMs)
			);
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
