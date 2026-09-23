// The transport and pressure instruments emit only labels the observability
// manifest declares.
//
// test/metrics-label-contract.test.js reads emit sites from source, and it can
// only see an emit whose object is a bare identifier and whose labels are an
// object literal. The transport instruments emit prebuilt label objects through
// optional-chained instrument fields, so all seven were outside that scan, and
// the pressure transitions pass their labels through from the telemetry. This
// checks them by value instead: the arrays every transport label object is
// built from, and the labels the pressure emitter actually hands its counter.

import { describe, it, expect } from 'vitest';
import { TRANSPORT_LABEL_VALUES } from '../src/runtime/transport-metrics.js';
import { emitPressureMetricTelemetry } from '../src/runtime/utils/os-pressure.js';
import { SIGNALS_BY_NAME, PRESSURE_REASON_CODES } from '../src/runtime/observability-manifest.js';

describe('transport metric labels', () => {
	it('names exactly the labels each signal declares, with values its domain admits', () => {
		const signals = Object.keys(TRANSPORT_LABEL_VALUES);
		expect(signals.length).toBe(7);
		for (const name of signals) {
			const signal = SIGNALS_BY_NAME.get(name);
			expect(signal, name + ' is in the manifest').toBeTruthy();
			const emitted = TRANSPORT_LABEL_VALUES[name];
			expect(Object.keys(emitted).sort(), name).toEqual([...signal.labels].sort());
			for (const [label, values] of Object.entries(emitted)) {
				const domain = signal.labelDomains[label];
				expect(domain?.kind, `${name}.${label}`).toBe('enum');
				expect([...values].sort(), `${name}.${label}`).toEqual([...domain.values].sort());
			}
		}
	});
});

describe('pressure transition labels', () => {
	it('hands the counter only reasons the manifest admits', () => {
		const recorded = [];
		const instruments = { reasonTransitions: { inc: (labels) => recorded.push(labels) } };
		const reasons = Object.keys(PRESSURE_REASON_CODES);
		for (const from of reasons) {
			for (const to of reasons) {
				emitPressureMetricTelemetry({ transition: { from, to }, os: { psi: null, cpuThrottle: null } }, instruments);
			}
		}
		const signal = SIGNALS_BY_NAME.get('pressure_reason_transitions_total');
		expect(recorded.length).toBe(reasons.length * reasons.length);
		for (const labels of recorded) {
			expect(Object.keys(labels).sort()).toEqual([...signal.labels].sort());
			expect(signal.labelDomains.from.values).toContain(labels.from);
			expect(signal.labelDomains.to.values).toContain(labels.to);
		}
	});
});
