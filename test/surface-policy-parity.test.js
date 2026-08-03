// The oracle that stops the socket surfaces diverging again.
//
// WHY A SOURCE SCAN. `src/runtime/handler.js` (production), `src/testing.js`
// (the published `svelte-adapter-uws/testing` server) and `src/vite.js` (the
// dev server) each own their own plumbing, so no behavioural test can cheaply
// prove they make the SAME decision in every configuration - and behavioural
// tests are exactly what missed this class repeatedly. Every divergence found
// in this area was found by reading the files side by side:
//
//   - the plugin-owned carve-out reached the batch path on all three surfaces
//     and the single path on one, so a documented group join worked or failed
//     depending on microtask coalescing;
//   - the recover guard reached two surfaces of three, so the test server
//     served a revoked topic's replay history and denied the subscribe after;
//   - the gap-fill fall-through reached one surface, so a regression test
//     written against the documented harness passed against the old behaviour;
//   - the same decision was spelled `isNew` in one file and `!subs.has(topic)`
//     in another, which is how it drifted unnoticed in the first place.
//
// WHY EVERYTHING HERE RESOLVES THROUGH THE AST AND THE IMPORT BINDING. This
// file has been defeated twice by adversarial review, and the second time was
// worse than the first:
//
//   v1 asserted a surface merely CONTAINED a call to each predicate. One call
//   in the single lane satisfied it while three other lanes had none.
//
//   v2 scanned lines for a list of known inline spellings. Wrapping any
//   expression across two lines evaded every pattern at once - and these call
//   sites sit at eight tabs of indentation, so wrapping is the NATURAL
//   formatting, not a contrivance. One pattern could never fire at any of the
//   three sites it was written for.
//
//   v3 (AST rules, but text everywhere else) was defeated in minutes: the
//   import check was `src.includes('subscribe-policy.js')`, which a COMMENT
//   satisfies, and the call counts were `src.split(fn).length - 1`, which
//   comments and dead code satisfy. A reviewer deleted the import from
//   `src/vite.js`, gave the dev surface its own local copies of all five
//   predicates, left one comment mentioning the path, and every oracle in the
//   project stayed green. That is the pre-extraction state exactly.
//
// So: a call counts only when the callee RESOLVES TO THE IMPORT. A surface must
// import the policy through a real ImportDeclaration, unaliased, and may not
// shadow any policy name with a local binding. Text appearing in a comment
// cannot satisfy any rule here, because comments are not in the tree.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

// ONE list. `SURFACES` and a separate file list used to sit side by side here,
// and they drifted: production's `platform.js` was counted but never scanned,
// so its `platform.subscribe` lane sat with two raw cap comparisons while the
// same lane on the other two surfaces asked the policy.
const SURFACES = [
	{
		label: 'production',
		// Production splits its platform helpers out; the other two keep theirs inline.
		files: ['src/runtime/handler.js', 'src/runtime/handler/platform.js']
	},
	{ label: 'the in-process test server', files: ['src/testing.js'] },
	{ label: 'the dev plugin', files: ['src/vite.js'] }
];

// Files that decide subscribes without being a surface. `ws-symbols.js` holds
// the plugin lane (`trackedSubscribe`) and carried its own copy of the cap;
// `state.js` and `subscribe-hooks.js` hold the two AXES every gate reads
// (`subscribeAuth` and `hasUserSubscribeHook`), so a re-derivation hidden there
// would be invisible while looking exactly like the shared decision; `caps.js`
// is where the cap value itself lives.
const SHARED = [
	'src/runtime/utils/ws-symbols.js',
	'src/runtime/handler/state.js',
	'src/runtime/handler/subscribe-hooks.js',
	'src/runtime/utils/caps.js'
];

const POLICY = 'src/runtime/utils/subscribe-policy.js';
const SUBSCRIPTION_CAP = 1_000_000;
const POLICY_NAMES = [
	'deniesWireSystemTopicSubscribe',
	'deniesWireSubscribePreHook',
	'deniesWireSubscribeLanding',
	'wantsRecover',
	'recoverIsRevoked',
	'exceedsSubscriptionCap',
	// The observer lane's grant recheck. Listed so the export-ownership rule
	// and the binding-shadow ban apply to the ONE predicate whose lane has no
	// second line of defence - a nested-scope shadow of this name could
	// otherwise satisfy the two-calls-around-one-await structure while the
	// real predicate is never asked.
	'deniesUngrantedObserve'
];

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const pathOf = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const policyRealpath = realpathSync(pathOf(POLICY));

/** Every JavaScript module below a directory, as repository-relative paths. */
function jsFiles(dir, prefix = dir) {
	const out = [];
	for (const entry of readdirSync(join(rootDir, dir), { withFileTypes: true })) {
		const relative = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...jsFiles(`${dir}/${entry.name}`, relative));
		else if (entry.isFile() && entry.name.endsWith('.js')) out.push(relative);
	}
	return out;
}

/**
 * Every node paired with its ancestor chain, nearest first.
 *
 * Hand-rolled because acorn-walk is not a dependency. Note the thing that must
 * NOT be hand-rolled: a JS SCANNER. One previously read `/['"]/` as a string
 * opening and ate 42,000 characters of a source file. Parsing is acorn's job.
 * @param {string} src
 */
function nodesWithAncestors(src) {
	const out = [];
	const root = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	const visit = (node, ancestors) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, ancestors);
			return;
		}
		if (typeof node.type !== 'string') return;
		out.push({ node, ancestors });
		const next = [node, ...ancestors];
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
			visit(node[key], next);
		}
	};
	visit(root, []);
	return out;
}

/** Resolve one relative module specifier to the canonical file it names. */
function resolvedImport(file, specifier) {
	if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null;
	try {
		return realpathSync(fileURLToPath(new URL(specifier, new URL(`../${file}`, import.meta.url))));
	} catch {
		return null;
	}
}

/** Names this file imports from the canonical policy module, as {local -> imported}. */
function policyImports(nodes, file) {
	/** @type {Map<string, string>} */
	const found = new Map();
	for (const { node } of nodes) {
		if (node.type !== 'ImportDeclaration') continue;
		if (resolvedImport(file, node.source?.value) !== policyRealpath) continue;
		for (const spec of node.specifiers) {
			if (spec.type === 'ImportSpecifier') found.set(spec.local.name, spec.imported.name);
		}
	}
	return found;
}

/** Add every identifier declared by a binding pattern. */
function addPatternBindings(pattern, names) {
	if (pattern === null || pattern === undefined) return;
	if (pattern.type === 'Identifier') {
		names.add(pattern.name);
		return;
	}
	if (pattern.type === 'RestElement') {
		addPatternBindings(pattern.argument, names);
		return;
	}
	if (pattern.type === 'AssignmentPattern') {
		addPatternBindings(pattern.left, names);
		return;
	}
	if (pattern.type === 'ArrayPattern') {
		for (const element of pattern.elements) addPatternBindings(element, names);
		return;
	}
	if (pattern.type === 'ObjectPattern') {
		for (const property of pattern.properties) {
			if (property.type === 'RestElement') addPatternBindings(property.argument, names);
			else addPatternBindings(property.value, names);
		}
	}
}

/** Every non-import binding declared in this file, including params and patterns. */
function localBindings(nodes) {
	const names = new Set();
	for (const { node } of nodes) {
		if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id) names.add(node.id.name);
		if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
			for (const param of node.params) addPatternBindings(param, names);
		} else if (node.type === 'ClassDeclaration' && node.id) names.add(node.id.name);
		else if (node.type === 'VariableDeclarator') addPatternBindings(node.id, names);
		else if (node.type === 'CatchClause') addPatternBindings(node.param, names);
	}
	return names;
}

