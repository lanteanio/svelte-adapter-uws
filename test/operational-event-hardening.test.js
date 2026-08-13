// The operational-event pipeline is called from inside catch blocks on
// timers and request paths - places where a throw becomes an uncaught
// exception that kills the worker. That is not theoretical: an invalid
// dataClass at two pressure listener-failure sites once turned a throwing
// user onPressure callback into a worker crash, because createDiagnostic
// validated the class by throwing and nothing above it caught. These tests
// pin the two layers of the fix: emitOperationalEvent is total (it can drop
// an event, never throw), and every dataClass literal in the runtime is a
// declared class so nothing is ever dropped for that reason.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosticError, emitOperationalEvent, setOperationalEventSink } from '../src/runtime/diagnostic.js';
import { getRuntimeEnv, resetRuntimeEnv, setRuntimeEnv } from '../src/runtime/runtime.js';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { DATA_CLASSES } from '../src/runtime/observability-manifest.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(absolute));
		else if (entry.isFile() && absolute.endsWith('.js')) files.push(absolute);
	}
	return files;
}

afterEach(() => {
	vi.restoreAllMocks();
	try { setOperationalEventSink(null); } catch { /* sink API absent */ }
});

describe('operational event hardening', () => {
	it('emitOperationalEvent never throws: an invalid record is dropped to console, not raised', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		let record;
		expect(() => {
			record = emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.pressure',
				event: 'pressure.listener-failed',
				severity: 'error',
				dataClass: 'not-a-declared-class',
				message: 'A pressure listener failed.',
				attributes: {}
			});
		}).not.toThrow();
		expect(record).toBeNull();
		expect(consoleError).toHaveBeenCalled();
	});

	it('the default console sink survives unserializable attributes', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => {
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.test',
				event: 'test.unserializable',
				severity: 'error',
				message: 'Attributes that JSON.stringify rejects.',
				attributes: { big: BigInt(7) }
			});
		}).not.toThrow();
		// The envelope still reached the console even though the attributes
		// could not be rendered.
		expect(consoleError).toHaveBeenCalled();
	});

	// The three last-resort lines below are the pipeline reporting its own
	// collapse, and each one's registry entry sends an operator somewhere
	// specific. Nothing executed them until now, so the entries could - and did -
	// describe conditions their own code cannot produce: one blamed the formatter
	// for a console that refused a well-formed line, the other reported two lost
	// records when the first had already printed. A gate cannot read prose; these
	// drive each line from the condition it claims to be about.
	function printedErrors(spy) {
		return spy.mock.calls.flat().filter((value) => typeof value === 'string').join('\n');
	}

	it('separates a console that refuses the line from a record that cannot be rendered', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		// Nothing wrong with this record. The WARN channel is broken - a host that
		// wrapped the console, a transport whose write end is gone.
		vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('transport gone'); });

		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.test',
			event: 'test.console-write',
			severity: 'warn',
			message: 'A record that formats perfectly well.',
			attributes: { ok: true }
		});

		const printed = printedErrors(consoleError);
		expect(printed).toContain('ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE');
		// The formatter never failed. Reporting this as a render collapse told the
		// operator to go and inspect the envelope of a record that is fine.
		expect(printed).not.toContain('ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE');
	});

	it('reports a render collapse when the process serialization itself is broken', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		// The record here is entirely valid. What is broken is the serialization
		// the format is built on, which is the ONLY thing that can fail both
		// attempts - see the case below for why the record never can.
		vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('serializer patched'); });

		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.test',
			event: 'test.render-collapse',
			severity: 'error',
			message: 'A perfectly valid record.',
			attributes: {}
		});

		const printed = printedErrors(consoleError);
		expect(printed).toContain('ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE');
		expect(printed).toContain('test.render-collapse');
		expect(printed).not.toContain('ADAPTER-ERR-DIAGNOSTIC-CONSOLE-WRITE');
	});

	it('cannot be driven into a render collapse by any record the runtime accepts', () => {
		// This is the property the entry above rests on, and the reason its
		// guidance sends an operator at the process rather than at the emitter.
		// The retry strips the attributes, and everything createDiagnostic leaves
		// behind is a bounded string or number it produced itself - the message is
		// cut to 512 characters at creation - so the second attempt has nothing
		// left that JSON can refuse. Every hostile payload below is absorbed.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const circular = /** @type {any} */ ({});
		circular.self = circular;
		const hostile = [
			['bigint', { big: BigInt(7) }],
			['circular', circular],
			['throwing-getter', { get boom() { throw new Error('hostile getter'); } }],
			['huge-message', { note: 'x'.repeat(4096) }]
		];

		for (const [name, attributes] of hostile) {
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.test',
				event: 'test.hostile-payload',
				severity: 'error',
				message: 'y'.repeat(4096),
				attributes
			});
			expect(printedErrors(consoleError), name).not.toContain('ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE');
		}
	});

	it('cannot be driven into a render collapse by a sink that mutates the record', () => {
		// A configured sink is handed the record by reference. One that mutated a
		// validated field and then threw gave the fallback a record it could no
		// longer rebuild, and that reached the render collapse with the process
		// serializer perfectly healthy - the one cause that entry rules out. The
		// record is frozen at the trust boundary now, so the mutation is refused
		// rather than absorbed and then documented.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		/** @type {any} */
		let seen = null;
		setOperationalEventSink((record) => {
			seen = record;
			// Both of these would produce the collapse if they landed: severity
			// makes the rebuild fail validation, message makes it unserializable.
			try { record.severity = 'not-a-severity'; } catch { /* refused, which is the point */ }
			try { record.message = BigInt(7); } catch { /* refused */ }
			throw new Error('sink down');
		});

		emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.test',
			event: 'test.mutating-sink',
			severity: 'error',
			message: 'A valid record handed to a hostile sink.',
			attributes: {}
		});

		const printed = printedErrors(consoleError);
		expect(JSON.stringify({}), 'the serializer is healthy throughout').toBe('{}');
		expect(printed).not.toContain('ADAPTER-ERR-DIAGNOSTIC-RENDER-COLLAPSE');
		// The ordinary fallback ran instead: the event and its sink-failure notice.
		expect(printed).toContain('A valid record handed to a hostile sink.');
		expect(printed).toContain('operational.sink.failed');
		expect(Object.isFrozen(seen), 'the sink must not receive a mutable record').toBe(true);
	});

	it('points the render-collapse guidance at the process, never at the emitter', () => {
		// Three of these entries have now shipped guidance for a state their own
		// code cannot be in, and a counting gate cannot see it. The case above
		// produces this line from a VALID record emitted by the adapter itself, so
		// any guidance naming the record or its emitter as the thing to inspect is
		// wrong by construction, whatever else it says.
		const entry = ADAPTER_ERROR_REGISTRY.find(
			(candidate) => candidate.id === ADAPTER_ERROR_IDS.DIAGNOSTIC_RENDER_COLLAPSE
		);
		expect(entry, 'the render-collapse entry must exist').toBeTruthy();
		expect(entry.nextAction).toMatch(/JSON\.stringify/);
		expect(entry.nextAction).toMatch(/not (a suspect|start at the emitter)/);
	});

	it('keeps the original event when a broken sink is reported and the notice cannot be built', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		setOperationalEventSink(() => { throw new Error('sink down'); });
		// The notice stamps its own wall clock and this one refuses. The event
		// under test carries an explicit occurredAt, so the broken clock is met
		// ONLY while building the notice - the shape the entry now describes.
		const base = getRuntimeEnv();
		setRuntimeEnv({
			...base,
			clock: { ...base.clock, wallEpoch: () => { throw new Error('clock gone'); } }
		});

		try {
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: 'runtime.test',
				event: 'test.sink-notice',
				severity: 'error',
				message: 'The sink will refuse this one.',
				occurredAt: '2026-08-02T12:00:00.000Z',
				attributes: {}
			});
		} finally {
			resetRuntimeEnv();
		}

		const printed = printedErrors(consoleError);
		expect(printed).toContain('ADAPTER-ERR-DIAGNOSTIC-SINK-NOTICE');
		// The original event is NOT lost. It is printed by the console fallback
		// before anything about the notice can fail, which is why telling an
		// operator that two records went missing was wrong.
		expect(printed).toContain('[lantean/diagnostic');
		expect(printed).toContain('The sink will refuse this one.');
	});

	it('every dataClass literal in the runtime names a declared class', () => {
		// The totality guard above stops a crash; this stops the silent
		// event-drop that an undeclared class would now cause instead.
		const declared = new Set(Object.keys(DATA_CLASSES));
		const offenders = [];
		for (const file of walk(srcDir)) {
			const source = readFileSync(file, 'utf8');
			// Either quote style, any casing: a quoted literal that is not a
			// declared class is an offense regardless of how it is spelled.
			for (const match of source.matchAll(/dataClass:\s*['"]([\w-]+)['"]/g)) {
				if (!declared.has(match[1])) {
					offenders.push(path.relative(srcDir, file) + ': ' + match[1]);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it('classifies caught values with bounded name, code, and message', () => {
		const err = new Error('x'.repeat(2000));
		/** @type {any} */ (err).code = 'E_SOMETHING';
		expect(diagnosticError(err)).toEqual({
			name: 'Error',
			code: 'E_SOMETHING',
			message: 'x'.repeat(512)
		});
		expect(diagnosticError('plain string')).toEqual({
			name: 'Error',
			code: null,
			message: 'plain string'
		});
		const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
		expect(() => diagnosticError(hostile)).not.toThrow();
	});

	it('the pressure listener-failure record shape is valid and pseudonymous', () => {
		// The exact input src/runtime/handler/pressure-metrics.js emits when a
		// user onPressure callback throws: it must produce a real record, not
		// a drop and not a throw.
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const record = emitOperationalEvent({
			source: 'svelte-adapter-uws',
			component: 'runtime.pressure',
			event: 'pressure.listener-failed',
			severity: 'error',
			dataClass: 'pseudonymous',
			message: 'A pressure listener failed.',
			attributes: { error: diagnosticError(new Error('listener boom')) }
		});
		expect(record).not.toBeNull();
		expect(record.dataClass).toBe('pseudonymous');
		expect(record.attributes.error.message).toBe('listener boom');
		expect(consoleError).toHaveBeenCalledTimes(1);
	});
});
