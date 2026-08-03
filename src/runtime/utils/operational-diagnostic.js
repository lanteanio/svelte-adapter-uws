import { OBSERVABILITY_SCHEMA_VERSION, TELEMETRY_LEVELS } from '../observability-manifest.js';
import { wallIso } from '../runtime.js';
import {
	ADAPTER_ERROR_IDS,
	adapterErrorDefinition,
	adapterErrorProblem
} from '../error-registry.js';
import { emitOperationalEvent, formatDiagnostic } from '../diagnostic.js';

const MAX_TEXT = 512;
const LEVELS = new Set(TELEMETRY_LEVELS);
const DOT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

function bounded(value, fallback = 'unknown') {
	const text = String(value ?? fallback)
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return (text || fallback).slice(0, MAX_TEXT);
}

function errorFields(error) {
	if (error == null) return null;
	return {
		name: bounded(error.name, 'Error').slice(0, 80),
		code: error.code == null ? null : bounded(error.code).slice(0, 80),
		message: bounded(error.message ?? error)
	};
}

/**
 * Build one canonical operational event plus the action-oriented text fields
 * that make a raw console line useful before a collector parses its JSON.
 *
 * @param {{ level: string, event: string, component: string, problem: string, effect: string, recovery: string, action: string, willRetry: boolean, host?: string | null, port?: number | null, error?: unknown, occurredAt?: string }} input
 */
export function createOperationalDiagnostic(input) {
	if (!LEVELS.has(input.level)) throw new TypeError('operational diagnostic level is invalid');
	if (!DOT_NAME.test(input.event)) throw new TypeError('operational diagnostic event must be a dot-name');
	if (!DOT_NAME.test(input.component)) throw new TypeError('operational diagnostic component must be a dot-name');
	if (typeof input.willRetry !== 'boolean') throw new TypeError('operational diagnostic willRetry must be boolean');
	const port = input.port == null ? null : Number(input.port);
	if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535)) {
		throw new TypeError('operational diagnostic port is invalid');
	}
	return {
		schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
		occurredAt: input.occurredAt ?? wallIso(),
		source: 'svelte-adapter-uws',
		severity: input.level,
		level: input.level,
		event: input.event,
		component: input.component,
		dataClass: 'operational',
		attributes: {
			problem: bounded(input.problem),
			effect: bounded(input.effect),
			recovery: bounded(input.recovery),
			action: bounded(input.action),
			willRetry: input.willRetry,
			host: input.host == null ? null : bounded(input.host).slice(0, 255),
			port,
			error: errorFields(input.error)
		}
	};
}

/**
 * Compose the single console line with per-part caps, so the ACTION - the
 * field an operator needs most and the last one in the pattern - can never
 * be the first thing truncated away by the record-level 512-char message
 * bound. The full untruncated fields always ride in `attributes`.
 *
 * @param {ReturnType<typeof createOperationalDiagnostic>} record
 */
function composedMessage(record) {
	const value = record.attributes;
	const part = (text, cap) => (text.length > cap ? text.slice(0, cap - 3) + '...' : text);
	return `${record.event}: ${part(value.problem, 150)}; ` +
		`effect: ${part(value.effect, 80)}; ` +
		`recovery: ${part(value.recovery, 80)}; ` +
		`action: ${part(value.action, 140)}`;
}

export function formatOperationalDiagnostic(input) {
	const record = createOperationalDiagnostic(input);
	return formatDiagnostic({ ...record, message: composedMessage(record) });
}

export function emitOperationalDiagnostic(input) {
	const record = createOperationalDiagnostic(input);
	return emitOperationalEvent({ ...record, message: composedMessage(record) });
}

export function listenFailureDiagnostic(host, port) {
	const definition = adapterErrorDefinition(ADAPTER_ERROR_IDS.LISTEN);
	return {
		level: 'fatal',
		event: definition.event,
		component: definition.component,
		problem: adapterErrorProblem(definition.id, ` ${host}:${port}.`),
		effect: definition.consequence,
		recovery: definition.automaticRecovery,
		action: definition.nextAction,
		willRetry: false,
		host,
		port,
		error: Object.assign(new Error('uWebSockets.js returned no listen socket'), { code: 'LISTEN_FAILED' })
	};
}

export function viteHandlerFailureDiagnostic({ phase, source, host, port, error }) {
	if (phase !== 'load' && phase !== 'reload') throw new TypeError('Vite handler failure phase is invalid');
	const initial = phase === 'load';
	const definition = adapterErrorDefinition(initial ? ADAPTER_ERROR_IDS.VITE_LOAD : ADAPTER_ERROR_IDS.VITE_RELOAD);
	return {
		level: 'error',
		event: definition.event,
		component: definition.component,
		problem: adapterErrorProblem(definition.id, `${source ? ` (${source})` : ''} failed.`),
		effect: definition.consequence,
		recovery: definition.automaticRecovery,
		action: definition.nextAction,
		willRetry: true,
		host,
		port,
		error
	};
}

export function viteHandlerRecoveredDiagnostic({ host, port, connectionsRestarted }) {
	return {
		level: 'info',
		event: 'vite.handler.recovered',
		component: 'vite.websocket',
		problem: 'The prior WebSocket handler load failure is cleared.',
		effect: connectionsRestarted
			? 'New upgrades use the current handler and existing connections were closed with code 1012 so they reconnect.'
			: 'New upgrades use the current handler and existing connections continue without a forced reconnect.',
		recovery: 'The newly loaded handler replaced the degraded state.',
		action: 'No operator action is required; reconnect any client that did not retry after the earlier HTTP 500.',
		willRetry: false,
		host,
		port,
		error: null
	};
}
