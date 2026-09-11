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
 * `expectStatement` asks two questions, and only the first is about text: the
 * line's trimmed text must be exactly the statement, and the statement must
 * RUN where it stands. Deleting the call fails the first, renaming it fails it,
 * and anything written on the same line around it fails it because the line is
 * no longer that statement.
 *
 * THE SECOND QUESTION IS ANSWERED FROM A PARSE, not from the text around the
 * line, because it is a structural question: whether a statement runs where it
 * stands depends on the constructs enclosing it, and a neutralization one line
 * long leaves every character of the pinned line intact. A wrapper on the
 * previous line, a ternary whose `:` reads like a label, `undefined:` which IS
 * a label, `if (true) return;` which ends in a semicolon, `false &&` which
 * ends in a brace: reading neighbouring text answers those one at a time and
 * the next spelling is always cheap to write, while reading the tree answers
 * the whole class. So the carve is parsed, and the pinned line is judged by
 * its place in it:
 *
 * - it must stand in a statement LIST - a block, a program, a class static
 *   block, a switch case - and never be the bare body of an `if`, an `else`, a
 *   loop or a label, and never sit in an expression position (a ternary arm,
 *   the right of `&&`, a concise arrow body);
 * - nothing enclosing it may be statically dead: `if (false) {`, `while (0) {`,
 *   `if ('') {`, `if (NaN) {`, `if (0 === 1) {`, `for (const x of []) {`,
 *   `0 && (() => {`, the `else` of an `if (true)`;
 * - no earlier statement in its block may always leave: `return`, `throw`,
 *   `break`, `continue`, `if (true) return;`, `{ return; }`.
 *
 * A carve that does not parse is refused loudly rather than guessed at, since a
 * pin whose rule could not run would read as green. Carves are slices of a
 * file, so a small ladder of wrappers supplies the context a method body or a
 * `} finally {` continuation needs.
 *
 * Comments and the inside of a literal that spans lines are blanked before the
 * text question, so `/* stmt *\/`, `// stmt` and a template literal whose own
 * line reads as the statement are not lines either. The failure names the
 * construct that owns the line rather than reporting a bare `false`, so a
 * neutralized guard identifies itself.
 *
 * WHAT THIS CANNOT SEE needs the program RUN: a condition that is a name
 * (`if (disabled) {`), a function nothing calls, and a caller that stops
 * reaching the statement's lane at all. A statement whose meaning depends on
 * its neighbours - a callback argument, a continuation of the line above - is
 * pinned with `expectStatementBlock`, which requires the lines CONSECUTIVELY
 * and requires the first of them to stand where it is, so a neutralization of
 * the line that owns the call changes the block. The rest is what the
 * behavioural case beside a pin exists for.
 */

import { parse } from 'acorn';
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
 * `line` with the text of its literals removed, so a brace or an anchor inside
 * one is not read as code. Handles the three quote kinds and a regular
 * expression, escapes included.
 */
function codeOnly(line) {
	return line.replace(
		/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[a-z]*/g,
		'\'\''
	);
}

/**
 * The wrappers a carve may need before it parses. A carve is a SLICE of a
 * file - usually one method of a class - so it is rarely a program on its own.
 * Each wrapper's prefix ends in a newline, so a line number in the wrapped
 * source is the slice's line number plus `lines`.
 */
const SLICE_WRAPPERS = [
	{ prefix: '', suffix: '', lines: 0 },
	{ prefix: 'class __Carve__ {\n', suffix: '\n}', lines: 1 },
	{ prefix: 'function __carve__() {\n', suffix: '\n}', lines: 1 },
	{ prefix: 'const __carve__ = {\n', suffix: '\n};', lines: 1 },
	// A carve anchored on a continuation: `} finally {` or `} catch {` opens
	// the slice, so the construct it belongs to has to be supplied for it to
	// parse at all.
	{ prefix: 'try {\n', suffix: '\n}', lines: 1 }
];

/** Parsed carves, keyed by the carve text: a suite pins the same slice many times. */
const parsedSlices = new Map();

/**
 * `slice` parsed under the first wrapper that accepts it, with the line offset
 * that wrapper introduced - or null when nothing parses it.
 *
 * @param {string} slice
 * @returns {{ program: any, lineOffset: number, prefixLength: number } | null}
 */