/** Policy names this module exports, including export-list aliases. */
function exportedPolicyNames(nodes) {
	const names = new Set();
	for (const { node } of nodes) {
		if (node.type !== 'ExportNamedDeclaration') continue;
		if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id) {
			names.add(node.declaration.id.name);
		}
		if (node.declaration?.type === 'VariableDeclaration') {
			for (const declaration of node.declaration.declarations) addPatternBindings(declaration.id, names);
		}
		for (const specifier of node.specifiers ?? []) {
			if (specifier.type !== 'ExportSpecifier') continue;
			// BOTH sides count. `export { deniesUngrantedObserve as x }`
			// re-publishes the policy under a name the exported-side filter
			// would drop, which is a barrel by another spelling.
			names.add(specifier.exported.name ?? specifier.exported.value);
			names.add(specifier.local?.name ?? specifier.local?.value);
		}
	}
	return new Set([...names].filter((name) => POLICY_NAMES.includes(name)));
}

/**
 * Modules that re-publish a policy module wholesale. `export * from` names no
 * specifier, so the specifier walk above cannot see it - but it republishes
 * every policy name the target owns, which is exactly the barrel the
 * exclusive-ownership rule exists to forbid.
 */
function starReexportedPolicySources(nodes, file) {
	const sources = [];
	for (const { node } of nodes) {
		if (node.type !== 'ExportAllDeclaration') continue;
		const target = resolvedImport(file, node.source?.value);
		if (target === null) continue;
		sources.push({ target, line: node.loc?.start?.line ?? 0 });
	}
	return sources;
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function nearestFunction(ancestors) {
	return ancestors.find((node) => FUNCTION_TYPES.has(node.type)) ?? null;
}

function staticBoolean(node) {
	if (node?.type === 'Literal' && typeof node.value === 'boolean') return node.value;
	if (node?.type === 'UnaryExpression' && node.operator === '!') {
		const value = staticBoolean(node.argument);
		return value === null ? null : !value;
	}
	if (node?.type === 'LogicalExpression') {
		const left = staticBoolean(node.left);
		const right = staticBoolean(node.right);
		if (node.operator === '&&') {
			if (left === false || right === false) return false;
			if (left === true && right === true) return true;
		}
		if (node.operator === '||') {
			if (left === true || right === true) return true;
			if (left === false && right === false) return false;
		}
	}
	return null;
}

/** False when a constant ancestor proves this expression can never execute. */
function staticallyReachable(entry) {
	const { node, ancestors } = entry;
	for (let index = 0; index < ancestors.length; index++) {
		const ancestor = ancestors[index];
		if (FUNCTION_TYPES.has(ancestor.type)) break;
		if (ancestor.type === 'BlockStatement') {
			const child = index === 0 ? node : ancestors[index - 1];
			const statementIndex = ancestor.body.indexOf(child);
			if (statementIndex > 0 && ancestor.body.slice(0, statementIndex).some((statement) =>
				statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement' ||
				statement.type === 'BreakStatement' || statement.type === 'ContinueStatement')) return false;
		}
		if (ancestor.type === 'IfStatement' || ancestor.type === 'ConditionalExpression') {
			const fixed = staticBoolean(ancestor.test);
			if (fixed === false && node.start >= ancestor.consequent.start && node.end <= ancestor.consequent.end) return false;
			if (fixed === true && ancestor.alternate && node.start >= ancestor.alternate.start && node.end <= ancestor.alternate.end) return false;
		}
		if ((ancestor.type === 'WhileStatement' || ancestor.type === 'ForStatement') && staticBoolean(ancestor.test) === false) return false;
		if (ancestor.type === 'LogicalExpression') {
			const other = node.start >= ancestor.right.start ? ancestor.left : ancestor.right;
			const fixed = staticBoolean(other);
			if (ancestor.operator === '&&' && fixed === false) return false;
			if (ancestor.operator === '||' && fixed === true) return false;
		}
	}
	return true;
}

/**
 * Functions reachable from a module export, a top-level registration callback,
 * or a call/object returned by a reachable function. A parked helper that is
 * never called, returned or registered is deliberately absent.
 */
function reachableFunctions(nodes) {
	const reachable = new Set();
	const byName = new Map();
	for (const { node, ancestors } of nodes) {
		if (!FUNCTION_TYPES.has(node.type)) continue;
		if (node.id?.name) byName.set(node.id.name, node);
		const parent = ancestors[0];
		if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') byName.set(parent.id.name, node);
		const beforeOuterFunction = [];
		for (const ancestor of ancestors) {
			if (FUNCTION_TYPES.has(ancestor.type)) break;
			beforeOuterFunction.push(ancestor);
		}
		if (beforeOuterFunction.some((ancestor) => ancestor.type === 'ExportNamedDeclaration' || ancestor.type === 'ExportDefaultDeclaration')) {
			reachable.add(node);
			continue;
		}
		const topLevelCall = beforeOuterFunction.find((ancestor) => ancestor.type === 'CallExpression');
		if (topLevelCall?.arguments.some((argument) => node.start >= argument.start && node.end <= argument.end)) reachable.add(node);
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const { node, ancestors } of nodes) {
			const owner = nearestFunction(ancestors);
			if (owner === null || !reachable.has(owner)) continue;
			if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
				const target = byName.get(node.callee.name);
				if (target && !reachable.has(target)) {
					reachable.add(target);
					changed = true;
				}
			}
			if (!FUNCTION_TYPES.has(node.type) || node === owner || reachable.has(node)) continue;
			const beforeOwner = [];
			for (const ancestor of ancestors) {
				if (ancestor === owner) break;
				beforeOwner.push(ancestor);
			}
			const registered = beforeOwner.some((ancestor) =>
				ancestor.type === 'CallExpression' && ancestor.arguments.some((argument) => node.start >= argument.start && node.end <= argument.end));
			const returned = beforeOwner.some((ancestor) => ancestor.type === 'ReturnStatement');
			const objectMethod = beforeOwner.some((ancestor) => ancestor.type === 'Property') &&
				beforeOwner.some((ancestor) => ancestor.type === 'ObjectExpression');
			if (registered || returned || objectMethod) {
				reachable.add(node);
				changed = true;
			}
		}
	}
	return reachable;
}

function identifierControlsDecision(nodes, name, owner, after) {
	for (const { node, ancestors } of nodes) {
		if (node.type !== 'Identifier' || node.name !== name || node.start <= after) continue;
		if (nearestFunction(ancestors) !== owner) continue;
		let child = node;
		for (const parent of ancestors) {
			if (parent === owner) break;
			if ((parent.type === 'IfStatement' || parent.type === 'ConditionalExpression' || parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement') && parent.test === child) return true;
			if (parent.type === 'ForStatement' && parent.test === child) return true;
			if (parent.type === 'SwitchStatement' && parent.discriminant === child) return true;
			if (parent.type === 'ReturnStatement') return true;
			if (parent.type === 'ExpressionStatement') break;
			child = parent;
		}
	}
	return false;
}

/** True when a policy result reaches control flow instead of decorative code. */
function resultIsConsumed(entry, nodes) {
	const { node, ancestors } = entry;
	const owner = nearestFunction(ancestors);
	let child = node;
	for (const parent of ancestors) {
		if (parent === owner) {
			if (parent?.type === 'ArrowFunctionExpression' && parent.body === child) return true;
			break;
		}
		if ((parent.type === 'IfStatement' || parent.type === 'ConditionalExpression' || parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement') && parent.test === child) return true;
		if (parent.type === 'ForStatement' && parent.test === child) return true;
		if (parent.type === 'SwitchStatement' && parent.discriminant === child) return true;
		if (parent.type === 'ReturnStatement') return true;
		if (parent.type === 'VariableDeclarator' && parent.init === child && parent.id?.type === 'Identifier') {
			return identifierControlsDecision(nodes, parent.id.name, owner, parent.end);
		}
		if (parent.type === 'AssignmentExpression' && parent.right === child && parent.left?.type === 'Identifier') {
			return identifierControlsDecision(nodes, parent.left.name, owner, parent.end);
		}
		if (parent.type === 'ExpressionStatement') return false;
		child = parent;
	}
	return false;
}

const ORDER_COMPARISONS = new Set(['<', '<=', '>', '>=']);

function propertyName(node) {
	if (node === null || node === undefined) return null;
	if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
	if (node.computed && node.property?.type === 'Literal') return node.property.value;
	if (node.type === 'Property') return node.key?.name ?? node.key?.value ?? null;
	return null;
}

function objectField(node, name) {
	if (node?.type !== 'ObjectExpression') return null;
	const fields = node.properties.filter((property) => property.type === 'Property' && propertyName(property) === name);
	return fields.length === 1 ? fields[0].value : null;
}

/** Nearest same-function initializer visible before one identifier use. */
function bindingInitializer(nodes, name, owner, before) {
	let found = null;
	for (const entry of nodes) {
		const { node, ancestors } = entry;
		if (node.end > before || nearestFunction(ancestors) !== owner) continue;
		let value = null;
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === name) {
			value = node.init;
		} else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && node.left.name === name) {
			value = node.right;
		} else if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init !== null) {
			const property = node.id.properties.find((candidate) =>
				candidate.type === 'Property' && candidate.value?.type === 'Identifier' && candidate.value.name === name);
			if (property !== undefined) {
				value = {
					type: 'MemberExpression',
					object: node.init,
					property: property.key,
					computed: property.computed,
					optional: false,
					start: node.init.start,
					end: node.end,
					loc: node.loc
				};
			}
		}
		if (value !== null && (found === null || node.start > found.node.start)) found = { node, value };
	}
	return found?.value ?? null;
}

function childNodes(node) {
	const children = [];
	for (const key of Object.keys(node ?? {})) {
		if (key === 'start' || key === 'end' || key === 'loc') continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) if (item && typeof item.type === 'string') children.push(item);
		} else if (value && typeof value.type === 'string') children.push(value);
	}
	return children;
}

