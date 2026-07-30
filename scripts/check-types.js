#!/usr/bin/env node
/**
 * Validate that the package's public surface is intact.
 *
 * For every subpath in the `exports` map (and the top-level
 * `types`/`main`/`module` fields) this asserts that:
 *   1. the target file exists on disk;
 *   2. a `types`/`typings` condition points at a real `.d.ts`;
 *   3. the target is covered by the `files` publish allowlist, so it actually
 *      ships (a file that resolves locally but is missing from `files` 404s
 *      after publish).
 *
 * It guards the drift class where an `exports` entry points at a missing or
 * mistyped declaration (silently degrading consumers to `any`) or a file that
 * never gets published. It is dependency-free on purpose: no TypeScript install
 * is required, so it runs anywhere `node` does. Run via `npm run check`; wired
 * into `pretest` so the unit run enforces it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const errors = [];
const checked = [];

const TYPE_CONDITIONS = new Set(['types', 'typings']);
const filesHasGlob = Array.isArray(pkg.files) && pkg.files.some((e) => /[*?{}[\]!]/.test(e));

function exists(rel) {
	return existsSync(join(root, rel.replace(/^\.\//, '')));
}

// True when a target is included by the `files` allowlist. Skipped (treated as
// covered) when there is no allowlist or it uses globs we will not try to model.
function isPublished(target) {
	if (!Array.isArray(pkg.files) || filesHasGlob) return true;
	const norm = target.replace(/^\.\//, '');
	return pkg.files.some((entry) => {
		const e = entry.replace(/^\.\//, '').replace(/\/$/, '');
		return norm === e || norm.startsWith(e + '/');
	});
}

function checkTarget(label, condition, target) {
	if (typeof target !== 'string') return;
	const ok = exists(target);
	checked.push({ label, condition, target, ok });
	if (!ok) {
		errors.push(`${label} (${condition}): target does not exist -> ${target}`);
		return;
	}
	if (TYPE_CONDITIONS.has(condition) && !target.endsWith('.d.ts')) {
		errors.push(`${label} (${condition}): a type condition must point at a .d.ts -> ${target}`);
	}
	if (!isPublished(target)) {
		errors.push(`${label} (${condition}): resolves locally but is not in the "files" publish allowlist -> ${target}`);
	}
}

// An exports value object is a conditions map when no key starts with '.'; a
// key starting with '.' marks a nested subpath. Walk handles both, plus the
// string shorthand and conditions nested under conditions.
function isConditions(obj) {
	return Object.keys(obj).every((k) => !k.startsWith('.'));
}

function walk(subpath, value) {
	if (typeof value === 'string') {
		checkTarget(subpath, 'default', value);
		return;
	}
	if (!value || typeof value !== 'object') return;
	if (isConditions(value)) {
		for (const [condition, target] of Object.entries(value)) {
			if (typeof target === 'string') checkTarget(subpath, condition, target);
			else walk(subpath, target);
		}
	} else {
		for (const [seg, sub] of Object.entries(value)) {
			walk(subpath === '.' ? seg : subpath + seg.replace(/^\./, ''), sub);
		}
	}
}

if (pkg.exports && typeof pkg.exports === 'object') {
	for (const [subpath, value] of Object.entries(pkg.exports)) walk(subpath, value);
} else if (typeof pkg.exports === 'string') {
	checkTarget('.', 'default', pkg.exports);
}

for (const field of ['types', 'typings']) {
	if (typeof pkg[field] === 'string') checkTarget(`(package.${field})`, 'types', pkg[field]);
}
for (const field of ['main', 'module']) {
	if (typeof pkg[field] === 'string') checkTarget(`(package.${field})`, 'default', pkg[field]);
}

// Every named runtime export must carry a declaration.
//
// Three root exports shipped undeclared, were declared one by one, and the
// class immediately re-broke when the next round added another - because
// nothing checked the CLASS, only the instances. A consumer importing an
// undeclared export gets `any` in a package whose whole point is that the
// types ship, and nothing fails until someone notices by hand.
//
// Deliberately a source-text scan rather than a typecheck: this gate runs
// before any build and must stay dependency-free, and the question here is
// only "is there a declaration with this name", which the text answers.
//
// The PAIRS COME FROM THE EXPORTS MAP, not a hand-kept list. A hand-kept list
// covered six of the thirty-two published pairs and left `./client` - the most
// imported subpath in the package - ungated, where two exports were in fact
// already undeclared. A gate that has to be remembered is the same failure it
// was written to stop.

/**
 * Names a JS module exports, read from the AST.
 *
 * PARSED, not pattern-matched. A hand-rolled scanner that stripped comments and
 * quoted literals looked right and was badly wrong: it has no way to tell a
 * regex literal from division, so a regex containing a quote (`/['"]/`) read as
 * the start of a string and swallowed everything to the next matching quote. On
 * `src/index.js` that ate 42,000 of 47,420 characters and the file reported ZERO
 * exports - a gate that silently checked nothing, which is worse than the false
 * positive it was written to remove. acorn is already a dependency here (see
 * check-scope.js) and answers the question exactly.
 *
 * @param {string} src
 * @param {string} label for the error message
 * @returns {Set<string> | null} null when the file cannot be parsed
 */
