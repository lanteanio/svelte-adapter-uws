import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { slugify } from './check-links.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markdown = new MarkdownIt({ html: true });
export const CATALOG_START = '<!-- public-entry-points:start -->';
export const CATALOG_END = '<!-- public-entry-points:end -->';

/** The only stability states a catalog entry may declare. */
export const STABILITY_LEVELS = Object.freeze(['supported', 'experimental', 'deprecated']);

// Stability is a REQUIRED argument: a new subpath must state its support level
// explicitly rather than inherit 'supported' by omission. Deprecation defaults
// to 'none' (the accurate state for a live entry) and otherwise carries the
// migration note as free text.
const p = (role, environment, guide, stability, deprecation = 'none') => ({
	role,
	environment,
	stability,
	guide,
	deprecation
});

// Exact keys are deliberate. A new package export has no documentation owner
// until a maintainer adds its role, runtime boundary, stability, and guide here.
export const ENTRY_POINTS = Object.freeze({
	'.': p('SvelteKit adapter and build output', 'Node build', '[Quick start](#quick-start-http)', 'supported'),
	'./upgrade-response': p('WebSocket 101 response headers', 'Node runtime', '[Custom 101 headers](#custom-101-response-headers-svelte-adapter-uwsupgrade-response)', 'supported'),
	'./connection': p('Stable connection identity', 'Node runtime', '[Session resume](#session-resume)', 'supported'),
	'./client': p('Reactive connection and topic stores', 'Browser', '[Client store API](#client-store-api)', 'supported'),
	'./vite': p('Development WebSocket and handler build plugin', 'Node build/dev', '[Development parity](#development-preview--production)', 'supported'),
	'./testing': p('In-process handler integration harness', 'Node test', '[Test harness](#test-harness-for-websocket-handlers)', 'supported'),
	'./sim': p('Deterministic network and cluster simulator', 'Node test', '[Simulation](#deterministic-simulation)', 'experimental'),
	'./safe-url': p('Outbound SSRF policy and address classification', 'Node runtime', '[Outbound SSRF gate](#outbound-ssrf-gate-svelte-adapter-uwssafe-url)', 'supported'),
	'./observability': p('Signal manifest, diagnostic formatter/parser, and schema validator', 'Universal', '[Package-attributed diagnostics](#package-attributed-diagnostics)', 'supported'),
	'./plugins/replay': p('Server replay buffer', 'Node runtime', '[Replay](#replay-ssr-gap)', 'supported'),
	'./plugins/replay/client': p('Browser replay client', 'Browser', '[Replay](#replay-ssr-gap)', 'supported'),
	'./plugins/presence': p('Server presence registry', 'Node runtime', '[Presence](#presence)', 'supported'),
	'./plugins/presence/client': p('Reactive presence client', 'Browser', '[Presence](#presence)', 'supported'),
	'./plugins/channels': p('Typed server topics', 'Node runtime', '[Typed channels](#typed-channels)', 'supported'),
	'./plugins/channels/client': p('Typed client topics', 'Browser', '[Typed channels](#typed-channels)', 'supported'),
	'./plugins/throttle': p('Topic throttle and debounce', 'Node runtime', '[Throttle and debounce](#throttledebounce)', 'supported'),
	'./plugins/ratelimit': p('Message rate limiting', 'Node runtime', '[Rate limiting](#rate-limiting)', 'supported'),
	'./plugins/cursor': p('Server cursor fan-out', 'Node runtime', '[Cursor](#cursor-ephemeral-state)', 'supported'),
	'./plugins/cursor/client': p('Reactive cursor client', 'Browser/worker', '[Cursor](#cursor-ephemeral-state)', 'supported'),
	'./plugins/middleware': p('Message middleware pipeline', 'Node runtime', '[Middleware](#middleware)', 'supported'),
	'./plugins/queue': p('Per-key ordered work queue', 'Node runtime', '[Queue](#queue-ordered-delivery)', 'supported'),
	'./plugins/groups': p('Server broadcast groups', 'Node runtime', '[Broadcast groups](#broadcast-groups)', 'supported'),
	'./plugins/groups/client': p('Reactive group client', 'Browser', '[Broadcast groups](#broadcast-groups)', 'supported'),
	'./plugins/lock': p('Per-key critical sections', 'Node runtime', '[Lock](#lock-per-key-serialization)', 'supported'),
	'./plugins/session': p('In-process session store', 'Node runtime', '[Session](#session-in-process-store-with-sliding-ttl)', 'supported'),
	'./plugins/dedup': p('Idempotency window', 'Node runtime', '[Dedup](#dedup-idempotency-window)', 'supported'),
	'./plugins/crdt': p('CRDT wire codec and authority', 'Node runtime', '[CRDT documents](#crdt-documents-replicas-sync-persistence)', 'supported'),
	'./plugins/crdt/client': p('Binary CRDT client sink', 'Browser', '[CRDT client sink](#crdt-binary-client-sink)', 'supported'),
	'./plugins/crdt/replica': p('Local CRDT replica primitives', 'Browser/Node', '[CRDT documents](#crdt-documents-replicas-sync-persistence)', 'supported'),
	'./plugins/crdt/channel': p('Reactive CRDT channel', 'Browser', '[CRDT documents](#crdt-documents-replicas-sync-persistence)', 'supported'),
	'./plugins/smooth': p('Server prediction authority and codec', 'Node runtime', '[Smooth](#smooth-prediction-and-reconciliation)', 'supported'),
	'./plugins/smooth/client': p('Prediction and interpolation client', 'Browser', '[Smooth](#smooth-prediction-and-reconciliation)', 'supported'),
	'./plugins/smooth/random': p('Shared deterministic random stream', 'Browser/Node', '[Shared random](#deterministic-shared-random)', 'supported'),
	'./plugins/webhooks': p('SSRF-gated webhook delivery', 'Node runtime', '[Webhooks](#verifying-a-received-webhook-svelte-adapter-uwspluginswebhooks)', 'supported')
});

