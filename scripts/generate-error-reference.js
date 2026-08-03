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
const EVENT_SCAN_FILES = Object.freeze(['src/observability.js', 'src/vite.js']);
const EVENT_SCAN_EXCLUDED = Object.freeze(['src/runtime/error-registry.js']);
const EVENT_LITERAL = /event: '([a-z][a-z0-9.-]*)'/;
const EVENT_CONTEXT_LINES = 6;

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
		if ((entry.component === null) !== (entry.problemPrefix === null)) {
			errors.push(label + ': component and problemPrefix must both be strings or both be null');
		}
		if (entry.component !== null) {
			if (entry.severity !== 'fatal' && entry.severity !== 'error') errors.push(label + ': invalid operational severity');
			const expected = '[' + DIAGNOSTIC_PREFIX + ' source=svelte-adapter-uws component=' + entry.component +
				' event=' + entry.event + ' severity=' + entry.severity + '] ' + entry.event + ': ' + entry.problemPrefix;
			if (entry.messagePrefix !== expected) errors.push(label + ': operational prefix does not match component, event, and problemPrefix');
		}
	}
	return errors;
}

function cell(value) {
	return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderErrorReference(entries = ADAPTER_ERROR_REGISTRY, options = {}) {
	const scan = options.scan || scanEmittedEvents();
	const errors = [...validateErrorRegistry(entries), ...findGhostRegistryEntries(entries, scan)];
	if (errors.length) throw new Error(errors.join('\n'));
	const siblingRef = options.siblingRef || releaseDocumentationRef();
	const indexedEvents = new Set(entries.map((entry) => entry.event));
	const unindexed = scan.events.filter((record) => !indexedEvents.has(record.event));
	const scannedNames = new Set(scan.events.map((record) => record.event));
	const emittedCount = scan.events.length + entries.filter((entry) => !scannedNames.has(entry.event)).length;
	const lines = [
		'# Error reference',
		'',
		'Search this page with the exact stable ID, code, event, or beginning of the message you saw.',
		'The indexed reference below covers ' + entries.length + ' of the ' + emittedCount + ' distinct diagnostic events the runtime',
		'emits; the [coverage list](#emitted-diagnostic-event-coverage) names all ' + emittedCount + ', so a search for any',
		'emitted event name lands on this page. Runtime messages for indexed entries preserve the',
		'documented prefix and append the stable ID plus this package-local help route.',
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
		'The ' + entries.length + ' indexed above carry stable IDs and full operator guidance. The remaining ' + unindexed.length,
		'are listed below with their emitting sources, so an operator searching any emitted event',
		'name finds an authoritative row on this page.',
		'',
		'Indexed events:',
		''
	);
	for (const entry of entries) {
		lines.push('- `' + entry.event + '` - [' + entry.id + '](#' + entry.anchor + ')');
	}
	lines.push(
		'',
		'### Emitted diagnostics not yet in the indexed reference',
		'',
		'These events have no stable ID yet. Each one is emitted on the shared diagnostic line',
		'format, so its searchable log prefix is:',
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
			'- **Runtime help:** `' + entry.help + '`',
			'- **Runtime sources:** ' + entry.sources.map((source) =>
				'[' + source + '](../' + source.replace(/\\/g, '/') + ')'
			).join(', ')
		);
	}
	return lines.join('\n') + '\n';
}

export function checkErrorReference({ write = false } = {}) {
	const siblingErrors = checkSiblingDocuments();
	if (siblingErrors.length) throw new Error(siblingErrors.join('\n'));
	const scan = scanEmittedEvents();
	const expected = renderErrorReference(ADAPTER_ERROR_REGISTRY, { scan });
	if (write) writeFileSync(outputPath, expected);
	const actual = readFileSync(outputPath, 'utf8');
	if (actual !== expected) {
		throw new Error('docs/errors.md is stale; run node scripts/generate-error-reference.js --write');
	}
	const scannedNames = new Set(scan.events.map((record) => record.event));
	const emittedCount = scan.events.length + ADAPTER_ERROR_REGISTRY.filter((entry) => !scannedNames.has(entry.event)).length;
	console.log('generate-error-reference: ' + ADAPTER_ERROR_REGISTRY.length + ' stable adapter errors and ' +
		emittedCount + ' emitted diagnostic events match docs/errors.md');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		checkErrorReference({ write: process.argv.includes('--write') });
	} catch (error) {
		console.error('generate-error-reference FAILED: ' + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}
