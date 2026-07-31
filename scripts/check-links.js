#!/usr/bin/env node
/**
 * Guard that every internal link in the shipped documentation resolves: a
 * `](#anchor)` names a heading that exists, and a relative `](./file.md)` names
 * a file that exists.
 *
 * A dead anchor is invisible to every other gate in this repository and to the
 * author writing it - GitHub renders it as an ordinary link and silently does
 * nothing when it is clicked. The README carries several thousand lines and a
 * table of contents, its headings get reworded, and the links to them do not
 * move with them; one such link had been dead in the published README for some
 * time before this existed.
 *
 * The slug rule is GitHub's, reproduced exactly, because an approximation is
 * worse than nothing here: it either passes dead links or fails live ones. In
 * particular `## Development, Preview & Production` really does produce
 * `development-preview--production` - punctuation is DELETED, not replaced, so
 * the two spaces around the removed `&` become two hyphens. A checker that
 * collapses runs of hyphens rejects a link that works.
 *
 * Scope: the markdown this package publishes plus the contributor documentation.
 * External `http(s)` links are not fetched - that would make a static gate
 * depend on the network and on other people's uptime.
 *
 * Dependency-free (no eslint), modeled on the sibling check-slugs /
 * check-determinism scripts.
 *
 * Flags:
 *   --verbose  list every resolved link, not only the broken ones.
 *
 * @module scripts/check-links
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

// The published docs (package.json `files` ships the first three) plus the
// contributor guide, which is the one document that links into all of them.
//
// CHANGELOG.md is deliberately absent: it is append-only history, its entries
// name paths that were correct on the day they were written and have since
// moved, and it uses GitHub's repo-relative link forms (`../../commits/...`)
// that are not filesystem paths at all. A gate that forces history to be
// rewritten is worse than the drift it prevents.
const DOCS = ['README.md', 'MIGRATION.md', 'PROTOCOL.md', 'CONTRIBUTING.md'];

/**
 * GitHub's heading slug: strip inline markdown, lowercase, delete everything
 * that is not a letter, digit, space, hyphen or underscore, then turn spaces
 * into hyphens. Repeated slugs get `-1`, `-2`, ... in document order.
 *
 * @param {string} heading heading text, without the leading `#`s
 * @returns {string}
 */
export function slugify(heading) {
	return heading
		.replace(/`([^`]*)`/g, '$1')              // code spans
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links keep their text
		.replace(/[*_~]/g, '')                    // emphasis markers
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

/**
 * Every anchor one document defines: its headings' slugs plus any explicit
 * `<a name>` / `<a id>`. Fenced code blocks are skipped, so a `# comment` line
 * inside a shell example is not read as a heading.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function anchorsOf(text) {
	const anchors = new Set();
	const seen = new Map();
	let fenced = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		for (const m of line.matchAll(/<a\s[^>]*(?:name|id)=["']([^"']+)["']/g)) anchors.add(m[1]);
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (!heading) continue;
		const base = slugify(heading[2]);
		if (base === '') continue;
		const n = seen.get(base) || 0;
		seen.set(base, n + 1);
		anchors.add(n === 0 ? base : `${base}-${n}`);
	}
	return anchors;
}

/**
 * Every markdown link target in a document, with its line number. Inline code
 * spans are excluded: `[x](#y)` written as an EXAMPLE of a link is not one.
 *
 * @param {string} text
 * @returns {{ line: number, target: string }[]}
 */
export function linksOf(text) {
	const links = [];
	const lines = text.split(/\r?\n/);
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
		if (fenced) continue;
		const line = lines[i].replace(/`[^`]*`/g, '');
		for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
			links.push({ line: i + 1, target: m[1] });
		}
	}
	return links;
}

/** Documents that exist, read once. */
function loadDocs() {
	/** @type {Map<string, { text: string, anchors: Set<string> }>} */
	const docs = new Map();
	for (const rel of DOCS) {
		const abs = join(root, rel);
		if (!existsSync(abs)) continue;
		const text = readFileSync(abs, 'utf8');
		docs.set(rel, { text, anchors: anchorsOf(text) });
	}
	return docs;
}

/**
 * Resolve one link against the document it appears in.
 *
 * @param {string} rel the document containing the link
 * @param {string} target the link target as written
 * @param {Map<string, { anchors: Set<string> }>} docs
 * @returns {string | null} the failure, or null when it resolves
 */
export function checkLink(rel, target, docs) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null; // external or mailto
	if (target.startsWith('#')) {
		const anchor = decodeURIComponent(target.slice(1));
		const doc = docs.get(rel);
		return doc && doc.anchors.has(anchor) ? null : `no heading in ${rel} produces #${anchor}`;
	}

	const [path, anchor] = target.split('#');
	if (path === '') return null;
	const resolved = posix.normalize(posix.join(posix.dirname(rel.split('\\').join('/')), path));
	if (!existsSync(join(root, resolved))) return `no such file: ${resolved}`;
	if (anchor === undefined) return null;

	// A cross-document anchor is only checkable when the target is one of the
	// documents this gate reads; anything else resolves as a plain file link.
	const doc = docs.get(resolved);
	if (!doc) return null;
	return doc.anchors.has(decodeURIComponent(anchor))
		? null
		: `no heading in ${resolved} produces #${anchor}`;
}

function main() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const docs = loadDocs();
	console.log(`check-links: ${pkg.name}@${pkg.version}`);

	let total = 0;
	const broken = [];
	for (const [rel, doc] of docs) {
		for (const { line, target } of linksOf(doc.text)) {
			total++;
			const failure = checkLink(rel, target, docs);
			if (failure) broken.push({ rel, line, target, failure });
			else if (verbose) console.log(`  ok ${rel}:${line} -> ${target}`);
		}
	}

	const headings = [...docs.values()].reduce((n, d) => n + d.anchors.size, 0);
	console.log(`  ${docs.size} document(s), ${headings} anchor(s), ${total} internal link(s) checked.`);

	if (broken.length) {
		console.error(`\ncheck-links FAILED (${broken.length} dead link(s)):`);
		for (const b of broken) console.error(`  x ${b.rel}:${b.line}  ${b.target}  - ${b.failure}`);
		console.error(`  Fix the link or the heading it points at. External links are not fetched.`);
		process.exit(1);
	}

	console.log(`  OK - every internal link resolves.`);
}

// Importable for its own test suite; only the CLI invocation reads the docs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
