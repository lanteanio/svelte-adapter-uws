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
// The scan reads the working copy, which is what a developer's own `npm run
// check` has in front of it, and ALSO the staged blob for any path whose
// working copy differs from the index. A byte fixed on disk after `git add`
// is still in the blob that `git commit` writes, and git's ratio keeps calling
// that blob text, so the disk alone cannot say the commit is clean.
//
// What is refused: the C0 controls except tab and newline, DEL, the C1 controls
// (U+0080 to U+009F, which no source encoding puts in a file on purpose), and
// the invisible code points that either terminate a line to a JS parser or
// mark a byte order - U+2028, U+2029, U+200B and U+FEFF anywhere, a leading
// BOM included. Every one of them is a byte nobody can see in an editor and
// nobody chose; a joiner that emoji sequences legitimately carry (U+200D) is
// not in the set. Tab, LF and CRLF are allowed; a CR that is not followed by LF
// is named as its own kind of hit, because it is the byte git most often calls
// binary in otherwise clean text.
//
// The report names a line and a codepoint instead of only a path: the fix is
// always the same one-character edit, and saying which character and where is
// the difference between a useful failure and a puzzle.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BUFFER = 64 * 1024 * 1024;

/** Tab and newline are the control characters source may hold anywhere; CR only before LF. */
const ALLOWED = new Set([0x09, 0x0a]);

/**
 * The multi-byte UTF-8 sequences that are refused, keyed by their code point.
 * U+0080..U+009F are the C1 controls (0xC2 0x80..0xC2 0x9F); U+200B, U+2028
 * and U+2029 are 0xE2 0x80 0x8B/0xA8/0xA9; U+FEFF is 0xEF 0xBB 0xBF.
 */
const INVISIBLE = new Map([
	[0x200b, [0xe2, 0x80, 0x8b]],
	[0x2028, [0xe2, 0x80, 0xa8]],
	[0x2029, [0xe2, 0x80, 0xa9]],
	[0xfeff, [0xef, 0xbb, 0xbf]]
]);

/**
 * What git records for each tracked path: the committed classification, the
 * working-copy classification, and the attribute that path resolves to.
 *
 * @param {string} [rootDirectory]
 * @returns {{ path: string, index: string, worktree: string, attr: string }[]}
 */
export function trackedEol(rootDirectory = root) {
	// -z: a path with a space or a non-ASCII character is printed as it is,
	// where the line form quotes and escapes it into a spelling no file has -
	// and a path the scan cannot open would count as scanned and clean.
	const output = execFileSync('git', ['ls-files', '--eol', '-z'], {
		cwd: rootDirectory, encoding: 'utf8', maxBuffer: MAX_BUFFER
	});
	const rows = [];
	for (const line of output.split('\0')) {
		if (!line.trim()) continue;
		// The attribute field holds SEVERAL space-separated attributes - this
		// repository's `* text=auto eol=lf` prints as `attr/text=auto eol=lf` - so
		// it runs up to the tab before the path, not to the first space. The
		// working-copy field is EMPTY for a path missing from disk, and that path
		// still has a staged blob to judge, so `w/` may match nothing. The path
		// runs to the end of the record, newline included: git allows one in
		// a name, and a dropped row would undercount rather than refuse.
		const match = /^i\/(\S+)\s+w\/(\S*)\s+attr\/([^\t]*?)\s*\t([\s\S]*)$/.exec(line);
		if (match) rows.push({ index: match[1], worktree: match[2], attr: match[3], path: match[4] });
	}
	return rows;
}

/**
 * The tracked paths whose working copy differs from the index, so the staged
 * blob has to be read on its own. A path deleted on disk is included: what is
 * staged is still what a commit would write.
 *
 * @param {string} [rootDirectory]
 * @returns {Set<string>}
 */
export function divergentPaths(rootDirectory = root) {
	const output = execFileSync('git', ['diff-files', '--name-only', '-z'], {
		cwd: rootDirectory, encoding: 'utf8', maxBuffer: MAX_BUFFER
	});
	return new Set(output.split('\0').filter(Boolean));
}

/**
 * The staged blob of each path, read in one `git cat-file --batch` so a tree
 * with many modified files costs one process rather than one per path. A path
 * git cannot resolve in the index maps to null.
 *
 * @param {Iterable<string>} paths
 * @param {string} [rootDirectory]
 * @returns {Map<string, Uint8Array | null>}
 */
export function indexBlobs(paths, rootDirectory = root) {
	const list = [...paths];
	const blobs = new Map();
	if (list.length === 0) return blobs;
	const output = execFileSync('git', ['cat-file', '--batch'], {
		cwd: rootDirectory, input: list.map((path) => `:${path}\n`).join(''), maxBuffer: MAX_BUFFER
	});
	let offset = 0;
	for (const path of list) {
		const end = output.indexOf(0x0a, offset);
		if (end === -1) { blobs.set(path, null); continue; }
		const header = output.subarray(offset, end).toString('utf8').split(' ');
		offset = end + 1;
		if (header[header.length - 1] === 'missing' || header.length < 3) { blobs.set(path, null); continue; }
		const size = Number(header[2]);
		blobs.set(path, output.subarray(offset, offset + size));
		// The object body is followed by one LF that is not part of it.
		offset += size + 1;
	}
	return blobs;
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
		} else if (byte === 0xc2 && bytes[i + 1] >= 0x80 && bytes[i + 1] <= 0x9f) {
			hits.push({ line, code: bytes[i + 1] });
			i += 1;
		} else if (byte === 0xe2 || byte === 0xef) {
			const code = invisibleAt(bytes, i);
			if (code === 0) continue;
			hits.push({ line, code });
			i += 2;
		} else {
			continue;
		}
		if (hits.length >= 8) break;
	}
	return hits;
}

