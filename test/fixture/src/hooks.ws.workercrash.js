// Dedicated to the cluster worker-error drill. The token keeps this fault
// injection unreachable in every other fixture variant and makes an
// accidental message harmless even inside this one.
export function message(_ws, { data }) {
	let message;
	try {
		message = JSON.parse(Buffer.from(data).toString());
	} catch {
		return;
	}
	if (
		!process.env.WORKER_CRASH_DRILL_TOKEN ||
		message?.type !== 'worker-crash-drill' ||
		message?.token !== process.env.WORKER_CRASH_DRILL_TOKEN
	) return;

	console.error('__WORKER_CRASH_DRILL_ARMED__');
	// Throw OFF the request context, so no request-path catch can contain it:
	// the worker's uncaught exception surfaces as the primary's worker
	// 'error' event - the condition the cluster worker-error entry names.
	setTimeout(() => {
		throw new Error('__WORKER_CRASH_DRILL__');
	}, 0);
}