function expressionContains(node, predicate, nodes, owner, before = node?.start ?? Infinity, seen = new Set()) {
	if (node === null || node === undefined) return false;
	if (predicate(node)) return true;
	if (node.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (seen.has(key)) return false;
		const init = bindingInitializer(nodes, node.name, owner, before);
		if (init !== null) {
			seen.add(key);
			const found = expressionContains(init, predicate, nodes, owner, init.start, seen);
			seen.delete(key);
			if (found) return true;
		}
	}
	return childNodes(node).some((child) => expressionContains(child, predicate, nodes, owner, child.start, seen));
}

function isSubscriptionSlot(node) {
	return (node.type === 'Identifier' && node.name === 'WS_SUBSCRIPTIONS') ||
		(node.type === 'MemberExpression' && propertyName(node) === 'WS_SUBSCRIPTIONS');
}

/** Nearest lexical initializer, including a closure's enclosing function. */
const lexicalBindingCache = new WeakMap();
function lexicalBindingInitializer(nodes, name, owner, before) {
	let byName = lexicalBindingCache.get(nodes);
	if (byName === undefined) {
		byName = new Map();
		for (const entry of nodes) {
			const { node, ancestors } = entry;
			let bindingName = null;
			let value = null;
			if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
				bindingName = node.id.name;
				value = node.init;
			} else if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && node.init !== null) {
				for (const property of node.id.properties) {
					if (property.type !== 'Property' || property.value?.type !== 'Identifier') continue;
					const member = {
						type: 'MemberExpression', object: node.init, property: property.key,
						computed: property.computed, optional: false,
						start: node.init.start, end: node.end, loc: node.loc
					};
					if (!byName.has(property.value.name)) byName.set(property.value.name, []);
					const declarationOwner = nearestFunction(ancestors);
					const width = declarationOwner === null ? Infinity : declarationOwner.end - declarationOwner.start;
					byName.get(property.value.name).push({ node, value: member, declarationOwner, width });
				}
				continue;
			} else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
				bindingName = node.left.name;
				value = node.right;
			}
			if (bindingName === null || value === null) continue;
			const declarationOwner = nearestFunction(ancestors);
			const width = declarationOwner === null ? Infinity : declarationOwner.end - declarationOwner.start;
			if (!byName.has(bindingName)) byName.set(bindingName, []);
			byName.get(bindingName).push({ node, value, declarationOwner, width });
		}
		lexicalBindingCache.set(nodes, byName);
	}

	const candidates = [];
	for (const entry of byName.get(name) ?? []) {
		const { node, ancestors } = entry;
		const { declarationOwner } = entry;
		const visibleOwner = declarationOwner === owner ||
			(declarationOwner === null && owner !== null) ||
			(declarationOwner !== null && owner !== null &&
				declarationOwner.start <= owner.start && declarationOwner.end >= owner.end);
		if (!visibleOwner) continue;
		if (declarationOwner === owner && node.end > before) continue;
		candidates.push(entry);
	}
	candidates.sort((a, b) => a.width - b.width || b.node.start - a.node.start);
	return candidates[0]?.value ?? null;
}

/**
 * Identity of an exact alias to `userData[WS_SUBSCRIPTIONS]`.
 * Descendants do not count: `{ original: subs, size: 0 }` is a wrapper, not an
 * alias to the Set, even though a provenance substring exists below it.
 */
function exactSubscriptionRoot(node, nodes, owner, seen = new Set()) {
	if (node?.type === 'ChainExpression') return exactSubscriptionRoot(node.expression, nodes, owner, seen);
	if (node?.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (seen.has(key)) return null;
		const init = lexicalBindingInitializer(nodes, node.name, owner, node.start);
		if (init === null) return null;
		seen.add(key);
		const root = exactSubscriptionRoot(init, nodes, owner, seen);
		seen.delete(key);
		return root;
	}
	if (node?.type === 'MemberExpression' && isSubscriptionSlot(node.property)) {
		return `slot:${node.start}:${node.end}`;
	}
	return null;
}

function collectExactHasRoots(node, nodes, owner, out = new Set(), seen = new Set()) {
	if (node === null || node === undefined) return out;
	if (node.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (!seen.has(key)) {
			const init = lexicalBindingInitializer(nodes, node.name, owner, node.start);
			if (init !== null) {
				seen.add(key);
				collectExactHasRoots(init, nodes, owner, out, seen);
				seen.delete(key);
			}
		}
	}
	if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
		propertyName(node.callee) === 'has' && node.arguments.length === 1) {
		const root = exactSubscriptionRoot(node.callee.object, nodes, owner);
		const topic = node.arguments[0];
		const topicShaped = topic?.type === 'Identifier' ||
			(topic?.type === 'MemberExpression' && propertyName(topic) === 'topic');
		if (root !== null && topicShaped) out.add(root);
	}
	for (const child of childNodes(node)) collectExactHasRoots(child, nodes, owner, out, seen);
	return out;
}

function expressionUsesExactSubscriptionSize(node, nodes, owner, seen = new Set()) {
	if (node === null || node === undefined) return false;
	if (node.type === 'MemberExpression' && propertyName(node) === 'size' &&
		exactSubscriptionRoot(node.object, nodes, owner) !== null) return true;
	if (node.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (!seen.has(key)) {
			const init = lexicalBindingInitializer(nodes, node.name, owner, node.start);
			if (init !== null) {
				seen.add(key);
				const found = expressionUsesExactSubscriptionSize(init, nodes, owner, seen);
				seen.delete(key);
				if (found) return true;
			}
		}
	}
	return childNodes(node).some((child) => expressionUsesExactSubscriptionSize(child, nodes, owner, seen));
}

