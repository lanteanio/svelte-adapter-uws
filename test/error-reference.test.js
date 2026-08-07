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
	adapterErrorHelpSuffix,
	adapterErrorMessage
} from '../src/runtime/error-registry.js';
import { formatDiagnostic } from '../src/runtime/diagnostic-format.js';
import { TELEMETRY_LEVELS } from '../src/runtime/observability-manifest.js';
import { uwsLoadErrorMessage } from '../src/uws-load-hint.js';
import {
	checkSiblingDocuments,
	findGhostRegistryEntries,
	findUnindexedFailures,
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
		expect(doc).toContain('### Informational events');
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
			// Informational on purpose: a failure severity would be caught by the
			// coverage gate instead, which is a different rule with its own test.
			events: [...scan.events, {
				event: 'zz-added.diagnostic.emitted',
				components: ['runtime.zz-added'],
				severities: ['debug'],
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

	// The short link exists because adapterErrorMessage/adapterErrorProblem append
	// it to text a console prints, and a console cannot resolve a repo-relative
	// route. Entries emitted through emitOperationalEvent append no suffix, so a
	// short link there would be an unredeemed promise to a route nobody serves.
	it('gives runtime-rendered entries an absolute short link and the rest none', () => {
		const rendered = new Set(['thrown', 'composed']);
		for (const entry of byId.values()) {
			if (rendered.has(entry.emission)) {
				expect(entry.link, entry.id).toMatch(/^https:\/\/svti\.me\/[a-z0-9-]+$/);
				expect(adapterErrorHelpSuffix(entry.id)).toContain(entry.link);
			} else {
				expect(entry.link, entry.id + ' is not rendered into runtime text').toBeUndefined();
				expect(adapterErrorHelpSuffix(entry.id)).toContain(entry.help);
			}
		}
	});

	// The strongest binding available: build the line the runtime would actually
	// print and require the documented prefix to be its beginning. A prefix that
	// only agrees with itself would survive any drift in the diagnostic format.
	it('documents a prefix that real emitted text actually starts with', () => {
		const emitted = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission === 'direct');
		expect(emitted.length).toBeGreaterThan(20);
		for (const entry of emitted) {
			const line = formatDiagnostic({
				source: 'svelte-adapter-uws',
				component: entry.component,
				event: entry.event,
				severity: entry.severity,
				message: entry.problemPrefix
			});
			expect(line.startsWith(entry.messagePrefix), entry.id + ': ' + line).toBe(true);
		}
		// The head shape stops before the varying severity, so it is a prefix of
		// the same line at whichever severity the call site chose.
		const head = ADAPTER_ERROR_REGISTRY.find((entry) => entry.emission === 'head');
		for (const severity of ['error', 'warn', 'fatal']) {
			const line = formatDiagnostic({
				source: 'svelte-adapter-uws',
				component: head.component,
				event: head.event,
				severity,
				message: 'some.category'
			});
			expect(line.startsWith(head.messagePrefix), severity).toBe(true);
		}
	});

	// Round-tripping the real emission sites: every literal message the runtime
	// passes to emitOperationalEvent for an indexed event must be the documented
	// problemPrefix, or the reference documents text that was since reworded.
	it('keeps every indexed problemPrefix equal to the emitted literal', () => {
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			if (entry.emission !== 'direct') continue;
			const found = entry.sources.some((source) => read(source).includes("message: '" + entry.problemPrefix + "'"));
			expect(found, entry.id + ': no source emits the documented message literal').toBe(true);
		}
	});

	// A severity outside TELEMETRY_LEVELS does not degrade: createDiagnostic
	// rejects the record and emitOperationalEvent DROPS it, so the diagnostic is
	// never seen. `cluster-relay.frame-refused` shipped as 'warning' and was
	// therefore invisible - and it reports a silent cross-worker publish split,
	// which is the class of fault that most needs to be visible.
	it('emits every indexed severity as a real telemetry level', () => {
		const levels = new Set(TELEMETRY_LEVELS);
		for (const entry of ADAPTER_ERROR_REGISTRY) {
			if (entry.severity === null) continue;
			expect(levels.has(entry.severity), entry.id + ' declares severity ' + entry.severity).toBe(true);
		}
		// The source, not just the registry: a literal the runtime passes to an
		// emission is what decides whether the event survives.
		const offenders = [];
		for (const file of new Set(ADAPTER_ERROR_REGISTRY.flatMap((entry) => entry.sources))) {
			read(file).split(/\r?\n/).forEach((line, index) => {
				const match = /^\s*severity: '([a-z]+)'/.exec(line);
				if (match && !levels.has(match[1])) offenders.push(file + ':' + (index + 1) + ' -> ' + match[1]);
			});
		}
		expect(offenders, 'these emissions would be dropped, not downgraded').toEqual([]);
	});

	it('actually delivers a warn-severity relay diagnostic to a sink', async () => {
		const { emitOperationalEvent, setOperationalEventSink } = await import('../src/runtime/diagnostic.js');
		const entry = byId.get(ADAPTER_ERROR_IDS.RELAY_FRAME_REFUSED);
		const seen = [];
		setOperationalEventSink((record) => seen.push(record));
		try {
			emitOperationalEvent({
				source: 'svelte-adapter-uws',
				component: entry.component,
				event: entry.event,
				severity: entry.severity,
				dataClass: 'pseudonymous',
				message: entry.problemPrefix,
				attributes: {}
			});
		} finally {
			setOperationalEventSink(null);
		}
		expect(seen.map((record) => record.event)).toEqual([entry.event]);
		expect(seen[0].severity).toBe(entry.severity);
	});

	describe('coverage gate', () => {
		const informational = (event) => ({
			event, components: ['runtime.zz'], severities: ['debug'], sources: ['src/runtime/handler.js']
		});
		const failing = (event, severities) => ({
			event, components: ['runtime.zz'], severities, sources: ['src/runtime/handler.js']
		});

		it('passes on the real tree', () => {
			expect(findUnindexedFailures()).toEqual([]);
		});

		it('refuses a new failure event that has no registry entry', () => {
			const scan = { idKeyReferences: new Set(), events: [failing('zz.broke', ['error'])] };
			const [message] = findUnindexedFailures(scan, ADAPTER_ERROR_REGISTRY);
			expect(message).toContain('zz.broke');
			expect(message).toContain('no entry in ADAPTER_ERROR_REGISTRY');
			// renderErrorReference refuses to produce a document at all, so the
			// gap cannot be published as a coverage row.
			expect(() => renderErrorReference(ADAPTER_ERROR_REGISTRY, { scan })).toThrow(/zz\.broke/);
		});

		it('exempts an informational event by severity, not by name', () => {
			const name = 'zz.notice';
			expect(findUnindexedFailures({ idKeyReferences: new Set(), events: [informational(name)] })).toEqual([]);
			// Same name, promoted: the exemption follows the severity it is
			// emitted at, so it cannot be inherited by a later failure.
			expect(findUnindexedFailures({ idKeyReferences: new Set(), events: [failing(name, ['warn'])] }))
				.toHaveLength(1);
		});

		it('treats every failure spelling and an unreadable severity as failures', () => {
			for (const severities of [['error'], ['fatal'], ['warn'], ['warning'], [], ['debug', 'error']]) {
				expect(findUnindexedFailures({ idKeyReferences: new Set(), events: [failing('zz.x', severities)] }),
					JSON.stringify(severities)).toHaveLength(1);
			}
		});
	});

	describe('emission shapes', () => {
		const entryFor = (emission) => ADAPTER_ERROR_REGISTRY.find((entry) => entry.emission === emission);

		it('rejects a prefix that does not match its declared shape', () => {
			for (const emission of ['composed', 'direct', 'head']) {
				const entry = { ...entryFor(emission), messagePrefix: 'not the real line' };
				expect(validateErrorRegistry([entry]).join('\n'), emission).toContain('prefix does not');
			}
		});

		it('rejects a composed entry at a warning severity', () => {
			const entry = { ...entryFor('composed'), severity: 'warn' };
			expect(validateErrorRegistry([entry]).join('\n')).toContain('composed entry is fatal or error');
		});

		it('rejects an unknown emission', () => {
			const entry = { ...entryFor('direct'), emission: 'telepathy' };
			expect(validateErrorRegistry([entry]).join('\n')).toContain('unknown emission');
		});
	});
});
