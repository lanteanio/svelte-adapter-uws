// A flag the mirrors READ must be a flag a typed caller can PASS.
//
// src/testing.js and src/vite.js both read `options.authorizeWireSubscribe` to
// arm the subscribe-grant conjunct, and neither published type declared it. A
// TypeScript app therefore could not arm the posture production runs: it wrote
// `createTestServer({})`, the conjunct never fired, and the double answered
// permissively where production denies - the same green false negative this
// harness exists to prevent, recreated one layer up in the types.
//
// Nothing else in the repo can see it. `npm run check`'s type step verifies that
// export targets resolve and that declarations are .d.ts files; it never
// typechecks a CALLER, and TypeScript is not a dependency here so a tsc-driven
// fixture would simply skip in CI.
//
// So this derives the requirement from the CODE. It is SCOPE-AWARE rather than a
// line-window scan: an earlier version looked at the first 120 lines and matched
// only `options.x`, which saw three of twelve options - it missed the factory's
// destructure entirely and everything read further down the file.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const isFn = (n) =>
	n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

/** Does this function re-bind `options` in its own parameter list? */
function rebinds(fn) {
	return fn.params.some((p) => {
		if (p.type === 'Identifier') return p.name === 'options';
		if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') return p.left.name === 'options';
		return false;
	});
}

/**
 * Every option name the factory reads off its own `options` parameter, whether
 * by member access or by destructuring.
 *
 * Scope matters: the platform methods further down take their OWN `options`
 * parameter (publish options, filters, close options), so a nested function that
 * re-binds the name shadows the factory's and its reads must not be collected.
 *
 * @param {string} src
 * @param {string} factory - name of the exported factory, or 'default'
 */
function optionsRead(src, factory) {
	const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });

	let target = null;
	const findTarget = (n) => {
		if (!n || typeof n.type !== 'string' || target) return;
		if (isFn(n) && rebinds(n) && (n.id?.name === factory || factory === 'default')) {
			target = n;
			return;
		}
		for (const k of Object.keys(n)) {
			const v = n[k];
			if (Array.isArray(v)) v.forEach(findTarget);
			else if (v && typeof v.type === 'string') findTarget(v);
		}
	};
	findTarget(ast);
	expect(target, 'could not locate the ' + factory + ' factory taking an `options` parameter').toBeTruthy();

	const names = new Set();
	const walk = (n) => {
		if (!n || typeof n.type !== 'string') return;
		// A nested function re-binding `options` shadows the factory's: skip it.
		if (n !== target && isFn(n) && rebinds(n)) return;
		if (
			n.type === 'MemberExpression' &&
			!n.computed &&
			n.object.type === 'Identifier' &&
			n.object.name === 'options'
		) {
			names.add(n.property.name);
		}
		// `const { a, b = 1 } = options`
		if (
			n.type === 'VariableDeclarator' &&
			n.init?.type === 'Identifier' &&
			n.init.name === 'options' &&
			n.id.type === 'ObjectPattern'
		) {
			for (const prop of n.id.properties) {
				if (prop.type === 'Property' && prop.key.type === 'Identifier') names.add(prop.key.name);
			}
		}
		for (const k of Object.keys(n)) {
			const v = n[k];
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v.type === 'string') walk(v);
		}
	};
	walk(target);
	// Internal escape hatches are deliberately undocumented.
	for (const n of [...names]) if (n.startsWith('_')) names.delete(n);
	return names;
}

/**
 * Property names declared by ONE named interface, plus any `Pick<...>` alias it
 * extends. Scoped deliberately: a whole-file scan also collects string-union
 * members (`'siege'`, `'auto'`) and properties of unrelated interfaces, so
 * `options.siege` or `options.url` would have satisfied it.
 */
function declaredIn(src, iface) {
	const start = src.indexOf('interface ' + iface);
	expect(start, 'interface ' + iface + ' not found').toBeGreaterThan(-1);
	const open = src.indexOf('{', start);
	let depth = 0;
	let end = open;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	const body = src.slice(open, end);
	const names = new Set();
	for (const m of body.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/gm)) names.add(m[1]);
	// An `extends <alias>` where the alias is a Pick<> list contributes too.
	const head = src.slice(start, open);
	const pickName = head.match(/extends\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
	if (pickName) {
		const alias = src.match(new RegExp('type\\s+' + pickName + '\\s*=\\s*Pick<[\\s\\S]*?>;'));
		if (alias) for (const m of alias[0].matchAll(/'([a-zA-Z_][a-zA-Z0-9_]*)'/g)) names.add(m[1]);
	}
	return names;
}

/** String members of a `const NAME = new Set([...])` declaration. */
function stringSetIn(src, name) {
	const match = src.match(
		new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)')
	);
	expect(match, 'Set ' + name + ' not found').toBeTruthy();
	return new Set([...match[1].matchAll(/'([a-zA-Z_][a-zA-Z0-9_]*)'/g)].map((m) => m[1]));
}

describe('published option types cover what the mirrors read', () => {
	it('createTestServer declares every option it reads', () => {
		const reads = optionsRead(read('src/testing.js'), 'createTestServer');
		const declared = declaredIn(read('src/testing.d.ts'), 'TestServerOptions');
		// Self-check the SCANNER before trusting its verdict: a scan that sees
		// nothing passes vacuously. These three arrive only via the factory's
		// destructure, and `reconnectDispersalMs` is read thousands of lines down,
		// so between them they pin both capabilities the earlier line-window
		// version lacked.
		for (const viaDestructure of ['port', 'wsPath', 'handler']) {
			expect(reads.has(viaDestructure), 'the scanner must see destructured option ' + viaDestructure).toBe(true);
		}
		expect(reads.has('reconnectDispersalMs'), 'the scanner must cover the whole file, not a preamble').toBe(true);
		expect(reads.size, 'the scan found too little - the factory moved or was renamed').toBeGreaterThan(8);
		const missing = [...reads].filter((n) => !declared.has(n)).sort();
		expect(
			missing,
			'src/testing.js reads these off `options` but src/testing.d.ts does not declare them, ' +
				'so a TypeScript caller cannot pass them: ' + missing.join(', ')
		).toEqual([]);
	});

	it('the vite plugin declares every option it reads', () => {
		const viteSrc = read('src/vite.js');
		const reads = optionsRead(viteSrc, 'default');
		const declared = declaredIn(read('src/vite.d.ts'), 'UWSPluginOptions');
		const known = stringSetIn(viteSrc, 'KNOWN_PLUGIN_OPTION_KEYS');
		expect(reads.size).toBeGreaterThan(5);
		expect(
			[...reads].sort(),
			'src/vite.js and UWSPluginOptions must describe the same flat option bag'
		).toEqual([...declared].sort());
		expect(
			[...known].sort(),
			'KNOWN_PLUGIN_OPTION_KEYS must stay in lockstep with UWSPluginOptions, or a typed option is warned and ignored'
		).toEqual([...declared].sort());
	});

	it('the dev plugin type does not claim flags appear automatically', () => {
		// The Pick is an explicit list, so a flag added to WebSocketOptions does NOT
		// surface here on its own - which is how authorizeWireSubscribe came to be
		// read but unpassable. The comment used to say the opposite.
		expect(read('src/vite.d.ts')).not.toMatch(/surfaces here\s*\n?\s*\*?\s*automatically/);
	});
});
