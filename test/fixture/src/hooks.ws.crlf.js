// Fixture handler for the 101-handshake header-injection variant.
//
// This returns the duck-typed upgrade-response shape DIRECTLY instead of
// calling the upgradeResponse() helper. That is deliberate and it is the whole
// point: the helper validates at construction time, so a hook that goes through
// it throws inside the hook and the request never reaches the handshake write
// loop. The runtime's own pre-write header check therefore had no coverage at
// all - the only way to exercise it is to hand the runtime the same object shape
// the helper would have produced, which an app can also do by mutating a helper
// result after construction.
//
// The bytes come from the shared vector table rather than being copied here, so
// the production surface cannot end up testing stale bytes under a name the
// suites have since redefined. The client only NAMES a vector: the bytes cannot
// be carried in a request header, because uWS's request parser consumes or
// rejects CR, LF, obs-fold and NUL before a hook ever sees them, so a
// client-supplied value would arrive already sanitized.

import { VECTORS_BY_NAME, buildShapeHeaders } from './handshake-vectors.js';

export function upgrade({ headers }) {
	const name = headers['x-fixture-vector'];
	// Shape vectors need a whole object built a particular way (a getter that
	// rewrites an already-read key, an own `__proto__` key), so they are built
	// rather than looked up.
	const shaped = buildShapeHeaders(name);
	if (shaped) return { __upgradeResponse: true, userData: {}, headers: shaped };

	const value = VECTORS_BY_NAME.get(name);
	if (value === undefined) return {};
	return {
		__upgradeResponse: true,
		userData: {},
		headers: { 'set-cookie': value }
	};
}
