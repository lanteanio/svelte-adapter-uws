// Error evidence from an autocannon result.
//
// A saturated or erroring run still prints a clean-looking request rate:
// autocannon keeps counting the responses that did arrive, while socket
// errors, timed-out requests, and non-2xx responses land only in counters a
// runner has to read deliberately. These helpers make every runner read
// them, so a row with failures is marked not comparable instead of being
// averaged into a summary beside healthy rows.

/** @param {any} result one autocannon result */
export function runEvidence(result) {
	return {
		errors: result.errors || 0, // connection errors; autocannon counts timeouts here too
		timeouts: result.timeouts || 0, // requests with no response in time (also inside errors)
		non2xx: result.non2xx || 0 // delivered responses outside 2xx
	};
}

export function emptyEvidence() {
	return { errors: 0, timeouts: 0, non2xx: 0 };
}

/** Accumulate one result's counters into `acc` (mutates and returns it). */
export function addEvidence(acc, result) {
	const e = runEvidence(result);
	acc.errors += e.errors;
	acc.timeouts += e.timeouts;
	acc.non2xx += e.non2xx;
	return acc;
}

export function isClean(ev) {
	return ev.errors === 0 && ev.timeouts === 0 && ev.non2xx === 0;
}

export function evidenceLabel(ev) {
	return `errors ${ev.errors}, timeouts ${ev.timeouts}, non-2xx ${ev.non2xx}`;
}
