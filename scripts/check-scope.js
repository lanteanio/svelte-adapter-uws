/**
 * Guard that every identifier a tracked source file READS actually resolves -
 * to a declaration in an enclosing scope, an import, or a declared global.
 *
 * `node --check` and the sibling check-syntax script both parse without
 * resolving, so a name that exists nowhere parses cleanly and throws only when
 * the line runs. That has shipped here twice: once an imported helper was used
 * without being added to the import list, and once a `const` declared inside an
 * `if` block was read after the block closed - the second inside a 60 s
 * maintenance timer, so nothing in a test suite lived long enough to reach it.
 * Both are the same class, and both are decidable statically.
 *
 * A file declares the names its bundler injects with the conventional
 * `/* global NAME, OTHER *\/` comment, which the runtime sources already carry.
 *
 * Deliberately NOT a general linter: it answers one question, has no config,
 * and its only dependency is the acorn already present in the tree. TDZ and
 * use-before-declaration are out of scope - a name declared anywhere in an
 * enclosing scope counts as resolvable, so this reports only names that cannot
 * resolve at all.
 *
 * @module scripts/check-scope
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** Names every environment provides. Not exhaustive - additions are cheap. */
const BUILTINS = new Set([
	// Language
	'globalThis', 'Object', 'Function', 'Boolean', 'Symbol', 'Error', 'AggregateError',
	'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
	'Number', 'BigInt', 'Math', 'Date', 'String', 'RegExp', 'Array', 'Int8Array',
	'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
	'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
	'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'ArrayBuffer',
	'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON', 'Promise', 'Reflect', 'Proxy',
	'Intl', 'undefined', 'NaN', 'Infinity', 'eval', 'isFinite', 'isNaN', 'parseFloat',
	'parseInt', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
	'escape', 'unescape', 'structuredClone', 'queueMicrotask',
	// Timers and console
	'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
	'clearImmediate', 'console',
	// Node
	'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
	'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'MessageChannel',
	'MessagePort', 'BroadcastChannel', 'performance', 'crypto', 'fetch', 'Request',
	'Response', 'Headers',
	'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream',
	'CompressionStream', 'DecompressionStream', 'CustomEvent', 'navigator',
	// Browser-ish (client stores and the cursor render worker)
	'window', 'document', 'self', 'location', 'history', 'localStorage', 'sessionStorage',
	'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'WebSocket',
	'Worker', 'OffscreenCanvas', 'ImageData', 'DOMMatrix', 'Path2D', 'CanvasGradient',
	'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'matchMedia',
	'devicePixelRatio', 'getComputedStyle', 'HTMLElement', 'Element', 'Node', 'Image',
	'CSS', 'PointerEvent', 'TouchEvent', 'KeyboardEvent', 'MouseEvent', 'WheelEvent',
	'postMessage', 'addEventListener', 'removeEventListener', 'alert', 'atob', 'btoa',
	'DedicatedWorkerGlobalScope', 'WorkerGlobalScope', 'importScripts',
	// Present in every modern runtime this ships on. `MessageEvent`, `CloseEvent`
	// and `DOMException` matter most here - this is a WebSocket library and
	// client code naming them is ordinary.
	'MessageEvent', 'CloseEvent', 'ErrorEvent', 'DOMException', 'WebAssembly',
	'EventSource', 'Iterator', 'AsyncIterator', 'URLPattern', 'reportError',
	'TextEncoderStream', 'TextDecoderStream', 'CountQueuingStrategy',
	'ByteLengthQueuingStrategy', 'Storage', 'XMLHttpRequest', 'FileReader',
	'customElements', 'ShadowRoot', 'DocumentFragment', 'Notification',
	'PerformanceObserver', 'PerformanceEntry', 'IdleDeadline'
]);

/** `var`/`function` bindings live in the nearest function-or-module scope. */
function functionScope(scope) {
	let s = scope;
	while (s.kind === 'block') s = s.parent;
	return s;
}

function createScope(parent, kind) {
	return { parent, kind, names: new Set() };
}

function resolvesIn(scope, name) {
	for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
	return false;
}

/**
 * Collect every binding a destructuring pattern introduces, and record the
 * computed keys inside it as references (`{ [k]: v }` reads `k`).
 */
