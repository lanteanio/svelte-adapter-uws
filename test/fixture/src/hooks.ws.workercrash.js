// Dedicated to the cluster worker-error drill. The token keeps this fault
// injection unreachable in every other fixture variant and makes an
// accidental message harmless even inside this one.

// An APPLICATION that handles its own uncaught exceptions, installed only when
// the drill asks for it. Node keeps a worker alive when something listens for
// this, and the runtime's own handler defers to an application that does - so
// this is the arm proving the worker survives rather than being exited out from
// under an app that meant to recover.
if (process.env.WORKER_CRASH_APP_HANDLER === '1') {
	process.on('uncaughtException', (err) => {
		console.error('__APP_HANDLED_UNCAUGHT__ ' + (err && err.message ? err.message : err));
	});
}
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
