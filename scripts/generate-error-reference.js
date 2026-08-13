#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_ERROR_IDS, ADAPTER_ERROR_REGISTRY } from '../src/runtime/error-registry.js';
import { DIAGNOSTIC_PREFIX } from '../src/runtime/diagnostic-format.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'docs', 'errors.md');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// The emitted-event inventory is derived from the runtime source at generation
// time, so a new diagnostic emission makes --check fail until --write reruns.
// The registry module is excluded from the scan: its event fields declare the
// index itself, and counting them as emissions would make the ghost-entry
// validation below vacuous.
const EVENT_SCAN_DIRECTORIES = Object.freeze(['src/runtime']);
// src/testing.js is a published entry point that emits diagnostics of its own,
// so leaving it unscanned let a shipped failure event escape the coverage gate.
const EVENT_SCAN_FILES = Object.freeze(['src/observability.js', 'src/vite.js', 'src/testing.js']);
const EVENT_SCAN_EXCLUDED = Object.freeze(['src/runtime/error-registry.js']);
const EVENT_LITERAL = /event: '([a-z][a-z0-9.-]*)'/;
const EVENT_CONTEXT_LINES = 6;

// The runtime spells the same band both ways at different call sites, so both
// count as a failure here rather than one silently escaping the coverage gate.
const FAILURE_SEVERITIES = new Set(['fatal', 'error', 'warn', 'warning']);
const INFORMATIONAL_SEVERITIES = new Set(['debug', 'info', 'trace']);

// Where each sibling package keeps its own error reference. A documentPath of
// null links the repository root and states that the reference lives with that
// package. checkSiblingDocuments() soft-verifies these paths against local
// checkouts next to this repository, so a sibling moving its document fails
// --check here instead of silently shipping a dead link.
const SIBLING_ERROR_DOCUMENTS = Object.freeze([
	Object.freeze({ repo: 'svelte-realtime', label: 'svelte-realtime errors', documentPath: 'docs/errors.md' }),
	Object.freeze({ repo: 'svelte-adapter-uws-extensions', label: 'svelte-adapter-uws-extensions errors', documentPath: 'ERRORS.md' })
]);
const SIBLING_DOCUMENT_CANDIDATES = Object.freeze(['docs/errors.md', 'ERRORS.md']);

export function releaseDocumentationRef(version = packageVersion) {
	return String(version).includes('-') ? 'dev' : 'main';
}

function eventScanFiles() {
	const files = [];
	const walk = (relativeDirectory) => {
		for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
			const relativePath = relativeDirectory + '/' + entry.name;
			if (entry.isDirectory()) walk(relativePath);
			else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(relativePath);
		}
	};
	for (const directory of EVENT_SCAN_DIRECTORIES) walk(directory);
	for (const file of EVENT_SCAN_FILES) if (existsSync(join(root, file))) files.push(file);
	return files.filter((file) => !EVENT_SCAN_EXCLUDED.includes(file)).sort();
}

/**
 * Every diagnostic event the runtime emits as a literal, with the component
 * and severity read from the surrounding emission when they are literals too.
 * Also collects which ADAPTER_ERROR_IDS keys the runtime references, because
 * registry-backed events are emitted through the registry helpers rather than
 * as event-name literals.
 *
 * @returns {{ events: { event: string, components: string[], severities: string[], sources: string[] }[], idKeyReferences: Set<string> }}
 */
