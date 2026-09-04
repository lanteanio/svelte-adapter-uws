#!/usr/bin/env node
// Refuse a tracked text file that git records as binary, and name the byte that
// made it one.
//
// Node accepts a raw control character inside a string literal, so a module
// carrying one runs correctly and reads correctly in an editor. Git does not
// treat it as text: one NUL is enough for the blob to be classified binary, and
// from that moment every diff, blame, patch and merge on the file degrades to
// `Bin <n> -> <m> bytes`. That is silent, and it is not what any author
// intended - the delimiter they wanted is available as an escape, which is the
// same byte at runtime and leaves the source a text file.
//
// It is worse than a lost diff. `check-formatting` skips a file git records as
// binary, because such a file has no end-of-line classification and no text
// contract to check - so going binary quietly removes a module from the
// formatting gate as well. A byte nobody chose ends up deciding which files are
// covered.
//
// The signal is git's own classification rather than a byte scan of our own:
// `git ls-files --eol` reports what is COMMITTED (`i/`), and the attribute
// (`attr/`) reports what .gitattributes declares that path should be. A file
// declared text whose committed blob is `-text` is the defect, stated in git's
// terms rather than in a rule this script invents. A path deliberately declared
// binary is not flagged, and needs no exemption list here - .gitattributes
// already is that list.
//
// `i/none` is NOT binary: git reports it for a file with no end-of-line at all
// (a single line with no trailing newline). Reading it as binary would flag an
// innocent fixture.
//
// The offending byte is then located by reading the file, so the report names a
// line and a codepoint instead of only a path - the fix is always the same
// one-character edit, and saying which character and where is the difference
// between a useful failure and a puzzle.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tab, newline and carriage return are the control characters source may hold. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/**
 * What git records for each tracked path: the committed classification and the
 * attribute that path resolves to.
 *
 * @returns {{ path: string, index: string, attr: string }[]}
 */
export function trackedEol() {
	const output = execFileSync('git', ['ls-files', '--eol'], {
		cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
	});
	const rows = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		// The attribute field holds SEVERAL space-separated attributes - this
		// repository's `* text=auto eol=lf` prints as `attr/text=auto eol=lf` - so
		// it runs up to the tab before the path, not to the first space.
		const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/([^\t]*?)\s*\t(.*)$/.exec(line);
		if (match) rows.push({ index: match[1], attr: match[3], path: match[4] });
	}
	return rows;
}

/** Does .gitattributes declare this path binary, so a binary blob is intended? */
function declaredBinary(attr) {
	return /(^|\s)(-text|binary)(\s|$)/.test(attr);
}

/**
 * Where the disallowed control characters are, so the report can name them.
 *
 * @param {string} file  repository-relative path
 * @returns {{ line: number, code: number }[]}
 */
function controlCharacters(file) {
	let bytes;
	try {
		bytes = readFileSync(resolve(root, file));
	} catch {
		return [];
	}
	const hits = [];
	let line = 1;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === 0x0a) { line++; continue; }
		if (ALLOWED.has(byte)) continue;
		if (byte < 0x20 || byte === 0x7f) {
			hits.push({ line, code: byte });
			// One report per file is enough to act on, and a file full of them is
			// an encoding accident whose first hit says so just as well.
			if (hits.length >= 8) break;
		}
	}
	return hits;
}

export function findOffenses() {
	const offenses = [];
	for (const { path, index, attr } of trackedEol()) {
		if (declaredBinary(attr)) continue;
		if (index !== '-text') continue;
		const hits = controlCharacters(path);
		if (hits.length === 0) {
			offenses.push(`${path}: git records this as binary though its attributes declare it text`);
			continue;
		}
		for (const { line, code } of hits) {
			const escape = code === 0 ? '\\0' : `\\u${code.toString(16).padStart(4, '0')}`;
			offenses.push(
				`${path}:${line}: control character U+${code.toString(16).padStart(4, '0').toUpperCase()} in tracked source; ` +
				`write it as ${escape} - the same byte at runtime, and the file stays text`
			);
		}
	}
	return offenses;
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const offenses = findOffenses();
console.log(`check-source-bytes: ${pkg.name}@${pkg.version}`);
if (offenses.length > 0) {
	console.error(`  ${offenses.length} offense(s):`);
	for (const offense of offenses) console.error(`    ${offense}`);
	console.error('  A control character makes git classify the blob as binary, which loses every');
	console.error('  textual diff on the file and drops it from check-formatting entirely.');
	process.exit(1);
}
const scanned = trackedEol().length;
console.log(`  ${scanned} tracked file(s) scanned; every text-declared path is committed as text.`);
