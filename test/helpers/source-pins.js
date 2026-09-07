/**
 * Source pins that survive the neutralization used to test them.
 *
 * A policy pin reads a slice of shipped source and requires a call to be
 * present, because the property it guards - a refusal that must happen before
 * an admission, an authority check that must run on every lane - has no
 * observable projection to assert on once the call is gone.
 *
 * `expect(slice).toContain('assertStampableSeq(seqOption);')` is the obvious
 * spelling and it is weaker than it looks. `false && assertStampableSeq(
 * seqOption);` still contains that text, and so does `if (false)
 * assertStampableSeq(seqOption);`. Prefixing `false &&` is how this repository
 * neutralizes a guard when checking whether its pin works, precisely because
 * the line stays present and only the behaviour moves - so a substring pin is
 * blind to the one mutation someone would use to test it, and the check comes
 * back green.
 *
 * `expectStatement` asks for a LINE whose trimmed text is exactly the
 * statement. Deleting the call fails it, renaming it fails it, and anything
 * written on the same line around it fails it, because the line is no longer
 * that statement. Comments and the inside of a literal that spans lines are
 * blanked first, so `/* stmt *\/`, `// stmt` and a template literal whose own
 * line reads as the statement are not lines either. The failure names the
 * line it found instead of reporting a bare `false`, so a neutralized guard
 * identifies itself.
 *
 * WHAT LINE EQUALITY CANNOT SEE: a wrapper on ANOTHER line. `if (false) {`
 * above the statement, or the statement moved into an arrow nothing calls,
 * leaves the pinned line byte-identical. A statement whose meaning depends on
 * its neighbours - a callback argument, a continuation of the line above - is
 * pinned with `expectStatementBlock`, which requires the lines CONSECUTIVELY,
 * so a neutralization of the line that owns the call changes the block. What
 * remains outside every text pin is a dead enclosing block; that is what the
 * behavioural case beside a pin exists for.
 */

import { expect } from 'vitest';

/** The characters after which a `/` opens a regular expression rather than dividing. */
const REGEX_LEADERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * `source` with every comment blanked, and the inside of every string,
 * template or regular-expression literal that spans a line blanked as well,
 * newlines kept so line numbers still mean what they did.
 *
 * A regular expression on the comment syntax cannot do this: a `/*` inside a
 * string or a line comment would open a "comment" that swallows real code up
 * to the next `*\/`, and a failure would then blame a statement that is
 * present. So this walks the text once and knows which of the four literal
 * kinds it is inside. A single-line literal is left as it is, because a
 * pinned statement may legitimately carry one (`throw new Error('x');`) and
 * must still equal its line.
 *
 * Whether a `/` divides or opens a regular expression is decided by the last
 * significant character before it, the way a tokenizer without a parser does.
 * That is exact for the source this repository writes and errs, if it errs,
 * toward reading a division as a regex that ends at the next `/`, which
 * blanks nothing across lines.
 *
 * @param {string} source
 * @returns {string}
 */
export function blankNonCode(source) {
	const out = source.split('');
	const blank = (from, to) => {
		for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
	};
	const length = source.length;
	let i = 0;
	// The last non-space character outside a comment, and the identifier it
	// ends, for the regex-or-division decision.
	let last = '';
	let lastWord = '';
	while (i < length) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === '/' && next === '/') {
			const end = source.indexOf('\n', i);
			const stop = end === -1 ? length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2);
			const stop = end === -1 ? length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '\'' || ch === '"') {
			const stop = literalEnd(source, i + 1, ch);
			if (source.slice(i, stop).includes('\n')) blank(i + 1, stop - 1);
			i = stop;
			last = ch;
			lastWord = '';
			continue;
		}
		if (ch === '`') {
			i = templateSpan(source, i, out);
			last = '`';
			lastWord = '';
			continue;
		}
		if (ch === '/' && (last === '' || REGEX_LEADERS.has(last) || REGEX_KEYWORDS.has(lastWord))) {
			const stop = regexEnd(source, i + 1);
			if (source.slice(i, stop).includes('\n')) blank(i + 1, stop - 1);
			i = stop;
			last = '/';
			lastWord = '';
			continue;
		}
		if (!/\s/.test(ch)) {
			last = ch;
			lastWord = /[A-Za-z_$]/.test(ch) ? lastWord + ch : /[0-9]/.test(ch) && lastWord !== '' ? lastWord + ch : '';
		}
		i++;
	}
	return out.join('');
}

/** The index just past the closing `quote`, honouring backslash escapes; an unterminated literal ends at the line. */
function literalEnd(source, from, quote) {
	for (let i = from; i < source.length; i++) {
		const ch = source[i];
		if (ch === '\\') { i++; continue; }
		if (ch === quote) return i + 1;
		if (ch === '\n') return i;
	}
	return source.length;
}

/** The index just past the closing `/` and its flags, honouring escapes and character classes. */
function regexEnd(source, from) {
	let inClass = false;
	let i = from;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === '\\') { i++; continue; }
		if (ch === '\n') return i;
		if (inClass) { if (ch === ']') inClass = false; continue; }
		if (ch === '[') { inClass = true; continue; }
		if (ch === '/') { i++; break; }
	}
	while (i < source.length && /[a-z]/.test(source[i])) i++;
	return i;
}