export function catalogErrors(exportsMap, catalog = ENTRY_POINTS) {
	const errors = [];
	const exported = Object.keys(exportsMap).sort();
	const documented = Object.keys(catalog).sort();
	for (const key of exported) if (!Object.hasOwn(catalog, key)) errors.push(`public export ${key} has no catalog owner`);
	for (const key of documented) if (!Object.hasOwn(exportsMap, key)) errors.push(`catalog entry ${key} is not a public export`);
	for (const key of documented) {
		const record = catalog[key];
		for (const field of ['role', 'environment', 'stability', 'guide', 'deprecation']) {
			if (typeof record?.[field] !== 'string' || !record[field].trim()) errors.push(`${key}: missing ${field}`);
		}
		// Stability is a closed vocabulary; deprecation is 'none' or the free-text
		// migration note (the non-empty check above already rejects blank text).
		if (typeof record?.stability === 'string' && record.stability.trim() && !STABILITY_LEVELS.includes(record.stability)) {
			errors.push(`${key}: stability '${record.stability}' is not one of ${STABILITY_LEVELS.join(' | ')}`);
		}
		if (record?.guide && !/^\[[^\]]+\]\((?:#|\.\/)[^)]+\)$/.test(record.guide)) errors.push(`${key}: guide must be an owned Markdown route`);
	}
	return errors;
}

/**
 * Every README heading with its resolved GitHub anchor, level, and start line.
 * Slugging (including the `-1`, `-2`, ... duplicate numbering) matches
 * check-links.js exactly - the slugger itself is imported from there.
 *
 * @param {string} readmeText
 * @returns {Array<{ anchor: string, level: number, line: number, heading: string }>}
 */
export function readmeHeadings(readmeText) {
	const seen = new Map();
	const headings = [];
	const tokens = markdown.parse(readmeText, {});
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type !== 'heading_open' || tokens[index + 1]?.type !== 'inline') continue;
		const base = slugify(tokens[index + 1].content);
		if (base === '') continue;
		const n = seen.get(base) || 0;
		seen.set(base, n + 1);
		headings.push({
			anchor: n === 0 ? base : `${base}-${n}`,
			level: Number(tokens[index].tag.slice(1)),
			line: tokens[index].map?.[0] ?? 0,
			heading: tokens[index + 1].content
		});
	}
	return headings;
}

