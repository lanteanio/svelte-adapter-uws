/**
 * Wrap a metric instrument so an emit can never throw into the caller. The
 * admission and pressure paths emit from inside uWS native callbacks and
 * timer callbacks, where an exception would skip the HTTP response, leak an
 * in-flight admission slot, or kill the sampler. A registry is operator
 * config - trusted like the upgrade hook, and contained like it. The first
 * failure logs; repeats from the same instrument are silent so a broken
 * registry cannot flood the log once per rejection. Registration is
 * deliberately NOT contained: a registry that throws while creating an
 * instrument fails at startup, loudly, which is the right failure mode for
 * configuration.
 *
 * @param {{ [method: string]: any } | null | undefined} instrument
 * @returns {any}
 */
export function containMetricInstrument(instrument) {
	if (instrument == null) return undefined;
	let warned = false;
	/** @param {Function} fn */
	const contain = (fn) => function (/** @type {any} */ a, /** @type {any} */ b) {
		try {
			fn.call(instrument, a, b);
		} catch (err) {
			if (!warned) {
				warned = true;
				console.error('[ws] metrics instrument threw; suppressing further errors from it:', err);
			}
		}
	};
	/** @type {any} */
	const wrapped = {};
	for (const method of ['inc', 'dec', 'set', 'observe']) {
		if (typeof instrument[method] === 'function') wrapped[method] = contain(instrument[method]);
	}
	return wrapped;
}
