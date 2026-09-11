// The source-pin helper is what the policy suites lean on when a guard has no
// observable projection, so it has to refuse the neutralizations this
// repository uses and it has to blame the right line when it does. Each case
// here is a shape that a substring pin, or the helper's own earlier
// comment-stripping regex, waved through or misread.

import { describe, expect, it } from 'vitest';
import { blankNonCode, codeLineIndex, expectStatement, expectStatementBlock, expectStatementCount, statementBlockIndexes, statementIndexes } from './helpers/source-pins.js';

const STATEMENT = 'assertStampableSeq(seqOption);';

describe('blankNonCode', () => {
	it('keeps every newline, so a line number in a failure still points at the source', () => {
		const source = "const a = '/*';\n/* one\n two */\nconst t = `\n${a}\n`;\n// c\nend();\n";
		expect(blankNonCode(source).split('\n').length).toBe(source.split('\n').length);
	});

	it('does not open a comment on a /* inside a string literal', () => {
		// A regex over the comment syntax swallowed everything from the
		// string's /* to the next */, and blamed the statement in between.
		const source = `const marker = '/*';\n${STATEMENT}\nlater(); /* real comment */\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines[1]).toBe(STATEMENT);
		expect(lines[2]).toBe('later();');
	});

	it('does not open a comment on a /* inside a line comment', () => {
		const source = `// see the /* below\n${STATEMENT}\nlater(); /* c */\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines[0]).toBe('');
		expect(lines[1]).toBe(STATEMENT);
	});

	it('does not open a comment or a string inside a regular expression literal', () => {
		const source = `const r = /[/*]/;\nconst q = /['"]/g;\n${STATEMENT}\nlater(); /* c */\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines[0]).toBe('const r = /[/*]/;');
		expect(lines[1]).toBe('const q = /[\'"]/g;');
		expect(lines[2]).toBe(STATEMENT);
		expect(lines[3]).toBe('later();');
	});

	it('reads a slash after an operand as division, not as a regex that runs to the next slash', () => {
		const source = `const n = a / b;\nconst m = a / b / c;\n${STATEMENT}\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines[0]).toBe('const n = a / b;');
		expect(lines[1]).toBe('const m = a / b / c;');
		expect(lines[2]).toBe(STATEMENT);
	});

	it('blanks the text of a template literal that spans lines and keeps the code inside ${}', () => {
		const source = `const t = \`\n${STATEMENT}\n\${ inner(seqOption) }\n\`;\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines[1]).toBe('');
		expect(lines[2]).toBe('${ inner(seqOption) }');
		expect(lines[3]).toBe('`;');
	});

	it('handles a template nested inside a ${} expression', () => {
		const source = `const t = \`a\n\${ cond ? \`\n${STATEMENT}\n\` : '' }\nb\`;\nafter();\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines[2]).toBe('');
		expect(lines[5]).toBe('after();');
	});

	it('leaves a single-line literal alone, so a pinned statement may carry one', () => {
		const source = "throw new Error('refused: /* not a comment */');\n";
		expect(blankNonCode(source)).toBe(source);
	});

	it('blanks a block comment and a line comment, newlines kept', () => {
		const source = `/* ${STATEMENT}\n */\n// ${STATEMENT}\n${STATEMENT}\n`;
		const lines = blankNonCode(source).split('\n').map((line) => line.trim());
		expect(lines.slice(0, 3)).toEqual(['', '', '']);
		expect(lines[3]).toBe(STATEMENT);
	});
});

