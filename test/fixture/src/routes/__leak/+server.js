// The leak lane's window into the server it is driving, and nothing else.
//
// Reading a process's resident set from OUTSIDE means asking the operating
// system, which spells the answer differently on every platform and reports a
// number the runtime itself never sees. Asking the process is exact and
// portable, and it is the only way to force a collection at a chosen instant -
// which the lane needs, because a baseline taken before the heap has settled
// invents a leak out of the climb back to the working set.
//
// ARMED BY ENVIRONMENT, and unreachable otherwise. Without `LEAK_PROBE` every
// operation here answers 404, the same as a route that does not exist: this is
// a fixture, but a probe that reports memory and retains buffers on request has
// no business answering in anything anyone deploys, and "it is only in the test
// fixture" is not a boundary the build enforces. The environment variable is.
//
// `op=retain` is the self-check's planted leak. It exists so the lane can prove
// it still detects one; a lane that has quietly lost that ability otherwise
// reports a clean bill of health, which is worse than no lane.

/** Retained on purpose by `op=retain`, released by `op=release`. */
const retained = [];

/** @param {number} status @param {unknown} body */
function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

export function GET({ url }) {
	if (process.env.LEAK_PROBE !== '1') return new Response('Not Found', { status: 404 });

	const op = url.searchParams.get('op');

	if (op === 'mem') {
		const usage = process.memoryUsage();
		return json(200, {
			rss: usage.rss,
			heapUsed: usage.heapUsed,
			heapTotal: usage.heapTotal,
			external: usage.external,
			retained: retained.length
		});
	}

	if (op === 'gc') {
		// Absent without --expose-gc. Reported rather than thrown: the lane
		// decides whether an unforced baseline is worth continuing with, and it
		// cannot decide that if the probe simply fails.
		const gc = /** @type {undefined | (() => void)} */ (globalThis.gc);
		if (typeof gc !== 'function') return json(200, { collected: false, reason: 'gc-not-exposed' });
		gc();
		return json(200, { collected: true });
	}

	if (op === 'retain') {
		const kb = Math.min(Number(url.searchParams.get('kb')) || 64, 1024);
		// Filled rather than allocated empty: an untouched Buffer.alloc is
		// zero-page-backed on some platforms and may never appear in the
		// resident set, which would make the planted leak invisible and the
		// self-check a lie in the reassuring direction.
		retained.push(Buffer.alloc(kb * 1024, 0x5a));
		return json(200, { retained: retained.length });
	}

	if (op === 'release') {
		const freed = retained.length;
		retained.length = 0;
		return json(200, { freed });
	}

	return json(400, { error: 'unknown op', accepts: ['mem', 'gc', 'retain', 'release'] });
}