export function scanEmittedEvents() {
	const byEvent = new Map();
	const idKeyReferences = new Set();
	for (const file of eventScanFiles()) {
		const content = readFileSync(join(root, file), 'utf8');
		for (const reference of content.matchAll(/ADAPTER_ERROR_IDS\.([A-Z0-9_]+)/g)) {
			idKeyReferences.add(reference[1]);
		}
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index++) {
			const match = EVENT_LITERAL.exec(lines[index]);
			if (!match) continue;
			let record = byEvent.get(match[1]);
			if (!record) {
				record = { event: match[1], components: new Set(), severities: new Set(), sources: new Set() };
				byEvent.set(match[1], record);
			}
			record.sources.add(file);
			const first = Math.max(0, index - EVENT_CONTEXT_LINES);
			const last = Math.min(lines.length - 1, index + EVENT_CONTEXT_LINES);
			for (let context = first; context <= last; context++) {
				const component = /component: '([a-z][a-z0-9.-]*)'/.exec(lines[context]);
				if (component) record.components.add(component[1]);
				const severity = /(?:severity|level): '([a-z]+)'/.exec(lines[context]);
				if (severity) record.severities.add(severity[1]);
			}
		}
	}
	const events = [...byEvent.values()]
		.map((record) => ({
			event: record.event,
			components: [...record.components].sort(),
			severities: [...record.severities].sort(),
			sources: [...record.sources].sort()
		}))
		.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
	return { events, idKeyReferences };
}

/**
 * A registry entry whose event nothing in the runtime emits is a ghost: its
 * documentation promises text that can never appear in a log. An entry counts
 * as emitted when its event is in the scanned inventory, when the runtime
 * references its ADAPTER_ERROR_IDS key, or when one of its declared source
 * files carries the event, the stable ID, or the key reference.
 *
 * @param {typeof ADAPTER_ERROR_REGISTRY} entries
 * @param {ReturnType<typeof scanEmittedEvents>} scan
 * @returns {string[]}
 */
export function findGhostRegistryEntries(entries = ADAPTER_ERROR_REGISTRY, scan = scanEmittedEvents()) {
	const errors = [];
	const keyById = new Map(Object.entries(ADAPTER_ERROR_IDS).map(([key, value]) => [value, key]));
	const scannedEvents = new Set(scan.events.map((record) => record.event));
	for (const entry of entries) {
		if (scannedEvents.has(entry.event)) continue;
		const key = keyById.get(entry.id);
		if (key && scan.idKeyReferences.has(key)) continue;
		let referenced = false;
		for (const source of entry.sources || []) {
			const sourcePath = resolve(root, source);
			if (isAbsolute(source) || relative(root, sourcePath).startsWith('..') || !existsSync(sourcePath)) continue;
			const content = readFileSync(sourcePath, 'utf8');
			if (content.includes("'" + entry.event + "'") ||
				content.includes(entry.id) ||
				(key && content.includes('ADAPTER_ERROR_IDS.' + key))) {
				referenced = true;
				break;
			}
		}
		if (!referenced) {
			errors.push((entry.id || 'registry entry') + ': event ' + entry.event +
				' is not emitted by any scanned runtime source and is not referenced from its declared sources');
		}
	}
	return errors;
}

/**
 * Soft drift check for the sibling links: when a sibling checkout exists next
 * to this repository, the referenced document must exist there. An absent
 * checkout is skipped silently so CI without sibling clones stays green.
 *
 * @param {string} parentDirectory
 * @returns {string[]}
 */
export function checkSiblingDocuments(parentDirectory = dirname(root)) {
	const errors = [];
	for (const sibling of SIBLING_ERROR_DOCUMENTS) {
		const checkout = join(parentDirectory, sibling.repo);
		if (!existsSync(checkout)) continue;
		if (sibling.documentPath === null) {
			for (const candidate of SIBLING_DOCUMENT_CANDIDATES) {
				if (existsSync(join(checkout, candidate))) {
					errors.push(sibling.repo + ': the local checkout now ships ' + candidate +
						' but this reference links only the repository root; update SIBLING_ERROR_DOCUMENTS in' +
						' scripts/generate-error-reference.js to point at it, then rerun --write');
				}
			}
			continue;
		}
		if (!existsSync(join(checkout, sibling.documentPath))) {
			errors.push(sibling.repo + ': the local checkout at ' + checkout + ' has no ' + sibling.documentPath +
				'; update SIBLING_ERROR_DOCUMENTS in scripts/generate-error-reference.js to the document that' +
				' repository actually ships (' + SIBLING_DOCUMENT_CANDIDATES.join(' or ') + '), or set documentPath' +
				' to null to link the repository root, then rerun --write');
		}
	}
	return errors;
}

