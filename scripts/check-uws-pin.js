#!/usr/bin/env node
/**
 * Guard that every live reference to uWebSockets.js names the SAME tag as the
 * `optionalDependencies` pin in package.json. The addon is a GitHub-hosted
 * native build pinned by tag, so an install line, a doc snippet or a test
 * harness naming an older tag hands someone a different binary than the one the
 * adapter is built and tested against - and because the dependency is optional,
 * npm reports nothing when the wrong one is fetched. That skew has shipped
 * twice: once from a spec hardcoded in the build entry point, and once from the
 * README install blocks plus the test harness sitting seven tags behind a bump.
 *
 * The rule, and where its boundary is:
 *
 *   - MATCHED: the install-spec form `uWebSockets.js#<ref>` - the copy-pasteable
 *     thing (an `npm install uNetworking/uWebSockets.js#<tag>` line, a
 *     dependency value, a JSDoc example of one). Whoever reads it acts on it,
 *     so it has to be current.
 *   - NOT MATCHED: a bare version named in prose ("pinned to v20.67.0 (was
 *     v20.60.0)"). CHANGELOG.md and MIGRATION.md say exactly that, on purpose,
 *     about the past. A guard that forces history to be rewritten on every bump
 *     is worse than the drift it prevents, so the pattern cannot see prose at
 *     all: it only fires on a spec someone could paste into a shell.
 *   - HISTORICAL DATA: a digest-pinned npm baseline in
 *     docs/compatibility.v1.csv may name the native tag that immutable release
 *     actually shipped. The compatibility validator authenticates that row;
 *     this guard must not rewrite it into the current worktree's pin.
 *   - SKIPPED WHOLE: CHANGELOG.md, append-only history whose entries may quote
 *     the full spec of their day and must keep quoting it verbatim. (The shipped
 *     log is untracked and only tracked files are scanned, so it never arrives
 *     here in the first place.)
 *   - REPORTED, NOT ENFORCED: lockfiles. They are generated, and a stale one is
 *     corrected by rerunning `npm install` in that directory, never by hand, so
 *     failing on one would demand the wrong edit.
 *   - NO TEXT OPT-OUTS: synthetic tests construct non-current refs from pieces
 *     so a marker cannot launder a copy-pasteable stale command in any shipped
 *     path. The only exceptions ride the authenticated historical manifest's
 *     own authority: the manifest itself, the README span generated from it,
 *     and the migration baseline whose recorded era-tag must be the
 *     manifest's validated ref FOR THE ADAPTER VERSION THE BASELINE ITSELF
 *     RECORDS - any other era's tag fails like a stale spec.
 *
 * The expected tag comes from the same derivation the runtime install hints use
 * (src/uws-load-hint.js), so the guard and the messages it protects can never
 * disagree about what the pin is.
 *
 * Dependency-free (no eslint), modeled on the sibling check-slugs /
 * check-determinism scripts, wired into `npm run check` and so into pretest.
 *
 * @module scripts/check-uws-pin
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { uwsInstallSpec } from '../src/uws-load-hint.js';
import {
	COMPATIBILITY_END,
	COMPATIBILITY_START,
	parseCompatibility,
	renderCompatibility,
	uwsRefFromSpec,
	validateCompatibility
} from './check-compatibility.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tokenize npm Git targets broadly, then compare their parsed repository and
// selector. This follows npm's one-pass percent decoding, URL query stripping,
// and semver selector handling instead of trusting the source spelling.
const SPEC_TOKEN_RE = /(?:github:[^\s"'`<>{}\[\](),;]+|(?:(?:git\+)?https?|git):\/\/[^\s"'`<>{}\[\](),;]+|(?:git\+)?ssh:\/\/[^\s"'`<>{}\[\](),;]+|git@(?:www\.)?github\.com:[^\s"'`<>{}\[\](),;]+|[A-Za-z0-9%._~-]+\/[A-Za-z0-9%._~-]+(?:\.git)?(?:#[^\s"'`<>{}\[\](),;]*)?)/gi;
const ARCHIVE_TOKEN_RE = /https:\/\/github\.com\/uNetworking\/uWebSockets\.js\/archive\/refs\/tags\/(v\d+\.\d+\.\d+)\.tar\.gz/gi;

function decodeNpmComponent(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function npmGitSelector(fragment) {
	const decoded = decodeNpmComponent(fragment);
	if (decoded === null) return null;
	let reference = null;
	for (const selector of decoded.split('::')) {
		if (/^path:/i.test(selector)) continue;
		const candidate = selector.replace(/^semver:/i, '');
		if (!candidate) return null;
		if (reference !== null) return decoded;
		reference = candidate;
	}
	return reference;
}

function canonicalNpmGitPath(path) {
	const decoded = decodeNpmComponent(path.split('?', 1)[0]);
	if (decoded === null) return null;
	const parts = [];
	for (const part of decoded.replace(/\\/g, '/').split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts;
}

function canonicalNpmGitSpec(spec) {
	let path;
	let fragment;
	if (/^github:/i.test(spec)) {
		const body = spec.slice(spec.indexOf(':') + 1);
		const hash = body.indexOf('#');
		path = hash === -1 ? body : body.slice(0, hash);
		fragment = hash === -1 ? null : body.slice(hash + 1);
	} else if (/^git@(?:www\.)?github\.com:/i.test(spec)) {
		const body = spec.slice(spec.indexOf(':') + 1);
		const hash = body.indexOf('#');
		path = hash === -1 ? body : body.slice(0, hash);
		fragment = hash === -1 ? null : body.slice(hash + 1);
	} else if (/^(?:git\+)?ssh:\/\/git@(?:www\.)?github\.com:/i.test(spec)) {
		const body = spec.replace(/^(?:git\+)?ssh:\/\/git@(?:www\.)?github\.com:/i, '');
		const hash = body.indexOf('#');
		path = hash === -1 ? body : body.slice(0, hash);
		fragment = hash === -1 ? null : body.slice(hash + 1);
	} else if (/^[a-z][a-z+.-]*:\/\//i.test(spec)) {
		let parsed;
		try {
			parsed = new URL(spec.replace(/^git\+/i, ''));
		} catch {
			return null;
		}
		if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return null;
		path = parsed.pathname.replace(/^\/+/, '');
		fragment = parsed.hash ? parsed.hash.slice(1) : null;
	} else {
		const hash = spec.indexOf('#');
		path = hash === -1 ? spec : spec.slice(0, hash);
		fragment = hash === -1 ? null : spec.slice(hash + 1);
	}
	// npm-package-arg resolves dot segments and removes URL query parameters
	// before comparing a hosted repository identity. SSH-colon and scp forms do
	// not pass through WHATWG URL, so apply the same normalization explicitly.
	const parts = canonicalNpmGitPath(path);
	if (parts === null) return null;
	if (parts.length !== 2) return null;
	const owner = parts[0].toLowerCase();
	const repository = parts[1].replace(/\.git$/i, '').toLowerCase();
	if (owner !== 'unetworking' || repository !== 'uwebsockets.js') return null;
	if (fragment === null || fragment === '') return { ref: null };
	const ref = npmGitSelector(fragment);
	if (ref === null && !/^path:.+/i.test(decodeNpmComponent(fragment) || '')) return null;
	return { ref };
}

function shellQuoteAt(text, start, end) {
	let quote = null;
	for (let index = start; index < end; index++) {
		const character = text[index];
		if (quote !== null) {
			if (character === quote) quote = null;
			else if (quote === '"' && character === '\\') index++;
			continue;
		}
		if (character === '"' || character === "'") quote = character;
		else if (character === '\\') index++;
	}
	return quote;
}

function quotedShellWord(text, contentIndex, contentEnd) {
	const startsQuoted = text[contentIndex - 1] === '"' || text[contentIndex - 1] === "'";
	if (!startsQuoted) {
		if (text[contentEnd] !== '"' && text[contentEnd] !== "'") return null;
		const lineStart = text.lastIndexOf('\n', contentIndex - 1) + 1;
		// If an earlier quote already encloses the Git target, the adjacent quote
		// closes that host-language or shell string. Only a locally unquoted target
		// can use it to open a suffix segment of the same shell word.
		if (shellQuoteAt(text, lineStart, contentIndex) !== null) return null;
	}
	let quote = null;
	let value = '';
	let sawQuote = false;
	let index = startsQuoted ? contentIndex - 1 : contentIndex;
	while (index < text.length) {
		const character = text[index];
		if (quote !== null) {
			if (character === quote) {
				quote = null;
				index++;
				if (text[index] !== '"' && text[index] !== "'" &&
					(index >= text.length || /\s|[<>\[\](),;|]/.test(text[index]))) {
					return { value, end: index };
				}
				continue;
			}
			if (quote === '"' && character === '\\' && index + 1 < text.length) {
				value += text[index + 1];
				index += 2;
				continue;
			}
			value += character;
			index++;
			continue;
		}
		if (character === '"' || character === "'") {
			sawQuote = true;
			quote = character;
			index++;
			continue;
		}
		if (/\s|[<>\[\](),;|]/.test(character)) break;
		if (character === '\\' && index + 1 < text.length) {
			value += text[index + 1];
			index += 2;
			continue;
		}
		value += character;
		index++;
	}
	return quote === null && sawQuote ? { value, end: index } : null;
}

function shellContinuationView(source) {
	let text = '';
	const offsets = [];
	for (let index = 0; index < source.length;) {
		const character = source[index];
		if (character === '\\' || character === '^' || character === '`') {
			if (source[index + 1] === '\n') {
				index += 2;
				continue;
			}
			if (source[index + 1] === '\r' && source[index + 2] === '\n') {
				index += 3;
				continue;
			}
		}
		offsets.push(index);
		text += character;
		index++;
	}
	offsets.push(source.length);
	return { text, offsets };
}

// Append-only history, plus this file (its own header spells the spec form out).
// Derived rather than hardcoded so renaming the guard cannot disarm it.
const SELF = relative(root, fileURLToPath(import.meta.url)).split('\\').join('/');
const SKIP_FILES = new Set(['CHANGELOG.md', SELF]);

// Generated by a package manager: reported, never enforced (see the header).
const LOCKFILES = new Set([
	'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'
]);

/**
 * The pinned git ref, from the adapter's optionalDependencies.
 * @param {{ optionalDependencies?: Record<string, string> } | undefined} pkg
 * @returns {string | null} e.g. `v20.69.0`, or null when the spec carries no ref
 */
