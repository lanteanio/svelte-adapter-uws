// The scope checker's own tests.
//
// It exists because two identifier-does-not-resolve defects have shipped from
// this repo, both invisible to `node --check` and to the suite: one helper used
// without being imported, and one `const` read after the block it was declared
// in had closed - the latter inside a 60 s maintenance timer, where nothing in
// a test run lived long enough to reach it.
//
// The first two cases below are those two defects, reduced. A checker that
// reports the tree clean while being unable to detect the bug it was written
// for is worse than no checker, so they are pinned here rather than assumed.

import { describe, it, expect } from 'vitest';
import { analyze } from '../scripts/check-scope.js';

/** Names reported as unresolved, without file/line noise. */
function unresolved(source) {
	return analyze(source).map((line) => /'([^']+)'/.exec(line)[1]);
}

describe('check-scope', () => {
	it('catches a const read after its block closed', () => {
		// The maintenance-timer defect, reduced.
		const source = `
			import { now } from './x.js';
			setInterval(() => {
				if (enabled) {
					const t = now();
					sweepA(t);
				}
				sweepB(t);
			}, 60000);
			/* global enabled */
			function sweepA() {}
			function sweepB() {}
		`;
		expect(unresolved(source)).toEqual(['t']);
	});

	it('catches a helper used without being imported', () => {
		const source = `
			import { imported } from './x.js';
			export function run(a) { return imported(a) && notImported(a); }
		`;
		expect(unresolved(source)).toEqual(['notImported']);
	});

	it('accepts a name declared in an enclosing scope', () => {
		const source = `
			const t = 1;
			function f() { if (true) { return t; } }
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('accepts use before declaration and hoisted functions', () => {
		// Resolvability is the question, not temporal-dead-zone correctness.
		const source = `
			export function a() { return later() + hoisted; }
			function later() { return 1; }
			var hoisted = 2;
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('accepts names a build step injects, declared with a global comment', () => {
		const source = `
			/* global WS_ENABLED */
			export const on = WS_ENABLED;
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('reports an injected name that was NOT declared', () => {
		expect(unresolved('export const on = WS_ENABLED;')).toEqual(['WS_ENABLED']);
	});

	it('does not mistake property names for references', () => {
		const source = `
			const o = { alpha: 1, ['beta']: 2 };
			export const v = o.gamma + o['delta'];
			class K { epsilon() { return this.zeta; } }
			export const k = new K();
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('handles destructuring, defaults, rest and catch bindings', () => {
		const source = `
			export function f({ a, b: { c } = {}, ...rest }, [d, ...tail] = []) {
				try { return a + c + d + tail.length + Object.keys(rest).length; }
				catch (err) { return err; }
			}
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('reads a computed destructuring key as a reference', () => {
		expect(unresolved('const { [missingKey]: v } = {}; export { v };')).toEqual(['missingKey']);
	});

	it('does not treat labels as identifiers', () => {
		const source = `
			export function f() {
				outer: for (let i = 0; i < 2; i++) { if (i) continue outer; else break outer; }
			}
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('scopes function parameters and named function expressions', () => {
		const source = `
			export const f = function self(n) { return n > 0 ? self(n - 1) : 0; };
			export const g = (x) => x * 2;
		`;
		expect(unresolved(source)).toEqual([]);
	});

	it('models arguments as a function binding rather than an ESM global', () => {
		expect(unresolved('export function f() { return arguments[0]; }')).toEqual([]);
		expect(unresolved('export function f() { return () => arguments[0]; }')).toEqual([]);
		expect(unresolved('export const f = () => arguments[0];')).toEqual(['arguments']);
		expect(unresolved('export const value = arguments[0];')).toEqual(['arguments']);
	});

	it('does not treat CommonJS wrapper bindings as ESM globals', () => {
		const source = `
			export const a = require('a');
			export const b = module.exports;
			export const c = exports.value;
			export const d = __dirname + __filename;
		`;
		expect(unresolved(source)).toEqual([
			'require', 'module', 'exports', '__dirname', '__filename'
		]);
	});

	it('does not report re-exports as local reads', () => {
		expect(unresolved(`export { thing } from './other.js';`)).toEqual([]);
	});

	// `typeof x` on an undeclared binding is the one identifier read in
	// JavaScript that does not throw, and it is the whole feature-detection
	// idiom. Reporting it would make the gate refuse the correct way to write
	// this - and `src/` uses it dozens of times.
	it('does not report a typeof feature check', () => {
		expect(unresolved(`export const isDeno = typeof Deno !== 'undefined';`)).toEqual([]);
		expect(unresolved(`export const dev = typeof __DEV__ !== 'undefined' && __DEV__;`)).toEqual(['__DEV__']);
	});

	it('still reports the operand of any other unary operator', () => {
		expect(unresolved('export const n = -missingA; export const m = !missingB;')).toEqual(['missingA', 'missingB']);
	});

	it('treats a function declared in a block as block-scoped', () => {
		// These sources are modules and therefore strict, where a `function`
		// inside a block does not escape it. Hoisting it made a genuine
		// ReferenceError resolve.
		const source = `
			{ function inner() { return 1; } }
			export const r = inner();
		`;
		expect(unresolved(source)).toEqual(['inner']);
	});

	it('still resolves a function declared beside its use', () => {
		expect(unresolved('export const r = ok(); function ok() { return 1; }')).toEqual([]);
	});

	it('only accepts a real global directive, not prose that opens with the word', () => {
		// An unanchored match turned any comment starting with "global" into a
		// declaration of every word in it, silently disarming the checker.
		const prose = `
			/* global state is shared here */
			export const r = state + shared + here;
		`;
		expect(unresolved(prose).sort()).toEqual(['here', 'shared', 'state']);
	});

	it('still accepts the directive with several comma-separated names', () => {
		expect(unresolved('/* global A, B, C */\nexport const r = A + B + C;')).toEqual([]);
	});

	it('does not read a line comment as a directive', () => {
		expect(unresolved('// global A\nexport const r = A;')).toEqual(['A']);
	});

	it('leaves an undefined export specifier to the parser, which already rejects it', () => {
		// Not this checker's case to report: `export { b }` with no local `b` is
		// a SyntaxError, so check-syntax catches it one layer down. Pinned so a
		// future change here does not quietly start double-reporting it.
		expect(() => analyze('const a = 1; export { a, b };')).toThrow(/not defined/);
	});
});
