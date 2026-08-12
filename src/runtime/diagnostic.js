import {
	DIAGNOSTIC_PREFIX,
	DIAGNOSTIC_SCHEMA_VERSION,
	checkedDiagnosticDataClass,
	checkedDiagnosticDotName,
	checkedDiagnosticSeverity,
	checkedDiagnosticSource,
	createDiagnostic,
	formatDiagnostic,
	hasUnsafePhysicalDiagnosticText,
	isDiagnosticDotName,
	isDiagnosticSeverity,
	normalizeDiagnosticMessage
} from './diagnostic-format.js';
import { wallIso } from './runtime.js';
import { ADAPTER_ERROR_IDS, adapterConsoleLine } from './error-registry.js';

export { DIAGNOSTIC_PREFIX, DIAGNOSTIC_SCHEMA_VERSION, createDiagnostic, formatDiagnostic };

// Symbol.for makes the sink process-wide even when more than one package (or
// more than one installed copy) participates in the same server process.
const OPERATIONAL_EVENT_SINK = Symbol.for('lantean.operational-event-sink.v1');
const OPERATIONAL_EVENT_SINK_REGISTRY = Symbol.for('lantean.operational-event-sink-registry.v1');

function defaultOperationalEventSink(record) {
	const method = record.severity === 'debug' ? 'debug'
		: record.severity === 'info' ? 'info'
			: record.severity === 'warn' ? 'warn' : 'error';
	// Rendering and writing are separated deliberately, and this is the whole
	// reason: `console[method](formatDiagnostic(record))` is ONE protected
	// expression, so a console method that throws - a host that replaced the
	// console, a transport whose write end is gone - landed on the same entry as
	// a record that could not be formatted. An operator was then told the
	// formatter had failed twice and sent to inspect the record's envelope, for a
	// record that formats perfectly well. Split, each failure names the condition
	// that actually produced it.
	let line;
	try {
		line = formatDiagnostic(record);
	} catch {
		// An unserializable attribute (BigInt, circular reference) must not
		// erase the event: drop the attributes, keep the envelope.
		try {
			line = formatDiagnostic(createDiagnostic({ ...record, attributes: undefined }));
		} catch {
			// Rendered from the registry like any other indexed line. That is a
			// pure string build over frozen data, not a trip through the sink -
			// the thing that just failed - so the operator gets a searchable ID
			// and a documented route even at the pipeline's last resort.
			try { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.DIAGNOSTIC_RENDER_COLLAPSE, String(record?.event))); } catch { /* console gone */ }
			return;
		}
	}
	try {
		console[method](line);
	} catch {
		// The record rendered; the console method it was destined for refused it.
		// Reported through console.error because it is a DIFFERENT method in every
		// case but this one, so a single broken severity channel still surfaces.
		try { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.DIAGNOSTIC_CONSOLE_WRITE, String(record?.event))); } catch { /* console gone */ }
	}
}

/**
 * Bounded, throw-proof projection of a caught value for diagnostic
 * attributes: name, code, and message only - never the stack, never
 * arbitrary own properties. Shared so every failure site classifies errors
 * the same way instead of each choosing between raw retention and discard.
 *
 * @param {unknown} error
 * @returns {{ name: string, code: string | null, message: string }}
 */
export function diagnosticError(error) {
	let name = 'Error';
	let code = null;
	let message = 'Uninspectable thrown value';
	try { if (typeof (/** @type {any} */ (error))?.name === 'string') name = /** @type {any} */ (error).name; } catch { /* hostile getter */ }
	try { if ((/** @type {any} */ (error))?.code != null) code = String((/** @type {any} */ (error)).code); } catch { /* hostile getter */ }
	try { message = String((/** @type {any} */ (error))?.message ?? error); } catch { /* hostile toString */ }
	return { name: name.slice(0, 80), code: code === null ? null : code.slice(0, 80), message: message.slice(0, 512) };
}

