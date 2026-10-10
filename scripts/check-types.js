#!/usr/bin/env node
/**
 * Validate that the package's public surface is intact.
 *
 * For every subpath in the `exports` map (and the top-level
 * `types`/`main`/`module` fields) this asserts that:
 *   1. the target file exists on disk;
 *   2. a `types`/`typings` condition points at a real `.d.ts`;
 *   3. the target is covered by the `files` publish allowlist, so it actually
 *      ships (a file that resolves locally but is missing from `files` 404s
 *      after publish).
 *
 * It guards the drift class where an `exports` entry points at a missing or
 * mistyped declaration (silently degrading consumers to `any`) or a file that
 * never gets published. It uses the development TypeScript parser without
 * executing package code. Run via `npm run check`; wired
 * into `pretest` so the unit run enforces it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const rootArg = process.argv.indexOf('--root');
if (rootArg !== -1 && !process.argv[rootArg + 1]) {
	console.error('check-types: --root requires a package directory');
	process.exit(1);
}
const root = rootArg === -1
	? resolve(dirname(fileURLToPath(import.meta.url)), '..')
	: resolve(process.argv[rootArg + 1]);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const errors = [];
const checked = [];

const TYPE_CONDITIONS = new Set(['types', 'typings']);
const filesHasGlob = Array.isArray(pkg.files) && pkg.files.some((e) => /[*?{}[\]!]/.test(e));

function exists(rel) {
	return existsSync(join(root, rel.replace(/^\.\//, '')));
}

// True when a target is included by the `files` allowlist. Skipped (treated as
// covered) when there is no allowlist or it uses globs we will not try to model.
function isPublished(target) {
	if (!Array.isArray(pkg.files) || filesHasGlob) return true;
	const norm = target.replace(/^\.\//, '');
	return pkg.files.some((entry) => {
		const e = entry.replace(/^\.\//, '').replace(/\/$/, '');
		return norm === e || norm.startsWith(e + '/');
	});
}

function checkTarget(label, condition, target) {
	if (typeof target !== 'string') return;
	const ok = exists(target);
	checked.push({ label, condition, target, ok });
	if (!ok) {
		errors.push(`${label} (${condition}): target does not exist -> ${target}`);
		return;
	}
	if (TYPE_CONDITIONS.has(condition) && !target.endsWith('.d.ts')) {
		errors.push(`${label} (${condition}): a type condition must point at a .d.ts -> ${target}`);
	}
	if (!isPublished(target)) {
		errors.push(`${label} (${condition}): resolves locally but is not in the "files" publish allowlist -> ${target}`);
	}
}

// An exports value object is a conditions map when no key starts with '.'; a
// key starting with '.' marks a nested subpath. Walk handles both, plus the
// string shorthand and conditions nested under conditions.
function isConditions(obj) {
	return Object.keys(obj).every((k) => !k.startsWith('.'));
}

function walk(subpath, value) {
	if (typeof value === 'string') {
		checkTarget(subpath, 'default', value);
		return;
	}
	if (!value || typeof value !== 'object') return;
	if (isConditions(value)) {
		for (const [condition, target] of Object.entries(value)) {
			if (typeof target === 'string') checkTarget(subpath, condition, target);
			else walk(subpath, target);
		}
	} else {
		for (const [seg, sub] of Object.entries(value)) {
			walk(subpath === '.' ? seg : subpath + seg.replace(/^\./, ''), sub);
		}
	}
}

if (pkg.exports && typeof pkg.exports === 'object') {
	if (isConditions(pkg.exports)) walk('.', pkg.exports);
	else for (const [subpath, value] of Object.entries(pkg.exports)) walk(subpath, value);
} else if (typeof pkg.exports === 'string') {
	checkTarget('.', 'default', pkg.exports);
}

for (const field of ['types', 'typings']) {
	if (typeof pkg[field] === 'string') checkTarget(`(package.${field})`, 'types', pkg[field]);
}
for (const field of ['main', 'module']) {
	if (typeof pkg[field] === 'string') checkTarget(`(package.${field})`, 'default', pkg[field]);
}

// Read both sides from syntax trees. In particular, follow bare star exports
// instead of treating them as an empty runtime or declaration surface.
const modules = new Map();
const ambiguous = Symbol('ambiguous export');
const resolutionOptions = {
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	allowJs: true
};
// Runtime resolution must never substitute a declaration for JavaScript.
const runtimeHost = { ...ts.sys, fileExists: (path) => !/\.(?:d\.)?[cm]?tsx?$/.test(path) && ts.sys.fileExists(path) };

function resolveReexport(specifier, from, declarations) {
	if (!declarations && specifier.startsWith('.')) {
		const path = resolve(dirname(from), specifier);
		if (existsSync(path)) return path;
	} else {
		const result = ts.resolveModuleName(specifier, from, resolutionOptions,
			declarations ? ts.sys : runtimeHost, undefined, undefined, ts.ModuleKind.ESNext);
		if (result.resolvedModule) return result.resolvedModule.resolvedFileName;
	}
	errors.push(`${from}: cannot resolve ${declarations ? 'declaration' : 'runtime'} re-export ${specifier}`);
	return null;
}

function bindingNames(name, output) {
	if (ts.isIdentifier(name)) output.push(name.text);
	else for (const element of name.elements) {
		if (!ts.isOmittedExpression(element)) bindingNames(element.name, output);
	}
}

function readModule(file, declarations) {
	const key = `${declarations}:${resolve(file)}`;
	if (modules.has(key)) return modules.get(key);
	const module = { key, explicit: new Map(), imports: new Map(), stars: [] };
	modules.set(key, module);
	let source;
	try { source = readFileSync(file, 'utf8'); }
	catch { errors.push(`${file}: cannot be read to compare exports`); return module; }
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
		declarations ? ts.ScriptKind.TS : ts.ScriptKind.JS);
	for (const diagnostic of ast.parseDiagnostics) {
		errors.push(`${file}: cannot be parsed to read its exports - ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
	}
	const target = (specifier) => {
		const path = resolveReexport(specifier.text, file, declarations);
		return path ? readModule(path, declarations) : null;
	};
	for (const node of ast.statements) {
		if (ts.isExportDeclaration(node)) {
			if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
				module.explicit.set(node.exportClause.name.text, { namespace: target(node.moduleSpecifier) });
			} else if (node.exportClause) {
				const from = node.moduleSpecifier ? target(node.moduleSpecifier) : null;
				for (const entry of node.exportClause.elements) {
					const name = (entry.propertyName || entry.name).text;
					module.explicit.set(entry.name.text, node.moduleSpecifier ? { from, name } : { local: name });
				}
			} else if (node.moduleSpecifier) {
				const from = target(node.moduleSpecifier);
				if (from) module.stars.push(from);
			}
		} else if (ts.isImportDeclaration(node) && node.importClause) {
			// Resolve these only if a local export refers to the imported name.
			const clause = node.importClause;
			if (clause.name) module.imports.set(clause.name.text, { specifier: node.moduleSpecifier, name: 'default', target });
			// Namespace imports re-exported locally remain distinct local
			// bindings (ParseModule); named imports become indirect exports.
			if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const entry of clause.namedBindings.elements) {
					module.imports.set(entry.name.text, { specifier: node.moduleSpecifier, name: (entry.propertyName || entry.name).text, target });
				}
			}
		} else if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
			if (node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
				module.explicit.set('default', { local: node.name?.text || 'default' });
				continue;
			}
			const names = [];
			if (ts.isVariableStatement(node)) {
				for (const declaration of node.declarationList.declarations) bindingNames(declaration.name, names);
			} else if (node.name) names.push(node.name.text);
			for (const name of names) module.explicit.set(name, { local: name });
		} else if (ts.isExportAssignment(node)) {
			module.explicit.set('default', { local: 'default' });
		}
	}
	return module;
}

function exportedNames(module, visited = new Set()) {
	if (visited.has(module)) return new Set();
	visited.add(module);
	const names = new Set(module.explicit.keys());
	for (const star of module.stars) {
		for (const name of exportedNames(star, visited)) if (name !== 'default') names.add(name);
	}
	return names;
}

// Mirror the ESM star ambiguity rule: two different bindings for one name
// are not an export, while a diamond that reaches the same binding is valid.
function resolveExport(module, name, visited = new Set()) {
	const key = `${module.key}:${name}`;
	if (visited.has(key)) return null;
	visited.add(key);
	const entry = module.explicit.get(name);
	if (entry) {
		if ('namespace' in entry) return entry.namespace ? `${entry.namespace.key}:*` : null;
		if (entry.local) {
			const imported = module.imports.get(entry.local);
			if (!imported) return `${module.key}:${entry.local}`;
			const from = imported.target(imported.specifier);
			return from ? resolveExport(from, imported.name, visited) : null;
		}
		return entry.from ? resolveExport(entry.from, entry.name, visited) : null;
	}
	if (name === 'default') return null;
	let found = null;
	for (const star of module.stars) {
		const binding = resolveExport(star, name, new Set(visited));
		if (binding === ambiguous || (found && binding && found !== binding)) return ambiguous;
		if (binding) found = binding;
	}
	return found;
}

function namesIn(file, declarations) {
	const module = readModule(file, declarations);
	return new Set([...exportedNames(module)].filter((name) => {
		if (name === 'default') return false;
		const binding = resolveExport(module, name);
		return binding !== null && binding !== ambiguous;
	}));
}

// Pair each subpath's runtime target with its declaration target.
/** @type {Map<string, { runtime?: string, types?: string }>} */
const bySubpath = new Map();
for (const c of checked) {
	if (!bySubpath.has(c.label)) bySubpath.set(c.label, {});
	const slot = /** @type {any} */ (bySubpath.get(c.label));
	if (TYPE_CONDITIONS.has(c.condition)) {
		if (!slot.types) slot.types = c.target;
	} else if (!slot.runtime && /\.(js|mjs)$/.test(c.target)) {
		slot.runtime = c.target;
	}
}