/** Raw Set/size data leaving for an opaque callee can hide a private cap. */
function expressionCarriesSubscriptionData(node, nodes, owner, seen = new Set()) {
	if (node === null || node === undefined) return false;
	if (exactSubscriptionRoot(node, nodes, owner) !== null) return true;
	if (node.type === 'MemberExpression' && propertyName(node) === 'size' &&
		exactSubscriptionRoot(node.object, nodes, owner) !== null) return true;
	if (node.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (seen.has(key)) return false;
		const init = lexicalBindingInitializer(nodes, node.name, owner, node.start);
		if (init === null) return false;
		seen.add(key);
		const carries = expressionCarriesSubscriptionData(init, nodes, owner, seen);
		seen.delete(key);
		return carries;
	}
	if (node.type === 'ObjectExpression') {
		return node.properties.some((property) =>
			property.type === 'SpreadElement'
				? expressionCarriesSubscriptionData(property.argument, nodes, owner, seen)
				: expressionCarriesSubscriptionData(property.value, nodes, owner, seen));
	}
	if (node.type === 'ArrayExpression') {
		return node.elements.some((element) => expressionCarriesSubscriptionData(element, nodes, owner, seen));
	}
	if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return false;
	if (node.type === 'AssignmentExpression') return expressionCarriesSubscriptionData(node.right, nodes, owner, seen);
	if (node.type === 'ConditionalExpression') {
		return expressionCarriesSubscriptionData(node.consequent, nodes, owner, seen) ||
			expressionCarriesSubscriptionData(node.alternate, nodes, owner, seen);
	}
	if (node.type === 'SequenceExpression') {
		return expressionCarriesSubscriptionData(node.expressions.at(-1), nodes, owner, seen);
	}
	if (node.type === 'UnaryExpression' || node.type === 'BinaryExpression') {
		if (ORDER_COMPARISONS.has(node.operator) || ['===', '!==', '==', '!=', 'instanceof', 'in'].includes(node.operator)) return false;
		return childNodes(node).some((child) => expressionCarriesSubscriptionData(child, nodes, owner, seen));
	}
	return false;
}

function receiverKey(node, nodes, owner, seen = new Set()) {
	if (node?.type === 'ChainExpression') return receiverKey(node.expression, nodes, owner, seen);
	if (node?.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (!seen.has(key)) {
			const init = bindingInitializer(nodes, node.name, owner, node.start);
			if (init?.type === 'Identifier') {
				seen.add(key);
				return receiverKey(init, nodes, owner, seen);
			}
		}
		return `id:${node.name}`;
	}
	if (node?.type === 'MemberExpression') {
		return `member:${receiverKey(node.object, nodes, owner, seen)}:${String(propertyName(node))}`;
	}
	return `expr:${node?.start ?? '?'}:${node?.end ?? '?'}`;
}

function collectHasReceivers(node, nodes, owner, out = new Set(), seen = new Set()) {
	if (node === null || node === undefined) return out;
	if (node.type === 'Identifier') {
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (!seen.has(key)) {
			const init = bindingInitializer(nodes, node.name, owner, node.start);
			if (init !== null) {
				seen.add(key);
				collectHasReceivers(init, nodes, owner, out, seen);
				seen.delete(key);
			}
		}
	}
	if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && propertyName(node.callee) === 'has') {
		out.add(receiverKey(node.callee.object, nodes, owner));
	}
	for (const child of childNodes(node)) collectHasReceivers(child, nodes, owner, out, seen);
	return out;
}

function constantNumber(node, nodes, owner, seen = new Set()) {
	if (node?.type === 'Literal' && typeof node.value === 'number') return node.value;
	if (node?.type === 'Identifier') {
		if (node.name === 'MAX_SUBSCRIPTIONS_PER_CONNECTION') return SUBSCRIPTION_CAP;
		const key = `${owner?.start ?? 'top'}:${node.name}`;
		if (seen.has(key)) return null;
		const init = bindingInitializer(nodes, node.name, owner, node.start);
		if (init === null) return null;
		seen.add(key);
		const value = constantNumber(init, nodes, owner, seen);
		seen.delete(key);
		return value;
	}
	if (node?.type === 'UnaryExpression' && (node.operator === '+' || node.operator === '-')) {
		const value = constantNumber(node.argument, nodes, owner, seen);
		return value === null ? null : (node.operator === '-' ? -value : value);
	}
	if (node?.type !== 'BinaryExpression') return null;
	const left = constantNumber(node.left, nodes, owner, seen);
	const right = constantNumber(node.right, nodes, owner, seen);
	if (left === null || right === null) return null;
	switch (node.operator) {
		case '+': return left + right;
		case '-': return left - right;
		case '*': return left * right;
		case '/': return right === 0 ? null : left / right;
		case '%': return right === 0 ? null : left % right;
		case '**': return left ** right;
		case '<<': return left << right;
		case '>>': return left >> right;
		case '>>>': return left >>> right;
		case '|': return left | right;
		case '&': return left & right;
		case '^': return left ^ right;
		default: return null;
	}
}

function resolvedPolicyCallEntries(nodes, imports, fnName) {
	return nodes.filter(({ node }) =>
		node.type === 'CallExpression' && node.callee?.type === 'Identifier' && imports.get(node.callee.name) === fnName);
}

function expressionUsesSubscriptionSize(node, nodes, owner) {
	return expressionContains(node, (candidate) =>
		candidate.type === 'MemberExpression' && propertyName(candidate) === 'size' &&
		expressionContains(candidate.object, isSubscriptionSlot, nodes, owner), nodes, owner);
}

function expressionUsesAnySize(node, nodes, owner) {
	return expressionContains(node, (candidate) =>
		candidate.type === 'MemberExpression' && propertyName(candidate) === 'size', nodes, owner);
}

function hasLiveRateLimitExit(entry, nodes) {
	const { node, ancestors } = entry;
	const owner = nearestFunction(ancestors);
	const decision = ancestors.find((parent) => parent.type === 'IfStatement' && parent.test === node);
	if (decision === undefined) return false;
	const branchEntries = nodes.filter((candidate) =>
		candidate.node.start >= decision.consequent.start && candidate.node.end <= decision.consequent.end &&
		nearestFunction(candidate.ancestors) === owner && staticallyReachable(candidate));
	const hasReason = branchEntries.some(({ node: candidate }) => candidate.type === 'Literal' && candidate.value === 'RATE_LIMITED');
	const hasExit = branchEntries.some(({ node: candidate }) =>
		candidate.type === 'ReturnStatement' || candidate.type === 'ContinueStatement' || candidate.type === 'ThrowStatement');
	return hasReason && hasExit;
}

function capCallContractOffenders(nodes, imports, file = '(synthetic)') {
	const offenders = [];
	for (const entry of resolvedPolicyCallEntries(nodes, imports, 'exceedsSubscriptionCap')) {
		const { node, ancestors } = entry;
		const owner = nearestFunction(ancestors);
		const held = objectField(node.arguments[0], 'held');
		const size = objectField(node.arguments[0], 'size');
		const max = objectField(node.arguments[0], 'max');
		const where = `${file}:${node.loc.start.line}`;
		const sizeReceiver = size?.type === 'MemberExpression' && propertyName(size) === 'size'
			? exactSubscriptionRoot(size.object, nodes, owner)
			: null;
		if (sizeReceiver === null) {
			offenders.push(`${where} size must read the live WS_SUBSCRIPTIONS collection`);
		}
		if (held === null || sizeReceiver === null || !collectExactHasRoots(held, nodes, owner).has(sizeReceiver)) {
			offenders.push(`${where} held must derive from has(topic) on the same collection as size`);
		}
		if (max?.type !== 'Identifier' || max.name !== 'MAX_SUBSCRIPTIONS_PER_CONNECTION') {
			offenders.push(`${where} max must be the canonical subscription cap`);
		}
		if (!hasLiveRateLimitExit(entry, nodes)) {
			offenders.push(`${where} result must directly guard a live RATE_LIMITED exit`);
		}
	}
	return offenders;
}

function privateSubscriptionOrderOffenders(nodes, file = '(synthetic)') {
	const offenders = [];
	for (const entry of nodes) {
		const { node, ancestors } = entry;
		if (node.type !== 'BinaryExpression' || !ORDER_COMPARISONS.has(node.operator)) continue;
		const owner = nearestFunction(ancestors);
		if (expressionUsesExactSubscriptionSize(node.left, nodes, owner) || expressionUsesExactSubscriptionSize(node.right, nodes, owner)) {
			offenders.push(`${file}:${node.loc.start.line}`);
		}
	}
	return offenders;
}

const SAFE_SUBSCRIPTION_CALLEES = new Set([
	'addLogicalSubscription',
	'removeLogicalSubscription',
	'accountClosedLogicalSubscriptions',
	'deniesUngrantedObserve'
]);

