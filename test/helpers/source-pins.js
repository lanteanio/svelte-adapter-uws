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
 * statement, AND which runs on its own where it stands. Deleting the call
 * fails it, renaming it fails it, and anything written on the same line
 * around it fails it because the line is no longer that statement. Four
 * shapes leave the pinned line byte-identical, and each is refused by reading
 * what is around it:
 *
 * - a one-line wrapper - `if (false)`, `else`, `false &&`, an arrow header -
 *   because the pinned line is then that line's body, not a statement;
 * - a jump out of the block immediately above it, `return` / `throw` /
 *   `break` / `continue`, with or without an `if (true)` in front, because
 *   nothing after it in that block runs;
 * - an enclosing block whose condition is one false literal (`if (false) {`,
 *   `while (0) {`, `if (null) {`) or which opens after `false &&`, found by
 *   walking the braces outward however far the header is;
 * - a place inside a `switch` body that no `case` has reached yet.
 *
 * Comments and the inside of a literal that spans lines are blanked first, so
 * `/* stmt *\/`, `// stmt` and a template literal whose own line reads as the
 * statement are not lines either. The failure names the line it found and
 * what took it over instead of reporting a bare `false`, so a neutralized
 * guard identifies itself.
 *
 * WHAT THIS STILL CANNOT SEE needs the program EVALUATED: a condition that is
 * a name (`if (disabled) {`) or an expression of literals (`if (0 === 1) {`),
 * a braced function nothing calls, and a caller that stops reaching the
 * statement's lane at all. A statement whose meaning depends on its
 * neighbours - a callback argument, a continuation of the line above - is
 * pinned with `expectStatementBlock`, which requires the lines CONSECUTIVELY
 * and requires the first of them to stand where it is, so a neutralization of
 * the line that owns the call changes the block. The rest is what the
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
 * The characters a line ends with when it FINISHES what it was saying: a
 * statement (`;`) or a block that opened or closed (`{`, `}`).
 *
 * Everything else means the line above did not finish - `if (false)`, `else`,
 * `while (x)`, `false &&`, `() =>`, an open argument list - and the line under
 * it is that line's BODY or its continuation, not a statement of its own.
 *
 * `:` is NOT one of them, because it ends a ternary as readily as a label:
 * `const dead = true ? undefined :` above a pinned call leaves the call dead
 * on a line that terminates. A `case` or `default` label really does hand the
 * next line its own statement, so those two are matched as whole lines
 * instead - and only those two, since a bare `ident:` is also what the middle
 * of a split ternary looks like.
 */
const STATEMENT_TERMINATORS = new Set([';', '{', '}']);

/**
 * A `case x:` or `default:` line: what follows belongs to it.
 *
 * Only those two, deliberately. A bare `ident:` reads as a label and is also
 * how the middle of a ternary looks once it is split over lines - `undefined:`
 * on its own line is a legal label and a legal ternary alternate, and nothing
 * on the line tells them apart. This repository writes no labeled statement
 * (no `break label;` / `continue label;` anywhere in `src/`), so admitting the
 * shape would buy nothing and cost the hole.
 */
const LABEL_LINE = /^(?:case\b.+|default)\s*:$/;

/**
 * A line that leaves the block: nothing after it in that block can run.
 *
 * The `if (true)` / `while (1)` prefix is part of it, because `if (true)
 * return;` above a pinned call is as cheap to write as `if (false)` and ends
 * in a terminator.
 */
const UNCONDITIONAL_JUMP = /^(?:(?:if|while)\s*\(\s*(?:true|1)\s*\)\s*)?(?:return|throw|break|continue)\b/;

/**
 * A block header that cannot run: a condition written as one false literal, or
 * a line opening with `false &&` (this repository's own neutralization idiom,
 * which reads as a block opener when an arrow body starts on that line).
 *
 * One LITERAL, not an expression of them: `0 === 1` needs evaluating, and
 * matching a bare `0 &&` anywhere on the line would refuse the ordinary
 * `if (x === 0 && y) {`.
 */
const DEAD_BLOCK_OPENER = /^(?:\}\s*else\s+)?(?:if|while)\s*\(\s*(?:false|0|null|undefined|!true|!1)\s*\)|^false\s*&&/;

/** A `case`/`default` line, for the switch-body check. */
const CASE_LINE = /^(?:case\b|default\s*:)/;

/** `line` with the text of its single-line literals removed, so a brace inside one is not counted. */
function codeOnly(line) {
	return line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '\'\'');
}

/**
 * The header of the block opened at `index`, which is that line unless the
 * brace stands alone - then the line above carries the condition.
 *
 * @param {string[]} lines
 * @param {number} index
 * @returns {string}
 */