function parsedSlice(slice) {
	if (parsedSlices.has(slice)) return parsedSlices.get(slice);
	/** @type {{ program: any, lineOffset: number, prefixLength: number } | null} */
	let parsed = null;
	for (const wrapper of SLICE_WRAPPERS) {
		try {
			const program = parse(wrapper.prefix + slice + wrapper.suffix, {
				ecmaVersion: 'latest',
				sourceType: 'module',
				locations: true
			});
			parsed = { program, lineOffset: wrapper.lines, prefixLength: wrapper.prefix.length };
			break;
		} catch { /* the next wrapper, or none */ }
	}
	parsedSlices.set(slice, parsed);
	return parsed;
}

/** The statically known value of `node`, as `{ value }`, or null when it has none. */
function staticValue(node) {
	if (!node) return null;
	switch (node.type) {
		case 'Literal':
			// A regular expression literal is an object, so it is truthy; its
			// `value` is engine-dependent, which is why it answers as a shape.
			return node.regex ? { value: {} } : { value: node.value };
		case 'TemplateLiteral':
			return node.expressions.length === 0 ? { value: node.quasis[0].value.cooked } : null;
		case 'Identifier':
			if (node.name === 'undefined') return { value: undefined };
			if (node.name === 'NaN') return { value: NaN };
			if (node.name === 'Infinity') return { value: Infinity };
			return null;
		case 'ArrayExpression':
			// Only the empty one, which is what a `for (const x of [])` needs.
			return node.elements.length === 0 ? { value: [] } : null;
		case 'ObjectExpression':
			return node.properties.length === 0 ? { value: {} } : null;
		case 'UnaryExpression': {
			const inner = staticValue(node.argument);
			if (!inner) return null;
			if (node.operator === '!') return { value: !inner.value };
			if (node.operator === '-') return { value: -(/** @type {any} */ (inner.value)) };
			if (node.operator === '+') return { value: +(/** @type {any} */ (inner.value)) };
			if (node.operator === 'void') return { value: undefined };
			if (node.operator === 'typeof') return { value: typeof inner.value };
			return null;
		}
		case 'BinaryExpression': {
			const left = staticValue(node.left);
			const right = staticValue(node.right);
			if (!left || !right) return null;
			return staticBinary(node.operator, left.value, right.value);
		}
		case 'LogicalExpression': {
			const left = staticValue(node.left);
			if (!left) return null;
			if (node.operator === '&&') return left.value ? staticValue(node.right) : left;
			if (node.operator === '||') return left.value ? left : staticValue(node.right);
			if (node.operator === '??') return left.value === null || left.value === undefined ? staticValue(node.right) : left;
			return null;
		}
		case 'SequenceExpression':
			return staticValue(node.expressions[node.expressions.length - 1]);
		case 'ParenthesizedExpression':
			return staticValue(node.expression);
		default:
			return null;
	}
}

/** `a <op> b` when both sides are statically known, or null for an operator this does not judge. */
function staticBinary(operator, a, b) {
	switch (operator) {
		case '===': return { value: a === b };
		case '!==': return { value: a !== b };
		// eslint-disable-next-line eqeqeq
		case '==': return { value: a == b };
		// eslint-disable-next-line eqeqeq
		case '!=': return { value: a != b };
		case '<': return { value: /** @type {any} */ (a) < /** @type {any} */ (b) };
		case '<=': return { value: /** @type {any} */ (a) <= /** @type {any} */ (b) };
		case '>': return { value: /** @type {any} */ (a) > /** @type {any} */ (b) };
		case '>=': return { value: /** @type {any} */ (a) >= /** @type {any} */ (b) };
		default: return null;
	}
}

/** Whether `node` always leaves the block it is in, so nothing after it runs. */
function alwaysTerminates(node) {
	if (!node) return false;
	switch (node.type) {
		case 'ReturnStatement':
		case 'ThrowStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
			return true;
		case 'BlockStatement':
			// A bare block that returns takes the statements after it with it.
			return node.body.some(alwaysTerminates);
		case 'IfStatement': {
			const test = staticValue(node.test);
			if (test && test.value) return alwaysTerminates(node.consequent);
			if (test && !test.value) return alwaysTerminates(node.alternate);
			return Boolean(node.alternate) && alwaysTerminates(node.consequent) && alwaysTerminates(node.alternate);
		}
		case 'LabeledStatement':
			return alwaysTerminates(node.body);
		default:
			return false;
	}
}

/** The statement-list node kinds: a statement standing in one of these stands on its own. */
const STATEMENT_LISTS = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase']);

/**
 * Every node whose span covers `index`, outermost first, each with the key it
 * occupies in its parent.
 *
 * @param {any} program
 * @param {number} index - a character offset into the wrapped source
 * @returns {Array<{ node: any, key: string, parent: any }>}
 */