function declarePattern(node, scope, refs, walkExpr) {
	if (!node) return;
	switch (node.type) {
		case 'Identifier':
			scope.names.add(node.name);
			return;
		case 'ObjectPattern':
			for (const prop of node.properties) {
				if (prop.type === 'RestElement') declarePattern(prop.argument, scope, refs, walkExpr);
				else {
					if (prop.computed) walkExpr(prop.key, scope);
					declarePattern(prop.value, scope, refs, walkExpr);
				}
			}
			return;
		case 'ArrayPattern':
			for (const el of node.elements) declarePattern(el, scope, refs, walkExpr);
			return;
		case 'AssignmentPattern':
			declarePattern(node.left, scope, refs, walkExpr);
			walkExpr(node.right, scope);
			return;
		case 'RestElement':
			declarePattern(node.argument, scope, refs, walkExpr);
			return;
		default:
			// A MemberExpression target (`[obj.a] = x`) binds nothing; it reads.
			walkExpr(node, scope);
	}
}

/**
 * Two passes are unnecessary because a scope's bindings are collected as the
 * walk enters it and references are only resolved after the whole file is
 * walked - so hoisting and use-before-declaration both resolve naturally.
 */
export function analyze(source, file = '<source>') {
	/** @type {{name: string, scope: any, line: number}[]} */
	const refs = [];
	const comments = [];
	const ast = acorn.parse(source, {
		ecmaVersion: 'latest',
		sourceType: 'module',
		locations: true,
		allowHashBang: true,
		allowAwaitOutsideFunction: true,
		onComment: comments
	});

	const moduleScope = createScope(null, 'module');
	// `/* global A, B */` - the directive the runtime sources already use to
	// declare the identifiers the adapter's build step substitutes in.
	for (const c of comments) {
		// Anchored to a real directive: `/* global A, B */` and nothing else.
		// An unanchored match turned any prose comment opening with the word
		// "global" into a declaration of every word in it, so
		// `// global state is shared here` silently declared `state`, `shared`
		// and `here` module-wide and disarmed the checker for them.
		if (c.type !== 'Block') continue;
		// COMMA-separated, and the directive must be the whole comment. Allowing
		// space separation cannot be distinguished from prose - `global state is
		// shared here` parses as four perfectly good identifiers - so that form
		// silently declared every word in any comment opening with "global".
		// Every real directive in this tree names one identifier, and the
		// comma form covers the rest.
		const m = /^\s*globals?\s+([A-Za-z_$][\w$]*(?::\s*\w+)?(?:\s*,\s*[A-Za-z_$][\w$]*(?::\s*\w+)?)*)\s*$/
			.exec(c.value);
		if (!m) continue;
		for (const raw of m[1].split(/[\s,]+/)) {
			const name = raw.split(':')[0].trim();
			if (name) moduleScope.names.add(name);
		}
	}

	const walkExpr = (node, scope) => walk(node, scope);

	function walkChildren(node, scope, skip) {
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
			if (skip && skip.has(key)) continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child.type === 'string') walk(child, scope);
			} else if (value && typeof value.type === 'string') {
				walk(value, scope);
			}
		}
	}

	function walkFunction(node, scope) {
		const inner = createScope(scope, 'function');
		if (node.id && node.type !== 'FunctionDeclaration') inner.names.add(node.id.name);
		// `arguments` is an implicit binding of ordinary functions, not a global.
		// An arrow inherits it from an enclosing ordinary function; at module
		// scope it is unresolved in ESM and throws like any other missing name.
		if (node.type !== 'ArrowFunctionExpression') inner.names.add('arguments');
		for (const param of node.params) declarePattern(param, inner, refs, walkExpr);
		// A function body's BlockStatement gets its own block scope whose parent
		// is this one, so params resolve outward exactly as they should.
		walk(node.body, inner);
	}

	function walk(node, scope) {
		if (!node || typeof node.type !== 'string') return;
		switch (node.type) {
			case 'UnaryExpression':
				// `typeof x` on an undeclared binding is the ONE identifier read
				// in JavaScript that does not throw, and it is the whole
				// feature-detection idiom (`typeof Deno !== 'undefined'`). Naming
				// something that may not exist is the point, so reporting it
				// would make the gate refuse the correct way to write this.
				if (node.operator === 'typeof' && node.argument.type === 'Identifier') return;
				walk(node.argument, scope);
				return;
			case 'Identifier':
				refs.push({ name: node.name, scope, line: node.loc.start.line });
				return;
			case 'MemberExpression':
				walk(node.object, scope);
				if (node.computed) walk(node.property, scope);
				return;
			case 'Property':
				if (node.computed) walk(node.key, scope);
				walk(node.value, scope);
				return;
			case 'MethodDefinition':
			case 'PropertyDefinition':
				if (node.computed) walk(node.key, scope);
				if (node.value) walk(node.value, scope);
				return;
			case 'LabeledStatement':
				walk(node.body, scope);
				return;
			case 'BreakStatement':
			case 'ContinueStatement':
			case 'MetaProperty':
			case 'PrivateIdentifier':
			case 'Super':
			case 'ThisExpression':
				return;
			case 'ImportDeclaration':
				for (const spec of node.specifiers) moduleScope.names.add(spec.local.name);
				return;
			case 'ExportNamedDeclaration':
				// `export { x } from './m'` re-exports without reading `x` locally.
				if (node.source) return;
				if (node.declaration) walk(node.declaration, scope);
				for (const spec of node.specifiers || []) walk(spec.local, scope);
				return;
			case 'ExportAllDeclaration':
				return;
			case 'VariableDeclaration': {
				const target = node.kind === 'var' ? functionScope(scope) : scope;
				for (const decl of node.declarations) {
					declarePattern(decl.id, target, refs, walkExpr);
					if (decl.init) walk(decl.init, scope);
				}
				return;
			}
			case 'FunctionDeclaration':
				// Block-scoped, not function-scoped: these sources are modules
				// and therefore always strict, where a `function` declared inside
				// a block does NOT escape it. Hoisting it to the function scope
				// made a genuine ReferenceError - reading it after the block -
				// resolve, which is the exact class this gate exists to catch.
				if (node.id) scope.names.add(node.id.name);
				walkFunction(node, scope);
				return;
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				walkFunction(node, scope);
				return;
			case 'ClassDeclaration':
				if (node.id) scope.names.add(node.id.name);
				walkChildren(node, createScope(scope, 'block'), new Set(['id']));
				return;
			case 'ClassExpression': {
				const inner = createScope(scope, 'block');
				if (node.id) inner.names.add(node.id.name);
				walkChildren(node, inner, new Set(['id']));
				return;
			}
			case 'BlockStatement':
			case 'StaticBlock':
			case 'SwitchStatement':
				walkChildren(node, createScope(scope, 'block'));
				return;
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement':
				// The head's `let`/`const` belongs to a scope enclosing the body.
				walkChildren(node, createScope(scope, 'block'));
				return;
			case 'CatchClause': {
				const inner = createScope(scope, 'block');
				if (node.param) declarePattern(node.param, inner, refs, walkExpr);
				walk(node.body, inner);
				return;
			}
			default:
				walkChildren(node, scope);
		}
	}

	walk(ast, moduleScope);

	const unresolved = [];
	for (const ref of refs) {
		if (BUILTINS.has(ref.name)) continue;
		if (resolvesIn(ref.scope, ref.name)) continue;
		unresolved.push(`${file}:${ref.line}: '${ref.name}' does not resolve`);
	}
	return unresolved;
}

