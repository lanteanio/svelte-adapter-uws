#!/usr/bin/env node
// Refuse a control character in tracked text, and name it.
//
// Node accepts a raw control character inside a string literal, so a module
// carrying one runs correctly and reads correctly in an editor. Git does not
// necessarily treat it as text: one NUL is enough for the blob to be classified
// binary, and from that moment every diff, blame, patch and merge on the file
// degrades to `Bin <n> -> <m> bytes`. That is silent, and it is not what any
// author intended - the delimiter they wanted is available as an escape, which
// is the same byte at runtime and leaves the source a text file.
//
// It is worse than a lost diff. `check-formatting` skips a file git records as
// binary, because such a file has no end-of-line classification and no text
// contract to check - so going binary quietly removes a module from the
// formatting gate as well. A byte nobody chose ends up deciding which files are
// covered.
//
// Two signals, because neither is enough alone. Git's classification is a
// RATIO, not a presence test: a blob is binary for a NUL or a lone CR, or for
// more than one non-printable per 128 printable bytes, so a single 0x01 or 0x7f
// in a module of ordinary size is text to git while the same byte in a tiny
// file is not, and ESC and BS are never counted at any size. So every path
// whose attributes declare it text is scanned byte by byte here, and separately
// `git ls-files --eol` says what git recorded for the committed blob (`i/`) and
// the working copy (`w/`) - either one `-text` under a text attribute is a
// defect even when the scan finds nothing to name, because git has already
// stopped treating the file as text. A path deliberately declared binary is not
// flagged, and needs no exemption list here - .gitattributes already is that
// list. `i/none` is NOT binary: git reports it for a file with no end-of-line
// at all.
//
// The report names a line and a codepoint instead of only a path: the fix is
// always the same one-character edit, and saying which character and where is
// the difference between a useful failure and a puzzle. A CR that is not
// followed by LF is named as its own kind of hit, because it is the byte git
// most often calls binary in otherwise clean text; a CRLF pair is a line ending
// a checkout may legitimately hold and is not a hit.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tab and newline are the control characters source may hold anywhere; CR only before LF. */
const ALLOWED = new Set([0x09, 0x0a]);

/**
 * What git records for each tracked path: the committed classification, the
 * working-copy classification, and the attribute that path resolves to.
 *
 * @param {string} [rootDirectory]
 * @returns {{ path: string, index: string, worktree: string, attr: string }[]}
 */
export function trackedEol(rootDirectory = root) {
	const output = execFileSync('git', ['ls-files', '--eol'], {
		cwd: rootDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
	});
	const rows = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		// The attribute field holds SEVERAL space-separated attributes - this
		// repository's `* text=auto eol=lf` prints as `attr/text=auto eol=lf` - so
		// it runs up to the tab before the path, not to the first space.
		const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/([^\t]*?)\s*\t(.*)$/.exec(line);
		if (match) rows.push({ index: match[1], worktree: match[2], attr: match[3], path: match[4] });
	}
	return rows;
}

/** Does .gitattributes declare this path binary, so a binary blob is intended? */
export function declaredBinary(attr) {
	return /(^|\s)(-text|binary)(\s|$)/.test(attr);
}

/**
 * Where the disallowed control characters are in `bytes`, so the report can
 * name them. At most eight: one is enough to act on, and a file full of them
 * is an encoding accident whose first hit says so just as well.
 *
 * @param {Uint8Array} bytes
 * @returns {{ line: number, code: number }[]}
 */
export function controlCharacters(bytes) {
	const hits = [];
	let line = 1;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === 0x0a) { line++; continue; }
		if (ALLOWED.has(byte)) continue;
		if (byte === 0x0d) {
			if (bytes[i + 1] === 0x0a) continue;
			hits.push({ line, code: byte });
		} else if (byte < 0x20 || byte === 0x7f) {
			hits.push({ line, code: byte });
		} else {
			continue;
		}
		if (hits.length >= 8) break;
	}
	return hits;
}

/**
 * The offense lines for one tracked text path, or none.
 *
 * @param {{ path: string, index: string, worktree: string, attr: string }} row
 * @param {(file: string) => Uint8Array | null} read
 * @returns {string[]}
 */
function offensesFor(row, read) {
	const bytes = read(row.path);
	const hits = bytes === null ? [] : controlCharacters(bytes);
	const offenses = [];
	for (const { line, code } of hits) {
		const escape = code === 0 ? '\\0' : code === 0x0d ? '\\r' : `\\u${code.toString(16).padStart(4, '0')}`;
		const what = code === 0x0d ? 'a carriage return with no line feed after it' : `control character U+${code.toString(16).padStart(4, '0').toUpperCase()}`;
		offenses.push(
			`${row.path}:${line}: ${what} in tracked source; ` +
			`write it as ${escape} - the same byte at runtime, and the file stays text`
		);
	}
	if (hits.length === 0) {
		if (row.index === '-text') offenses.push(`${row.path}: git records the committed blob as binary though its attributes declare it text`);
		else if (row.worktree === '-text') offenses.push(`${row.path}: git records the working copy as binary though its attributes declare it text`);
	}
	return offenses;
}

/**
 * Every offense across the tracked tree, plus how many text-declared paths were
 * scanned - a caller that reports success must be able to say it read
 * something, because a parser that matched nothing would otherwise report a
 * clean tree having checked no file at all.
 *
 * @param {string} [rootDirectory]
 * @returns {{ offenses: string[], scanned: number, tracked: number }}
 */
export function findOffenses(rootDirectory = root) {
	const rows = trackedEol(rootDirectory);
	const read = (file) => {
		try { return readFileSync(resolve(rootDirectory, file)); } catch { return null; }
	};
	const offenses = [];
	let scanned = 0;
	for (const row of rows) {
		if (declaredBinary(row.attr)) continue;
		scanned++;
		offenses.push(...offensesFor(row, read));
	}
	return { offenses, scanned, tracked: rows.length };
}

function main() {
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const { offenses, scanned, tracked } = findOffenses();
	console.log(`check-source-bytes: ${pkg.name}@${pkg.version}`);
	if (tracked === 0) {
		throw new Error('git ls-files --eol reported no tracked file, so nothing was checked; the line shape it prints may have changed');
	}
	if (offenses.length > 0) {
		console.error(`  ${offenses.length} offense(s):`);
		for (const offense of offenses) console.error(`    ${offense}`);
		console.error('  A control character makes git classify the blob as binary, which loses every');
		console.error('  textual diff on the file and drops it from check-formatting entirely.');
		process.exitCode = 1;
		return;
	}
	console.log(`  ${tracked} tracked file(s), ${scanned} declared text and scanned; every one is text with no control character.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('check-source-bytes failed:\n' + error.message);
		process.exitCode = 1;
	}
}