function ancestryAt(program, index) {
	/** @type {Array<{ node: any, key: string, parent: any }>} */
	const chain = [];
	const visit = (node, key, parent) => {
		if (!node || typeof node.type !== 'string') return;
		if (!(node.start <= index && index < node.end)) return;
		chain.push({ node, key, parent });
		for (const [childKey, child] of Object.entries(node)) {
			if (childKey === 'type' || childKey === 'loc' || childKey === 'start' || childKey === 'end') continue;
			if (Array.isArray(child)) {
				for (const entry of child) visit(entry, childKey, node);
			} else visit(child, childKey, node);
		}
	};
	visit(program, 'root', null);
	return chain;
}

/**
 * Why the code at line `line` of `slice` does not run where it stands, or null
 * when it does.
 *
 * TWO QUESTIONS, both answered from the parse rather than from the text of the
 * line above. Line equality alone was defeated three times running, each time
 * by a neutralization one line long: a wrapper on the previous line, a ternary
 * whose `:` looked like a label, a jump above it, a `false &&` opening a block.
 * Reading what is AROUND a line cannot settle those; reading the tree can.
 *
 * 1. STANDS ON ITS OWN. The pinned statement's parent must be a statement list
 *    - a block, a program, a class static block, a switch case. A statement
 *    that is instead the bare body of an `if`, an `else`, a loop or a label, or
 *    that sits in an expression position (a ternary arm, the right of `&&`, a
 *    concise arrow body), is that construct's body and not a statement of its
 *    own, whatever the condition says.
 * 2. IS REACHED. No enclosing construct may be statically dead - `if (false)`,
 *    `while (0)`, `if ('')`, `for (const x of [])`, `0 &&`, a ternary arm the
 *    test rules out - and no earlier statement in the same block may always
 *    leave it (`return;`, `throw`, `break`, `continue`, `if (true) return;`,
 *    `{ return; }`).
 *
 * Conditions are judged by static evaluation of literals: `if (0 === 1)` is
 * dead, `if (disabled)` is not, because seeing the second needs the program
 * RUN. Reachability of a FUNCTION - whether anything calls it - is out of
 * reach for the same reason, and is what the behavioural case beside a pin is
 * for.
 *
 * @param {string} slice
 * @param {number} line - 0-based line index into `slice`
 * @returns {{ reason: string, owner: string } | null}
 */
