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
// Only specifiers that NAME a file are judged. This repository writes explicit
// extensions on relative imports, so that covers them; a directory or
// extensionless specifier would need real module resolution, and guessing at it
// would produce false offenses. Saying so here is better than implying coverage
// this does not have.
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every path in the index, slash-normalised so comparisons hold on Windows. */
function trackedPaths() {
	return new Set(
		execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
			.split('\n')
			.filter(Boolean)
			.map((path) => path.replace(/\\/g, '/'))
	);
}

// Static `import`/`export ... from`, plus dynamic `import(...)`.
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Drop comment lines before matching.
 *
 * The dynamic-import branch cannot be line-anchored the way the static one is,
 * so it matches anywhere - including inside a comment that quotes an example
 * specifier. This file's own doc comment did exactly that and the check
 * reported itself. A module that documents an import is ordinary; a checker
 * that reads documentation as code is not.
 *
 * Line-based, because that is what the false positive needs and it cannot
 * corrupt a string the way a general comment stripper can: a `//` inside a
 * string literal never starts the line, and block comments here are JSDoc whose
 * continuations start with `*`.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutCommentLines(text) {
	return text
		.split('\n')
		.map((line) => {
			const trimmed = line.trimStart();
			return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') ? '' : line;
		})
		.join('\n');
}

export function findOffenses() {
	const tracked = trackedPaths();
	const sources = [...tracked].filter((path) => /^(src|scripts)\/.*\.(js|mjs)$/.test(path));
	const offenses = [];

	for (const file of sources) {
		let text;
		try {
			text = readFileSync(join(root, file), 'utf8');
		} catch {
			continue;
		}
		const code = withoutCommentLines(text);
		SPECIFIER.lastIndex = 0;
		let match;
		while ((match = SPECIFIER.exec(code)) !== null) {
			const specifier = match[1] || match[2];
			if (!specifier) continue;
			const target = posix.normalize(posix.join(posix.dirname(file), specifier));
			if (!/\.(js|mjs|cjs|json)$/.test(target)) continue;
			if (tracked.has(target)) continue;
			const onDisk = existsSync(join(root, target));
			offenses.push(
				onDisk
					? `${file}: imports ${specifier} - present on disk, absent from git, so this repository builds here and not from a clone`
					: `${file}: imports ${specifier} - which resolves to nothing`
			);
		}
	}
	return offenses;
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const offenses = findOffenses();
console.log(`check-tracked-imports: ${pkg.name}@${pkg.version}`);
if (offenses.length > 0) {
	console.error(`  ${offenses.length} offense(s):`);
	for (const offense of offenses) console.error(`    ${offense}`);
	console.error('  An untracked import target passes every local run and breaks every clone.');
	process.exit(1);
}
const scanned = [...trackedPaths()].filter((path) => /^(src|scripts)\/.*\.(js|mjs)$/.test(path)).length;
console.log(`  ${scanned} tracked source file(s) scanned; every relative file import resolves to a tracked file.`);