function blockHeader(lines, index) {
	if (lines[index] !== '{') return lines[index];
	for (let i = index - 1; i >= 0; i--) {
		if (lines[i] !== '') return `${lines[i]} {`;
	}
	return '{';
}

/**
 * The enclosing block header that cannot run the line at `index`, or null.
 *
 * Line equality cannot see a dead BLOCK: the pinned line follows an ordinary
 * `{`, which is what every live block looks like too. Walking the braces
 * outward finds the headers that opened the blocks this line is in, and a
 * header that says false in as many characters is the neutralization someone
 * reaches for once the one-line and line-above shapes are refused. A
 * `switch` whose body has not reached a `case` yet is the same thing said
 * differently, so it counts too.
 *
 * What this cannot see needs the program EVALUATED: a condition that is a
 * name, or an expression of literals (`0 === 1`), and a braced function
 * nothing calls. Those are what the behavioural case beside a pin is for.
 *
 * @param {string[]} lines - trimmed, non-code already blanked
 * @param {number} index
 * @returns {string | null}
 */
function deadEnclosingBlock(lines, index) {
	let depth = 0;
	for (let i = index - 1; i >= 0; i--) {
		const line = codeOnly(lines[i]);
		for (let c = line.length - 1; c >= 0; c--) {
			if (line[c] === '}') { depth++; continue; }
			if (line[c] !== '{') continue;
			if (depth > 0) { depth--; continue; }
			// An opener of a block this line is inside.
			const header = blockHeader(lines, i);
			if (DEAD_BLOCK_OPENER.test(header)) return header;
			// A statement between `switch (x) {` and its first `case` is
			// unreachable: control enters at a case label or not at all.
			if (/^switch\s*\(/.test(header)) {
				let sawCase = false;
				for (let k = i + 1; k < index; k++) if (CASE_LINE.test(lines[k])) { sawCase = true; break; }
				if (!sawCase) return header;
			}
		}
	}
	return null;
}

/**
 * What owns the line at `index` instead of letting it stand as a statement of
 * its own, or null when nothing does.
 *
 * This is what closes the neutralizations line equality could not see. A
 * wrapper written on the PREVIOUS line leaves the pinned line byte-identical,
 * so `if (false)` above a pinned call passed a pin that `if (false) call();`
 * on one line fails; reading the line above tells the two apart, because a
 * free-standing statement always follows a line that terminated. Two more
 * shapes terminate a line and still leave the pinned call dead: an
 * unconditional `return` / `throw` / `break` / `continue` above it, and a
 * `if (false) {` block around it.
 *
 * Blank lines are skipped; comment-only lines are already blank by the time
 * these lines are produced. A statement at the top of the slice has nothing
 * above it and stands on its own.
 *
 * @param {string[]} lines - trimmed, non-code already blanked
 * @param {number} index
 * @returns {string | null}
 */
function ownedBy(lines, index) {
	for (let i = index - 1; i >= 0; i--) {
		const previous = lines[i];
		if (previous === '') continue;
		if (UNCONDITIONAL_JUMP.test(previous)) return previous;
		if (LABEL_LINE.test(previous)) break;
		if (!STATEMENT_TERMINATORS.has(previous[previous.length - 1])) return previous;
		break;
	}
	return deadEnclosingBlock(lines, index);
}

/**
 * Whether the line at `index` stands on its own.
 *
 * @param {string[]} lines - trimmed, non-code already blanked
 * @param {number} index
 * @returns {boolean}
 */
function startsItsOwnStatement(lines, index) {
	return ownedBy(lines, index) === null;
}

/**
 * Where in `slice` `statement` stands as a statement of its own, as line
 * indexes into the same blanked, ownership-filtered view the pins judge.
 *
 * ORDER BETWEEN TWO PINNED CALLS HAS TO BE ASKED IN THIS VIEW. A pin that
 * counts qualifying statements and then reads `indexOf` on the RAW carve is
 * asking two different questions: text that no longer runs - commented out,
 * prefixed `false &&`, owned by the line above - is gone from the count and
 * still present for `indexOf`. One neutralized call plus a duplicate of the
 * live one then satisfies both halves at once, which is exactly the shape a
 * per-branch count exists to refuse.
 *
 * @param {string} slice - the carved source region to search
 * @param {string} statement - the complete statement as written, including its
 *   terminating semicolon
 * @returns {number[]} ascending line indexes
 */
export function statementIndexes(slice, statement) {
	const lines = statementLines(slice);
	/** @type {number[]} */
	const found = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === statement && startsItsOwnStatement(lines, i)) found.push(i);
	}
	return found;
}

