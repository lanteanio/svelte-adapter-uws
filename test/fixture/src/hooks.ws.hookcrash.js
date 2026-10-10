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

/**
 * Lifecycle lanes, for ADAPTER-ERR-OPEN-HOOK, -DRAIN-HOOK and -CLOSE-HOOK.
 *
 * A connection opts in with an `X-Request-ID` of `lifecycle-<lane>-<drill
 * token>`, which reaches every hook as `platform.requestId`. Selecting through
 * the request id rather than an `upgrade` export keeps this build on the
 * no-upgrade-hook path the other suites booting it rely on.
 * @param {any} platform
 */
function lifecycleLane(platform) {
	const token = process.env.HOOK_CRASH_DRILL_TOKEN;
	const id = platform?.requestId;
	if (!token || typeof id !== 'string') return null;
	const suffix = '-' + token;
	if (!id.startsWith('lifecycle-') || !id.endsWith(suffix)) return null;
	return id.slice('lifecycle-'.length, id.length - suffix.length);
}

export function open(ws, { platform }) {
	const lane = lifecycleLane(platform);
	if (lane === 'open-throws') throw new Error('__OPEN_HOOK_CRASH__');
	if (lane === 'open-rejects') return Promise.reject(new Error('__OPEN_HOOK_REJECT__'));
	// Send until uWS holds bytes the socket would not take. The client pauses
	// its socket for this lane, so that happens within a chunk or two, and uWS
	// fires drain once the client reads again. A loopback socket that is being
	// read accepts a single 8 MB write whole, which is why the size alone does
	// not do it.
	if (lane === 'drain-throws') {
		const chunk = new Uint8Array(1024 * 1024);
		for (let i = 0; i < 64 && ws.getBufferedAmount() === 0; i++) ws.send(chunk, true);
	}
	return undefined;
}

export function drain(ws, { platform }) {
	if (lifecycleLane(platform) === 'drain-throws') throw new Error('__DRAIN_HOOK_CRASH__');
}

export function close(ws, { platform }) {
	const lane = lifecycleLane(platform);
	// Heard by the suite, which loads the built server into the test process.
	if (lane !== null) process.emit('hookcrash:lifecycle-close', lane);
	if (lane === 'close-throws') throw new Error('__CLOSE_HOOK_CRASH__');
	if (lane === 'close-rejects') return Promise.reject(new Error('__CLOSE_HOOK_REJECT__'));
	return undefined;
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
	if (msg?.type === 'message-hook-failure' && process.env.HOOK_CRASH_DRILL_TOKEN && msg.token === process.env.HOOK_CRASH_DRILL_TOKEN) {
		if (msg.mode === 'throws') throw new Error('__MESSAGE_HOOK_THROWS__');
		if (msg.mode === 'rejects') return Promise.reject(new Error('__MESSAGE_HOOK_REJECTS__'));
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

/**
 * Admin route, for ADAPTER-ERR-ADMIN-HANDLER.
 *
 * Throws only for a request carrying the drill token, so the same build serves
 * the healthy answer as its own control - an entry that promises "that ONE
 * request answered 500" needs the next one to succeed in the same process to
 * mean anything.
 */
export function admin(request) {
	if (request.headers.get('x-response-date') === '1') return new Response('dated', { headers: { date: 'Thu, 01 Jan 1970 00:00:00 GMT' } });
	if (
		process.env.HOOK_CRASH_DRILL_TOKEN &&
		request.headers.get('x-hook-crash') === process.env.HOOK_CRASH_DRILL_TOKEN
	) {
		throw new Error('__ADMIN_HOOK_CRASH__');
	}
	if (
		process.env.HOOK_CRASH_DRILL_TOKEN &&
		request.headers.get('x-shutdown-sequence-crash') === process.env.HOOK_CRASH_DRILL_TOKEN
	) {
		// For ADAPTER-ERR-SHUTDOWN-FAILED: the graceful sequence contains every
		// application-supplied input behind its own entry (a throwing hook, a
		// rejecting listener), so what this entry guards is the sequence's OWN
		// machinery throwing. The realistic way an app breaks that machinery is
		// a global patch - APM and instrumentation layers rewrap process and
		// EventEmitter internals routinely - so the drill is exactly that: a
		// broken `process.listeners` that throws when the cleanup step asks for
		// the `sveltekit:shutdown` listeners, installed only now, and a SIGTERM
		// dispatched through the real handler on the next tick. `process.emit`
		// rather than a signal because Windows children have no deliverable
		// SIGTERM, and the handler under test is the same function either way.
		const original = process.listeners.bind(process);
		process.listeners = function (name) {
			if (name === 'sveltekit:shutdown') throw new Error('__SHUTDOWN_SEQUENCE_CRASH__');
			return original(name);
		};
		setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 25);
		return new Response(JSON.stringify({ ok: true, draining: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}
	const path = new URL(request.url).pathname;
	// Held open until `request.signal` aborts or three seconds pass, recording
	// the abort on `globalThis.__adminHoldAborts` for a suite running the server
	// in its own process.
	if (path.endsWith('/hold')) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(new Response('held')), 3000);
			globalThis.__adminHoldStarted = (globalThis.__adminHoldStarted ?? 0) + 1;
			request.signal.addEventListener('abort', () => {
				clearTimeout(timer);
				(globalThis.__adminHoldAborts ??= []).push(request.signal.reason?.name);
				resolve(new Response('aborted'));
			}, { once: true });
		});
	}
	// Bodyless answers, so the wire the admin writer produces for them is
	// observable on a real build: a 204, and a 200 that declares a length it
	// carries no bytes for (what a HEAD-answering handler does).
	if (path.endsWith('/empty')) return new Response(null, { status: 204 });
	if (path.endsWith('/declared')) {
		return new Response(null, { status: 200, headers: { 'content-length': '12' } });
	}
	return new Response(JSON.stringify({ ok: true, path }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}
