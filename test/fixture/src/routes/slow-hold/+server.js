// Holds a GET response open for `ms` milliseconds (capped at 60000, default 0)
// before answering 200. It exists so a suite can put a request in flight on
// demand and keep it there across a shutdown budget: nothing else in the
// fixture stays open long enough to still be running when the budget expires.
// The line printed when the hold begins is the in-flight signal - a harness
// scanning the server's output can wait on it instead of guessing with a delay.
export async function GET({ url }) {
	const requested = Number(url.searchParams.get('ms'));
	const ms = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 0, 60000);
	console.log(`[slow-hold] holding the response for ${ms}ms`);
	await new Promise((resolve) => setTimeout(resolve, ms));
	return new Response(`held ${ms}ms`, {
		headers: { 'cache-control': 'no-store' }
	});
}
