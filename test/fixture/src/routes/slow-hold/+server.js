// Holds a GET response open for `ms` milliseconds (capped at 60000, default 0)
// before answering 200. It exists so a suite can put a request in flight on
// demand and keep it there across a shutdown budget: nothing else in the
// fixture stays open long enough to still be running when the budget expires.
// The line printed when the hold begins is the in-flight signal - a harness
// scanning the server's output can wait on it instead of guessing with a delay.
// The line printed when it ends places the answer in the same output, so a
// suite can read what ran before and after it.
//
// It also reports `request.signal` aborting - printed, and recorded on
// `globalThis.__slowHoldAborts` for a suite running the server in its own
// process - and deliberately keeps holding, so a suite still sees what happens
// to a handler that does not stop. `globalThis.__slowHoldStarted` counts the
// holds that have begun and `__slowHoldEntered` the handlers watching their
// signal, which is when a suite may cut the client off. POST reads its whole
// body first, then holds the same way.

/**
 * Report the signal aborting, whenever it does - before this call included.
 * @param {Request} request @param {number} ms
 */
function watch(request, ms) {
	const record = () => {
		const reason = request.signal.reason;
		const message = typeof reason?.message === 'string' ? reason.message : String(reason);
		console.log(`[slow-hold] signal aborted: ${message}`);
		(globalThis.__slowHoldAborts ??= []).push({ ms, name: reason?.name, message });
	};
	if (request.signal.aborted) record();
	else request.signal.addEventListener('abort', record, { once: true });
	globalThis.__slowHoldEntered = (globalThis.__slowHoldEntered ?? 0) + 1;
}

/** @param {number} ms */
async function hold(ms) {
	console.log(`[slow-hold] holding the response for ${ms}ms`);
	globalThis.__slowHoldStarted = (globalThis.__slowHoldStarted ?? 0) + 1;
	await new Promise((resolve) => setTimeout(resolve, ms));
	console.log(`[slow-hold] answering after ${ms}ms`);
	return new Response(`held ${ms}ms`, {
		headers: { 'cache-control': 'no-store' }
	});
}

/** @param {URL} url */
function holdMs(url) {
	const requested = Number(url.searchParams.get('ms'));
	return Math.min(Number.isFinite(requested) && requested > 0 ? requested : 0, 60000);
}

export async function GET({ url, request }) {
	const ms = holdMs(url);
	watch(request, ms);
	return hold(ms);
}

export async function POST({ url, request }) {
	const ms = holdMs(url);
	watch(request, ms);
	// A body that never arrives in full rejects the read; the hold still runs.
	try { await request.text(); } catch { /* the client went away mid-body */ }
	return hold(ms);
}