/**
 * Where in `slice` `block` appears as consecutive lines that stand where they
 * are, as line indexes into that same view.
 *
 * The block form is what pins a call to its PLACE: moving a check out of the
 * loop it guards, or out of the branch that reaches it, changes the lines
 * around it even when the call itself is untouched. A window measured in
 * `indexOf` distances cannot say that - it admits any relocation inside the
 * window, and windows drawn between two distant anchors are wide.
 *
 * @param {string} slice
 * @param {string[]} block - each line as written, trimmed
 * @returns {number[]} ascending line indexes of each first line
 */
export function statementBlockIndexes(slice, block) {
	const lines = statementLines(slice);
	/** @type {number[]} */
	const found = [];
	for (let i = 0; i + block.length <= lines.length; i++) {
		let j = 0;
		while (j < block.length && lines[i + j] === block[j]) j++;
		if (j === block.length && startsItsOwnStatement(lines, i)) found.push(i);
	}
	return found;
}

/**
 * The first line index in `slice` whose code contains `text`, or -1.
 *
 * For an ANCHOR rather than a pin - the publish a check has to precede, say.
 * It reads the blanked view too, so a mention inside a comment is not the
 * anchor, and it makes no ownership claim: an anchor is a landmark, and what
 * is pinned about it is asserted separately.
 *
 * @param {string} slice
 * @param {string} text
 * @returns {number}
 */
export function codeLineIndex(slice, text) {
	const lines = statementLines(slice);
	for (let i = 0; i < lines.length; i++) if (lines[i].includes(text)) return i;
	return -1;
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
	/** @type {number[]} */
	const exact = [];
	for (let i = 0; i < lines.length; i++) if (lines[i] === statement) exact.push(i);
	if (exact.some((i) => startsItsOwnStatement(lines, i))) return;

	// Report the near misses rather than a bare false. A wrapped, owned or
	// commented call still contains the text, and naming the line that holds
	// it - or the line above, the jump, or the dead block that took it over -
	// is the difference between "the pin failed" and "here is what someone
	// did to it".
	if (exact.length > 0) {
		const owners = exact.map((i) => JSON.stringify(ownedBy(lines, i) ?? '')).join(' | ');
		expect.fail(`${label}: ${JSON.stringify(statement)} is its own line but does not run on its own, owned by: ${owners}`);
	}
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
	/** @type {number[]} */
	const exact = [];
	for (let i = 0; i < lines.length; i++) if (lines[i] === statement) exact.push(i);
	// An owned line does not count. Neutralizing one of a lane's two exits by
	// putting `if (false)` above it, jumping out of the block before it, or
	// wrapping it in a block written false would otherwise leave the count
	// intact, which is the whole reason this function exists rather than a
	// `toContain`.
	const owned = exact.filter((i) => !startsItsOwnStatement(lines, i));
	const found = exact.length - owned.length;
	if (found === count) return;
	const wrapped = lines.filter((line) => line !== statement && line.includes(statement));
	const detail = [
		owned.length > 0
			? `${owned.length} more line(s) do not run on their own, owned by: ${owned.map((i) => JSON.stringify(ownedBy(lines, i) ?? '')).join(' | ')}`
			: '',
		wrapped.length > 0
			? `${wrapped.length} more line(s) contain it without being it: ${wrapped.map((line) => JSON.stringify(line)).join(' | ')}`
			: ''
	].filter(Boolean).join('; ');
	expect.fail(`${label}: expected ${count} line(s) exactly ${JSON.stringify(statement)}, found ${found}${detail ? ` (${detail})` : ''}`);
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
	/** @type {number[]} */
	const consecutive = [];
	for (let i = 0; i + block.length <= lines.length; i++) {
		let j = 0;
		while (j < block.length && lines[i + j] === block[j]) j++;
		if (j === block.length) consecutive.push(i);
	}
	// The block's OWN first line has to stand where it is, for the same reason
	// a single pinned statement does: consecutive lines inside `if (false) {`
	// are as consecutive as anywhere else.
	if (consecutive.some((i) => startsItsOwnStatement(lines, i))) return;
	if (consecutive.length > 0) {
		const owners = consecutive.map((i) => JSON.stringify(ownedBy(lines, i) ?? '')).join(' | ');
		expect.fail(`${label}: the lines ${JSON.stringify(block)} appear consecutively but do not run where they stand, owned by: ${owners}`);
	}
	const anchor = lines.indexOf(block[0]);
	const detail = anchor === -1
		? `its first line ${JSON.stringify(block[0])} is not in the slice`
		: `its first line is at slice line ${anchor + 1} but what follows is ${JSON.stringify(lines.slice(anchor, anchor + block.length))}`;
	expect.fail(`${label}: the lines ${JSON.stringify(block)} do not appear consecutively - ${detail}`);
}
