const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';
const MAX_TRACESTATE_BYTES = 512;
const MAX_TRACESTATE_MEMBERS = 32;

function readHeader(carrier, name) {
	if (carrier == null) return undefined;
	try {
		if (typeof carrier.get === 'function') return carrier.get(name) ?? undefined;
		const direct = carrier[name] ?? carrier[name.toLowerCase()] ?? carrier[name.toUpperCase()];
		if (direct !== undefined) return direct;
		for (const key of Object.keys(carrier)) {
			if (key.toLowerCase() === name) return carrier[key];
		}
	} catch {}
	return undefined;
}

function validTracestate(value) {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string' || value.length > MAX_TRACESTATE_BYTES) return null;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return null;
	}
	const members = value.split(',');
	if (members.length > MAX_TRACESTATE_MEMBERS) return null;
	const keys = new Set();
	for (const raw of members) {
		const member = raw.trim();
		const equal = member.indexOf('=');
		if (equal < 1 || equal === member.length - 1) return null;
		const key = member.slice(0, equal);
		const validKey = key.includes('@')
			? /^[a-z0-9][a-z0-9_\-*\/]{0,240}@[a-z][a-z0-9_\-*\/]{0,13}$/.test(key)
			: /^[a-z0-9][a-z0-9_\-*\/]{0,255}$/.test(key);
		if (!validKey || keys.has(key)) return null;
		keys.add(key);
		const stateValue = member.slice(equal + 1);
		if (stateValue.length > 256 || stateValue.includes('=')) return null;
	}
	return value;
}

/**
 * Validate and normalize a W3C trace context. Invalid input is ignored rather
 * than propagated across a trust boundary.
 *
 * @param {unknown} value
 * @returns {{ traceparent: string, tracestate?: string } | null}
 */
export function normalizeTraceContext(value) {
	if (value === null || typeof value !== 'object') return null;
	const traceparent = readHeader(value, 'traceparent');
	if (typeof traceparent !== 'string') return null;
	const match = TRACEPARENT_RE.exec(traceparent);
	if (match === null || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) return null;
	const tracestate = validTracestate(readHeader(value, 'tracestate'));
	return tracestate === null ? { traceparent } : { traceparent, tracestate };
}

/** @param {unknown} carrier */
export function extractTraceContext(carrier) {
	return normalizeTraceContext(carrier);
}

/**
 * Inject a validated context into Headers or a mutable plain object. Invalid or
 * absent contexts leave the carrier untouched.
 *
 * @param {Headers | Record<string, string>} carrier
 * @param {unknown} [context]
 */
export function injectTraceContext(carrier, context = null) {
	const normalized = normalizeTraceContext(context);
	if (normalized === null || carrier === null || typeof carrier !== 'object') return carrier;
	if (typeof /** @type {Headers} */ (carrier).set === 'function') {
		/** @type {Headers} */ (carrier).set('traceparent', normalized.traceparent);
		if (normalized.tracestate !== undefined) /** @type {Headers} */ (carrier).set('tracestate', normalized.tracestate);
		return carrier;
	}
	/** @type {Record<string, string>} */ (carrier).traceparent = normalized.traceparent;
	if (normalized.tracestate !== undefined) /** @type {Record<string, string>} */ (carrier).tracestate = normalized.tracestate;
	return carrier;
}