export function validateErrorRegistry(entries) {
	const errors = [];
	const ids = new Set();
	const anchors = new Set();
	const prefixes = new Set();
	for (const [index, entry] of entries.entries()) {
		const label = entry.id || 'entry ' + (index + 1);
		if (!/^ADAPTER-ERR-[A-Z0-9-]+$/.test(entry.id || '')) errors.push(label + ': invalid stable id');
		if (ids.has(entry.id)) errors.push(label + ': duplicate stable id');
		ids.add(entry.id);
		if (!/^adapter-err-[a-z0-9-]+$/.test(entry.anchor || '')) errors.push(label + ': invalid anchor');
		if (anchors.has(entry.anchor)) errors.push(label + ': duplicate anchor');
		anchors.add(entry.anchor);
		if (prefixes.has(entry.messagePrefix)) errors.push(label + ': duplicate messagePrefix');
		prefixes.add(entry.messagePrefix);
		for (const field of ['event', 'messagePrefix', 'cause', 'consequence', 'automaticRecovery', 'nextAction', 'help']) {
			if (typeof entry[field] !== 'string' || !entry[field].trim()) errors.push(label + ': missing ' + field);
		}
		if (entry.help !== 'docs/errors.md#' + entry.anchor) errors.push(label + ': help route does not match anchor');
		// `link` is displayed by the runtime itself (the See: suffix on adapter
		// error messages), so its characters are load-bearing operator output:
		// only the registered shortlink domain is acceptable, and the value is
		// rendered into this generated document so any change is reviewed there.
		if (entry.link !== undefined && entry.link !== null &&
			(typeof entry.link !== 'string' || !/^https:\/\/svti\.me\/[a-z0-9-]+$/.test(entry.link))) {
			errors.push(label + ': link must be an https://svti.me/<slug> shortlink');
		}
		if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
			errors.push(label + ': missing sources');
		} else {
			for (const source of entry.sources) {
				const sourcePath = resolve(root, source);
				if (isAbsolute(source) || relative(root, sourcePath).startsWith('..') || !existsSync(sourcePath)) {
					errors.push(label + ': missing or out-of-root source: ' + source);
				}
			}
		}
		if (entry.code !== null && (typeof entry.code !== 'string' || !entry.code)) {
			errors.push(label + ': code must be a string or null');
		}
		// The emission shapes produce different lines. Validating the
		// declared prefix against the shape is what stops the reference promising
		// text no log will ever contain.
		const head = '[' + DIAGNOSTIC_PREFIX + ' source=svelte-adapter-uws component=' + entry.component +
			' event=' + entry.event + ' severity=';
		if (entry.emission === 'thrown') {
			if (entry.component !== null || entry.severity !== null || entry.problemPrefix !== null) {
				errors.push(label + ': a thrown entry carries no component, severity, or problemPrefix');
			}
		} else if (entry.emission === 'composed' || entry.emission === 'direct') {
			if (typeof entry.component !== 'string' || typeof entry.problemPrefix !== 'string') {
				errors.push(label + ': an emitted entry needs a component and a problemPrefix');
			}
			if (!FAILURE_SEVERITIES.has(entry.severity)) errors.push(label + ': invalid operational severity');
			if (entry.emission === 'composed' && entry.severity !== 'fatal' && entry.severity !== 'error') {
				errors.push(label + ': a composed entry is fatal or error');
			}
			const body = entry.emission === 'composed' ? entry.event + ': ' + entry.problemPrefix : entry.problemPrefix;
			if (entry.messagePrefix !== head + entry.severity + '] ' + body) {
				errors.push(label + ': ' + entry.emission + ' prefix does not match component, event, severity, and problemPrefix');
			}
		} else if (entry.emission === 'head') {
			if (typeof entry.component !== 'string' || entry.severity !== null || entry.problemPrefix !== null) {
				errors.push(label + ': a head entry carries a component but no fixed severity or problemPrefix');
			}
			if (entry.messagePrefix !== head) errors.push(label + ': head prefix does not stop where the variation begins');
		} else if (entry.emission === 'console') {
			// A console entry's prefix is the literal line beginning, so it must
			// not claim the diagnostic head it never carries, it must state a
			// real failure severity even though no event pipeline enforces one,
			// and it must open with an owned family tag - the attribution gate
			// admits adapterConsoleLine output on the strength of this check.
			if (entry.component !== null || entry.problemPrefix !== null) {
				errors.push(label + ': a console entry carries no component or problemPrefix');
			}
			if (!FAILURE_SEVERITIES.has(entry.severity)) errors.push(label + ': invalid operational severity');
			if (entry.messagePrefix.startsWith('[' + DIAGNOSTIC_PREFIX)) {
				errors.push(label + ': a console prefix must not claim the diagnostic line head');
			}
			if (!/^\[(?:svelte-adapter-uws|tls|ws|primary)\] /.test(entry.messagePrefix)) {
				errors.push(label + ': a console prefix must open with an owned family tag');
			}
		} else {
			errors.push(label + ': unknown emission ' + JSON.stringify(entry.emission));
		}
	}
	return errors;
}