function importedMembershipMutators(nodes, file) {
	const allowed = new Set();
	for (const { node } of nodes) {
		if (node.type !== 'ImportDeclaration') continue;
		const target = resolvedImport(file, node.source?.value);
		if (target !== realpathSync(pathOf('src/runtime/utils.js')) &&
			target !== realpathSync(pathOf('src/runtime/utils/ws-symbols.js'))) continue;
		for (const specifier of node.specifiers) {
			if (specifier.type === 'ImportSpecifier' && specifier.local.name === specifier.imported.name &&
				SAFE_SUBSCRIPTION_CALLEES.has(specifier.imported.name)) allowed.add(specifier.local.name);
		}
	}
	return allowed;
}

function subscriptionDataEscapeOffenders(nodes, imports, file = '(synthetic)') {
	const offenders = [];
	const allowedMutators = file === '(synthetic)' ? new Set() : importedMembershipMutators(nodes, file);
	const candidateNames = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		for (const { node } of nodes) {
			if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier' || node.init === null ||
				candidateNames.has(node.id.name)) continue;
			const carriesCandidate = (() => {
				const pending = [node.init];
				while (pending.length) {
					const current = pending.pop();
					if (current?.type === 'FunctionExpression' || current?.type === 'ArrowFunctionExpression') continue;
					if (current?.type === 'MemberExpression' && isSubscriptionSlot(current.property)) return true;
					if (current?.type === 'Identifier' && candidateNames.has(current.name)) return true;
					pending.push(...childNodes(current));
				}
				return false;
			})();
			if (carriesCandidate) {
				candidateNames.add(node.id.name);
				changed = true;
			}
		}
	}
	for (const { node, ancestors } of nodes) {
		if (node.type !== 'CallExpression') continue;
		const canonicalPolicy = node.callee?.type === 'Identifier' &&
			(imports.get(node.callee.name) === 'exceedsSubscriptionCap' ||
				imports.get(node.callee.name) === 'deniesUngrantedObserve');
		const canonicalMutator = node.callee?.type === 'Identifier' && SAFE_SUBSCRIPTION_CALLEES.has(node.callee.name) &&
			(allowedMutators.has(node.callee.name) || file === 'src/runtime/utils/ws-symbols.js');
		if (canonicalPolicy || canonicalMutator) continue;
		const possible = node.arguments.some((argument) => {
			const pending = [argument];
			while (pending.length) {
				const current = pending.pop();
				if (current?.type === 'FunctionExpression' || current?.type === 'ArrowFunctionExpression') continue;
				if (current?.type === 'MemberExpression' && isSubscriptionSlot(current.property)) return true;
				if (current?.type === 'Identifier' && candidateNames.has(current.name)) return true;
				pending.push(...childNodes(current));
			}
			return false;
		});
		if (!possible) continue;
		const owner = nearestFunction(ancestors);
		if (node.arguments.some((argument) => expressionCarriesSubscriptionData(argument, nodes, owner))) {
			offenders.push(`${file}:${node.loc.start.line}`);
		}
	}
	return offenders;
}

function capEquivalentSizeComparisonOffenders(nodes, file = '(synthetic)', cap = SUBSCRIPTION_CAP) {
	const offenders = [];
	for (const entry of nodes) {
		const { node, ancestors } = entry;
		if (node.type !== 'BinaryExpression' || !ORDER_COMPARISONS.has(node.operator)) continue;
		const owner = nearestFunction(ancestors);
		const leftSize = expressionUsesAnySize(node.left, nodes, owner);
		const rightSize = expressionUsesAnySize(node.right, nodes, owner);
		const leftValue = constantNumber(node.left, nodes, owner);
		const rightValue = constantNumber(node.right, nodes, owner);
		if ((leftSize && rightValue === cap) || (rightSize && leftValue === cap)) offenders.push(`${file}:${node.loc.start.line}`);
	}
	return offenders;
}

/**
 * Calls to `fnName` whose callee resolves to the policy import.
 *
 * A bare identifier that is NOT the imported local name does not count, so a
 * local shadow scores zero rather than satisfying the minimum. Text in a
 * comment scores zero because comments are not nodes.
 */
function realCallCount(nodes, imports, fnName, reachable) {
	let local = null;
	for (const [localName, imported] of imports) if (imported === fnName) local = localName;
	if (local === null) return 0;
	let n = 0;
	for (const entry of nodes) {
		const { node, ancestors } = entry;
		if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier' || node.callee.name !== local) continue;
		const owner = nearestFunction(ancestors);
		if (owner !== null && !reachable.has(owner)) continue;
		if (!staticallyReachable(entry)) continue;
		if (resultIsConsumed(entry, nodes)) n++;
	}
	return n;
}

const parsed = new Map();
/** @param {string} f */
function ast(f) {
	if (!parsed.has(f)) {
		const nodes = nodesWithAncestors(read(f));
		parsed.set(f, { nodes, imports: policyImports(nodes, f), locals: localBindings(nodes), reachable: reachableFunctions(nodes) });
	}
	return parsed.get(f);
}

describe('the oracle itself rejects the padding classes found by review', () => {
	it('finds policy-name shadows in parameters and destructuring patterns', () => {
		const nodes = nodesWithAncestors(`
			function shadow({ deniesWireSubscribePreHook }, [recoverIsRevoked], exceedsSubscriptionCap) {
				return { deniesWireSubscribePreHook, recoverIsRevoked, exceedsSubscriptionCap };
			}
		`);
		const bindings = localBindings(nodes);
		expect([...bindings].filter((name) => POLICY_NAMES.includes(name)).sort()).toEqual([
			'deniesWireSubscribePreHook',
			'exceedsSubscriptionCap',
			'recoverIsRevoked'
		]);
	});

	it('counts only reachable, consumed calls and rejects decorative or constant-dead padding', () => {
		const nodes = nodesWithAncestors(`
			export function live(value) {
				if (predicate(value)) return true;
			}
			function parked(value) {
				predicate(value);
			}
			export function padded(value) {
				if (false) {
					if (predicate(value)) return true;
				}
				predicate(value);
				return false;
			}
			export function afterReturn(value) {
				return false;
				if (predicate(value)) return true;
			}
		`);
		const imports = new Map([['predicate', 'deniesWireSubscribePreHook']]);
		expect(realCallCount(nodes, imports, 'deniesWireSubscribePreHook', reachableFunctions(nodes))).toBe(1);
	});

	it('rejects the reviewed inert cap call plus constant-expression private decision', () => {
		const nodes = nodesWithAncestors(`
			export function subscribe(ud, topic) {
				const subs = ud[WS_SUBSCRIPTIONS];
				const isNew = !subs.has(topic);
				if (exceedsSubscriptionCap({ held: true, size: 0, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) {
					throw new Error('padding');
				}
				if (isNew && subs.size >= (10 ** 6)) return 'RATE_LIMITED';
			}
		`);
		const imports = new Map([['exceedsSubscriptionCap', 'exceedsSubscriptionCap']]);
		expect(realCallCount(nodes, imports, 'exceedsSubscriptionCap', reachableFunctions(nodes))).toBe(1);
		expect(capCallContractOffenders(nodes, imports)).not.toEqual([]);
		expect(privateSubscriptionOrderOffenders(nodes)).toHaveLength(1);
		expect(capEquivalentSizeComparisonOffenders(nodes)).toHaveLength(1);
	});

	it('follows folded thresholds and count aliases without banning unrelated or empty checks', () => {
		const folded = nodesWithAncestors(`
			export function subscribe(ud, topic) {
				const subs = ud[WS_SUBSCRIPTIONS];
				const held = subs.has(topic);
				const base = 10;
				const foldedCap = base ** 6;
				const count0 = subs.size;
				const count = count0;
				if (foldedCap <= count) return 'RATE_LIMITED';
				const { size: destructuredCount } = subs;
				let assignedCount = 0;
				assignedCount = destructuredCount;
				if (assignedCount >= foldedCap) return 'RATE_LIMITED';
				if (exceedsSubscriptionCap({ held, size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
			}
		`);
		const imports = new Map([['exceedsSubscriptionCap', 'exceedsSubscriptionCap']]);
		expect(privateSubscriptionOrderOffenders(folded)).toHaveLength(2);
		expect(capEquivalentSizeComparisonOffenders(folded)).toHaveLength(2);
		expect(capCallContractOffenders(folded, imports)).toEqual([]);

		const legitimate = nodesWithAncestors(`
			export function subscribe(ud, topic, queue) {
				const subs = ud[WS_SUBSCRIPTIONS];
				if (subs.size === 0) return null;
				if (queue.size > 10) return 'QUEUE_FULL';
				if (exceedsSubscriptionCap({ held: subs.has(topic), size: subs.size, max: MAX_SUBSCRIPTIONS_PER_CONNECTION })) return 'RATE_LIMITED';
			}
		`);
		expect(privateSubscriptionOrderOffenders(legitimate)).toEqual([]);
		expect(capEquivalentSizeComparisonOffenders(legitimate)).toEqual([]);
		expect(capCallContractOffenders(legitimate, imports)).toEqual([]);
	});

	it('rejects object laundering and opaque helper escapes of the live Set or its size', () => {
		const nodes = nodesWithAncestors(`
			const thresholdParts = { base: 4, power: 2 };
			export function subscribe(ud, topic) {
				const subs = ud[WS_SUBSCRIPTIONS];
				const capOracleView = { original: subs, has() { return true; }, size: 0 };
				if (exceedsSubscriptionCap({
					held: capOracleView.has(topic),
					size: capOracleView.size,
					max: MAX_SUBSCRIPTIONS_PER_CONNECTION
				})) return 'RATE_LIMITED';
				if (privateSubscriptionCapReached(subs.size)) return 'RATE_LIMITED';
			}
			export function privateSubscriptionCapReached(count) {
				return count >= thresholdParts.base ** thresholdParts.power;
			}
		`);
		const imports = new Map([['exceedsSubscriptionCap', 'exceedsSubscriptionCap']]);
		expect(capCallContractOffenders(nodes, imports)).not.toEqual([]);
		expect(subscriptionDataEscapeOffenders(nodes, imports)).not.toEqual([]);

		const wholeSet = nodesWithAncestors(`
			export function subscribe(ud) {
				const subs = ud[WS_SUBSCRIPTIONS];
				return privateSubscriptionCapReached({ original: subs });
			}
		`);
		expect(subscriptionDataEscapeOffenders(wholeSet, new Map())).not.toEqual([]);
	});
});

