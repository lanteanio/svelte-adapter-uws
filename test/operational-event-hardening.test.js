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
