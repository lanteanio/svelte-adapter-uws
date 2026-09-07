// The source-bytes gate must be able to REFUSE, and it must refuse the class it
// is named for: a raw control character in tracked text. Git's own text
// heuristic is not that class - it is a ratio, so one stray byte in an
// ordinary-sized module is text to git - which is why the gate scans every
// text-declared file itself and only leans on git's classification as a second
// signal. Each of those shapes is driven here against a scratch repository
// that carries the same `* text=auto eol=lf` attribute as this one, and the
// real tree is asked to come back clean over a file list large enough to mean
// something.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlCharacters, declaredBinary, divergentPaths, findOffenses, indexBlobs, report, trackedEol } from '../scripts/check-source-bytes.js';

describe('the tracked tree', () => {
	it('is clean, over a file list large enough to mean something', () => {
		const { offenses, scanned, tracked } = findOffenses();
		expect(offenses).toEqual([]);
		// A parser that matched nothing would report a clean tree having read
		// no file at all; the floor is what makes that shape of failure loud.
		expect(tracked).toBeGreaterThan(500);
		expect(scanned).toBeGreaterThan(500);
	});

	it('reads git\'s committed and working-copy classification for every path', () => {
		const rows = trackedEol();
		const pkg = rows.find((row) => row.path === 'package.json');
		expect(pkg).toBeDefined();
		expect(pkg.index).toBe('lf');
		expect(['lf', 'crlf']).toContain(pkg.worktree);
		expect(pkg.attr).toMatch(/text=auto/);
	});
});

describe('the byte scan', () => {
	const bytes = (text) => Buffer.from(text, 'latin1');

	it('names each control character with its line', () => {
		expect(controlCharacters(bytes('ok\nstill ok\n\u0001here\n'))).toEqual([{ line: 3, code: 0x01 }]);
		expect(controlCharacters(bytes('a\u007fb'))).toEqual([{ line: 1, code: 0x7f }]);
		expect(controlCharacters(bytes('a\u001bb\u000bc'))).toEqual([{ line: 1, code: 0x1b }, { line: 1, code: 0x0b }]);
	});

	it('allows tab, LF and CRLF, and names a lone CR', () => {
		expect(controlCharacters(bytes('\tindented\r\nnext\r\n'))).toEqual([]);
		expect(controlCharacters(bytes('old mac\rline'))).toEqual([{ line: 1, code: 0x0d }]);
	});

	it('names the C1 controls and the invisible code points by their UTF-8 bytes', () => {
		const utf8 = (text) => Buffer.from(text, 'utf8');
		expect(controlCharacters(utf8('a\u0085b'))).toEqual([{ line: 1, code: 0x85 }]);
		expect(controlCharacters(utf8('a\u0080b\u009fc'))).toEqual([{ line: 1, code: 0x80 }, { line: 1, code: 0x9f }]);
		expect(controlCharacters(utf8('\ufeffconst a = 1;\n'))).toEqual([{ line: 1, code: 0xfeff }]);
		expect(controlCharacters(utf8('ok\nzero\u200bwidth\n'))).toEqual([{ line: 2, code: 0x200b }]);
		expect(controlCharacters(utf8('a\u2028b\u2029c'))).toEqual([{ line: 1, code: 0x2028 }, { line: 1, code: 0x2029 }]);
		// The neighbours of those sequences are ordinary text: U+00A0, an em dash
		// (E2 80 94), the zero-width joiner emoji carry, a CJK character and an
		// umlaut share lead bytes with the refused set and must not be hits.
		expect(controlCharacters(utf8('a\u00a0b \u2014 \u{1f468}\u200d\u{1f469} 中 ü'))).toEqual([]);
	});

	it('stops after eight hits, because one is enough to act on', () => {
		expect(controlCharacters(bytes('\u0001'.repeat(40)))).toHaveLength(8);
	});

	it('reads a binary declaration out of the attribute field', () => {
		expect(declaredBinary('text=auto eol=lf')).toBe(false);
		expect(declaredBinary('-text')).toBe(true);
		expect(declaredBinary('binary')).toBe(true);
		expect(declaredBinary('text=auto -text')).toBe(true);
	});
});