describe('every socket surface routes its subscribe decisions through the shared policy', () => {
	it('only the canonical policy module exports the policy decisions', () => {
		const exporters = new Map(POLICY_NAMES.map((name) => [name, []]));
		const policyPath = realpathSync(pathOf(POLICY));
		for (const file of jsFiles('src')) {
			for (const name of exportedPolicyNames(ast(file).nodes)) exporters.get(name).push(file);
			// `export * from './subscribe-policy.js'` names no specifier, so
			// the specifier walk cannot see it - yet it republishes every
			// policy name the target owns. A barrel by another spelling.
			if (file === POLICY) continue;
			for (const { target } of starReexportedPolicySources(ast(file).nodes, file)) {
				if (target !== policyPath) continue;
				for (const name of POLICY_NAMES) exporters.get(name).push(file);
			}
		}
		for (const name of POLICY_NAMES) {
			expect(
				exporters.get(name),
				`${name} must be exported by exactly the canonical policy module; a second exporter restores a private policy copy`
			).toEqual([POLICY]);
		}
	});

	for (const { label, files } of SURFACES) {
		it(`${label} imports the policy through a real import, unaliased`, () => {
			const importing = files.filter((f) => ast(f).imports.size > 0);
			expect(
				importing.length,
				`${label} must have an ImportDeclaration from subscribe-policy.js in one of ${files.join(', ')} - ` +
				'a mention in a comment is not an import, and that is exactly how this check was defeated before'
			).toBeGreaterThan(0);

			// Aliasing would put every name-keyed rule below out of reach.
			for (const f of files) {
				const aliased = [...ast(f).imports.entries()].filter(([localName, imported]) => localName !== imported);
				expect(aliased, `${f} aliases a policy import: ${aliased.map(([l, i]) => `${i} as ${l}`).join(', ')}`).toEqual([]);
			}
		});

		it(`${label} does not redeclare a policy name in any binding position`, () => {
			// A local `function exceedsSubscriptionCap(...)` would satisfy every
			// call count while the real decision never runs. This is the shape a
			// reviewer used to give the dev surface private copies of all five.
			for (const f of files) {
				const { locals } = ast(f);
				const shadowed = POLICY_NAMES.filter((n) => locals.has(n));
				expect(
					shadowed,
					`${f} declares its own ${shadowed.join(', ')} - the surface would be asking itself, not the policy`
				).toEqual([]);
			}
		});
	}

	for (const file of SHARED) {
		it(`${file} does not redeclare a policy name in any binding position`, () => {
			const shadowed = POLICY_NAMES.filter((name) => ast(file).locals.has(name));
			expect(
				shadowed,
				`${file} declares its own ${shadowed.join(', ')} instead of asking the canonical policy`
			).toEqual([]);
		});
	}

	// COUNTS, not presence - and REAL calls, not text. v1 asserted only that a
	// surface contained a call to each predicate, and one call in the single
	// lane satisfied it while three other lanes had none.
	//
	// The numbers are the counts the lanes actually have. Raise them when a
	// surface gains a lane; NEVER lower one to clear a red - a red here means a
	// lane stopped asking, which is the whole point of the file.
	const PREDICATE_MINIMUMS = [
		{ fn: 'deniesWireSystemTopicSubscribe', min: 2 }, // single + batch
		{ fn: 'deniesWireSubscribePreHook', min: 2 },   // single + batch
		{ fn: 'deniesWireSubscribeLanding', min: 2 },
		{ fn: 'wantsRecover', min: 2 },
		{ fn: 'recoverIsRevoked', min: 2 },
		{ fn: 'exceedsSubscriptionCap', min: 5 }        // 2 wire + 1 batch + 2 platform.subscribe
	];

	for (const { label, files } of SURFACES) {
		for (const { fn, min } of PREDICATE_MINIMUMS) {
			it(`${label} really calls ${fn} at least ${min}x`, () => {
				const n = files.reduce((acc, f) => {
					const { nodes, imports, reachable } = ast(f);
					return acc + realCallCount(nodes, imports, fn, reachable);
				}, 0);
				expect(
					n,
					`${label} has ${n} RESOLVED call(s) to ${fn} across ${files.join(', ')}, expected >= ${min}. ` +
					'Only a reachable call whose callee is the canonical imported binding and whose result reaches ' +
					'control flow counts - comments, parked helpers, decorative calls and local shadows do not.'
				).toBeGreaterThanOrEqual(min);
			});
		}
	}

	// A resolved call with an omitted axis is still a private re-definition of
	// the policy: `topic` omitted from the plugin landing makes its membership
	// proof vanish, while all call-count checks remain green. Pin the complete
	// object contract at every call site, not merely the callee name.
	const REQUIRED_POLICY_FIELDS = [
		{ fn: 'deniesWireSystemTopicSubscribe', fields: ['allowSystem', 'topic'] },
		{ fn: 'deniesWireSubscribeLanding', fields: ['armed', 'hasUserHook', 'held', 'topic'] },
		{ fn: 'recoverIsRevoked', fields: ['held', 'wireAuthz', 'cancelled', 'topic'] }
	];
	for (const { label, files } of SURFACES) {
		for (const { fn, fields } of REQUIRED_POLICY_FIELDS) {
			it(`${label} passes every ${fn} policy axis`, () => {
				const offenders = [];
				for (const file of files) {
					const { nodes, imports } = ast(file);
					for (const { node } of nodes) {
						if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') continue;
						if (imports.get(node.callee.name) !== fn) continue;
						const arg = node.arguments[0];
						const present = new Set(
							arg?.type === 'ObjectExpression'
								? arg.properties.map((p) => p.key?.name ?? p.key?.value)
								: []
						);
						const missing = fields.filter((field) => !present.has(field));
						if (missing.length) offenders.push(`${file}:${node.loc.start.line} missing ${missing.join(', ')}`);
					}
				}
				expect(
					offenders,
					`${fn} calls must pass the full shared-policy contract: ${offenders.join('; ')}`
				).toEqual([]);
			});
		}
	}

	// The enrolment machinery is the revocation guard rather than a policy
	// decision, so it is counted by name across the surface's files. These are
	// the REAL counts, asserted as EQUALITY: the previous global minimum of 11
	// carried two of slack on production and testing, and a reviewer deleted the
	// batch lane's revocation guard outright while this file stayed green; a
	// floor also stays green when a NEW enroller appears without its own
	// settle discipline, which is precisely how the observer lane in
	// ws-symbols.js shipped without the held seed or a denial-exit reading. An
	// exact count forces every added or removed call site through this table.
	// The held-at-landing branches settle through settleHeldSubscribe - the
	// plain settle cannot read the membership's provenance there - and the
	// hook-DENIAL exits settle through settleDeniedSubscribe, which answers
	// whether a membership the denied attempt installed mid-window must be
	// unwound. All three spellings are pinned, because a lane that reverts to
	// the plain settle at either branch loses its provenance reading silently
	// and stays green otherwise.
	//
	// The shared row is the enrolment that lives OUTSIDE the surfaces: the
	// observer lane (authorizeDerivedSubscribe) begins, settles and reads its
	// denial provenance in ws-symbols.js itself, and trackedUnsubscribe
	// tombstones there. The per-surface rows cannot see it, so it is counted
	// where it lives.
	const ENROLMENT = [
		{ fn: 'beginPendingSubscribe', production: 3, testing: 3, dev: 3, shared: 1 },
		{ fn: 'settlePendingSubscribe', production: 7, testing: 6, dev: 6, shared: 1 },
		{ fn: 'settleHeldSubscribe', production: 4, testing: 4, dev: 4, shared: 1 },
		{ fn: 'settleDeniedSubscribe', production: 3, testing: 3, dev: 3, shared: 1 },
		{ fn: 'tombstonePendingSubscribe', production: 2, testing: 2, dev: 2, shared: 1 }
	];
	const KEY = {
		production: 'production',
		'the in-process test server': 'testing',
		'the dev plugin': 'dev',
		'the shared enrolment primitive': 'shared'
	};
	const ENROLMENT_GROUPS = [
		...SURFACES,
		{ label: 'the shared enrolment primitive', files: ['src/runtime/utils/ws-symbols.js'] }
	];

	for (const { label, files } of ENROLMENT_GROUPS) {
		for (const entry of ENROLMENT) {
			const want = entry[KEY[label]];
			it(`${label} really calls ${entry.fn} exactly ${want}x`, () => {
				const n = files.reduce((acc, f) => {
					const { nodes } = ast(f);
					let c = 0;
					for (const { node } of nodes) {
						if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === entry.fn) c++;
					}
					return acc + c;
				}, 0);
				expect(
					n,
					`${label} has ${n} resolved call(s) to ${entry.fn}, expected exactly ${want} - either a lane ` +
					'lost its enrolment/settle, or an enroller was added without updating this table (and a new ' +
					'enroller must seed held at creation and read settleDeniedSubscribe at its denial exit)'
				).toBe(want);
			});
		}
	}
});