function runtimeExportNames(src, label) {
	let ast;
	try {
		ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
	} catch (err) {
		errors.push(`${label}: cannot be parsed to read its exports - ${/** @type {Error} */ (err).message}`);
		return null;
	}
	const names = new Set();
	for (const node of ast.body) {
		if (node.type === 'ExportNamedDeclaration') {
			if (node.declaration) {
				const d = node.declaration;
				if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
					if (d.id) names.add(d.id.name);
				} else if (d.type === 'VariableDeclaration') {
					for (const decl of d.declarations) {
						if (decl.id.type === 'Identifier') names.add(decl.id.name);
					}
				}
			}
			for (const spec of node.specifiers) {
				const exported = spec.exported;
				const name = exported.type === 'Identifier' ? exported.name : exported.value;
				if (name && name !== 'default') names.add(name);
			}
		} else if (node.type === 'ExportAllDeclaration' && node.exported) {
			const name = node.exported.type === 'Identifier' ? node.exported.name : node.exported.value;
			if (name) names.add(name);
		}
	}
	return names;
}

/**
 * Remove comments from a `.d.ts` so a commented-out declaration is correctly
 * read as absent rather than as a declaration.
 *
 * A declaration file is not parsed here - acorn does not read TypeScript - so
 * this side stays a text scan. It is far safer than the same scan over JS: a
 * `.d.ts` carries no regex literals and no executable code, so the only hazard
 * the JS scanner tripped on does not exist. Quoted literals are deliberately
 * left alone, since swallowing them is what caused the failure above.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
	let out = '';
	let i = 0;
	while (i < src.length) {
		if (src[i] === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (src[i] === '/' && src[i + 1] === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
			i += 2;
			out += ' ';
			continue;
		}
		out += src[i];
		i++;
	}
	return out;
}

/**
 * Names a `.d.ts` declares or re-exports.
 * @param {string} src already stripped of comments
 * @returns {Set<string>}
 */
function declaredNamesIn(src) {
	const names = new Set();
	const declared = /(?:^|\n)\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
	for (const m of src.matchAll(declared)) names.add(m[1]);
	// `export { a, b as c }`, including multiline lists and `export { x } from`.
	const list = /(?:^|\n)\s*export\s*\{([\s\S]*?)\}/g;
	for (const m of src.matchAll(list)) {
		for (const part of m[1].split(',')) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
		}
	}
	const star = /(?:^|\n)\s*export\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g;
	for (const m of src.matchAll(star)) names.add(m[1]);
	return names;
}

// Pair each subpath's runtime target with its declaration target.
/** @type {Map<string, { runtime?: string, types?: string }>} */
const bySubpath = new Map();
for (const c of checked) {
	if (!bySubpath.has(c.label)) bySubpath.set(c.label, {});
	const slot = /** @type {any} */ (bySubpath.get(c.label));
	if (TYPE_CONDITIONS.has(c.condition)) {
		if (!slot.types) slot.types = c.target;
	} else if (!slot.runtime && /\.(js|mjs)$/.test(c.target)) {
		slot.runtime = c.target;
	}
}

let undeclaredCount = 0;
let declaredCount = 0;
let pairsChecked = 0;
for (const [subpath, { runtime, types }] of bySubpath) {
	if (!runtime || !types) continue;
	let runtimeSrc;
	let typesSrc;
	try {
		runtimeSrc = readFileSync(join(root, runtime.replace(/^\.\//, '')), 'utf8');
		typesSrc = stripComments(readFileSync(join(root, types.replace(/^\.\//, '')), 'utf8'));
	} catch {
		errors.push(`${subpath}: ${runtime} / ${types} cannot be read to compare exports`);
		continue;
	}
	const runtimeNames = runtimeExportNames(runtimeSrc, runtime);
	if (runtimeNames === null) continue;
	pairsChecked++;
	const declaredNames = declaredNamesIn(typesSrc);
	for (const name of runtimeNames) {
		declaredCount++;
		if (!declaredNames.has(name)) {
			undeclaredCount++;
			errors.push(`${runtime} exports \`${name}\` but ${types} does not declare it`);
		}
	}
}

const declarations = checked.filter((c) => TYPE_CONDITIONS.has(c.condition));
console.log(`check-types: ${pkg.name}@${pkg.version}`);
console.log(`  ${checked.length} export target(s) checked, ${declarations.length} declaration file(s).`);
console.log(`  ${declaredCount} named runtime export(s) matched against declarations, ${undeclaredCount} undeclared.`);

if (errors.length) {
	console.error(`\ncheck-types FAILED (${errors.length} problem(s)):`);
	for (const e of errors) console.error(`  x ${e}`);
	process.exit(1);
}

console.log('  OK - every exports target resolves, types are .d.ts, and all ship.');