function sinkFailureFallback(record) {
	// A broken observer must not erase the event it was meant to report.
	// This runs inside emitOperationalEvent's own catch (and in a rejection
	// handler), so nothing here may throw either - not even with a broken
	// injected clock underneath wallIso().
	//
	// The original event goes out FIRST and on its own. Both calls used to sit
	// inside one try, which made this report - through the entry it printed -
	// that BOTH records were lost. They never were: defaultOperationalEventSink
	// contains every failure it can have and does not throw, so the original had
	// always already printed by the time anything here could fail. The only thing
	// that can throw is BUILDING the notice below, from the clock or the record
	// shape - one record's worth of loss, and a different thing to send an
	// operator looking at.
	defaultOperationalEventSink(record);
	/** @type {any} */
	let notice;
	try {
		notice = createDiagnostic({
			source: 'svelte-adapter-uws',
			component: 'runtime.observability',
			event: 'operational.sink.failed',
			severity: 'error',
			message: 'The configured operational event sink failed; console fallback was restored for this event.',
			occurredAt: wallIso(),
			attributes: { originalSource: record.source, originalEvent: record.event }
		});
	} catch {
		try { console.error(adapterConsoleLine(ADAPTER_ERROR_IDS.DIAGNOSTIC_SINK_NOTICE, String(record?.event))); } catch { /* console gone */ }
		return;
	}
	defaultOperationalEventSink(notice);
}

function operationalEventSinkRegistry() {
	let registry = globalThis[OPERATIONAL_EVENT_SINK_REGISTRY];
	if (!registry || !Array.isArray(registry.entries)) {
		const inherited = globalThis[OPERATIONAL_EVENT_SINK];
		registry = {
			entries: typeof inherited === 'function'
				? [{ sink: inherited, active: true }]
				: []
		};
		globalThis[OPERATIONAL_EVENT_SINK_REGISTRY] = registry;
	}
	return registry;
}

function syncOperationalEventSink(registry) {
	const current = registry.entries[registry.entries.length - 1];
	if (current) globalThis[OPERATIONAL_EVENT_SINK] = current.sink;
	else delete globalThis[OPERATIONAL_EVENT_SINK];
}

/**
 * Install the process-wide operational event sink shared by the adapter,
 * extensions, and realtime packages. Pass null to restore console output.
 * The returned disposer removes only this registration. If registrations are
 * nested, the newest still-active sink resumes; disposing an older registration
 * out of order prevents it from ever being resurrected later.
 *
 * @param {((record: ReturnType<typeof createDiagnostic>) => void | Promise<void>) | null} sink
 */
export function setOperationalEventSink(sink) {
	if (sink !== null && typeof sink !== 'function') {
		throw new TypeError('operational event sink must be a function or null');
	}
	const registry = operationalEventSinkRegistry();
	if (sink === null) {
		for (const entry of registry.entries) entry.active = false;
		registry.entries.length = 0;
		delete globalThis[OPERATIONAL_EVENT_SINK];
		return () => {};
	}
	const entry = { sink, active: true };
	registry.entries.push(entry);
	globalThis[OPERATIONAL_EVENT_SINK] = sink;
	return () => {
		if (!entry.active) return;
		entry.active = false;
		const index = registry.entries.indexOf(entry);
		if (index !== -1) registry.entries.splice(index, 1);
		syncOperationalEventSink(registry);
	};
}

/**
 * Emit one canonical operational record. A configured sink receives the
 * structured record; otherwise a canonical JSON diagnostic line is written to
 * console. Sink throws and rejections fail over to console and never escape.
 *
 * @param {Parameters<typeof createDiagnostic>[0]} input
 */