describe('every observer lane revalidates its grant after the async hook', () => {
	const observerSurfaces = [
		{ label: 'production', file: 'src/runtime/handler/platform.js' },
		{ label: 'the in-process test server', file: 'src/testing.js' },
		{ label: 'the dev plugin', file: 'src/vite.js' }
	];

	for (const { label, file } of observerSurfaces) {
		it(`${label} asks deniesUngrantedObserve before and after its await`, () => {
			const { nodes } = ast(file);
			const imports = [];
			for (const { node } of nodes) {
				if (node.type !== 'ImportDeclaration') continue;
				for (const spec of node.specifiers || []) {
					if (spec.type === 'ImportSpecifier' && spec.imported?.name === 'deniesUngrantedObserve') {
						imports.push(spec);
					}
				}
			}
			expect(imports, `${file} must import the shared observer decision exactly once`).toHaveLength(1);
			expect(
				imports[0].local.name,
				`${file} must not alias the shared observer decision`
			).toBe('deniesUngrantedObserve');

			const methods = nodes
				.map(({ node }) => node)
				.filter((node) => node.type === 'Property' &&
					(node.key?.name ?? node.key?.value) === 'checkSubscribe' &&
					node.value?.type === 'FunctionExpression');
			expect(methods, `${file} must expose exactly one checkSubscribe method`).toHaveLength(1);
			const method = methods[0].value;
			const calls = nodes
				.filter(({ node, ancestors }) =>
					node.type === 'CallExpression' &&
					node.callee?.type === 'Identifier' &&
					node.callee.name === 'deniesUngrantedObserve' &&
					ancestors.includes(method))
				.map(({ node }) => node);
			const awaits = nodes
				.filter(({ node, ancestors }) => node.type === 'AwaitExpression' && ancestors.includes(method))
				.map(({ node }) => node);

			expect(
				calls,
				`${file} must check the observer grant once before and once after the hook await`
			).toHaveLength(2);
			expect(awaits, `${file} checkSubscribe should have one authorization await`).toHaveLength(1);
			expect(calls[0].start).toBeLessThan(awaits[0].start);
			expect(calls[1].start).toBeGreaterThan(awaits[0].end);
		});
	}
});