function notRunningHere(slice, line) {
	const parsed = parsedSlice(slice);
	if (!parsed) {
		throw new Error(
			'source-pins: the carve does not parse, so no pin over it can say whether a statement runs. ' +
			'Widen or narrow the carve to a complete construct (a whole method, a whole function) and pin that.'
		);
	}
	const lines = slice.split('\n');
	// The character offset of the first non-space character on that line, in the
	// WRAPPED source the parse saw - so the wrapper's own prefix counts. Looking
	// the prefix up by its line count instead would pick the first wrapper with
	// one newline and read every function-wrapped carve five characters short.
	let offset = parsed.prefixLength;
	for (let i = 0; i < line; i++) offset += lines[i].length + 1;
	offset += lines[line].length - lines[line].trimStart().length;

	const chain = ancestryAt(parsed.program, offset);
	if (chain.length === 0) return null;
	const text = (node) => {
		const at = node.loc.start.line - parsed.lineOffset - 1;
		return at >= 0 && at < lines.length ? lines[at].trim() : node.type;
	};

	// Walk outward from the innermost node covering the line.
	for (let i = chain.length - 1; i >= 1; i--) {
		const { node, key } = chain[i];
		const parent = chain[i - 1].node;
		if (parent.type === 'IfStatement') {
			const test = staticValue(parent.test);
			if (key === 'consequent' && test && !test.value) return { reason: 'an `if` whose condition is written false', owner: text(parent) };
			if (key === 'alternate' && test && test.value) return { reason: 'an `else` whose `if` is written true', owner: text(parent) };
			// An `else if` chain is an IfStatement in the alternate, which is
			// ordinary; a bare statement there is the else's body.
			if (key === 'alternate' && node.type !== 'BlockStatement' && node.type !== 'IfStatement') {
				return { reason: 'the bare body of an `else`', owner: text(parent) };
			}
			if (key === 'consequent' && node.type !== 'BlockStatement') return { reason: 'the bare body of an `if`', owner: text(parent) };
		}
		if (parent.type === 'ConditionalExpression') {
			const test = staticValue(parent.test);
			if (key === 'consequent' && test && !test.value) return { reason: 'a ternary arm its condition rules out', owner: text(parent) };
			if (key === 'alternate' && test && test.value) return { reason: 'a ternary arm its condition rules out', owner: text(parent) };
			if (key !== 'test') return { reason: 'a ternary arm, not a statement', owner: text(parent) };
		}
		if (parent.type === 'LogicalExpression' && key === 'right') {
			const left = staticValue(parent.left);
			if (parent.operator === '&&' && left && !left.value) return { reason: 'the right of a `&&` whose left is written false', owner: text(parent) };
			if (parent.operator === '||' && left && left.value) return { reason: 'the right of a `||` whose left is written true', owner: text(parent) };
			return { reason: `the right of a \`${parent.operator}\`, not a statement`, owner: text(parent) };
		}
		if ((parent.type === 'WhileStatement' || parent.type === 'ForStatement') && key === 'body') {
			const test = staticValue(parent.test);
			if (test && !test.value) return { reason: 'a loop whose condition is written false', owner: text(parent) };
			if (node.type !== 'BlockStatement') return { reason: 'the bare body of a loop', owner: text(parent) };
		}
		if ((parent.type === 'ForOfStatement' || parent.type === 'ForInStatement') && key === 'body') {
			const right = staticValue(parent.right);
			if (right && (Array.isArray(right.value) || (right.value && typeof right.value === 'object' && Object.keys(right.value).length === 0))) {
				return { reason: 'a loop over an empty literal', owner: text(parent) };
			}
			if (node.type !== 'BlockStatement') return { reason: 'the bare body of a loop', owner: text(parent) };
		}
		if ((parent.type === 'DoWhileStatement' || parent.type === 'LabeledStatement' || parent.type === 'WithStatement') && key === 'body' && node.type !== 'BlockStatement') {
			return { reason: `the bare body of a \`${parent.type === 'LabeledStatement' ? 'label' : parent.type.replace('Statement', '').toLowerCase()}\``, owner: text(parent) };
		}
		if (parent.type === 'ArrowFunctionExpression' && key === 'body' && node.type !== 'BlockStatement') {
			return { reason: 'a concise arrow body, not a statement', owner: text(parent) };
		}
		// An earlier statement in the same list that never comes back.
		if (STATEMENT_LISTS.has(parent.type)) {
			const list = parent.type === 'SwitchCase' ? parent.consequent : parent.body;
			if (Array.isArray(list)) {
				for (const sibling of list) {
					if (sibling === node) break;
					if (alwaysTerminates(sibling)) return { reason: 'a statement above it that always leaves the block', owner: text(sibling) };
				}
			}
		}
	}
	return null;
}

/**
 * What keeps the line at `index` from running, as a phrase naming the owner, or
 * null when nothing does.
 *
 * @param {string} slice
 * @param {number} index
 * @returns {string | null}
 */
function ownedBy(slice, index) {
	const verdict = notRunningHere(slice, index);
	return verdict === null ? null : `${verdict.reason}: ${JSON.stringify(verdict.owner)}`;
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
		if (lines[i] === statement && ownedBy(slice, i) === null) found.push(i);
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
		if (j === block.length && ownedBy(slice, i) === null) found.push(i);
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
	if (exact.some((i) => ownedBy(slice, i) === null)) return;

	// Report the near misses rather than a bare false. A wrapped, owned or
	// commented call still contains the text, and naming the line that holds
	// it - or the line above, the jump, or the dead block that took it over -
	// is the difference between "the pin failed" and "here is what someone
	// did to it".
	if (exact.length > 0) {
		const owners = exact.map((i) => ownedBy(slice, i) ?? '').join(' | ');
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
	const owned = exact.filter((i) => ownedBy(slice, i) !== null);
	const found = exact.length - owned.length;
	if (found === count) return;
	const wrapped = lines.filter((line) => line !== statement && line.includes(statement));
	const detail = [
		owned.length > 0
			? `${owned.length} more line(s) do not run on their own, owned by: ${owned.map((i) => ownedBy(slice, i) ?? '').join(' | ')}`
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
	if (consecutive.some((i) => ownedBy(slice, i) === null)) return;
	if (consecutive.length > 0) {
		const owners = consecutive.map((i) => ownedBy(slice, i) ?? '').join(' | ');
		expect.fail(`${label}: the lines ${JSON.stringify(block)} appear consecutively but do not run where they stand, owned by: ${owners}`);
	}
	const anchor = lines.indexOf(block[0]);
	const detail = anchor === -1
		? `its first line ${JSON.stringify(block[0])} is not in the slice`
		: `its first line is at slice line ${anchor + 1} but what follows is ${JSON.stringify(lines.slice(anchor, anchor + block.length))}`;
	expect.fail(`${label}: the lines ${JSON.stringify(block)} do not appear consecutively - ${detail}`);
}
