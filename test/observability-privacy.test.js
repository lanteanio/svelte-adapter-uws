import { describe, expect, it } from 'vitest';
import { formatDiagnostic } from '../src/runtime/diagnostic.js';
import { privateValueMetadata } from '../src/runtime/utils/observability-privacy.js';

describe('observability privacy metadata', () => {
	it('correlates a private topic inside one process without retaining it', () => {
		const raw = 'org:customer-123:secret';
		const first = privateValueMetadata(raw, 'topic');
		const second = privateValueMetadata(raw, 'topic');
		const other = privateValueMetadata(raw + '-other', 'topic');

		expect(first).toEqual(second);
		expect(first.ref).toMatch(/^topic:[A-Za-z0-9_-]{16}$/);
		expect(first.ref).not.toBe(other.ref);
		expect(first.chars).toBe(raw.length);
		expect(JSON.stringify(first)).not.toContain(raw);
	});

	it('keeps the canonical physical diagnostic free of the private value', () => {
		const raw = 'tenant:alice@example.test:password';
		const line = formatDiagnostic({
			source: 'svelte-adapter-uws',
			component: 'runtime.pressure',
			event: 'pressure.runaway-publisher',
			severity: 'warn',
			dataClass: 'pseudonymous',
			message: 'A publisher crossed a configured per-topic pressure threshold.',
			attributes: { topic: privateValueMetadata(raw, 'topic') }
		});

		expect(line).not.toContain(raw);
		expect(line).toContain('"dataClass":"pseudonymous"');
		expect(line).toContain('"ref":"topic:');
	});

	it('does not invoke hostile object conversion on a diagnostic path', () => {
		const hostile = new Proxy({}, {
			get() {
				throw new Error('must not be read');
			}
		});
		expect(() => privateValueMetadata(hostile, 'error')).not.toThrow();
		expect(privateValueMetadata(hostile, 'error')).toEqual({
			dataClass: 'pseudonymous',
			kind: 'error',
			valueType: 'object'
		});
	});
});
