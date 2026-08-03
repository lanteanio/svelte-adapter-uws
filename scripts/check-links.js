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
 * depend on the network and on other people's uptime. The scheduled/manual
 * `check-external-links.js` companion owns redirects, hard errors, and
 * soft-404 pages without weakening this pull-request gate.
 *
 * Dependency-free (no eslint), modeled on the sibling check-slugs /
 * check-determinism scripts.
 *
 * Flags:
 *   --verbose  list every resolved link, not only the broken ones.
 *
 * @module scripts/check-links
 */
import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join, posix, relative as pathRelative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { parseFragment } from 'parse5';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const markdown = new MarkdownIt({ html: true });

const REPOSITORY_DOCS = [
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'bench',
	'docs/release-manifest.md',
	'docs/releasing.md',
	'SECURITY.md'
];

function addFilesBeneath(relative, files) {
	const absolute = join(root, relative);
	if (!existsSync(absolute)) return;
	const stat = statSync(absolute);
	if (stat.isFile()) {
		files.add(relative.split('\\').join('/'));
		return;
	}
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(absolute)) addFilesBeneath(join(relative, entry), files);
}

function trackedMarkdown() {
	try {
		const repositoryRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		if (resolve(repositoryRoot).toLowerCase() !== root.toLowerCase()) return [];
		return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore']
		}).split('\0').filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Every Markdown document owned by this checkout or included in the package.
 * The package-file walk is also the fallback when the checker runs without a
 * Git worktree.
 *
 * @returns {string[]}
 */
export function documentationFiles() {
	const files = new Set(trackedMarkdown());
	for (const relative of REPOSITORY_DOCS) addFilesBeneath(relative, files);
	for (const relative of packageFiles()) {
		if (relative.toLowerCase().endsWith('.md')) files.add(relative);
	}
	return [...files].sort();
}

/** Every file the package allowlist includes, with exact repository casing. */
export function packageFiles() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const files = new Set(['package.json']);
	for (const relative of pkg.files || []) addFilesBeneath(relative, files);
	return [...files].sort();
}

const rootRealpath = realpathSync(root);

function ownedPathStatus(relativePath) {
	if (posix.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) {
		return 'outside';
	}
	let cursor = root;
	for (const segment of relativePath.split('/').filter(Boolean)) {
		if (!existsSync(cursor) || !statSync(cursor).isDirectory()) return 'missing';
		if (!readdirSync(cursor).includes(segment)) return 'missing';
		cursor = join(cursor, segment);
	}
	if (!existsSync(cursor)) return 'missing';
	const escaped = pathRelative(rootRealpath, realpathSync(cursor));
	if (escaped === '..' || escaped.startsWith('..' + sep) || isAbsolute(escaped)) return 'outside';
	return 'owned';
}

function packageContains(relativePath, packagedFiles) {
	const target = relativePath.replace(/\/$/, '');
	if (packagedFiles.has(target)) return true;
	for (const file of packagedFiles) {
		if (file.startsWith(target + '/')) return true;
	}
	return false;
}

/**
 * GitHub's heading slug: strip inline markdown, lowercase, delete everything
 * that is not a letter, digit, space, hyphen or underscore, then turn spaces
 * into hyphens. Repeated slugs get `-1`, `-2`, ... in document order.
 *
 * @param {string} heading heading text, without the leading `#`s
 * @returns {string}
 */
function inlineText(tokens = []) {
	let result = '';
	for (const token of tokens) {
		if (token.type === 'text' || token.type === 'code_inline') result += token.content;
		else if (token.type === 'softbreak' || token.type === 'hardbreak') result += ' ';
		else if (token.type === 'image') result += inlineText(token.children || []) || token.content;
		else if (token.children) result += inlineText(token.children);
	}
	return result;
}

function renderedInlineText(source) {
	const tokens = markdown.parseInline(source, {});
	return tokens.map((token) => inlineText(token.children || [])).join('');
}

export function slugify(heading) {
	const rendered = renderedInlineText(heading.replace(/[ \t]+#+[ \t]*$/, ''));
	return rendered.trim()
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
	const tokens = markdown.parse(text, {});
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type !== 'heading_open' || tokens[index + 1]?.type !== 'inline') continue;
		const base = slugify(tokens[index + 1].content);
		if (base === '') continue;
		const n = seen.get(base) || 0;
		seen.set(base, n + 1);
		anchors.add(n === 0 ? base : `${base}-${n}`);
	}
	const rendered = parseFragment(markdown.render(text));
	function visit(node) {
		if (node.tagName === 'a') {
			for (const attribute of node.attrs || []) {
				if (attribute.name === 'name' || attribute.name === 'id') anchors.add(attribute.value);
			}
		}
		for (const child of node.childNodes || []) visit(child);
	}
	visit(rendered);
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

	function htmlTargets(source, firstLine) {
		const targets = [];
		const rendered = parseFragment(source, { sourceCodeLocationInfo: true });
		function visit(node) {
			const tag = node.tagName?.toLowerCase();
			const attributeName = tag === 'a' ? 'href' : tag === 'img' ? 'src' : null;
			if (attributeName) {
				const attribute = node.attrs?.find((candidate) => candidate.name.toLowerCase() === attributeName);
				if (attribute) targets.push({
					line: firstLine + (node.sourceCodeLocation?.startLine || 1) - 1,
					target: attribute.value
				});
			}
			for (const child of node.childNodes || []) visit(child);
		}
		visit(rendered);
		return targets;
	}

	function inlineTargets(tokens, firstLine) {
		const targets = [];
		let line = firstLine;
		for (const token of tokens || []) {
			if (token.type === 'softbreak' || token.type === 'hardbreak') {
				line++;
				continue;
			}
			if (token.type === 'link_open') {
				const target = token.attrGet('href');
				if (target !== null) targets.push({ line, target });
			} else if (token.type === 'image') {
				const target = token.attrGet('src');
				if (target !== null) targets.push({ line, target });
			} else if (token.type === 'html_inline') {
				targets.push(...htmlTargets(token.content, line));
			}
		}
		return targets;
	}

	for (const token of markdown.parse(text, {})) {
		const line = (token.map?.[0] ?? 0) + 1;
		const targets = token.type === 'inline'
			? inlineTargets(token.children, line)
			: token.type === 'html_block' ? htmlTargets(token.content, line) : [];
		links.push(...targets);
	}
	return links;
}

