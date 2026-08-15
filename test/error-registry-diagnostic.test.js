// The diagnostic pipeline's own three failure entries, driven from the
// conditions they claim: ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE,
// ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE, and ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE.
//
// These entries describe the telemetry pipeline failing, so every case stubs
// the console methods and reads what the pipeline wrote - including the calls
// a throwing stub still records, which is how a channel that is itself broken
// leaves evidence. The wall clock rides the injectable runtime seam, which is
// what makes the sink-notice window - the same clock succeeding for the
// event's record and failing for the notice moments later - reachable on cue.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitOperationalEvent, setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { emitOperationalDiagnostic } from '../src/runtime/utils/operational-diagnostic.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/runtime/runtime.js';

afterEach(() => {
	setOperationalEventSink(null);
	resetRuntimeEnv();
	vi.restoreAllMocks();
});

function validRecord(overrides = {}) {
	return {
		source: 'svelte-adapter-uws',
		component: 'runtime.observability',
		event: 'claims.case',
		severity: 'error',
		dataClass: 'pseudonymous',
		message: 'a well-formed record',
		...overrides
	};
}

describe('ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE', () => {
	it('a malformed event name prints the indexed line and drops the record', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		emitOperationalEvent(validRecord({ event: 'not a dot name' }));
		const indexed = error.mock.calls.filter((c) => String(c[0]).includes('[ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE]'));
		expect(indexed).toHaveLength(1);
	});

	it('an unserializable attribute is absorbed by the stripped retry, with no error line', () => {
		// The entry's cause draws exactly this boundary: a field that cannot be
		// serialized does NOT die at record construction and does NOT print the
		// render-collapse line - the envelope appears minus its attributes.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		emitOperationalEvent(validRecord({ attributes: { impossible: BigInt(1) } }));
		const lines = error.mock.calls.map((c) => String(c[0]));
		expect(lines.some((l) => l.includes('claims.case')), `the envelope must print: ${lines.join(' | ')}`).toBe(true);
		expect(lines.some((l) => l.includes('[ADAPTER-ERR-')), `no indexed failure line may print: ${lines.join(' | ')}`).toBe(false);
	});
});

describe('ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE', () => {
	it('a throwing warn channel loses the warn record and reports through console.error', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('write end gone'); });
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		emitOperationalEvent(validRecord({ severity: 'warn' }));
		// The formatted line was handed to its own method...
		expect(warn.mock.calls.length).toBe(1);
		expect(String(warn.mock.calls[0][0])).toContain('claims.case');
		// ...and the failure surfaced on the DIFFERENT method the entry names.
		const indexed = error.mock.calls.filter((c) => String(c[0]).includes('[ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE]'));
		expect(indexed).toHaveLength(1);
		expect(String(indexed[0][0])).toContain('claims.case');
	});

	it('fatal rides console.error, so a broken error channel loses both severities', () => {
		// The entry's consequence: error and fatal share one method. A stub that
		// throws still records what was handed to it - the evidence that the
		// fatal line was destined for console.error, and that the failure line
		// (same channel) could only be swallowed.
		const error = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('write end gone'); });
		emitOperationalEvent(validRecord({ severity: 'fatal' }));
		const handed = error.mock.calls.map((c) => String(c[0]));
		expect(handed.some((l) => l.includes('claims.case') && l.includes('severity=fatal')),
			`the fatal line must be handed to console.error: ${handed.join(' | ')}`).toBe(true);
		expect(handed.some((l) => l.includes('[ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE]')),
			'the failure report itself rides the same broken channel').toBe(true);
	});
});

describe('ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE', () => {
	it('the notice window needs the clock to succeed for the event and fail for the notice', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		let calls = 0;
		setRuntimeEnv({
			clock: {
				wallEpoch: () => {
					calls++;
					if (calls >= 2) throw new Error('clock detached');
					return 1755302400000;
				}
			}
		});
		setOperationalEventSink(() => { throw new Error('sink refused'); });
		emitOperationalEvent(validRecord());

		const lines = error.mock.calls.map((c) => String(c[0]));
		// The consequence's first half: the EVENT is in the log via the
		// fallback; only the machine-readable notice is lost.
		expect(lines.some((l) => l.includes('claims.case') && !l.includes('[ADAPTER-ERR-')),
			`the original event must be fallback-printed: ${lines.join(' | ')}`).toBe(true);
		expect(lines.some((l) => l.includes('[ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE]')),
			`the indexed notice-loss line must print: ${lines.join(' | ')}`).toBe(true);
	});

	it('the composed emitter takes the same guard: a broken clock cannot escape the telemetry layer', () => {
		// The composed boot-lane emitters sit on failure paths; a record
		// construction throw escaping here would replace the failure being
		// reported with a crash in the telemetry itself.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		setRuntimeEnv({ clock: { wallEpoch: () => { throw new Error('clock detached'); } } });
		expect(() => emitOperationalDiagnostic({
			level: 'error', event: 'claims.composed', component: 'runtime.observability',
			problem: 'p', effect: 'e', recovery: 'r', action: 'a', willRetry: false
		})).not.toThrow();
		const lines = error.mock.calls.map((c) => String(c[0]));
		expect(lines.some((l) => l.includes('[ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE]')),
			`the record-shape line must print: ${lines.join(' | ')}`).toBe(true);
	});

	it('a clock broken outright dies earlier and prints the record-shape line instead', () => {
		// The recovery's intermittency claim: this is why a persistently broken
		// clock cannot keep printing the sink-notice line beside every event.
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		setRuntimeEnv({ clock: { wallEpoch: () => { throw new Error('clock detached'); } } });
		setOperationalEventSink(() => { throw new Error('sink refused'); });
		emitOperationalEvent(validRecord());
		const lines = error.mock.calls.map((c) => String(c[0]));
		expect(lines.some((l) => l.includes('[ADAPTER-ERR-DIAGNOSTIC-RECORD-SHAPE]')),
			`record construction is where it dies: ${lines.join(' | ')}`).toBe(true);
		expect(lines.some((l) => l.includes('[ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE]')),
			'the sink-notice line must NOT print - the sink was never reached').toBe(false);
	});
});
