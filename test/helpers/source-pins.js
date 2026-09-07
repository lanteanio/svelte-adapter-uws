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
 * that statement. Block comments are stripped first, so `/* stmt *\/` is not a
 * line either. The failure names the line it found instead of reporting a
 * bare `false`, so a neutralized guard identifies itself.
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

/**
 * The slice as lines, trimmed, with block comments removed so a commented-out
 * statement is not a line that reads as the statement.
 * @param {string} slice
 * @returns {string[]}
 */
function statementLines(slice) {
	return slice.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.trim());
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