describe('against a scratch repository', () => {
	let repo;
	const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	// Long enough that one stray byte sits far under git's one-per-128 ratio,
	// which is the shape the old rule waved through.
	const filler = ('const x = 1;\n').repeat(400);

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), 'source-bytes-'));
		git('init', '-q');
		git('config', 'user.email', 'test@example.invalid');
		git('config', 'user.name', 'Test');
		git('config', 'core.autocrlf', 'false');
		writeFileSync(join(repo, '.gitattributes'), '* text=auto eol=lf\n*.bin binary\n');
		writeFileSync(join(repo, 'clean.js'), filler);
		writeFileSync(join(repo, 'crlf.js'), filler.replace(/\n/g, '\r\n'));
		writeFileSync(join(repo, 'zero.js'), filler + "const sep = '\u0000';\n");
		writeFileSync(join(repo, 'soh.js'), filler + "const mark = '\u0001';\n");
		writeFileSync(join(repo, 'del.js'), filler + "const mark = '\u007f';\n");
		writeFileSync(join(repo, 'cr.js'), filler + 'const a = 1;\rconst b = 2;\n');
		mkdirSync(join(repo, 'assets'));
		writeFileSync(join(repo, 'assets', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0x7f, 0xff]));
		git('add', '-A');
		git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed');
	});

	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it('refuses the bytes git itself would call text, and names them', () => {
		const { offenses, scanned, tracked } = findOffenses(repo);
		expect(tracked).toBe(8);
		// The binary-declared blob is not scanned; everything else is.
		expect(scanned).toBe(7);
		const paths = offenses.map((line) => line.split(':')[0]);
		expect(paths).toContain('soh.js');
		expect(paths).toContain('del.js');
		expect(paths).toContain('zero.js');
		expect(paths).toContain('cr.js');
		expect(paths).not.toContain('clean.js');
		expect(paths).not.toContain('crlf.js');
		expect(paths).not.toContain('assets/blob.bin');
		expect(offenses.find((line) => line.startsWith('soh.js'))).toMatch(/:401: control character U\+0001 .* write it as \\u0001/);
		expect(offenses.find((line) => line.startsWith('cr.js'))).toMatch(/:401: a carriage return with no line feed after it/);
		expect(offenses.find((line) => line.startsWith('zero.js'))).toMatch(/write it as \\0/);
	});

	it('the ratio is what the old rule leaned on: git records the stray-byte files as text', () => {
		// The observation this gate exists for. If git ever starts calling these
		// blobs binary the scan is still what names the byte, but the reason
		// the scan is needed would have changed and this case says so.
		const rows = Object.fromEntries(trackedEol(repo).map((row) => [row.path, row]));
		expect(rows['soh.js'].index).toBe('lf');
		expect(rows['del.js'].index).toBe('lf');
		expect(rows['zero.js'].index).toBe('-text');
		expect(rows['assets/blob.bin'].attr).toMatch(/-text|binary/);
	});

	it('an unstaged fix does not clear a committed binary blob, and a corrupt working copy is refused on its own', () => {
		// Fix zero.js on disk only: the committed blob is still binary, and the
		// gate reads that from git rather than trusting the disk.
		writeFileSync(join(repo, 'zero.js'), filler + "const sep = '\\0';\n");
		let { offenses } = findOffenses(repo);
		expect(offenses.find((line) => line.startsWith('zero.js'))).toMatch(/:401: control character U\+0000 in the staged blob/);
		// Corrupt clean.js on disk only: the committed blob is fine, the working
		// copy is what a developer's own `npm run check` reads, and it is refused
		// by the scan before git is even asked.
		writeFileSync(join(repo, 'clean.js'), filler + "const sep = '\u0000';\n");
		({ offenses } = findOffenses(repo));
		expect(offenses.find((line) => line.startsWith('clean.js'))).toMatch(/control character U\+0000/);
	});

	it('a staged byte git calls text is refused from the blob when the working copy is already clean', () => {
		// The shape the disk scan alone cannot see: soh.js is committed with a
		// raw 0x01 that git's ratio records as text, and the escaped spelling is
		// written to disk without `git add`. The commit would still write the
		// raw byte, so the gate has to read the index for it.
		writeFileSync(join(repo, 'soh.js'), filler + "const mark = '\\u0001';\n");
		expect(divergentPaths(repo).has('soh.js')).toBe(true);
		let { offenses } = findOffenses(repo);
		const staged = offenses.find((line) => line.startsWith('soh.js'));
		expect(staged).toMatch(/:401: control character U\+0001 in the staged blob, though the working copy is clean; write it as \\u0001/);
		expect(staged).toMatch(/then stage the fixed file/);
		// Staging the fixed file is the remedy the message names, and it clears the hit.
		git('add', 'soh.js');
		expect(divergentPaths(repo).has('soh.js')).toBe(false);
		({ offenses } = findOffenses(repo));
		expect(offenses.find((line) => line.startsWith('soh.js'))).toBeUndefined();
	});

	it('a file removed from disk is still judged by its staged blob', () => {
		rmSync(join(repo, 'del.js'));
		const { offenses, scanned } = findOffenses(repo);
		expect(scanned).toBe(7);
		expect(offenses.find((line) => line.startsWith('del.js'))).toMatch(/U\+007F in the staged blob/);
	});

	it('a path with a non-ASCII name is opened, scanned and judged by its staged blob like any other', () => {
		// git prints such a path quoted and escaped in its line output, a
		// spelling no file on disk has; a scan that trusted it would count the
		// path as scanned and find nothing.
		const name = 'caf\u00e9.js';
		writeFileSync(join(repo, name), filler + "const mark = '\u0001';\n");
		git('add', name);
		git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'non-ascii');
		expect(trackedEol(repo).map((row) => row.path)).toContain(name);
		let { offenses } = findOffenses(repo);
		expect(offenses.find((line) => line.startsWith(name))).toMatch(/:401: control character U\+0001 in tracked source/);
		writeFileSync(join(repo, name), filler + "const mark = '\\u0001';\n");
		({ offenses } = findOffenses(repo));
		expect(offenses.find((line) => line.startsWith(name))).toMatch(/in the staged blob/);
		git('add', name);
		({ offenses } = findOffenses(repo));
		expect(offenses.find((line) => line.startsWith(name))).toBeUndefined();
	});

	it('a listed path the scan cannot open is an offense, never a file counted as scanned and clean', () => {
		// The reader answers null for one clean, undiverged path - what an
		// unreadable file or a name the process cannot spell would produce.
		const blind = (file) => {
			if (file === 'crlf.js') return null;
			try { return readFileSync(join(repo, file)); } catch { return null; }
		};
		const { offenses, scanned } = findOffenses(repo, blind);
		expect(scanned).toBe(8);
		expect(offenses.find((line) => line.startsWith('crlf.js'))).toMatch(/could not be read, so its bytes were not checked/);
	});

	it('reads the staged blobs in one batch and maps an unknown path to null', () => {
		const blobs = indexBlobs(['cr.js', 'not-tracked.js', 'crlf.js'], repo);
		expect(blobs.size).toBe(3);
		expect(blobs.get('not-tracked.js')).toBeNull();
		// The bytes are the committed ones, not the disk's: cr.js still holds its lone CR.
		expect(controlCharacters(blobs.get('cr.js'))).toEqual([{ line: 401, code: 0x0d }]);
		// crlf.js was normalised to LF by the attribute on the way in, and the
		// blob after it in the batch is read at the right offset.
		expect(Buffer.from(blobs.get('crlf.js')).toString('utf8')).toBe(filler);
	});

	it('reports the offenses it found and refuses to call an empty repository clean', () => {
		const lines = { log: [], error: [] };
		const out = { log: (line) => lines.log.push(line), error: (line) => lines.error.push(line) };
		const result = report(repo, out);
		expect(result.offenses.length).toBeGreaterThan(0);
		expect(lines.error[0]).toMatch(new RegExp(`^  ${result.offenses.length} offense\\(s\\):$`));
		expect(lines.log).toEqual([]);

		const empty = mkdtempSync(join(tmpdir(), 'source-bytes-empty-'));
		try {
			execFileSync('git', ['init', '-q'], { cwd: empty, stdio: 'ignore' });
			expect(() => report(empty, out)).toThrow(/reported no tracked file, so nothing was checked/);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