export function pinnedRef(pkg) {
	const spec = uwsInstallSpec(pkg);
	return uwsRefFromSpec(spec);
}

/**
 * Every install-spec reference in one file's text.
 * @param {string} text file contents
 * @param {string} pinned the pinned ref every reference must name
 * @returns {{ line: number, ref: string | null, stale: boolean }[]}
 */
export function scanTextWithOffsets(text, pinned) {
	const refs = [];
	const view = shellContinuationView(text);
	SPEC_TOKEN_RE.lastIndex = 0;
	let match;
	while ((match = SPEC_TOKEN_RE.exec(view.text)) !== null) {
		if (match[0].endsWith('$') && view.text[match.index + match[0].length] === '{') continue;
		if (match[0].endsWith('#') && view.text[match.index + match[0].length] === '<') continue;
		let spec = match[0];
		let specEnd = match.index + spec.length;
		const shellWord = quotedShellWord(view.text, match.index, specEnd);
		if (shellWord !== null) {
			// Shells concatenate adjacent quoted segments into one argument.
			// Parse the complete word so a pinned first segment cannot hide an
			// unpinned range in the immediately adjacent segment.
			spec = shellWord.value;
			specEnd = shellWord.end;
			SPEC_TOKEN_RE.lastIndex = shellWord.end;
		}
		const canonical = canonicalNpmGitSpec(spec);
		if (!canonical) continue;
		const start = view.offsets[match.index];
		const end = view.offsets[specEnd];
		refs.push({
			line: text.slice(0, start).split('\n').length,
			ref: canonical.ref,
			stale: canonical.ref !== pinned,
			start,
			end
		});
	}
	ARCHIVE_TOKEN_RE.lastIndex = 0;
	while ((match = ARCHIVE_TOKEN_RE.exec(view.text)) !== null) {
		const start = view.offsets[match.index];
		const end = view.offsets[match.index + match[0].length];
		refs.push({
			line: text.slice(0, start).split('\n').length,
			ref: match[1],
			stale: match[1] !== pinned,
			start,
			end
		});
	}
	refs.sort((a, b) => a.start - b.start);
	return refs;
}