/**
 * A failure the runtime can emit but the reference does not index is the defect
 * this document exists to prevent: an operator pastes the text and finds a row
 * with no cause and no recovery. Informational events are exempt BY SEVERITY,
 * not by name, so a new one is only exempt while it stays informational.
 *
 * An event whose severity is not a literal cannot be proven informational, so
 * it must be indexed - unknown is treated as a failure rather than waved past.
 *
 * @param {ReturnType<typeof scanEmittedEvents>} scan
 * @param {typeof ADAPTER_ERROR_REGISTRY} entries
 * @returns {string[]}
 */
export function findUnindexedFailures(scan = scanEmittedEvents(), entries = ADAPTER_ERROR_REGISTRY) {
	const indexed = new Set(entries.map((entry) => entry.event));
	const unindexed = [];
	for (const record of scan.events) {
		if (indexed.has(record.event)) continue;
		const informational = record.severities.length > 0 &&
			record.severities.every((severity) => INFORMATIONAL_SEVERITIES.has(severity));
		if (!informational) unindexed.push(record);
	}
	if (!unindexed.length) return [];
	return unindexed.map((record) => record.event + ' (severity ' +
		(record.severities.join('/') || 'not a literal') + ', emitted by ' + record.sources.join(', ') +
		') is a failure with no entry in ADAPTER_ERROR_REGISTRY; add one with cause, consequence,' +
		' automatic recovery, and next action, then rerun --write');
}