export function emitOperationalEvent(input) {
	let record;
	try {
		record = createDiagnostic({ ...input, occurredAt: input?.occurredAt ?? wallIso() });
	} catch (err) {
		// Telemetry must never turn the failure it reports into a crash: many
		// callers emit from inside a catch block on a timer or a request
		// path, where a throw here would take the worker down. An invalid
		// record shape is a programming error for tests to surface; at
		// runtime the last honest act is a plain console line.
		try {
			console.error(
				adapterConsoleLine(ADAPTER_ERROR_IDS.DIAGNOSTIC_RECORD_SHAPE),
				/** @type {any} */ (err)?.message ?? err,
				input?.event
			);
		} catch { /* console gone */ }
		return null;
	}
	const sink = globalThis[OPERATIONAL_EVENT_SINK];
	if (typeof sink !== 'function') {
		defaultOperationalEventSink(record);
		return record;
	}
	try {
		const result = sink(record);
		if (result && typeof result.then === 'function') {
			Promise.resolve(result).catch(() => sinkFailureFallback(record));
		}
	} catch {
		sinkFailureFallback(record);
	}
	return record;
}

const LEGACY_PREFIXES = new Map([
	['svelte-adapter-uws', ['svelte-adapter-uws', 'runtime.adapter', 'diagnostic.legacy', 'warn']],
	['adapter-uws', ['svelte-adapter-uws', 'runtime.adapter', 'diagnostic.legacy', 'warn']],
	['adapter-uws/assert', ['svelte-adapter-uws', 'runtime.assertion', 'invariant.violated', 'warn']],
	['adapter-uws/fatal', ['svelte-adapter-uws', 'runtime.assertion', 'invariant.violated', 'fatal']],
	['adapter-uws/devAssert', ['svelte-adapter-uws', 'runtime.assertion', 'invariant.violated', 'error']],
	['adapter-uws/testing', ['svelte-adapter-uws', 'runtime.testing', 'diagnostic.legacy', 'warn']],
	['adapter-uws/relay-gap', ['svelte-adapter-uws', 'runtime.relay-gap', 'diagnostic.legacy', 'error']],
	['ws', ['svelte-adapter-uws', 'runtime.websocket', 'diagnostic.legacy', 'warn']],
	['tls', ['svelte-adapter-uws', 'runtime.tls', 'diagnostic.legacy', 'warn']],
	['primary', ['svelte-adapter-uws', 'runtime.primary', 'diagnostic.legacy', 'warn']],
	['pressure', ['svelte-adapter-uws', 'runtime.pressure', 'diagnostic.legacy', 'warn']],
	['extensions', ['svelte-adapter-uws-extensions', 'runtime.extensions', 'diagnostic.legacy', 'warn']],
	['extensions/assert', ['svelte-adapter-uws-extensions', 'runtime.assertion', 'invariant.violated', 'warn']],
	['extensions/fatal', ['svelte-adapter-uws-extensions', 'runtime.assertion', 'invariant.violated', 'fatal']],
	['extensions/devAssert', ['svelte-adapter-uws-extensions', 'runtime.assertion', 'invariant.violated', 'error']],
	['redis', ['svelte-adapter-uws-extensions', 'runtime.redis', 'diagnostic.legacy', 'warn']],
	['redis replay', ['svelte-adapter-uws-extensions', 'runtime.redis.replay', 'diagnostic.legacy', 'warn']],
	['redis stream replay', ['svelte-adapter-uws-extensions', 'runtime.redis.stream-replay', 'diagnostic.legacy', 'warn']],
	['postgres', ['svelte-adapter-uws-extensions', 'runtime.postgres', 'diagnostic.legacy', 'warn']],
	['postgres replay', ['svelte-adapter-uws-extensions', 'runtime.postgres.replay', 'diagnostic.legacy', 'warn']],
	['postgres tasks', ['svelte-adapter-uws-extensions', 'runtime.postgres.tasks', 'diagnostic.legacy', 'warn']],
	['publish-rate', ['svelte-adapter-uws-extensions', 'runtime.redis.publish-rate', 'diagnostic.legacy', 'warn']],
	['svelte-realtime', ['svelte-realtime', 'runtime.realtime', 'diagnostic.legacy', 'warn']],
	['realtime/assert', ['svelte-realtime', 'runtime.assertion', 'invariant.violated', 'warn']],
	['realtime/fatal', ['svelte-realtime', 'runtime.assertion', 'invariant.violated', 'fatal']]
]);