/** Documents that exist, read once. */
function loadDocs() {
	/** @type {Map<string, { text: string, anchors: Set<string> }>} */
	const docs = new Map();
	for (const rel of documentationFiles()) {
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
 * @param {{ packagedDocs?: Set<string>, packagedFiles?: Set<string> }} [options]
 * @returns {string | null} the failure, or null when it resolves
 */
export function checkLink(rel, target, docs, options = {}) {
	// A single-slash scheme typo (https:/example.com) parses as a relative
	// path in a browser but matches the scheme regex below, so it would be
	// waved through as external while being dead in both worlds.
	if (/^https?:\/(?!\/)/i.test(target)) {
		return `malformed scheme (single slash) in link: ${target}`;
	}
	// Same-repo GitHub source routes are checkable locally: the ref must be
	// the canonical main branch (the tree every release fast-forwards onto),
	// and the path must exist in this working tree - a typo'd or moved path
	// is dead the day main receives this tree, so it fails now.
	const sameRepo = /^https:\/\/github\.com\/lanteanio\/svelte-adapter-uws\/(blob|tree|raw)\/([^/]+)\/([^#?]*)/i.exec(target);
	if (sameRepo) {
		const [, , ref, blobPath] = sameRepo;
		if (ref !== 'main') {
			return `same-repo source link must use the canonical main ref, not ${ref}: ${target}`;
		}
		const decoded = decodeURIComponent(blobPath.replace(/\/+$/, ''));
		if (decoded !== '' && !existsSync(resolve(root, decoded))) {
			return `same-repo source link names a path absent from this tree: ${target}`;
		}
		return null;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null; // external or mailto
	if (target.startsWith('#')) {
		let anchor;
		try { anchor = decodeURIComponent(target.slice(1)); }
		catch { return `malformed percent escape in anchor: ${target}`; }
		const doc = docs.get(rel);
		return doc && doc.anchors.has(anchor) ? null : `no heading in ${rel} produces #${anchor}`;
	}

	const hashAt = target.indexOf('#');
	const route = hashAt === -1 ? target : target.slice(0, hashAt);
	const anchor = hashAt === -1 ? undefined : target.slice(hashAt + 1);
	const queryAt = route.indexOf('?');
	const encodedPath = queryAt === -1 ? route : route.slice(0, queryAt);
	if (encodedPath === '') return null;
	let decodedPath;
	try { decodedPath = decodeURIComponent(encodedPath); }
	catch { return `malformed percent escape in path: ${encodedPath}`; }
	const resolved = posix.normalize(posix.join(posix.dirname(rel.split('\\').join('/')), decodedPath));
	const status = ownedPathStatus(resolved);
	if (status === 'outside') return `path leaves repository: ${resolved}`;
	if (status === 'missing') return `no such file with exact case: ${resolved}`;
	if (options.packagedDocs?.has(rel) && options.packagedFiles && !packageContains(resolved, options.packagedFiles)) {
		return `target omitted from package: ${resolved}`;
	}
	if (anchor === undefined) return null;

	// A cross-document anchor is only checkable when the target is one of the
	// documents this gate reads; anything else resolves as a plain file link.
	const doc = docs.get(resolved);
	if (!doc) return null;
	let decodedAnchor;
	try { decodedAnchor = decodeURIComponent(anchor); }
	catch { return `malformed percent escape in anchor: ${anchor}`; }
	return doc.anchors.has(decodedAnchor) ? null : `no heading in ${resolved} produces #${anchor}`;
}

function main() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const docs = loadDocs();
	const packagedFiles = new Set(packageFiles());
	const packagedDocs = new Set([...packagedFiles].filter((relative) => relative.toLowerCase().endsWith('.md')));
	console.log(`check-links: ${pkg.name}@${pkg.version}`);

	let total = 0;
	const broken = [];
	for (const [rel, doc] of docs) {
		for (const { line, target } of linksOf(doc.text)) {
			total++;
			const failure = checkLink(rel, target, docs, { packagedDocs, packagedFiles });
			if (failure) broken.push({ rel, line, target, failure });
			else if (verbose) console.log(`  ok ${rel}:${line} -> ${target}`);
		}
	}

	const headings = [...docs.values()].reduce((n, d) => n + d.anchors.size, 0);
	console.log(`  ${docs.size} document(s), ${packagedDocs.size} packaged, ${headings} anchor(s), ${total} internal link(s) checked.`);

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
