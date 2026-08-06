// Fixture handler for the pending-cap variant.
//
// `subscribeBatch` PARKS EVERY invocation until the client releases them all.
// hooks.ws.park.js deliberately refuses a second outstanding park - its
// suites need a clobbered park to fail loudly - but proving the runtime
// refuses an attempt PAST the pending-attempt budget requires filling that
// budget first, and the budget is many whole batch frames deep. Each frame
// parks its own hook invocation here, so the count of parked probes is the
// count of frames that genuinely reached authorization.
//
// The hook denies nothing (an empty map means allow), so a parked batch
// lands in full once released; the only refusals a client can see are the
// runtime's own, which is exactly what the suite asserts.

const PARKS = '__parkedResolvers';

export function subscribeBatch(ws, topics, { platform }) {
	const ud = ws.getUserData();
	return new Promise((resolve) => {
		if (!ud[PARKS]) ud[PARKS] = [];
		ud[PARKS].push(() => resolve({}));
		// Announce the park with its ordinal, so the driver can count which
		// attempts reached the hook without guessing at delays.
		platform.send(ws, 'probe', 'parked', { ordinal: ud[PARKS].length, topics: topics.length });
	});
}

export function message(ws, { data, platform }) {
	const msg = JSON.parse(Buffer.from(data).toString());
	if (msg.type === 'release') {
		const ud = ws.getUserData();
		const parked = ud[PARKS] ?? [];
		ud[PARKS] = [];
		for (const release of parked) release();
		platform.send(ws, 'probe', 'released', { count: parked.length, nonce: msg.nonce ?? null });
	}
}
