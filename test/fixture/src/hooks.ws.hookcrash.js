// Fault injection for the hook-failure registry entries. Every failure is
// selected per call through an env-gated token, so an accidental frame or
// POST from another suite is harmless, and the same build drives its own
// healthy path as the control.

export function authenticate({ headers }) {
	if (
		process.env.HOOK_CRASH_DRILL_TOKEN &&
		headers['x-hook-crash'] === process.env.HOOK_CRASH_DRILL_TOKEN
	) {
		throw new Error('__AUTH_HOOK_CRASH__');
	}
	return { userId: 'hookcrash-user' };
}

export function resume(ws, { lastSeenSeqs, platform }) {
	// The gap-fill request names its topics; one keyed on the drill token
	// selects the throw, so an ordinary resume through this build replays.
	if (
		process.env.HOOK_CRASH_DRILL_TOKEN &&
		Object.prototype.hasOwnProperty.call(lastSeenSeqs || {}, 'crash:' + process.env.HOOK_CRASH_DRILL_TOKEN)
	) {
		throw new Error('__RESUME_HOOK_CRASH__');
	}
	platform.send(ws, 'probe', 'replayed', { topics: Object.keys(lastSeenSeqs || {}) });
	return undefined;
}

export function message(ws, { data, platform }) {
	let msg;
	try {
		msg = JSON.parse(Buffer.from(data).toString());
	} catch {
		return;
	}
	if (
		msg?.type !== 'sendto-async-drill' ||
		!process.env.HOOK_CRASH_DRILL_TOKEN ||
		msg?.token !== process.env.HOOK_CRASH_DRILL_TOKEN
	) return;
	// The documented misuse: sendTo must be handed a synchronous filter.
	// Two calls let a case pin the once-per-worker warning, and the counts
	// travel back over the wire so fail-closed is client-observable.
	const first = platform.sendTo(async () => true, 'test-topic', 'dm', { n: 1 });
	const second = platform.sendTo(async () => true, 'test-topic', 'dm', { n: 2 });
	platform.send(ws, 'probe', 'sendto-async-drill', { nonce: msg.nonce, first, second });
}
