import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	DATA_CLASSES,
	NO_DATA_POLICIES,
	OBSERVABILITY_SCHEMA_VERSION,
	SIGNALS,
	TELEMETRY_CONTRACT,
	TELEMETRY_LEVELS,
	validateObservabilityContract
} from '../src/observability.js';
import { renderContract, renderTypes } from '../scripts/generate-observability.js';

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8')
	.replace(/\r\n/g, '\n');

describe('public observability contract', () => {
	it('is complete, versioned, and fail-closed', () => {
		expect(OBSERVABILITY_SCHEMA_VERSION).toBe(1);
		expect(validateObservabilityContract()).toEqual([]);
		expect(TELEMETRY_LEVELS).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
		expect(Object.keys(DATA_CLASSES)).toEqual([
			'operational', 'pseudonymous', 'application', 'secret'
		]);
		expect(DATA_CLASSES.secret.defaultRetention).toBe('prohibited');
		expect(Object.keys(NO_DATA_POLICIES)).toContain('zero_when_complete');
	});

	it('declares every event field, correlation seam, and support truth', () => {
		const fields = TELEMETRY_CONTRACT.eventEnvelope.fields;
		for (const name of ['schemaVersion', 'occurredAt', 'level', 'event', 'component', 'dataClass']) {
			expect(fields[name].required, name).toBe(true);
		}
		expect(fields.attributes.dataClass).toBe('application');
		expect(fields.requestId.dataClass).toBe('pseudonymous');
		expect(TELEMETRY_CONTRACT.correlation.requestId).toMatchObject({
			header: 'x-request-id',
			supported: true,
			dataClass: 'pseudonymous'
		});
		expect(TELEMETRY_CONTRACT.correlation.traceparent.supported).toBe(true);
		expect(TELEMETRY_CONTRACT.correlation.tracestate.supported).toBe(true);
	});

	it('gives every metric exact data, label, enum, and no-data metadata', () => {
		for (const signal of SIGNALS) {
			expect(signal.schemaVersion, signal.name).toBe(OBSERVABILITY_SCHEMA_VERSION);
			expect(signal.dataClass, signal.name).toBe('operational');
			expect(Object.keys(signal.labelDomains).sort(), signal.name).toEqual([...signal.labels].sort());
			expect(NO_DATA_POLICIES, signal.name).toHaveProperty(signal.noData.local);
			expect(NO_DATA_POLICIES, signal.name).toHaveProperty(signal.noData.snapshot);
			for (const label of signal.labels) {
				expect(signal.labelDomains[label].dataClass, `${signal.name}.${label}`).toBe('operational');
			}
			if (signal.unit === 'enum') {
				expect(Object.keys(signal.valueDomain), signal.name).not.toHaveLength(0);
			} else {
				expect(signal.valueDomain, signal.name).toBeNull();
			}
		}
	});

	it('rejects partial copies and classification drift', () => {
		const missingClass = SIGNALS.map((signal, index) =>
			index === 0 ? { ...signal, dataClass: undefined } : signal
		);
		expect(validateObservabilityContract(missingClass)).toContain(
			'http_requests_total: metrics must use the operational data class'
		);

		const missingNoData = SIGNALS.map((signal, index) =>
			index === 0 ? { ...signal, noData: {} } : signal
		);
		expect(validateObservabilityContract(missingNoData)).toContain(
			'http_requests_total: unknown or missing no-data policy'
		);

		const rejected = SIGNALS.find((signal) => signal.name === 'upgrade_rejected_total');
		const missingDomain = SIGNALS.map((signal) =>
			signal === rejected ? { ...signal, labelDomains: {} } : signal
		);
		expect(validateObservabilityContract(missingDomain)).toContain(
			'upgrade_rejected_total: labelDomains must exactly match labels'
		);

		const fields = { ...TELEMETRY_CONTRACT.eventEnvelope.fields };
		fields.level = { ...fields.level, values: ['info', 'error'] };
		const shortLevels = {
			...TELEMETRY_CONTRACT,
			eventEnvelope: { fields }
		};
		expect(validateObservabilityContract(SIGNALS, shortLevels)).toContain(
			'event level domain must exactly match TELEMETRY_LEVELS'
		);
	});

	it('rejects unit-convention and aggregation-law drift a sibling could declare', () => {
		// A sibling package validating its own signals through this export must
		// be told about a millisecond metric or an illegal law - these checks
		// previously lived only in this repository's test suite, where no
		// sibling can call them.
		const base = SIGNALS.find((signal) => signal.name === 'ws_connections');
		const declare = (overrides) =>
			validateObservabilityContract([{ ...base, ...overrides }]);

		expect(declare({ name: 'lock_acquire_wait_ms' })).toContain(
			'lock_acquire_wait_ms: durations are seconds, never milliseconds'
		);
		expect(declare({ name: 'queue_delay_milliseconds' })).toContain(
			'queue_delay_milliseconds: durations are seconds, never milliseconds'
		);
		expect(declare({ type: 'summary' })).toContain(
			'ws_connections: unknown type summary'
		);
		expect(declare({ aggregate: 'average' })).toContain(
			'ws_connections: unknown aggregation law average'
		);
		expect(declare({
			name: 'wait_seconds', type: 'histogram', unit: 'seconds',
			buckets: [0.1, 1], aggregate: 'max'
		})).toContain(
			'wait_seconds: histograms must sum across workers, not max'
		);
		expect(declare({ scope: 'cluster' })).toContain(
			'ws_connections: unknown scope cluster'
		);
		expect(declare({ scope: 'process', aggregate: 'sum' })).toContain(
			'ws_connections: process-scoped values must not sum across workers'
		);
		expect(declare({ name: 'events_handled_total', type: 'counter', aggregate: 'max' })).toContain(
			'events_handled_total: counters must sum across workers, not max'
		);
		expect(declare({ name: 'events_handled', type: 'counter' })).toContain(
			'events_handled: the _total suffix and the counter type must agree'
		);
		expect(declare({ name: 'wait_time', unit: 'seconds' })).toContain(
			'wait_time: second-valued metrics end in _seconds'
		);
		expect(declare({ name: 'buffer_size', unit: 'bytes' })).toContain(
			'buffer_size: byte-valued metrics end in _bytes (before _total for counters)'
		);
		// The manifest itself passes every one of these rules.
		expect(validateObservabilityContract()).toEqual([]);
	});

	it('generates the public document and ships the typed entry point', () => {
		expect(read('docs/observability.md')).toBe(renderContract());
		expect(read('src/observability.generated.d.ts')).toBe(renderTypes());
		const pkg = JSON.parse(read('package.json'));
		expect(pkg.exports['./observability']).toEqual({
			types: './src/observability.d.ts',
			default: './src/observability.js'
		});
		// The generated contract lives under docs/, which the docs entry publishes.
		expect(pkg.files).toContain('docs');
		const declarations = read('src/observability.d.ts');
		for (const name of [
			'OBSERVABILITY_SCHEMA_VERSION',
			'TELEMETRY_CONTRACT',
			'SIGNALS',
			'validateObservabilityContract'
		]) {
			expect(declarations).toContain(name);
		}
	});
});
