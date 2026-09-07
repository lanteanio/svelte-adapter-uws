// The source-pin helper is what the policy suites lean on when a guard has no
// observable projection, so it has to refuse the neutralizations this
// repository uses and it has to blame the right line when it does. Each case
// here is a shape that a substring pin, or the helper's own earlier
// comment-stripping regex, waved through or misread.

import { describe, expect, it } from 'vitest';
import { blankNonCode, expectStatement, expectStatementBlock, expectStatementCount } from './helpers/source-pins.js';

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
});

describe('expectStatementCount', () => {
	it('counts only exact lines and reports the wrapped ones', () => {
		expect(() => expectStatementCount(`${STATEMENT}\nx();\n${STATEMENT}\n`, STATEMENT, 2, 'pin')).not.toThrow();
		expect(() => expectStatementCount(`${STATEMENT}\nfalse && ${STATEMENT}\n`, STATEMENT, 2, 'pin'))
			.toThrow(/expected 2 line\(s\) .* found 1 \(1 more line\(s\) contain it without being it/);
	});
});

describe('expectStatementBlock', () => {
	const block = ['authorize(ws, () =>', 'check(ws)', ');'];

	it('passes on the consecutive lines and refuses a neutralized owner line', () => {
		expect(() => expectStatementBlock('a();\nauthorize(ws, () =>\n\tcheck(ws)\n);\n', block, 'pin')).not.toThrow();
		expect(() => expectStatementBlock('authorize(ws, () => true ||\n\tcheck(ws)\n);\n', block, 'pin'))
			.toThrow(/its first line "authorize\(ws, \(\) =>" is not in the slice/);
		expect(() => expectStatementBlock('authorize(ws, () =>\n\t// gap\n\tcheck(ws)\n);\n', block, 'pin'))
			.toThrow(/its first line is at slice line 1 but what follows is/);
	});

	it('needs at least two lines', () => {
		expect(() => expectStatementBlock('x', ['x'], 'pin')).toThrow(TypeError);
	});
});