describe('expectStatement', () => {
	it('passes on a line that is exactly the statement', () => {
		expect(() => expectStatement(`before();\n\t${STATEMENT}\nafter();\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('refuses the same-line neutralizations and names the line it found', () => {
		for (const line of [`false && ${STATEMENT}`, `if (false) ${STATEMENT}`, `void 0, ${STATEMENT}`]) {
			expect(() => expectStatement(`before();\n${line}\n`, STATEMENT, 'pin'))
				.toThrow(new RegExp(`pin: no line is exactly .* it appears only inside: ${JSON.stringify(line).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
		}
	});

	it('refuses a deleted statement and says it is absent', () => {
		expect(() => expectStatement('before();\nafter();\n', STATEMENT, 'pin')).toThrow(/does not appear in the slice at all/);
	});

	it('refuses a statement that survives only as a comment or inside a multi-line template', () => {
		expect(() => expectStatement(`/* ${STATEMENT} */\n`, STATEMENT, 'pin')).toThrow(/does not appear/);
		expect(() => expectStatement(`// ${STATEMENT}\n`, STATEMENT, 'pin')).toThrow(/does not appear/);
		expect(() => expectStatement(`const t = \`\n${STATEMENT}\n\`;\n`, STATEMENT, 'pin')).toThrow(/does not appear/);
	});

	it('is not fooled by a comment opener inside a string ahead of the statement', () => {
		// The shape that made the old regex blame a present statement.
		const slice = `const sep = '/*';\n${STATEMENT}\nreturn x; /* trailing */\n`;
		expect(() => expectStatement(slice, STATEMENT, 'pin')).not.toThrow();
	});

	it('refuses a wrapper written on the line ABOVE, and names that line', () => {
		// The neutralization line equality could not see: the pinned line stays
		// byte-identical while the line above takes it over.
		const OWNERS = [
			['if (false)', 'before();\nif (false)', 'an `if` whose condition is written false'],
			['else', 'if (ready) {\n\tfirst();\n} else', 'the bare body of an `else`'],
			['while (false)', 'before();\nwhile (false)', 'a loop whose condition is written false'],
			['for (;;)', 'before();\nfor (;;)', 'the bare body of a loop'],
			['false &&', 'before();\nfalse &&', 'the right of a `&&` whose left is written false'],
			['const unused = () =>', 'before();\nconst unused = () =>', 'a concise arrow body'],
			['if (someCondition)', 'before();\nif (someCondition)', 'the bare body of an `if`']
		];
		for (const [owner, opening, reason] of OWNERS) {
			expect(() => expectStatement(`${opening}\n\t${STATEMENT}\nafter();\n`, STATEMENT, 'pin'), owner)
				.toThrow(new RegExp(`pin: .* owned by: ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
		}
	});

	it('refuses an owner that finishes its own line and still leaves the statement dead', () => {
		// A line can finish what it was saying and still take the next line
		// with it. The ternary is the one that reads finished: `:` closes a
		// label and an alternate alike, and the alternate is a one-line
		// wrapper with the same cost to write as `if (false)` - including when
		// it is split so the line above the pin is a bare `undefined:`, which
		// is lexically a label. The jumps are the other half: a line that
		// leaves the block ends in `;`, and everything after it in that block
		// is unreachable - `if (true)` in front of one changes nothing.
		const FINISHED = [
			['a ternary alternate', 'const dead = true ?\n\tundefined :', '', 'a ternary arm'],
			['a ternary alternate on one line', 'const dead = true ? undefined :', '', 'a ternary arm'],
			['a label', 'undefined:', '', 'the bare body of a `label`'],
			['a bare return', 'return;', '', 'always leaves the block'],
			['a return with a value', 'return value;', '', 'always leaves the block'],
			['a throw', "throw new Error('x');", '', 'always leaves the block'],
			['a break in a loop', 'while (x) {\n\tbreak;', '}', 'always leaves the block'],
			['a continue in a loop', 'while (x) {\n\tcontinue;', '}', 'always leaves the block'],
			['a conditional return that always fires', 'if (true) return;', '', 'always leaves the block'],
			['a conditional throw that always fires', "if (1) throw new Error('x');", '', 'always leaves the block'],
			['a block that returns', '{ return; }', '', 'always leaves the block']
		];
		for (const [label, opening, closing, reason] of FINISHED) {
			const slice = `before();\n${opening}\n\t${STATEMENT}\n${closing}\nafter();\n`;
			expect(() => expectStatement(slice, STATEMENT, 'pin'), label)
				.toThrow(new RegExp(`pin: .* owned by: .*${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
		}
		// A jump that does NOT always fire leaves the next line reachable, and
		// the rule must not refuse it.
		for (const [label, opening] of [['a guarded return', 'if (maybe) return;'], ['a loop break', 'while (x) {\n\tif (done) break;']]) {
			const slice = opening.includes('while') ? `${opening}\n\t${STATEMENT}\n}\n` : `${opening}\n${STATEMENT}\n`;
			expect(() => expectStatement(slice, STATEMENT, 'pin'), label).not.toThrow();
		}
	});

	it('refuses a statement wrapped in a block written false, however far above the header is', () => {
		// The dead enclosing BLOCK. The pinned line follows an ordinary `{`,
		// which is what a live block looks like too, so the braces have to be
		// walked outward to find the header that opened it.
		const DEAD = [
			['if (false) {', 'before();\nif (false) {', '}'],
			['while (0) {', 'before();\nwhile (0) {', '}'],
			['} else if (false) {', 'if (ready) {\n\tfirst();\n} else if (false) {', '}'],
			['if (null) {', 'before();\nif (null) {', '}'],
			['if (!true) {', 'before();\nif (!true) {', '}'],
			["if ('') {", "before();\nif ('') {", '}'],
			['if (0 === 1) {', 'before();\nif (0 === 1) {', '}'],
			['if (NaN) {', 'before();\nif (NaN) {', '}'],
			['for (const x of []) {', 'before();\nfor (const x of []) {', '}'],
			['false && (() => {', 'before();\nfalse && (() => {', '})();']
		];
		for (const [header, opening, closing] of DEAD) {
			// Live blocks between the dead header and the pin, so the judgement
			// has to walk out to it rather than read the line above.
			const slice = `${opening}\n\tx();\n\tif (ready) {\n\t\ty();\n\t}\n\twhile (n--) {\n\t\tz();\n\t}\n\t${STATEMENT}\n${closing}\nafter();\n`;
			expect(() => expectStatement(slice, STATEMENT, 'pin'), header)
				.toThrow(new RegExp(`pin: .* owned by: .*${JSON.stringify(header).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
		}
		// A live block around a dead one does not launder it.
		expect(() => expectStatement(`if (ready) {\n\tif (false) {\n\t\t${STATEMENT}\n\t}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*"if \(false\) \{"/);
		// The brace on its own line is the same construct to a parse, so
		// splitting the header hides nothing.
		expect(() => expectStatement(`if (false)\n{\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*"if \(false\)"/);
		// A brace inside a string is text, not structure: it must neither hide
		// a dead header nor invent one around live code.
		expect(() => expectStatement(`if (false) {\n\tconst open = '}';\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*"if \(false\) \{"/);
		expect(() => expectStatement(`if (false) {\n\tx();\n}\nconst open = '{';\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('judges the line the text question matched, not the character the raw line starts with', () => {
		// A comment is blanked to spaces for the text question, so a pinned line
		// behind one still IS the statement - and the first non-space character
		// of the RAW line is the comment's slash, an offset inside no statement.
		// Reading the position from the raw line would leave every reachability
		// rule with nothing to judge and pass all of them.
		for (const owner of ['if (false)', 'return;', 'false &&']) {
			expect(() => expectStatement(`before();\n${owner}\n\t/**/ ${STATEMENT}\nafter();\n`, STATEMENT, 'pin'), owner)
				.toThrow(/pin: .* owned by: /);
		}
		// And a comment on a live line is still just a comment.
		expect(() => expectStatement(`before();\n\t/**/ ${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('refuses a statement under something that never comes back, beyond the bare jumps', () => {
		const NEVER_RETURNS = [
			['a try that returns from every path', 'try {\n\treturn;\n} catch {\n\treturn;\n}'],
			['a try whose finalizer returns', 'try {\n\tmaybe();\n} finally {\n\treturn;\n}'],
			['a loop nothing leaves', 'while (true) {\n\ttick();\n}'],
			['a for with no condition and no break', 'for (;;) {\n\ttick();\n}']
		];
		for (const [label, above] of NEVER_RETURNS) {
			expect(() => expectStatement(`before();\n${above}\n${STATEMENT}\n`, STATEMENT, 'pin'), label)
				.toThrow(/pin: .* owned by: .*always leaves the block/);
		}
		// A loop that CAN be left, and one whose body holds the pin, both run.
		expect(() => expectStatement(`while (true) {\n\tif (done) break;\n}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		expect(() => expectStatement(`while (true) {\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
		// A try that only MIGHT return does not take the next line with it.
		expect(() => expectStatement(`try {\n\treturn;\n} catch {\n\tlog();\n}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('refuses a switch case the discriminant cannot reach, and takes the one it can', () => {
		expect(() => expectStatement(`switch (0) {\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		expect(() => expectStatement(`switch (0) {\n\tcase 0:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
		// Only the cases BEFORE it can reach it by falling through, so a matching
		// case or a `default` placed AFTER the pinned one changes nothing - both
		// of these are dead, and reading the whole list called the refusal off.
		expect(() => expectStatement(`switch (0) {\n\tcase 1:\n\t\t${STATEMENT}\n\tdefault:\n\t\tbreak;\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		expect(() => expectStatement(`switch (0) {\n\tcase 1:\n\t\t${STATEMENT}\n\tcase 0:\n\t\tbreak;\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		// A case BEFORE it that matches does reach it, by falling through -
		// unless that case leaves first. A `break` ends the fall-through as
		// surely as a `return`, and reading the match alone admitted both.
		expect(() => expectStatement(`switch (0) {\n\tcase 0:\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
		expect(() => expectStatement(`switch (0) {\n\tcase 0:\n\t\tbreak;\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		expect(() => expectStatement(`switch (0) {\n\tcase 0:\n\t\treturn;\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		// A `default` can be entered and fall through, and a discriminant the
		// rule cannot fold says nothing, so both are taken.
		expect(() => expectStatement(`switch (0) {\n\tdefault:\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
		expect(() => expectStatement(`switch (kind) {\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
		// But a `default` is entered only when NO case matches, wherever the
		// matching one stands: one after the pin takes control away from a
		// default before it. And a default that leaves does not fall through.
		expect(() => expectStatement(`switch (0) {\n\tdefault:\n\tcase 1:\n\t\t${STATEMENT}\n\tcase 0:\n\t\tbreak;\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		expect(() => expectStatement(`switch (0) {\n\tdefault:\n\t\treturn;\n\tcase 1:\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		// A test the fold cannot read AFTER the first match changes nothing,
		// because the first match in source order is where control enters.
		expect(() => expectStatement(`switch (0) {\n\tcase 0:\n\tcase 1:\n\t\t${STATEMENT}\n\tcase kind:\n\t\tbreak;\n}\n`, STATEMENT, 'pin')).not.toThrow();
		// One AFTER the pin with nothing matching before it and no default
		// before it either: whether it matches or not, control enters past the
		// pin or nowhere, so the pin is dead and the unknown does not save it.
		expect(() => expectStatement(`switch (0) {\n\tcase 1:\n\t\t${STATEMENT}\n\tcase kind:\n\t\tbreak;\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
		// With a default before the pin, the same unknown decides whether the
		// default is entered, so nothing is known and the pin is taken -
		// unless a case after the unknown matches, which takes control past
		// the pin whatever the unknown does.
		expect(() => expectStatement(`switch (0) {\n\tdefault:\n\tcase 1:\n\t\t${STATEMENT}\n\tcase kind:\n\t\tbreak;\n}\n`, STATEMENT, 'pin')).not.toThrow();
		expect(() => expectStatement(`switch (0) {\n\tdefault:\n\tcase 1:\n\t\t${STATEMENT}\n\tcase kind:\n\t\tx();\n\tcase 0:\n\t\tbreak;\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*discriminant cannot reach/);
	});

	it('refuses the catch of a try with nothing in it to throw', () => {
		expect(() => expectStatement(`try {\n} catch {\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*nothing in it to throw/);
		// A try that CAN throw reaches its catch.
		expect(() => expectStatement(`try {\n\trisky();\n} catch {\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('refuses a statement under a switch that leaves down every case', () => {
		const above = 'switch (kind) {\n\tcase 1:\n\t\treturn;\n\tdefault:\n\t\treturn;\n}';
		expect(() => expectStatement(`before();\n${above}\n${STATEMENT}\n`, STATEMENT, 'pin'))
			.toThrow(/pin: .* owned by: .*always leaves the block/);
		// Without a default, a discriminant matching nothing falls past it.
		const partial = 'switch (kind) {\n\tcase 1:\n\t\treturn;\n}';
		expect(() => expectStatement(`before();\n${partial}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		// A `break` leaves the CASE and lands on the line after the switch, so
		// the ordinary switch - every case ending in one - comes back. Reading
		// `break` as a jump out of the block refused every pin below one.
		const ordinary = 'switch (kind) {\n\tcase 1:\n\t\ta();\n\t\tbreak;\n\tdefault:\n\t\tb();\n\t\tbreak;\n}';
		expect(() => expectStatement(`before();\n${ordinary}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		const braced = 'switch (kind) {\n\tcase 1: {\n\t\tbreak;\n\t}\n\tdefault:\n\t\treturn;\n}';
		expect(() => expectStatement(`before();\n${braced}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		// `continue` leaves the switch for the loop around it, so a switch that
		// continues or returns on every case never comes back.
		const continuing = 'switch (kind) {\n\tcase 1:\n\t\tcontinue;\n\tdefault:\n\t\treturn;\n}';
		expect(() => expectStatement(`while (more()) {\n\tbefore();\n\t${continuing.replace(/\n/g, '\n\t')}\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/pin: .* owned by: .*always leaves the block/);
	});

	it('does not read a break to a label as leaving the block the label stands in', () => {
		// `break outer` lands on the line after the labelled statement.
		const labelled = 'outer: {\n\tif (kind) break outer;\n\tother();\n}';
		expect(() => expectStatement(`before();\n${labelled}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		const labelledOut = 'outer: {\n\tbreak outer;\n}';
		expect(() => expectStatement(`before();\n${labelledOut}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		// A return inside the label's body still leaves.
		const labelledReturn = 'outer: {\n\treturn;\n}';
		expect(() => expectStatement(`before();\n${labelledReturn}\n${STATEMENT}\n`, STATEMENT, 'pin'))
			.toThrow(/pin: .* owned by: .*always leaves the block/);
		// An UNLABELLED break inside the label's body targets the loop around
		// it, not the label, so it leaves - a label wrapped around a `break`
		// must not launder the bare `break` above a pin that the statement
		// scan refuses. The owner is the label, not the loop.
		const laundered = 'outer: {\n\tbreak;\n}';
		expect(() => expectStatement(`while (more()) {\n\tbefore();\n\t${laundered.replace(/\n/g, '\n\t')}\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'))
			.toThrow(/pin: .* owned by: .*always leaves the block: "outer: \{"/);
		// And a break to a label FURTHER OUT leaves the inner label's block.
		const further = 'outer: {\n\tinner: {\n\t\tbreak outer;\n\t}\n\t' + STATEMENT + '\n}';
		expect(() => expectStatement(`before();\n${further}\n`, STATEMENT, 'pin'))
			.toThrow(/pin: .* owned by: .*always leaves the block: "inner: \{"/);
	});

	it('does not read a jump inside a nested function as the loop\'s own', () => {
		// `return` in a callback leaves the callback. Counting it called off the
		// refusal for a loop that never ends.
		const above = 'while (true) {\n\tqueue.push(() => { return 1; });\n}';
		expect(() => expectStatement(`before();\n${above}\n${STATEMENT}\n`, STATEMENT, 'pin'))
			.toThrow(/pin: .* owned by: .*always leaves the block/);
	});

	it('folds an expression of literals, and answers rather than throwing on one it cannot', () => {
		// `0 === 1` was the only shape the comparison-only fold caught; an
		// arithmetic one is the same class and the same single line to write.
		for (const header of ['if (1 - 1) {', 'if (0 * 1) {', "if ('' + '') {", 'if (2 % 2) {']) {
			expect(() => expectStatement(`${header}\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'), header)
				.toThrow(/owned by: .*written false/);
		}
		// A fold that would THROW is not an answer: a BigInt mixed with a number
		// must leave the pin judging nothing rather than raising out of it.
		expect(() => expectStatement(`if (+0n) {\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
		expect(() => expectStatement(`if (1n + 1) {\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('refuses a carve it cannot parse instead of guessing from the text', () => {
		// The judgement IS the parse, so a carve that is not a complete
		// construct has no answer to give. Saying so names what to fix; the
		// alternative is a pin that reads green because the rule could not run.
		expect(() => expectStatement(`if (ready) {\n\t${STATEMENT}\n`, STATEMENT, 'pin'))
			.toThrow(/the carve does not parse/);
		// Under a `case` the pinned line is an ordinary statement. Above the
		// first `case` it cannot be written at all - that is a SyntaxError - so
		// it is not a shape any pin has to refuse.
		expect(() => expectStatement(`switch (kind) {\n\tcase 'a':\n\t\t${STATEMENT}\n}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('takes a statement inside an ordinary block, however deep', () => {
		// The refusal above must cost nothing to live code: a nested block
		// whose headers say nothing about being dead is where most pinned
		// statements actually live.
		const slice = `if (ready) {\n\tfor (const x of xs) {\n\t\ttry {\n\t\t\t${STATEMENT}\n\t\t} catch {}\n\t}\n}\n`;
		expect(() => expectStatement(slice, STATEMENT, 'pin')).not.toThrow();
		// A block that CLOSED above the statement is not enclosing it.
		expect(() => expectStatement(`if (false) {\n\tx();\n}\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
		// And a line that merely BEGINS with a jump keyword is not a jump: the
		// refusal is anchored on the word, not on the letters.
		for (const above of ['returnValue = 1;', 'breakGlass();', 'continueFrom(x);', 'throwing = false;']) {
			expect(() => expectStatement(`${above}\n${STATEMENT}\n`, STATEMENT, 'pin'), above).not.toThrow();
		}
		// A condition nothing can fold is admitted deliberately - seeing that it
		// is false means running the program - and the header says so.
		for (const header of ['if (disabled) {', 'while (ready) {']) {
			expect(() => expectStatement(`${header}\n\t${STATEMENT}\n}\n`, STATEMENT, 'pin'), header).not.toThrow();
		}
	});

	it('looks past blank and comment-only lines to find the line that owns it', () => {
		expect(() => expectStatement(`if (false)\n\n\t// a note\n\t${STATEMENT}\n`, STATEMENT, 'pin'))
			.toThrow(/owned by: .*"if \(false\)"/);
		expect(() => expectStatement(`before();\n\n\t// a note\n\t${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
	});

	it('takes every line that really does start a statement of its own', () => {
		// A terminated statement, an opened block, a closed block, a case
		// label, and the top of the slice: each is an ordinary place for the
		// pinned statement to stand, and none of them is a wrapper.
		const LIVE = [
			['a terminated statement', `before();\n\t${STATEMENT}\n`],
			['an opened block', `if (x) {\n\t${STATEMENT}\n}\n`],
			['a closed block', `if (x) {\n\ty();\n}\n${STATEMENT}\n`],
			['a case label', `switch (k) {\n\tcase 'x':\n\t\t${STATEMENT}\n}\n`],
			['a default label', `switch (k) {\n\tdefault:\n\t\t${STATEMENT}\n}\n`],
			['a labelled block', `retry: {\n\t${STATEMENT}\n}\n`],
			['the top of the carve', `${STATEMENT}\n`]
		];
		for (const [label, slice] of LIVE) {
			expect(() => expectStatement(slice, STATEMENT, 'pin'), label).not.toThrow();
		}
	});

	it('takes a free-standing occurrence even when another one is owned', () => {
		// One neutralized call does not condemn the lane that still has a live
		// one; what a lane with two exits needs is expectStatementCount.
		expect(() => expectStatement(`if (false)\n\t${STATEMENT}\nx();\n${STATEMENT}\n`, STATEMENT, 'pin')).not.toThrow();
	});
});

describe('expectStatementCount', () => {
	it('counts only exact lines and reports the wrapped ones', () => {
		expect(() => expectStatementCount(`${STATEMENT}\nx();\n${STATEMENT}\n`, STATEMENT, 2, 'pin')).not.toThrow();
		expect(() => expectStatementCount(`${STATEMENT}\nfalse && ${STATEMENT}\n`, STATEMENT, 2, 'pin'))
			.toThrow(/expected 2 line\(s\) .* found 1 \(1 more line\(s\) contain it without being it/);
	});

	it('does not count a line the line above owns, and says which line took it', () => {
		// The count is what pins one check per lane exit, so neutralizing one
		// exit from the line above has to move the number.
		expect(() => expectStatementCount(`${STATEMENT}\nif (false)\n\t${STATEMENT}\n`, STATEMENT, 2, 'pin'))
			.toThrow(/expected 2 line\(s\) .* found 1 \(1 more line\(s\) do not run on their own, owned by: .*"if \(false\)"\)/);
		expect(() => expectStatementCount(`${STATEMENT}\nif (false)\n\t${STATEMENT}\n`, STATEMENT, 1, 'pin')).not.toThrow();
		// And the count drops for a dead block around one of them just as it
		// does for a wrapper above it.
		expect(() => expectStatementCount(`${STATEMENT}\nif (false) {\n\t${STATEMENT}\n}\n`, STATEMENT, 2, 'pin'))
			.toThrow(/found 1 \(1 more line\(s\) do not run on their own, owned by: .*"if \(false\) \{"\)/);
	});
});

describe('statementIndexes, statementBlockIndexes and codeLineIndex', () => {
	it('reports only the occurrences that run, so order and count read one view', () => {
		// The pair a pin needs when it asks BOTH how many and in what order: a
		// count taken in the filtered view and an order taken on the raw text
		// are two questions, and one neutralized call beside one duplicate of a
		// live call answers both.
		const slice = `${STATEMENT}\nif (false)\n\t${STATEMENT}\nx();\n// ${STATEMENT}\ny();\n${STATEMENT}\n`;
		expect(statementIndexes(slice, STATEMENT)).toEqual([0, 6]);
		expect(statementIndexes(slice, 'absent();')).toEqual([]);
	});

	it('reports a block only where its lines are neighbours and stand where they are', () => {
		const block = ['guard(ws);', 'act(ws);'];
		// Three occurrences: the live one, one inside a dead block, and one with
		// a comment between the two lines. A comment is not a change to the
		// code, so the third counts; the dead one does not.
		const slice = `guard(ws);\nact(ws);\nif (false) {\n\tguard(ws);\n\tact(ws);\n}\nguard(ws);\n// gap\nact(ws);\n`;
		expect(statementBlockIndexes(slice, block)).toEqual([0, 6]);
		// A STATEMENT between them does break it: the lines have to stay each
		// other's neighbours, which is what the block form pins.
		expect(statementBlockIndexes(`guard(ws);\nbetween();\nact(ws);\n`, block)).toEqual([]);
	});

	it('anchors on code, not on a mention inside a comment', () => {
		expect(codeLineIndex('// this.publishWire(x)\nthis.publishWire(y);\n', 'this.publishWire(')).toBe(1);
		expect(codeLineIndex('nothing();\n', 'this.publishWire(')).toBe(-1);
	});
});

describe('expectStatementBlock', () => {
	const block = ['authorize(ws, () =>', 'check(ws)', ');'];

	it('passes on the consecutive lines and refuses a neutralized owner line', () => {
		expect(() => expectStatementBlock('a();\nauthorize(ws, () =>\n\tcheck(ws)\n);\n', block, 'pin')).not.toThrow();
		expect(() => expectStatementBlock('authorize(ws, () => true ||\n\tcheck(ws)\n);\n', block, 'pin'))
			.toThrow(/its first line "authorize\(ws, \(\) =>" is not in the slice/);
		// A comment between the lines is not a change to the code.
		expect(() => expectStatementBlock('a();\nauthorize(ws, () =>\n\t// gap\n\tcheck(ws)\n);\n', block, 'pin')).not.toThrow();
		// A statement between them is: the block says these lines are each
		// other's neighbours.
		expect(() => expectStatementBlock('authorize(ws, () =>\n\tbetween() ||\n\tcheck(ws)\n);\n', block, 'pin'))
			.toThrow(/do not appear consecutively/);
	});

	it('refuses a block whose own first line does not run where it stands', () => {
		// Consecutive lines inside a dead block are as consecutive as anywhere
		// else, so the block's first line answers the same question a single
		// pinned statement does.
		expect(() => expectStatementBlock(`if (false) {\n\t${block.join('\n\t')}\n}\n`, block, 'pin'))
			.toThrow(/appear consecutively but do not run where they stand, owned by: .*"if \(false\) \{"/);
		expect(() => expectStatementBlock(`return;\n${block.join('\n')}\n`, block, 'pin'))
			.toThrow(/owned by: .*"return;"/);
		// And the live placement still passes, including the one the block form
		// exists for: a first line that is itself an owner of what follows it.
		expect(() => expectStatementBlock(`if (ready) {\n\t${block.join('\n\t')}\n}\n`, block, 'pin')).not.toThrow();
	});

	it('needs at least two lines', () => {
		expect(() => expectStatementBlock('x', ['x'], 'pin')).toThrow(TypeError);
	});
});