/** Run the check over the tracked sources. Exit code is the result. */
function main() {
	// Tracked AND untracked (honouring .gitignore). `git ls-files` alone lists
	// only tracked files, so a source a contributor had just written was never
	// checked until `git add` - while the script still printed that everything
	// resolved. A brand-new file is exactly where "an import that was never
	// added" lives, so that was the one place the gate was blind.
	const files = execFileSync(
		'git',
		['ls-files', '--cached', '--others', '--exclude-standard', '*.js', '*.mjs'],
		{ cwd: root, encoding: 'utf8' }
	)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		// Generated build output is not source; it is checked at its own source.
		.filter((file) => !/(^|\/)(node_modules|build[^/]*|\.svelte-kit)\//.test(file))
		// Deduplicate: a path can appear in both listings.
		.filter((file, i, all) => all.indexOf(file) === i);

	let failures = 0;
	const seen = new Set();
	for (const file of files) {
		const source = readFileSync(resolvePath(root, file), 'utf8');
		let problems;
		try {
			problems = analyze(source, file);
		} catch (err) {
			// A file that does not parse is NOT scope-checked, so staying quiet
			// here would report the tree clean while skipping it - which is how a
			// `*/` inside a JSDoc line got past this check once already. Say so
			// and fail; check-syntax reports the parse error itself in detail.
			failures++;
			console.error(`check-scope: ${file}: not scope-checked, does not parse (${err.message})`);
			continue;
		}
		for (const problem of problems) {
			if (seen.has(problem)) continue;
			seen.add(problem);
			failures++;
			console.error(`check-scope: ${problem}`);
		}
	}

	if (failures > 0) {
		console.error(
			`check-scope: ${failures} unresolved identifier reference(s). Each one throws when its ` +
			'line runs. Import it, declare it, or add it to a /* global */ comment if a build step injects it.'
		);
		process.exit(1);
	}
	console.log(`check-scope: ${files.length} source files, every identifier resolves`);
}

// Importable for its own test suite; only the CLI invocation runs the check.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) main();
