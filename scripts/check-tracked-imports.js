#!/usr/bin/env node
// Refuse a tracked source file that imports a relative path which is not itself
// tracked.
//
// A module can sit on disk and be absent from git - one over-broad `.gitignore`
// line is enough, and the line does not have to name it. Everything local then
// passes: the tests import it, the checks import it, and `npm pack` lists it,
// because all three read the WORKING TREE. Only a fresh clone is broken, and it
// is broken at the entry point rather than in some corner, because the import
// runs at module load.
//
// That is the whole failure: working tree green, clone unusable, and nothing in
// between looks at the difference. `npm pack --dry-run` cannot answer it - it
// happily lists an untracked file, which is why a tarball can be complete while
// the repository is not.
//
// The imports are read from the PARSED module, not matched by a regular
// expression: a side-effect import (`import './x.js'`), a named import that
// spans lines, `export ... from`, `export * from`, a dynamic `import('./x.js')`
// and a `require('./x.js')` are all declarations to the parser and all of them
// break a clone the same way, while a specifier quoted in a comment or a string
// is not a declaration and is never judged.
//
// Only a relative specifier that names a file is judged. A dynamic import whose
// argument is computed cannot be resolved without running the program and is
// left alone. A relative specifier without a file extension is refused on its
// own account: Node's ESM loader does not resolve one, so it is either a bug or
// a bundler-only path, and this repository writes explicit extensions. A query
// or fragment on the specifier is dropped first, because the loader resolves
// the file and keeps the query as a cache key.
//
// The fixture's build output (`test/fixture/build`, `test/fixture/build-*`) is
// the one untracked place a test may import from: the suite's global setup
// generates it in every clone before a test runs, so an import into it is not
// a clone-breaker and is not judged.
//
// The two outcomes are reported differently on purpose. `on disk but untracked`
// is the dangerous one and the reason this check exists - it cannot be found by
// running anything. `missing entirely` already fails loudly the first time
// anyone imports it, so it is reported for completeness rather than as the
// motivating case.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The tracked files this check reads: JavaScript under src/, scripts/ and test/. */
const SOURCE = /^(src|scripts|test)\/.*\.(js|mjs)$/;

/**
 * A specifier whose last segment carries an extension, so it names a file.
 * Any extension counts: a `.svelte` or `.css` import from a fixture route is
 * a file a clone needs just as much as a module is.
 */
const NAMES_FILE = /\.[^./\\]+$/;

/** The fixture build output every clone regenerates through the suite's global setup. */
const GENERATED = /^test\/fixture\/build(-[^/]+)?\//;

/**
 * Every path in the index, slash-normalised so comparisons hold on Windows.
 * @param {string} [rootDirectory]
 * @returns {Set<string>}
 */
export function trackedPaths(rootDirectory = root) {
	return new Set(
		execFileSync('git', ['ls-files', '-z'], { cwd: rootDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
			.split('\0')
			.filter(Boolean)
			.map((path) => path.replace(/\\/g, '/'))
	);
}

/**
 * The string a module specifier node carries, or null when it is computed.
 * A template literal with no substitution is a string to the loader too.
 * @param {any} node
 * @returns {string | null}
 */
function literalSpecifier(node) {
	if (!node) return null;
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked;
	return null;
}

/**
 * Every relative specifier `text` imports, in source order, with the line it
 * sits on. Reads the parsed module: import and export declarations, dynamic
 * `import()` and `require()` with a literal argument.
 *
 * @param {string} text
 * @returns {{ specifier: string, line: number }[]}
 */
export function relativeImports(text) {
	const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
	const found = [];
	const take = (node, source) => {
		const specifier = literalSpecifier(source);
		if (specifier !== null && specifier.startsWith('.')) found.push({ specifier, line: node.loc.start.line });
	};
	const walk = (node) => {
		if (!node || typeof node.type !== 'string') return;
		switch (node.type) {
			case 'ImportDeclaration':
			case 'ExportAllDeclaration':
				take(node, node.source);
				break;
			case 'ExportNamedDeclaration':
				if (node.source) take(node, node.source);
				break;
			case 'ImportExpression':
				take(node, node.source);
				break;
			case 'CallExpression':
				if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) take(node, node.arguments[0]);
				break;
			default:
				break;
		}
		for (const key of Object.keys(node)) {
			if (key === 'loc') continue;
			const child = node[key];
			if (Array.isArray(child)) { for (const item of child) if (item && typeof item.type === 'string') walk(item); }
			else if (child && typeof child.type === 'string') walk(child);
		}
	};
	walk(ast);
	return found;
}

/**
 * Every offense across the tracked sources, plus how many were scanned - a
 * caller reporting success must be able to say it read something.
 *
 * @param {string} [rootDirectory]
 * @returns {{ offenses: string[], scanned: number }}
 */
export function findOffenses(rootDirectory = root) {
	const tracked = trackedPaths(rootDirectory);
	const sources = [...tracked].filter((path) => SOURCE.test(path));
	const offenses = [];
	let scanned = 0;

	for (const file of sources) {
		let text;
		try {
			text = readFileSync(join(rootDirectory, file), 'utf8');
		} catch {
			continue;
		}
		scanned++;
		let imports;
		try {
			imports = relativeImports(text);
		} catch (error) {
			offenses.push(`${file}: does not parse as a module, so its imports cannot be read - ${error.message}`);
			continue;
		}
		for (const { specifier, line } of imports) {
			const target = posix.normalize(posix.join(posix.dirname(file), specifier.replace(/[?#].*$/, '')));
			if (GENERATED.test(target)) continue;
			if (!NAMES_FILE.test(target)) {
				offenses.push(`${file}:${line}: imports ${specifier} - no file extension, which Node's module loader does not resolve; name the file`);
				continue;
			}
			if (tracked.has(target)) continue;
			const onDisk = existsSync(join(rootDirectory, target));
			offenses.push(
				onDisk
					? `${file}:${line}: imports ${specifier} - present on disk, absent from git, so this repository builds here and not from a clone`
					: `${file}:${line}: imports ${specifier} - which resolves to nothing`
			);
		}
	}
	return { offenses, scanned };
}

function main() {
	// An optional root lets the check be pointed at another repository, which is
	// how its own test drives the real entry against a scratch tree.
	const rootDirectory = process.argv[2] ? resolve(process.argv[2]) : root;
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	console.log(`check-tracked-imports: ${pkg.name}@${pkg.version}`);
	const { offenses, scanned } = findOffenses(rootDirectory);
	if (scanned === 0) {
		throw new Error('git ls-files listed no source file under src/, scripts/ or test/, so nothing was checked');
	}
	if (offenses.length > 0) {
		console.error(`  ${offenses.length} offense(s):`);
		for (const offense of offenses) console.error(`    ${offense}`);
		console.error('  An untracked import target passes every local run and breaks every clone.');
		process.exitCode = 1;
		return;
	}
	console.log(`  ${scanned} tracked source file(s) scanned; every relative import resolves to a tracked file.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('check-tracked-imports failed:\n' + error.message);
		process.exitCode = 1;
	}
}