function sectionBody(readmeText, headings, index) {
	const lines = readmeText.split('\n');
	const owner = headings[index];
	let end = lines.length;
	for (let next = index + 1; next < headings.length; next++) {
		if (headings[next].level <= owner.level) { end = headings[next].line; break; }
	}
	return lines.slice(owner.line, end).join('\n');
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A guide route must be OWNED, not merely resolvable: the anchor's section
 * body has to document the entry's specifier (as an import or an inline-code
 * mention). Without this, a catalog row could point at any unrelated heading
 * and still pass the shape check above plus check-links' existence check.
 *
 * The root entry's specifier prefixes every subpath specifier, so it only
 * counts when quote-bounded as an import of the bare package name.
 *
 * @param {string} readmeText
 * @param {string} pkgName
 * @param {typeof ENTRY_POINTS} [catalog]
 * @returns {string[]}
 */
export function guideAnchorErrors(readmeText, pkgName, catalog = ENTRY_POINTS) {
	const errors = [];
	const headings = readmeHeadings(readmeText);
	for (const [key, record] of Object.entries(catalog)) {
		const anchorMatch = /^\[[^\]]+\]\(#([^)]+)\)$/.exec(record?.guide ?? '');
		if (!anchorMatch) continue; // ./path guides resolve as files via check-links
		const anchor = anchorMatch[1];
		const index = headings.findIndex((heading) => heading.anchor === anchor);
		if (index < 0) {
			errors.push(`${key}: guide anchor #${anchor} matches no README heading`);
			continue;
		}
		const specifier = pkgName + (key === '.' ? '' : key.slice(1));
		const mention = key === '.'
			? new RegExp(`from\\s+["']${escapeRegExp(pkgName)}["']`)
			: new RegExp(`["'\`]${escapeRegExp(specifier)}["'\`]`);
		if (!mention.test(sectionBody(readmeText, headings, index))) {
			errors.push(`${key}: guide anchor #${anchor} resolves to heading "${headings[index].heading}" whose section never mentions ${specifier}; point the guide at the section documenting this entry point, or document it there`);
		}
	}
	return errors;
}

/**
 * The named value exports of src/sim.d.ts (function/const/class declarations;
 * interfaces and type aliases are erased at runtime). A declaration whose
 * immediately preceding doc comment carries `@internal` is exempt.
 *
 * @param {string} dtsText
 * @returns {string[]}
 */
export function simExportNames(dtsText) {
	const names = [];
	// The doc-comment group matches exactly ONE comment (no '*/' inside), so it
	// can only bind to the comment immediately preceding the declaration and can
	// never span unrelated declarations between two comments.
	const declaration = /(\/\*\*(?:[^*]|\*(?!\/))*\*\/[ \t\r\n]*)?export[ \t]+(?:declare[ \t]+)?(?:function|const|class|let|var)[ \t]+([A-Za-z_$][\w$]*)/g;
	for (const match of dtsText.matchAll(declaration)) {
		if (match[1]?.includes('@internal')) continue;
		if (!names.includes(match[2])) names.push(match[2]);
	}
	return names;
}

/**
 * The README region that owns the sim subpath: from its 'Deterministic
 * simulation' heading up to the next chapter ('## ') heading, so the sibling
 * leak-harness subsection it ships with counts as part of its home. Fence
 * lines are tracked so a '## ' inside a code block never ends the region.
 *
 * @param {string} readmeText
 * @returns {string | null}
 */
