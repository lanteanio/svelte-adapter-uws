// Minimal metrics registry for the fixture, shaped like the contract the
// adapter documents for `websocket.metrics`: positional
// counter(name, help, labelNames) / gauge(name, help, labelNames) factories
// returning instruments with inc / dec / set, plus serialize() for scrape output.
//
// Label values are intentionally aggregated away - a test asserting that a
// counter moved does not need per-label series, and keeping one number per name
// makes the scrape trivial to parse.
//
// Readable through `platform.metrics` AND by importing this module directly:
// the Vite plugin bundles the registry into the app's own server graph, so the
// runtime's instance and an app-graph import are the same object. The
// metrics-direct route drives that contract; a build that bundled this module
// standalone would hand that route a second, empty registry.

/** @type {Map<string, number>} */
const values = new Map();

/** @param {string} name */
function instrument(name) {
	if (!values.has(name)) values.set(name, 0);
	/** @param {unknown} a */
	const amount = (a) => (typeof a === 'number' && Number.isFinite(a) ? a : 1);
	return {
		/** @param {unknown} [a] */
		inc(a) { values.set(name, (values.get(name) || 0) + amount(a)); },
		/** @param {unknown} [a] */
		dec(a) { values.set(name, (values.get(name) || 0) - amount(a)); },
		/** @param {unknown} [a] */
		set(a) { values.set(name, typeof a === 'number' && Number.isFinite(a) ? a : 0); },
		/** @param {unknown} [a] */
		observe(a) { values.set(name, (values.get(name) || 0) + amount(a)); }
	};
}

export default {
	/** @param {string} name */
	counter(name) { return instrument(name); },
	/** @param {string} name */
	gauge(name) { return instrument(name); },
	/** @param {string} name */
	histogram(name) { return instrument(name); },
	/** Prometheus-ish text: one `name value` line per instrument. */
	serialize() {
		let out = '';
		for (const [name, value] of values) out += `${name} ${value}\n`;
		return out;
	}
};