function cell(value) {
	return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderErrorReference(entries = ADAPTER_ERROR_REGISTRY, options = {}) {
	const scan = options.scan || scanEmittedEvents();
	const errors = [
		...validateErrorRegistry(entries),
		...findGhostRegistryEntries(entries, scan),
		...findUnindexedFailures(scan, entries)
	];
	if (errors.length) throw new Error(errors.join('\n'));
	const siblingRef = options.siblingRef || releaseDocumentationRef();
	const indexedEvents = new Set(entries.map((entry) => entry.event));
	const unindexed = scan.events.filter((record) => !indexedEvents.has(record.event));
	const scannedNames = new Set(scan.events.map((record) => record.event));
	// Console entries index plain console lines, not diagnostic events: their
	// event fields are registry keys that never appear in a log, so counting
	// them as emitted events would make the document overstate the pipeline.
	const consoleEntries = entries.filter((entry) => entry.emission === 'console');
	const diagnosticEntries = entries.filter((entry) => entry.emission !== 'console');
	const emittedCount = scan.events.length + diagnosticEntries.filter((entry) => !scannedNames.has(entry.event)).length;
	const lines = [
		'# Error reference',
		'',
		'Search this page with the exact stable ID, code, event, or beginning of the message you saw.',
		'Every failure emitted as a diagnostic event is indexed below with its cause, what it means',
		'for traffic, whether anything recovers on its own, and what to do next: ' + diagnosticEntries.length + ' entries',
		'against the ' + emittedCount + ' distinct diagnostic events emitted from the scanned sources, plus',
		'' + consoleEntries.length + ' entries indexing consequential plain console lines that never enter the diagnostic',
		'pipeline - each such line is printed through the registry and carries its stable ID tag, so',
		'the emitted text cannot drift from the prefix indexed here. The remaining emitted events are',
		'informational, listed under [coverage](#emitted-diagnostic-event-coverage) with no recovery guidance',
		'because there is nothing to recover from. A new failure event cannot be added to those sources',
		'without an entry here: the generator fails the build until one exists. Plain console output is',
		'held to the same rule from the other side - check-console-index walks every console.warn and',
		'console.error across the production runtime, the dev server, the test harness and the shipped',
		'plugins, and fails the build unless the line prints through this registry or carries a recorded',
		'reason an operator who read it needs nothing more. A failure absent from this page is therefore',
		'a decision someone made rather than one nobody noticed. The build-time adapter and the browser',
		'client print for other audiences and are deliberately outside that walk.',
		'',
		'This is the adapter-owned part of the ecosystem index. The sibling packages',
		'generate and ship their own runtime-owned references on the same release channel:',
		''
	];
	for (const sibling of SIBLING_ERROR_DOCUMENTS) {
		lines.push(sibling.documentPath === null
			? '- [' + sibling.label + '](https://github.com/lanteanio/' + sibling.repo + ') - the error reference lives with that package.'
			: '- [' + sibling.label + '](https://github.com/lanteanio/' + sibling.repo + '/blob/' + siblingRef + '/' + sibling.documentPath + ')');
	}
	lines.push(
		'',
		'| Stable ID | Code or event | Searchable message prefix |',
		'|---|---|---|'
	);
	for (const entry of entries) {
		lines.push(
			'| [' + entry.id + '](#' + entry.anchor + ') | `' + cell(entry.code || entry.event) +
			'` | `' + cell(entry.messagePrefix) + '` |'
		);
	}
	lines.push(
		'',
		'## Emitted diagnostic event coverage',
		'',
		'This inventory is derived at generation time by scanning `src/runtime/`, `src/observability.js`,',
		'and `src/vite.js` for emitted diagnostic events; the runtime emits ' + emittedCount + ' distinct events.',
		'The ' + diagnosticEntries.length + ' indexed above carry stable IDs and full operator guidance; the remaining ' + unindexed.length,
		'are informational. That split is enforced by severity rather than by a list: an emitted event',
		'is exempt from the indexed reference only while every severity it is emitted at is',
		'informational, so promoting one to a warning or an error fails generation until it is indexed.',
		'',
		'Indexed events:',
		''
	);
	for (const entry of diagnosticEntries) {
		lines.push('- `' + entry.event + '` - [' + entry.id + '](#' + entry.anchor + ')');
	}
	lines.push(
		'',
		'Indexed console lines (no diagnostic event; the searchable key is the printed prefix and',
		'the stable ID tag on the line):',
		''
	);
	for (const entry of consoleEntries) {
		lines.push('- `' + cell(entry.messagePrefix) + '` - [' + entry.id + '](#' + entry.anchor + ')');
	}
	lines.push(
		'',
		'### Informational events',
		'',
		'These carry no stable ID and no recovery guidance because they report normal operation',
		'rather than a failure. Each is emitted on the shared diagnostic line format, so its',
		'searchable log prefix is:',
		'',
		'`[' + DIAGNOSTIC_PREFIX + ' source=svelte-adapter-uws component=<component> event=<event> severity=<severity>] <message>`',
		'',
		'| Event | Component | Severity | Emitting sources |',
		'|---|---|---|---|'
	);
	for (const record of unindexed) {
		lines.push(
			'| `' + record.event + '` | ' +
			(record.components.length ? record.components.map((component) => '`' + component + '`').join(', ') : 'varies by call site') + ' | ' +
			(record.severities.length ? record.severities.join(', ') : 'varies by call site') + ' | ' +
			record.sources.map((source) => '[' + source + '](../' + source + ')').join(', ') + ' |'
		);
	}
	for (const entry of entries) {
		lines.push(
			'',
			'<a id="' + entry.anchor + '"></a>',
			'## `' + entry.id + '`',
			'',
			'- **Code/event:** `' + (entry.code || entry.event) + '`',
			'- **Message prefix:** `' + entry.messagePrefix + '`',
			'- **Cause:** ' + entry.cause,
			'- **Consequence:** ' + entry.consequence,
			'- **Automatic recovery:** ' + entry.automaticRecovery,
			'- **Next action:** ' + entry.nextAction,
			// The shortlink is what the RUNTIME prints to operators (See: ...),
			// so it renders here and is validated: an edited URL must surface in
			// this generated, checked document rather than slip through as an
			// unwatched string.
			...(entry.link ? ['- **Operator shortlink:** `' + entry.link + '`'] : []),
			'- **Runtime help:** `' + entry.help + '`',
			'- **Runtime sources:** ' + entry.sources.map((source) =>
				'[' + source + '](../' + source.replace(/\\/g, '/') + ')'
			).join(', ')
		);
	}
	return lines.join('\n') + '\n';
}

/**
 * Whether a generated document on disk still matches what the generator would
 * produce, compared on CONTENT rather than byte for byte.
 *
 * The generator writes LF. A Windows checkout with `core.autocrlf=true` - the
 * default this repository is developed under - materialises the committed file
 * as CRLF, so a byte comparison reports a freshly cloned tree as stale before a
 * line of it has been touched, and `--write` cannot fix it: the next checkout
 * puts the CRLF back. What this gate exists to catch is generated content that
 * no longer matches its source, and that question is line-ending independent.
 *
 * @param {string} onDisk
 * @param {string} generated
 * @returns {boolean}
 */
export function generatedContentMatches(onDisk, generated) {
	return onDisk.replace(/\r\n/g, '\n') === generated.replace(/\r\n/g, '\n');
}

export function checkErrorReference({ write = false } = {}) {
	const siblingErrors = checkSiblingDocuments();
	if (siblingErrors.length) throw new Error(siblingErrors.join('\n'));
	const scan = scanEmittedEvents();
	const expected = renderErrorReference(ADAPTER_ERROR_REGISTRY, { scan });
	if (write) writeFileSync(outputPath, expected);
	const actual = readFileSync(outputPath, 'utf8');
	if (!generatedContentMatches(actual, expected)) {
		throw new Error('docs/errors.md is stale; run node scripts/generate-error-reference.js --write');
	}
	const scannedNames = new Set(scan.events.map((record) => record.event));
	const consoleCount = ADAPTER_ERROR_REGISTRY.filter((entry) => entry.emission === 'console').length;
	const emittedCount = scan.events.length + ADAPTER_ERROR_REGISTRY
		.filter((entry) => entry.emission !== 'console' && !scannedNames.has(entry.event)).length;
	console.log('generate-error-reference: ' + ADAPTER_ERROR_REGISTRY.length + ' stable adapter errors (' +
		consoleCount + ' console lines) and ' + emittedCount + ' emitted diagnostic events match docs/errors.md');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		checkErrorReference({ write: process.argv.includes('--write') });
	} catch (error) {
		console.error('generate-error-reference FAILED: ' + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}
