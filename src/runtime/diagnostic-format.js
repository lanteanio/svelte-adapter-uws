import { DATA_CLASSES, OBSERVABILITY_SCHEMA_VERSION, TELEMETRY_LEVELS } from './observability-manifest.js';

export const DIAGNOSTIC_SCHEMA_VERSION = OBSERVABILITY_SCHEMA_VERSION;
export const DIAGNOSTIC_PREFIX = 'lantean/diagnostic';

const MAX_TEXT = 512;
const LEVELS = new Set(TELEMETRY_LEVELS);
const CLASSES = new Set(Object.keys(DATA_CLASSES));
const DOT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const SOURCE = /^[a-z0-9@][a-z0-9@/._-]{0,127}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\uffff]/g;
const UNSAFE_PHYSICAL_LINE = /[\u0000-\u001f\u007f-\uffff]/;

function unicodeEscape(character) {
	return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
}

export function normalizeDiagnosticMessage(value, fallback = 'unknown') {
	const text = String(value ?? fallback)
		.replace(UNSAFE_TEXT, unicodeEscape)
		.replace(/\s+/g, ' ')
		.trim();
	return (text || fallback).slice(0, MAX_TEXT);
}

function asciiJson(value) {
	return JSON.stringify(value).replace(/[\u007f-\uffff]/g, unicodeEscape);
}

export function hasUnsafePhysicalDiagnosticText(value) {
	return UNSAFE_PHYSICAL_LINE.test(value);
}

export function isDiagnosticDotName(value) {
	return DOT_NAME.test(value);
}

export function isDiagnosticSeverity(value) {
	return LEVELS.has(value);
}

export function checkedDiagnosticSource(value) {
	const source = String(value ?? '');
	if (!SOURCE.test(source)) throw new TypeError('diagnostic source is invalid');
	return source;
}

export function checkedDiagnosticDotName(value, field) {
	const name = String(value ?? '');
	if (!isDiagnosticDotName(name)) throw new TypeError(`diagnostic ${field} must be a dot-name`);
	return name;
}

export function checkedDiagnosticSeverity(value) {
	if (!isDiagnosticSeverity(value)) throw new TypeError('diagnostic severity is invalid');
	return value;
}

export function checkedDiagnosticDataClass(value) {
	if (!CLASSES.has(value)) throw new TypeError('diagnostic dataClass is invalid');
	return value;
}

/**
 * Build the package-neutral diagnostic envelope shared by the adapter,
 * extensions, and realtime packages.
 *
 * @param {{ source: string, component: string, event: string, severity: string, message: string, occurredAt?: string | null, dataClass?: string, attributes?: unknown }} input
 */
export function createDiagnostic(input) {
	if (!input || typeof input !== 'object') throw new TypeError('diagnostic input is required');
	const occurredAt = input.occurredAt ?? null;
	if (occurredAt !== null && (typeof occurredAt !== 'string' || !occurredAt)) {
		throw new TypeError('diagnostic occurredAt must be a string or null');
	}
	const severity = checkedDiagnosticSeverity(input.severity);
	return {
		schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
		occurredAt,
		source: checkedDiagnosticSource(input.source),
		component: checkedDiagnosticDotName(input.component, 'component'),
		event: checkedDiagnosticDotName(input.event, 'event'),
		severity,
		level: severity,
		dataClass: checkedDiagnosticDataClass(input.dataClass ?? 'operational'),
		message: normalizeDiagnosticMessage(input.message),
		attributes: input.attributes ?? null
	};
}

/** @param {Parameters<typeof createDiagnostic>[0]} input */
export function formatDiagnostic(input) {
	const record = createDiagnostic(input);
	// Keep the physical console line ASCII outside the package-owned English
	// message. JSON escapes retain the exact structured value for collectors
	// while preventing C1, bidi controls, and right-to-left payload text from
	// reordering the surrounding terminal line.
	const suffix = asciiJson(record);
	return `[${DIAGNOSTIC_PREFIX} source=${record.source} component=${record.component} event=${record.event} severity=${record.severity}] ${record.message} ${suffix}`;
}
