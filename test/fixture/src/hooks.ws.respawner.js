// Dedicated to the Linux external-respawner drill. The token keeps this fault
// injection unreachable in every other fixture variant and makes an accidental
// message harmless even inside this one.
export function message(_ws, { data }) {
	let message;
	try {
		message = JSON.parse(Buffer.from(data).toString());
	} catch {
		return;
	}
	if (
		message?.type !== 'respawner-drill-wedge' ||
		message?.token !== process.env.RESPAWNER_DRILL_TOKEN
	) return;

	console.error('__RESPAWNER_DRILL_WORKER_WEDGED__');
	// Block this worker's event loop without burning a CPU. The primary misses
	// heartbeats, requests a clean exit, then takes the documented whole-process
	// SIGKILL fallback because a wedged worker cannot receive that request.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