export function scanText(text, pinned) {
	return scanTextWithOffsets(text, pinned).map(({ line, ref, stale }) => ({ line, ref, stale }));
}

function isMarkdownNavigationTarget(text, ref) {
	let start = ref.start - 1;
	let end = ref.end;
	if (text[start] === '<' && text[end] === '>') {
		start--;
		end++;
	}
	return text[start] === '(' && text[end] === ')';
}

/** Tracked files only: generated output and installed dependencies are hands-off. */
function trackedFiles() {
	// Tracked files PLUS untracked ones git would add, minus anything ignored. A
	// new file is untracked right up until the commit that ships it, so scanning
	// only the tracked set waves every new stale spec through on its way in - which
	// is exactly how a synthetic tag in a new test file first reached this guard
	// one commit too late.
	return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		cwd: root,
		encoding: 'utf8'
	})
		.split('\0')
		.filter(Boolean);
}

/**
 * Whether a ref found in the migration baseline is that baseline's own era
 * fact: the file must be the baseline, and the ref must be the manifest's
 * validated historical native tag for the adapter version the baseline
 * itself records. Pure so the contract suite can probe it; the caller
 * additionally gates on the manifest having validated at all.
 *
 * @param {string} rel repository-relative path of the scanned file
 * @param {string} text the scanned file's content
 * @param {string | null} refValue the ref the scanner extracted
 * @param {Map<string, string>} historicalRefByAdapterVersion npm-provenance rows: adapter version -> native ref
 * @returns {boolean}
 */