/**
 * Walk a template literal starting at the backtick at `from`, blanking its
 * quasi text in `out` when the literal spans a line, and recursing through
 * each `${ }` so the code inside is kept and a nested template is handled.
 * Returns the index just past the closing backtick.
 */
function templateSpan(source, from, out) {
	const spans = [];
	let i = from + 1;
	let quasiStart = i;
	while (i < source.length) {
		const ch = source[i];
		if (ch === '\\') { i += 2; continue; }
		if (ch === '`') { spans.push([quasiStart, i]); i++; break; }
		if (ch === '$' && source[i + 1] === '{') {
			spans.push([quasiStart, i]);
			i = expressionEnd(source, i + 2, out);
			quasiStart = i;
			continue;
		}
		i++;
	}
	if (source.slice(from, i).includes('\n')) {
		for (const [start, end] of spans) for (let k = start; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
	}
	return i;
}

/** The index just past the `}` closing a `${` expression, skipping nested braces, strings and templates. */
function expressionEnd(source, from, out) {
	let depth = 0;
	let i = from;
	while (i < source.length) {
		const ch = source[i];
		if (ch === '\'' || ch === '"') { i = literalEnd(source, i + 1, ch); continue; }
		if (ch === '`') { i = templateSpan(source, i, out); continue; }
		if (ch === '{') depth++;
		else if (ch === '}') {
			if (depth === 0) return i + 1;
			depth--;
		}
		i++;
	}
	return i;
}

/**
 * The slice as lines, trimmed, with comments and multi-line literal bodies
 * blanked so a commented-out or quoted statement is not a line that reads as
 * the statement.
 * @param {string} slice
 * @returns {string[]}
 */
function statementLines(slice) {
	return blankNonCode(slice).split('\n').map((line) => line.trim());
}

/**
 * Require `slice` to contain a line that is exactly `statement` once trimmed.
 *
 * @param {string} slice - the carved source region to search
 * @param {string} statement - the complete statement, as it is written in the
 *   source including its terminating semicolon
 * @param {string} label - what the statement guarantees, used in the failure
 */
export function expectStatement(slice, statement, label) {
	const lines = statementLines(slice);
	if (lines.includes(statement)) return;

	// Report the near misses rather than a bare false. A wrapped or commented
	// call still contains the text, and naming the line that holds it is the
	// difference between "the pin failed" and "here is what someone did to it".
	const wrapped = lines.filter((line) => line.includes(statement));
	const detail = wrapped.length > 0
		? `it appears only inside: ${wrapped.map((line) => JSON.stringify(line)).join(' | ')}`
		: 'it does not appear in the slice at all';
	expect.fail(`${label}: no line is exactly ${JSON.stringify(statement)} - ${detail}`);
}

/**
 * Require every statement in `statements` to be its own line in `slice`.
 *
 * @param {string} slice
 * @param {string[]} statements
 * @param {string} label
 */
export function expectStatements(slice, statements, label) {
	for (const statement of statements) expectStatement(slice, statement, label);
}

/**
 * Require `slice` to contain exactly `count` lines equal to `statement`.
 *
 * A lane that must run a check on each of its two exits is not served by
 * "the statement appears somewhere": one of the two can be neutralized while
 * the pin still passes on the other.
 *
 * @param {string} slice
 * @param {string} statement
 * @param {number} count
 * @param {string} label
 */
export function expectStatementCount(slice, statement, count, label) {
	const lines = statementLines(slice);
	const found = lines.filter((line) => line === statement).length;
	if (found === count) return;
	const wrapped = lines.filter((line) => line !== statement && line.includes(statement));
	const detail = wrapped.length > 0
		? ` (${wrapped.length} more line(s) contain it without being it: ${wrapped.map((line) => JSON.stringify(line)).join(' | ')})`
		: '';
	expect.fail(`${label}: expected ${count} line(s) exactly ${JSON.stringify(statement)}, found ${found}${detail}`);
}

/**
 * Require `block` to appear in `slice` as CONSECUTIVE lines, each exactly the
 * given text once trimmed.
 *
 * For a statement that only means something with its neighbours: a callback
 * handed to a guard (`authorize(ws, () =>` / `check(ws)` / `);`), where the
 * line that owns the call can be neutralized while the call's own line stays
 * byte-identical. Pinning the lines together makes the owning line part of
 * the pin.
 *
 * @param {string} slice
 * @param {string[]} block - two or more consecutive statements, as written
 * @param {string} label
 */
export function expectStatementBlock(slice, block, label) {
	if (block.length < 2) throw new TypeError('expectStatementBlock needs at least two lines; use expectStatement for one');
	const lines = statementLines(slice);
	for (let i = 0; i + block.length <= lines.length; i++) {
		let j = 0;
		while (j < block.length && lines[i + j] === block[j]) j++;
		if (j === block.length) return;
	}
	const anchor = lines.indexOf(block[0]);
	const detail = anchor === -1
		? `its first line ${JSON.stringify(block[0])} is not in the slice`
		: `its first line is at slice line ${anchor + 1} but what follows is ${JSON.stringify(lines.slice(anchor, anchor + block.length))}`;
	expect.fail(`${label}: the lines ${JSON.stringify(block)} do not appear consecutively - ${detail}`);
}
