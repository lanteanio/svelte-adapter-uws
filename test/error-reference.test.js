import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	formatOperationalDiagnostic,
	listenFailureDiagnostic,
	viteHandlerFailureDiagnostic
} from '../src/runtime/utils/operational-diagnostic.js';
import {
	ADAPTER_ERROR_IDS,
	ADAPTER_ERROR_REGISTRY,
	adapterErrorMessage
} from '../src/runtime/error-registry.js';
import { uwsLoadErrorMessage } from '../src/uws-load-hint.js';
import {
	checkSiblingDocuments,
	findGhostRegistryEntries,
	renderErrorReference,
	releaseDocumentationRef,
	scanEmittedEvents,
	validateErrorRegistry
} from '../scripts/generate-error-reference.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const byId = new Map(ADAPTER_ERROR_REGISTRY.map((entry) => [entry.id, entry]));

describe('generated operational error reference', () => {
	it('keeps unique stable ids, anchors, and complete operator fields', () => {
		expect(validateErrorRegistry(ADAPTER_ERROR_REGISTRY)).toEqual([]);
		expect(validateErrorRegistry([
			...ADAPTER_ERROR_REGISTRY,
			{ ...ADAPTER_ERROR_REGISTRY[0] }
		])).toContain('ADAPTER-ERR-LISTEN: duplicate stable id');
		expect(validateErrorRegistry([{
			...ADAPTER_ERROR_REGISTRY[0],
			id: 'ADAPTER-ERR-MISSING-SOURCE',
			anchor: 'adapter-err-missing-source',
			help: 'docs/errors.md#adapter-err-missing-source',
			messagePrefix: 'missing source',
			component: null,
			problemPrefix: null,
			sources: ['src/not-present.js']
		}])).toContain('ADAPTER-ERR-MISSING-SOURCE: missing or out-of-root source: src/not-present.js');
	});

	it('matches generated documentation byte for byte', () => {
		expect(read('docs/errors.md')).toBe(renderErrorReference());
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			expect(read('docs/errors.md')).toContain('<a id="' + entry.anchor + '"></a>');
			expect(read('docs/errors.md')).toContain(entry.messagePrefix);
			expect(read('docs/errors.md')).toContain(entry.help);
		}
		expect(releaseDocumentationRef('0.6.0-next.91')).toBe('dev');
		expect(releaseDocumentationRef('0.6.0')).toBe('main');
		expect(renderErrorReference(ADAPTER_ERROR_REGISTRY, { siblingRef: 'dev' })).toContain('/blob/dev/docs/errors.md');
	});

	it('binds operational and native message prefixes to emitted text', () => {
		const listen = formatOperationalDiagnostic(listenFailureDiagnostic('127.0.0.1', 3000));
		expect(listen.startsWith(byId.get(ADAPTER_ERROR_IDS.LISTEN).messagePrefix)).toBe(true);
		expect(listen).toContain('[' + ADAPTER_ERROR_IDS.LISTEN + ']');
		const viteLoad = formatOperationalDiagnostic(viteHandlerFailureDiagnostic({
			phase: 'load', source: 'src/hooks.ws.js', host: '127.0.0.1', port: 5173, error: new Error('bad import')
		}));
		expect(viteLoad.startsWith(byId.get(ADAPTER_ERROR_IDS.VITE_LOAD).messagePrefix)).toBe(true);
		// The console help route renders the entry's absolute link when one is
		// declared; only link-less entries render the package-local doc route.
		const viteLoadEntry = byId.get(ADAPTER_ERROR_IDS.VITE_LOAD);
		expect(viteLoad).toContain(' See: ' + (viteLoadEntry.link ?? viteLoadEntry.help));
		expect(formatOperationalDiagnostic(viteHandlerFailureDiagnostic({
			phase: 'reload', source: 'src/hooks.ws.js', host: '127.0.0.1', port: 5173, error: new Error('bad import')
		})).startsWith(byId.get(ADAPTER_ERROR_IDS.VITE_RELOAD).messagePrefix)).toBe(true);
		expect(uwsLoadErrorMessage(undefined, new Error('wrong ABI'))
			.startsWith(byId.get(ADAPTER_ERROR_IDS.NATIVE_LOAD).messagePrefix)).toBe(true);
		expect(uwsLoadErrorMessage(undefined, new Error('wrong ABI'))).toContain(ADAPTER_ERROR_IDS.NATIVE_LOAD);
	});

	it('derives the emitted event inventory from the runtime source', () => {
		const scan = scanEmittedEvents();
		const names = scan.events.map((record) => record.event);
		expect(new Set(names).size).toBe(names.length);
		for (const expected of [
			'runtime.ssr.failed',
			'runtime.websocket-upgrade.failed',
			'runtime.authenticate.failed',
			'runtime.relay-gap.detected',
			'operational.sink.failed',
			'invariant.violated',
			'pressure.runaway-publisher',
			'pressure.topic-registry-high',
			'pressure.listener-failed',
			'pressure.publish-rate-listener-failed'
		]) expect(names).toContain(expected);
		for (const record of scan.events) {
			expect(record.sources.length).toBeGreaterThan(0);
			for (const source of record.sources) expect(source).toMatch(/^src\//);
		}
		expect(scan.idKeyReferences.has('LISTEN')).toBe(true);
		expect(scan.idKeyReferences.has('REQUEST_TIMEOUT')).toBe(true);
	});

	it('lists every emitted event in the generated documentation', () => {
		const doc = read('docs/errors.md');
		expect(doc).toContain('## Emitted diagnostic event coverage');
		expect(doc).toContain('### Emitted diagnostics not yet in the indexed reference');
		for (const record of scanEmittedEvents().events) {
			expect(doc).toContain('`' + record.event + '`');
		}
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			expect(doc).toContain('- `' + entry.event + '` - [' + entry.id + '](#' + entry.anchor + ')');
		}
	});

	it('fails the drift gate when the emitted inventory changes without regeneration', () => {
		const scan = scanEmittedEvents();
		const grown = {
			idKeyReferences: scan.idKeyReferences,
			events: [...scan.events, {
				event: 'zz-added.diagnostic.emitted',
				components: ['runtime.zz-added'],
				severities: ['error'],
				sources: ['src/runtime/handler.js']
			}]
		};
		const current = renderErrorReference();
		const regenerated = renderErrorReference(ADAPTER_ERROR_REGISTRY, { scan: grown });
		expect(regenerated).not.toBe(current);
		expect(regenerated).toContain('zz-added.diagnostic.emitted');
		// checkErrorReference compares docs/errors.md byte for byte against the
		// regenerated text, so the changed inventory fails --check until --write.
		expect(read('docs/errors.md')).toBe(current);
		expect(read('docs/errors.md')).not.toBe(regenerated);
	});

	it('rejects ghost registry entries whose event nothing emits', () => {
		expect(findGhostRegistryEntries(ADAPTER_ERROR_REGISTRY)).toEqual([]);
		const ghost = {
			...ADAPTER_ERROR_REGISTRY[0],
			id: 'ADAPTER-ERR-GHOST',
			anchor: 'adapter-err-ghost',
			help: 'docs/errors.md#adapter-err-ghost',
			messagePrefix: 'ghost prefix',
			component: null,
			problemPrefix: null,
			event: 'ghost.never-emitted',
			sources: ['src/runtime/diagnostic.js']
		};
		const failures = findGhostRegistryEntries([ghost]);
		expect(failures.length).toBe(1);
		expect(failures[0]).toContain('ADAPTER-ERR-GHOST');
		expect(failures[0]).toContain('ghost.never-emitted');
		expect(() => renderErrorReference([ghost])).toThrow(/ghost\.never-emitted/);
	});

	it('soft-checks sibling error documents only when a checkout exists', () => {
		const parent = mkdtempSync(join(tmpdir(), 'sibling-errors-'));
		try {
			expect(checkSiblingDocuments(parent)).toEqual([]);
			mkdirSync(join(parent, 'svelte-realtime'));
			const failures = checkSiblingDocuments(parent);
			expect(failures.length).toBe(1);
			expect(failures[0]).toContain('svelte-realtime');
			expect(failures[0]).toContain('docs/errors.md');
			expect(failures[0]).toContain('SIBLING_ERROR_DOCUMENTS');
			mkdirSync(join(parent, 'svelte-realtime', 'docs'));
			writeFileSync(join(parent, 'svelte-realtime', 'docs', 'errors.md'), '# errors\n');
			expect(checkSiblingDocuments(parent)).toEqual([]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it('binds request rejection messages to the registry in production and Vite', () => {
		for (const source of byId.get(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT).sources) {
			expect(read(source)).toContain('ADAPTER_ERROR_IDS.REQUEST_TIMEOUT');
		}
		for (const source of byId.get(ADAPTER_ERROR_IDS.REQUEST_CLOSED).sources) {
			expect(read(source)).toContain('ADAPTER_ERROR_IDS.REQUEST_CLOSED');
		}
		const message = adapterErrorMessage(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT);
		expect(message.startsWith(byId.get(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT).messagePrefix)).toBe(true);
		expect(message).toContain('[' + ADAPTER_ERROR_IDS.REQUEST_TIMEOUT + ']');
		// Consumer-visible text carries the ABSOLUTE short link - a console
		// cannot resolve a repository-relative route.
		expect(message).toContain(byId.get(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT).link);
		expect(byId.get(ADAPTER_ERROR_IDS.REQUEST_TIMEOUT).link).toMatch(/^https:\/\/svti\.me\//);
	});

	it('gives every stable registry entry an absolute short link for runtime text', () => {
		for (const entry of byId.values()) {
			expect(entry.link, entry.id).toMatch(/^https:\/\/svti\.me\/[a-z0-9-]+$/);
		}
	});
});