export function migrationBaselineException(rel, text, refValue, historicalRefByAdapterVersion) {
	if (rel !== 'test/fixtures/migration-0.5/baseline.lock') return false;
	// [^\r\n] rather than a $-anchored dot, so CR handling is visible at a
	// glance instead of derived from multiline-$ semantics: in ECMAScript the
	// dot form happens to exclude CR too (CR is a LineTerminator), but a
	// plausible refactor to [^\n]+$ would capture the carriage return of a
	// CRLF working copy and fail the lookup with a misleading stale-spec
	// verdict - the unit case pins that trap shut.
	const era = /^adapter\.version=([^\r\n]+)/m.exec(text);
	if (!era) return false;
	if (typeof refValue !== 'string') return false;
	const allowed = historicalRefByAdapterVersion.get(era[1]);
	return allowed !== undefined && allowed === refValue;
}

export function authenticatedReadmeSpan(text, rows) {
	const rendered = renderCompatibility(rows);
	if (text.split(COMPATIBILITY_START).length !== 2 || text.split(COMPATIBILITY_END).length !== 2) return null;
	const offset = text.indexOf(rendered);
	if (offset === -1 || text.indexOf(rendered, offset + 1) !== -1) return null;
	return { start: offset, end: offset + rendered.length };
}

function main() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const pinned = pinnedRef(pkg);

	console.log(`check-uws-pin: ${pkg.name}@${pkg.version}`);
	if (pinned === null) {
		console.error(`\ncheck-uws-pin FAILED: package.json optionalDependencies names no pinned`);
		console.error(`  uWebSockets.js ref. Pin it to a tag so every install site has one truth.`);
		process.exit(1);
	}
	console.log(`  pin: ${pinned} (package.json optionalDependencies).`);

	const files = trackedFiles().filter((rel) => !SKIP_FILES.has(rel));
	const compatibilityRows = parseCompatibility(readFileSync(join(root, 'docs', 'compatibility.v1.csv'), 'utf8'));
	const authenticatedCompatibility = validateCompatibility(compatibilityRows, pkg).length === 0;
	const historicalCompatibilityRefs = new Set(
		compatibilityRows
			.filter((row) => row.provenance.startsWith('npm:'))
			.map((row) => uwsRefFromSpec(row.uwebsockets))
			.filter(Boolean)
	);
	const historicalRefByAdapterVersion = new Map(
		compatibilityRows
			.filter((row) => row.provenance.startsWith('npm:'))
			.map((row) => [row.adapter_version, uwsRefFromSpec(row.uwebsockets)])
	);
	// Normalised, and so is every file scanned below, because the generated-README
	// exception is an OFFSET range: the span is located in one read of this file
	// and the stale ref is located in another, so the two must agree on how many
	// bytes a line ending takes. Under a Windows checkout they did not, and the
	// exception stopped covering the very span it was written for - reporting the
	// stable row's own historical tag as a stale pin. Line NUMBERS are unaffected
	// by the normalisation, so the reported location stays correct.
	const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
	const readmeCompatibilitySpan = authenticatedCompatibility ? authenticatedReadmeSpan(readme, compatibilityRows) : null;
	let authenticatedBinaryPackage = null;
	try {
		const accepted = JSON.parse(readFileSync(join(root, 'scripts', 'uws-accepted.json'), 'utf8'));
		const acceptedSpec = accepted.package.endsWith('/')
			? accepted.package + accepted.ref + '.tar.gz'
			: accepted.package + '#' + accepted.ref;
		if (acceptedSpec === pkg.optionalDependencies['uWebSockets.js']) {
			authenticatedBinaryPackage = accepted.package;
		}
	} catch {
		// The binary gate reports a malformed record; this scanner grants it no exception.
	}
	let total = 0;
	let allowed = 0;
	const stale = [];
	const lockfiles = [];

	for (const rel of files) {
		let text;
		try {
			text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
		} catch {
			continue; // a tracked path missing from the working tree is not this guard's case
		}
		const isLockfile = LOCKFILES.has(rel.split('/').pop());
		for (const ref of scanTextWithOffsets(text, pinned)) {
			total++;
			if (!ref.stale) continue;
			const markdownNavigationTarget = ref.ref === null && /\.md$/i.test(rel) &&
				isMarkdownNavigationTarget(text, ref);
			const immutableCompatibilityFact = authenticatedCompatibility && rel === 'docs/compatibility.v1.csv' &&
				historicalCompatibilityRefs.has(ref.ref);
			const generatedReadmeFact = rel === 'README.md' && readmeCompatibilitySpan !== null &&
				ref.start >= readmeCompatibilitySpan.start && ref.end <= readmeCompatibilitySpan.end &&
				historicalCompatibilityRefs.has(ref.ref);
			const authenticatedBinaryRecord = rel === 'scripts/uws-accepted.json' &&
				authenticatedBinaryPackage !== null && ref.ref === null &&
				text.includes('"package": "' + authenticatedBinaryPackage + '"');
			// The migration baseline records the 0.5 era's native tag whole -
			// splitting it into pieces to dodge this scanner would be exactly
			// the laundering the no-text-opt-outs rule forbids. It is allowed
			// on the same authority as the compatibility manifest, bound to
			// the baseline's OWN era: the ref must be the manifest's validated
			// historical fact for the adapter version the baseline records, so
			// a baseline naming any other tag - published in a different era
			// or never - fails like any other stale spec.
			const authenticatedMigrationBaseline = authenticatedCompatibility &&
				migrationBaselineException(rel, text, ref.ref, historicalRefByAdapterVersion);
			if (markdownNavigationTarget || immutableCompatibilityFact || generatedReadmeFact || authenticatedBinaryRecord || authenticatedMigrationBaseline) {
				allowed++;
				continue;
			}
			(isLockfile ? lockfiles : stale).push({ rel, ...ref });
		}
	}

	console.log(
		`  ${files.length} tracked file(s) scanned, ${total} install-spec reference(s)` +
		`, ${stale.length} stale, ${allowed} authenticated exception(s).`
	);

	// A lockfile out of step is real drift, but the fix is a reinstall, so it is
	// surfaced and left to a human rather than failing the build.
	for (const f of lockfiles) {
		const named = f.ref ?? '(no exact commit or semver selector)';
		console.log(`  note (generated lockfile behind the pin; rerun \`npm install\` there): ${f.rel}:${f.line} -> ${named}`);
	}

	if (stale.length) {
		console.error(`\ncheck-uws-pin FAILED (${stale.length} stale install spec(s)):`);
		for (const f of stale) {
			const named = f.ref ?? '(no exact commit or semver selector)';
			console.error(`  x ${f.rel}:${f.line}  names ${named}, pin is ${pinned}`);
		}
		console.error(`  Update each site to the pinned tag - or, in runtime code, derive it from`);
		console.error(`  optionalDependencies with uwsInstallSpec() from src/uws-load-hint.js.`);
		console.error(`  synthetic test ref must be assembled from pieces so it is not copy-pasteable.`);
		process.exit(1);
	}

	console.log(`  OK - every install spec names the pinned ref.`);
}

// Importable for its own test suite; only the CLI invocation runs the check.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