/** The refused three-byte code point starting at `i`, or 0 when the bytes are something else. */
function invisibleAt(bytes, i) {
	for (const [code, sequence] of INVISIBLE) {
		if (bytes[i] === sequence[0] && bytes[i + 1] === sequence[1] && bytes[i + 2] === sequence[2]) return code;
	}
	return 0;
}

/** How to write the code point so the file stays text, and what to call it. */
function describe(code) {
	const hex = code.toString(16).padStart(4, '0');
	if (code === 0x0d) return { what: 'a carriage return with no line feed after it', escape: '\\r' };
	if (code === 0xfeff) return { what: 'a byte-order mark (U+FEFF)', escape: '\\ufeff' };
	if (code === 0x200b) return { what: 'a zero-width space (U+200B)', escape: '\\u200b' };
	if (code === 0x2028 || code === 0x2029) return { what: `a Unicode line terminator (U+${hex.toUpperCase()})`, escape: `\\u${hex}` };
	return { what: `control character U+${hex.toUpperCase()}`, escape: code === 0 ? '\\0' : `\\u${hex}` };
}

/**
 * The offense lines for one tracked text path, or none.
 *
 * @param {{ path: string, index: string, worktree: string, attr: string }} row
 * @param {(file: string) => Uint8Array | null} read
 * @param {Map<string, Uint8Array | null>} staged the index blob of each divergent path
 * @returns {string[]}
 */
function offensesFor(row, read, staged) {
	const bytes = read(row.path);
	if (bytes === null && !staged.has(row.path)) {
		// A path git lists that this process cannot open, and that git does not
		// report as differing from the index, is not a clean file; it is a file
		// the scan never saw, and saying so beats counting it as scanned.
		return [`${row.path}: git lists it and it could not be read, so its bytes were not checked`];
	}
	let hits = bytes === null ? [] : controlCharacters(bytes);
	let where = 'in tracked source';
	let fix = 'the same byte at runtime, and the file stays text';
	if (hits.length === 0 && staged.has(row.path)) {
		// The disk is clean but the index holds something else: read what a
		// commit would actually write, and say that the fix is to stage it.
		const blob = staged.get(row.path);
		hits = blob === null ? [] : controlCharacters(blob);
		where = 'in the staged blob, though the working copy is clean';
		fix = 'the same byte at runtime - then stage the fixed file, because the commit writes the blob, not the disk';
	}
	const offenses = [];
	for (const { line, code } of hits) {
		const { what, escape } = describe(code);
		offenses.push(`${row.path}:${line}: ${what} ${where}; write it as ${escape} - ${fix}`);
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
 * @param {(file: string) => Uint8Array | null} [read] how a tracked path's
 *   working copy is read; null for a file that cannot be opened
 * @returns {{ offenses: string[], scanned: number, tracked: number }}
 */
export function findOffenses(rootDirectory = root, read = (file) => {
	try { return readFileSync(resolve(rootDirectory, file)); } catch { return null; }
}) {
	const rows = trackedEol(rootDirectory);
	const divergent = divergentPaths(rootDirectory);
	const text = new Set(rows.filter((row) => !declaredBinary(row.attr)).map((row) => row.path));
	const staged = indexBlobs([...divergent].filter((path) => text.has(path)), rootDirectory);
	const offenses = [];
	let scanned = 0;
	for (const row of rows) {
		if (!text.has(row.path)) continue;
		scanned++;
		offenses.push(...offensesFor(row, read, staged));
	}
	return { offenses, scanned, tracked: rows.length };
}

/**
 * Run the scan over `rootDirectory` and say what was found. Throws when git
 * listed nothing, because a clean report over zero files is not a clean tree.
 * Separate from the CLI entry so a test can point it at a repository of its
 * own choosing; the entry is what turns an offense into an exit code.
 *
 * @param {string} [rootDirectory]
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [out]
 * @returns {{ offenses: string[], scanned: number, tracked: number }}
 */
export function report(rootDirectory = root, out = console) {
	const result = findOffenses(rootDirectory);
	const { offenses, scanned, tracked } = result;
	if (tracked === 0) {
		throw new Error('git ls-files --eol reported no tracked file, so nothing was checked; the line shape it prints may have changed');
	}
	if (offenses.length > 0) {
		out.error(`  ${offenses.length} offense(s):`);
		for (const offense of offenses) out.error(`    ${offense}`);
		out.error('  A control character makes git classify the blob as binary, which loses every');
		out.error('  textual diff on the file and drops it from check-formatting entirely.');
		return result;
	}
	out.log(`  ${tracked} tracked file(s), ${scanned} declared text and scanned; every one is text with no control character.`);
	return result;
}

function main() {
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	console.log(`check-source-bytes: ${pkg.name}@${pkg.version}`);
	if (report().offenses.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('check-source-bytes failed:\n' + error.message);
		process.exitCode = 1;
	}
}
