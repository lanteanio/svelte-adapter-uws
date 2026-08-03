// @ts-check

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

		// Attribute the primary-owned incident once to an OTHER worker registry.
		// The quarantined peer may not drain control messages, and broadcasting
		// would multiply one incident in the cluster-wide sum.
		for (const [reporter] of workers) {
			if (reporter === worker) continue;
			try {
				reporter.postMessage({
					type: 'relay-spill-overflow',
					reason: event.reason,
					droppedBytes: event.droppedBytes,
					pendingAgeMs: event.pendingAgeMs
				});
				break;
			} catch { /* try the next surviving reporter */ }
		}
		requestWorkerExit(worker, 1);
		return true;
	};
}
