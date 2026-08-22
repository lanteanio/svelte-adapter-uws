// A test that boots a real runtime in its own body must say what its budget is.
//
// WHY THIS IS A GATE AND NOT A CONVENTION. vitest gives a test 5000 ms unless it
// says otherwise, and that number was chosen for unit tests. A test whose first
// act is starting a real server is not one: boots here run around 2.4 s idle and
// have been seen at 5.3 s and 6.2 s while a full run is competing for the
// machine. Straddling the default is the worst place a budget can sit, because
// the suite then fails one run and passes the next, and the file always looks
// green in isolation - which is where anyone investigating runs it.
//
// It has already cost real time twice, in two different disguises: once as a
// bare timeout, and once as an ASSERTION about duplicate roster members in an
// authorization test, when a boot that outlived its budget left a listener
// running into the next case. Neither reads as a scheduling problem.
//
// The rule is one line to satisfy - pass REAL_BOOT_BUDGET_MS as the third
// argument - and a suite that boots once in `beforeAll` is not covered, because
// that hook carries its own budget.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'acorn';
import { describe, it, expect } from 'vitest';

const testDir = fileURLToPath(new URL('.', import.meta.url));

/** Calls whose cost is a real build or a real boot, not the assertion under test. */
const EXPENSIVE = new Set(['startRealRuntime', 'buildFixtureOnce']);
/** The vitest declarations a budget can be attached to. */
const TEST_DECLARATIONS = new Set(['it', 'test']);

/** @param {any} node @param {(n: any) => void} visit */
function walk(node, visit) {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node.type === 'string') visit(node);
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
		walk(node[key], visit);
	}
}

/** The callee's plain name, seeing through `it.only` / `test.each(...)`. */
function calleeName(callee) {
	if (!callee) return null;
	if (callee.type === 'Identifier') return callee.name;
	if (callee.type === 'MemberExpression') return calleeName(callee.object);
	if (callee.type === 'CallExpression') return calleeName(callee.callee);
	return null;
}

/**
 * Every `it(...)` in one file that reaches an expensive call, with whether it
 * declared a budget.
 *
 * Nested declarations cannot happen in vitest, so attributing an expensive call
 * to the nearest enclosing test is exact rather than a heuristic: the walk
 * starts at a test's own callback and never leaves it.
 *
 * @param {string} source
 */
export function budgetlessBoots(source) {
	const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	/** @type {{ line: number, calls: string[] }[]} */
	const offenders = [];

	walk(tree, (node) => {
		if (node.type !== 'CallExpression') return;
		if (!TEST_DECLARATIONS.has(calleeName(node.callee) ?? '')) return;

		// `it(name, fn)` / `it(name, fn, timeout)`, and the `it.each(table)(name,
		// fn, timeout)` form, which arrives here with the same argument shape.
		const body = node.arguments.find((arg) =>
			arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression');
		if (!body) return;
		const declaresBudget = node.arguments.some((arg) => arg !== body && (
			arg.type === 'Literal' && typeof arg.value === 'number'
			|| arg.type === 'Identifier' && /BUDGET|TIMEOUT/.test(arg.name)
			|| arg.type === 'ObjectExpression' && arg.properties.some((p) => p.key?.name === 'timeout')
		));
		if (declaresBudget) return;

		/** @type {string[]} */
		const calls = [];
		walk(body, (inner) => {
			if (inner.type !== 'CallExpression') return;
			const name = calleeName(inner.callee);
			if (name && EXPENSIVE.has(name)) calls.push(name);
		});
		if (calls.length > 0) offenders.push({ line: node.loc.start.line, calls: [...new Set(calls)] });
	});

	return offenders;
}

const testFiles = readdirSync(testDir)
	.filter((name) => name.endsWith('.test.js'))
	.sort();

describe('a test that boots a real runtime declares its budget', () => {
	it('finds every test file, so a silent zero cannot pass for compliance', () => {
		expect(testFiles.length).toBeGreaterThan(150);
	});

	it('reads a budgetless boot as an offence', () => {
		// The gate proving it can refuse. Without this the rule below is
		// satisfied just as well by a walk that never matches anything.
		const offenders = budgetlessBoots(
			"it('boots', async () => { const s = await startRealRuntime({}); });"
		);
		expect(offenders).toEqual([{ line: 1, calls: ['startRealRuntime'] }]);
	});

	it('accepts the same test once it carries one, in either spelling', () => {
		expect(budgetlessBoots(
			"it('boots', async () => { await startRealRuntime({}); }, 30000);"
		)).toEqual([]);
		expect(budgetlessBoots(
			"it('boots', async () => { await startRealRuntime({}); }, REAL_BOOT_BUDGET_MS);"
		)).toEqual([]);
	});

	it('leaves a beforeAll boot alone - that hook carries its own budget', () => {
		expect(budgetlessBoots(
			"beforeAll(async () => { await startRealRuntime({}); }, 400000);"
			+ "it('uses it', () => { expect(1).toBe(1); });"
		)).toEqual([]);
	});

	it.each(testFiles)('%s', (name) => {
		const source = readFileSync(path.join(testDir, name), 'utf8');
		if (!EXPENSIVE.has('startRealRuntime') || !/startRealRuntime|buildFixtureOnce/.test(source)) return;
		const offenders = budgetlessBoots(source);
		expect(
			offenders,
			`${name}: these tests boot or build inside their own body on vitest's 5000 ms default, which does not `
			+ 'survive a loaded run. Pass REAL_BOOT_BUDGET_MS from helpers/real-runtime.js as the third argument.'
		).toEqual([]);
	});
});