export function simSectionOf(readmeText) {
	const lines = readmeText.split('\n');
	let fenced = false;
	let start = -1;
	let end = lines.length;
	for (let index = 0; index < lines.length; index++) {
		if (/^\s*(```|~~~)/.test(lines[index])) { fenced = !fenced; continue; }
		if (fenced) continue;
		if (start < 0) {
			if (/^#{2,4}[ \t]+Deterministic simulation[ \t]*$/.test(lines[index])) start = index;
			continue;
		}
		if (/^##[ \t]/.test(lines[index])) { end = index; break; }
	}
	return start < 0 ? null : lines.slice(start, end).join('\n');
}

/**
 * Every public sim export needs a documented home in the README's
 * deterministic-simulation docs; a subpath whose helpers are exported but
 * unfindable in the guide is documentation debt this gate refuses.
 *
 * @param {string} readmeText
 * @param {string} dtsText
 * @returns {string[]}
 */
export function simDocErrors(readmeText, dtsText) {
	const section = simSectionOf(readmeText);
	if (section === null) return ["README has no 'Deterministic simulation' heading for the sim subpath's exports to live under"];
	const missing = simExportNames(dtsText)
		.filter((name) => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(section));
	return missing.length
		? [`README 'Deterministic simulation' docs are missing sim exports: ${missing.join(', ')} (every public svelte-adapter-uws/sim export needs a home there)`]
		: [];
}

export function renderCatalog(pkg, catalog = ENTRY_POINTS) {
	const errors = catalogErrors(pkg.exports ?? {}, catalog);
	if (errors.length) throw new Error(errors.join('\n'));
	const lines = [
		'| Entry point | Role | Environment | Stability | Guide | Deprecation |',
		'|---|---|---|---|---|---|'
	];
	for (const key of Object.keys(pkg.exports)) {
		const record = catalog[key];
		const specifier = pkg.name + (key === '.' ? '' : key.slice(1));
		lines.push(`| \`${specifier}\` | ${record.role} | ${record.environment} | ${record.stability} | ${record.guide} | ${record.deprecation} |`);
	}
	return lines.join('\n');
}

export function replaceCatalog(readme, rendered) {
	const start = readme.indexOf(CATALOG_START);
	const end = readme.indexOf(CATALOG_END);
	if (start < 0 || end < 0 || end < start) throw new Error('README public entry-point markers are missing or unordered');
	if (readme.indexOf(CATALOG_START, start + 1) >= 0 || readme.indexOf(CATALOG_END, end + 1) >= 0) {
		throw new Error('README must contain exactly one public entry-point catalog');
	}
	return readme.slice(0, start + CATALOG_START.length) + '\n' + rendered + '\n' + readme.slice(end);
}

function main() {
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const readmePath = resolve(root, 'README.md');
	const readme = readFileSync(readmePath, 'utf8');
	const simDts = readFileSync(resolve(root, 'src/sim.d.ts'), 'utf8');
	const expected = replaceCatalog(readme, renderCatalog(pkg));
	const gateErrors = [
		...guideAnchorErrors(readme, pkg.name),
		...simDocErrors(readme, simDts)
	];
	if (process.argv.includes('--write')) {
		writeFileSync(readmePath, expected);
		console.log(`check-entry-points: wrote ${Object.keys(pkg.exports).length} README catalog rows`);
		if (gateErrors.length) {
			console.error('check-entry-points FAILED (not writable; fix by hand):');
			for (const error of gateErrors) console.error(`  x ${error}`);
			process.exitCode = 1;
		}
		return;
	}
	if (expected !== readme) {
		console.error('check-entry-points FAILED: README catalog is stale; run node scripts/check-entry-points.js --write');
		process.exitCode = 1;
		return;
	}
	if (gateErrors.length) {
		console.error(`check-entry-points FAILED (${gateErrors.length} error(s)):`);
		for (const error of gateErrors) console.error(`  x ${error}`);
		process.exitCode = 1;
		return;
	}
	console.log(`check-entry-points: ${Object.keys(pkg.exports).length} public exports have owned README routes; ${simExportNames(simDts).length} sim exports documented`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