function canonicalRecord(line) {
	const close = line.indexOf(']');
	if (close < 0 || !line.startsWith(`[${DIAGNOSTIC_PREFIX} `)) return null;
	const prefix = line.slice(1, close);
	const match = /^lantean\/diagnostic source=([^ ]+) component=([^ ]+) event=([^ ]+) severity=([^ ]+)$/.exec(prefix);
	if (!match) return null;
	const marker = line.lastIndexOf(' {"schemaVersion":');
	if (marker <= close) return null;
	try {
		const record = JSON.parse(line.slice(marker + 1));
		if (record.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION ||
			record.source !== match[1] || record.component !== match[2] ||
			record.event !== match[3] || record.severity !== match[4] ||
			record.level !== record.severity ||
			record.message !== line.slice(close + 1, marker).trim() ||
			normalizeDiagnosticMessage(record.message) !== record.message ||
			!Object.hasOwn(record, 'attributes') ||
			(record.occurredAt !== null && (typeof record.occurredAt !== 'string' || !record.occurredAt))) return null;
		checkedDiagnosticSource(record.source);
		checkedDiagnosticDotName(record.component, 'component');
		checkedDiagnosticDotName(record.event, 'event');
		checkedDiagnosticSeverity(record.severity);
		checkedDiagnosticDataClass(record.dataClass);
		return record;
	} catch {
		return null;
	}
}

function legacyRecord(line, defaultSeverity) {
	const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
	if (!match) return null;
	let fields = LEGACY_PREFIXES.get(match[1]);
	if (!fields && match[1].startsWith('svelte-adapter-uws/')) {
		const component = match[1].slice('svelte-adapter-uws/'.length);
		if (isDiagnosticDotName(component)) fields = ['svelte-adapter-uws', component, 'diagnostic.legacy', defaultSeverity];
	}
	if (!fields && /^worker \d+$/.test(match[1])) {
		fields = ['svelte-adapter-uws', 'runtime.worker', 'diagnostic.legacy', defaultSeverity];
	}
	if (!fields && /^group .+$/.test(match[1])) {
		fields = ['svelte-adapter-uws', 'plugins.groups', 'diagnostic.legacy', defaultSeverity];
	}
	if (!fields && /^(redis|postgres)\/[a-z0-9._-]+$/.test(match[1])) {
		fields = ['svelte-adapter-uws-extensions', `runtime.${match[1].replace('/', '.')}`, 'diagnostic.legacy', defaultSeverity];
	}
	if (!fields) return null;

	let message = match[2];
	let attributes = { legacyPrefix: match[1] };
	const marker = line.lastIndexOf(' {"schemaVersion":');
	if (marker > 0) {
		try {
			const embedded = JSON.parse(line.slice(marker + 1));
			message = line.slice(match[0].length - match[2].length, marker).trim();
			attributes = { ...attributes, legacyRecord: embedded };
			if (isDiagnosticDotName(embedded.event)) fields = [fields[0], fields[1], embedded.event, isDiagnosticSeverity(embedded.level) ? embedded.level : fields[3]];
		} catch { /* leave the suffix as legacy text */ }
	}
	try {
		return createDiagnostic({
			source: fields[0], component: fields[1], event: fields[2], severity: fields[3],
			message, attributes
		});
	} catch {
		return null;
	}
}

/**
 * Parse the canonical one-line grammar, or a recognized legacy prefix during
 * the compatibility window. Unknown or malformed input returns null.
 *
 * @param {unknown} value
 * @param {{ defaultSeverity?: string }} [options]
 */
export function parseDiagnostic(value, options = {}) {
	if (typeof value !== 'string') return null;
	if (value.startsWith('[' + DIAGNOSTIC_PREFIX + ' ') && hasUnsafePhysicalDiagnosticText(value)) return null;
	const record = canonicalRecord(value);
	if (record) return { format: 'canonical', record };
	const defaultSeverity = isDiagnosticSeverity(options.defaultSeverity) ? options.defaultSeverity : 'warn';
	const legacy = legacyRecord(value, defaultSeverity);
	return legacy ? { format: 'legacy', record: legacy } : null;
}