describe('no surface re-derives a decision the policy owns', () => {
	const SCANNED = [...SURFACES.flatMap((s) => s.files), ...SHARED];
	const CAP_DECISION_FILES = jsFiles('src');

	for (const { label, files } of SURFACES) {
		it(`${label} gives every cap call live membership axes and a decisive rate-limit exit`, () => {
			const offenders = files.flatMap((file) => {
				const { nodes, imports } = ast(file);
				return capCallContractOffenders(nodes, imports, file);
			});
			expect(
				offenders,
				`${label} can pad the call count with a semantically inert cap decision: ${offenders.join('; ')}`
			).toEqual([]);
		});

		it(`${label} has no private ordered decision driven by subscription membership size`, () => {
			const offenders = files.flatMap((file) => privateSubscriptionOrderOffenders(ast(file).nodes, file));
			expect(
				offenders,
				`${label} compares WS_SUBSCRIPTIONS size outside exceedsSubscriptionCap: ${offenders.join(', ')}`
			).toEqual([]);
		});
	}

	it('no shipped module reconstructs the cap through a folded size comparison', () => {
		const offenders = CAP_DECISION_FILES.flatMap((file) =>
			capEquivalentSizeComparisonOffenders(ast(file).nodes, file, SUBSCRIPTION_CAP));
		expect(
			offenders,
			`a helper rebuilt the million-subscription decision under a constant expression: ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('no shipped module holds a private ordered decision on subscription membership size', () => {
		// The surface-scoped rule above cannot see a helper the surface hands
		// its userData to: `const ud = ws.getUserData()` then
		// `ud[WS_SUBSCRIPTIONS].size >= 500` in any src file was invisible to
		// every rule (the repo-wide rule is value-specific to the cap constant,
		// and the escape tracker has no CallExpression branch). This rule is
		// threshold-agnostic and repo-wide, so a private cap of ANY value in
		// ANY shipped module is an offense, wherever the Set came from.
		const offenders = CAP_DECISION_FILES.flatMap((file) =>
			privateSubscriptionOrderOffenders(ast(file).nodes, file));
		expect(
			offenders,
			`a shipped module compares WS_SUBSCRIPTIONS size outside exceedsSubscriptionCap: ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('the shared plugin lane holds no private ordered decision either', () => {
		// trackedSubscribe in the shared symbols module makes the same cap
		// call the three surfaces make. Its exit shape is a boolean refusal
		// rather than a wire RATE_LIMITED denial, so the surface call
		// contract does not apply verbatim; the inert-call mutation for this
		// lane is owned behaviourally by the grant-model suite, which drives
		// trackedSubscribe at the cap, at the cap while holding the topic,
		// and one below it. What must hold statically here is the same
		// no-private-threshold rule the surfaces carry.
		const offenders = SHARED.flatMap((file) =>
			privateSubscriptionOrderOffenders(ast(file).nodes, file));
		expect(
			offenders,
			`a shared module compares WS_SUBSCRIPTIONS size outside exceedsSubscriptionCap: ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('no socket decision module sends the live subscription Set or its size to an opaque callee', () => {
		const offenders = SCANNED.flatMap((file) => {
			const { nodes, imports } = ast(file);
			return subscriptionDataEscapeOffenders(nodes, imports, file);
		});
		expect(
			offenders,
			`an opaque helper can hide a private or changed cap after subscription data escapes: ${offenders.join(', ')}`
		).toEqual([]);
	});

	// THE CAP. The constant may be imported, and READ only as the `max` property
	// of an `exceedsSubscriptionCap` argument. Anything else is a surface
	// computing the answer itself, whatever the spelling - `>=`, `> max - 1`,
	// operands swapped, a hoisted local, or wrapped across lines.
	//
	// Note `max:` specifically, not "anywhere inside the call": the previous
	// version exempted any node nested in an argument, which let a reviewer
	// smuggle the whole comparison in as a different property -
	// `exceedsSubscriptionCap({ held: subs.size >= MAX_..., size: 0, max: 1 })`.
	for (const file of CAP_DECISION_FILES) {
		it(`${file} reads the subscription cap only as exceedsSubscriptionCap's max`, () => {
			const { nodes, imports } = ast(file);
			let capLocal = 'MAX_SUBSCRIPTIONS_PER_CONNECTION';
			const offenders = [];
			for (const { node, ancestors } of nodes) {
				if (node.type === 'ImportSpecifier' && node.imported?.name === capLocal && node.local?.name !== capLocal) {
					offenders.push(`${file}:${node.loc.start.line} (aliased import)`);
					continue;
				}
				if (node.type !== 'Identifier' || node.name !== capLocal) continue;
				if (ancestors.some((a) => a.type === 'ImportDeclaration' || a.type === 'ExportNamedDeclaration')) continue;
				// caps.js is where it is declared.
				if (ancestors.some((a) => a.type === 'VariableDeclarator' && a.id === node)) continue;
				const prop = ancestors[0];
				const isMaxValue = prop?.type === 'Property' && prop.value === node && prop.key?.name === 'max';
				const call = ancestors.find((a) => a.type === 'CallExpression');
				const inPolicyCall = isMaxValue && call?.callee?.type === 'Identifier' &&
					imports.get(call.callee.name) === 'exceedsSubscriptionCap';
				if (!inPolicyCall) offenders.push(`${file}:${node.loc.start.line}`);
			}
			expect(
				offenders,
				`the per-connection cap belongs to exceedsSubscriptionCap, which scopes it to a topic the socket ` +
				`does not already hold - these references re-derive it: ${offenders.join(', ')}`
			).toEqual([]);
		});
	}

	// Banning only the constant NAME left the same decision available under a
	// local spelling: `const cap = 1_000_000; if (subs.size >= cap)`. The shared
	// caps module legitimately contains several independent one-million bounds;
	// every consumer module must receive this one through the named import.
	for (const file of SCANNED.filter((candidate) => candidate !== 'src/runtime/utils/caps.js')) {
		it(`${file} does not re-declare the subscription cap value`, () => {
			const offenders = ast(file).nodes
				.filter(({ node }) => node.type === 'Literal' && node.value === SUBSCRIPTION_CAP)
				.map(({ node }) => `${file}:${node.loc.start.line}`);
			expect(
				offenders,
				`the reviewed cap value must enter through MAX_SUBSCRIPTIONS_PER_CONNECTION, not a local copy: ${offenders.join(', ')}`
			).toEqual([]);
		});
	}

	// The cap's VALUE, not merely its shape. The rule above is the ONLY defence
	// this decision has - the cap is 1,000,000, so no behavioural test can reach
	// it - and asserting only "a finite number above zero" left the constant
	// itself as the way to disable it: raising caps.js to a number no connection
	// can ever hit removes the limit while every other rule in this file stays
	// green. Moving the cap is a deliberate act and must move this line with it.
	it('the cap constant is one numeric literal, pinned at its reviewed value', async () => {
		const src = read('src/runtime/utils/caps.js');
		const declared = [...src.matchAll(/export const MAX_SUBSCRIPTIONS_PER_CONNECTION\s*=\s*([^;]+);/g)];
		expect(
			declared.map((d) => d[1].trim()),
			'caps.js must declare MAX_SUBSCRIPTIONS_PER_CONNECTION exactly once - a second declaration is what a ' +
			'source-level pin cannot see past'
		).toHaveLength(1);

		const literal = declared[0][1].trim();
		// A literal, so the value is readable HERE. `Number.MAX_SAFE_INTEGER`,
		// `Infinity` and `1e9` all satisfy "finite number above zero" while
		// putting the cap out of reach of anything.
		expect(literal, 'the cap must be a plain numeric literal, not an expression').toMatch(/^[0-9][0-9_]*$/);
		expect(Number(literal.replace(/_/g, '')), 'the per-connection subscription cap moved').toBe(SUBSCRIPTION_CAP);

		// And what the runtime LOADS, so a re-export or a shadowing module cannot
		// leave the source pinned while the surfaces read something else.
		const caps = await import('../src/runtime/utils/caps.js');
		expect(
			caps.MAX_SUBSCRIPTIONS_PER_CONNECTION,
			'the value caps.js exports disagrees with the literal it declares'
		).toBe(SUBSCRIPTION_CAP);
	});

	// THE PLUGIN CARVE-OUT. It stands the wire gate aside, and is safe only
	// because deniesWireSubscribeLanding re-tests real membership behind it. A
	// surface applying it builds its own exemption with nothing guaranteed to
	// re-check - which, on the observer gate and the client-named resume filter,
	// served a private group's buffered history to any client that named it.
	for (const file of SCANNED) {
		it(`${file} does not apply the plugin-owned carve-out itself`, () => {
			const { nodes } = ast(file);
			const offenders = [];
			for (const { node, ancestors } of nodes) {
				// Same aliased-import ban the cap rule has: `import
				// { isPluginOwnedTopic as _owned }` reintroduced the historical
				// hole at the batch landing while every rule stayed green.
				if (node.type === 'ImportSpecifier' && node.imported?.name === 'isPluginOwnedTopic') {
					if (node.local?.name !== 'isPluginOwnedTopic') offenders.push(`${file}:${node.loc.start.line} (aliased import)`);
					continue;
				}
				if (node.type !== 'Identifier' || node.name !== 'isPluginOwnedTopic') continue;
				if (ancestors.some((a) => a.type === 'ImportDeclaration' || a.type === 'ExportNamedDeclaration')) continue;
				offenders.push(`${file}:${node.loc.start.line}`);
			}
			expect(
				offenders,
				`the plugin-owned carve-out belongs to deniesWireSubscribePreHook and must not be applied in a lane ` +
				`with no landing re-check behind it: ${offenders.join(', ')}`
			).toEqual([]);
		});
	}

	it('the policy module still spells the decisions out', () => {
		// A guard for the guard: if the policy module stopped containing the
		// decisions, every rule above would pass vacuously against three surfaces
		// asking an empty module.
		const src = read(POLICY);
		for (const fn of POLICY_NAMES) {
			expect(src, `${POLICY} must still export ${fn}`).toContain(`export function ${fn}(`);
		}
		expect(src, 'the cap decision must live here').toContain('size >= max');
		expect(src, 'the carve-out must live here').toContain('isPluginOwnedTopic(topic)');
	});
});