let undeclaredCount = 0;
let declaredCount = 0;
let pairsChecked = 0;
for (const [subpath, { runtime, types }] of bySubpath) {
	if (runtime && !types && !subpath.startsWith('(package.')) {
		errors.push(`${subpath}: ${runtime} has no types condition`);
	}
	if (!runtime || !types) continue;
	const runtimeNames = namesIn(join(root, runtime.replace(/^\.\//, '')), false);
	const declaredNames = namesIn(join(root, types.replace(/^\.\//, '')), true);
	pairsChecked++;
	for (const name of runtimeNames) {
		declaredCount++;
		if (!declaredNames.has(name)) {
			undeclaredCount++;
			errors.push(`${runtime} exports \`${name}\` but ${types} does not declare it`);
		}
	}
}

const declarations = checked.filter((c) => TYPE_CONDITIONS.has(c.condition));
console.log(`check-types: ${pkg.name}@${pkg.version}`);
console.log(`  ${checked.length} export target(s) checked, ${declarations.length} declaration file(s).`);
console.log(`  ${declaredCount} named runtime export(s) matched against declarations, ${undeclaredCount} undeclared.`);

if (errors.length) {
	console.error(`\ncheck-types FAILED (${errors.length} problem(s)):`);
	for (const e of errors) console.error(`  x ${e}`);
	process.exit(1);
}

console.log('  OK - every exports target resolves, types are .d.ts, and all ship.');
