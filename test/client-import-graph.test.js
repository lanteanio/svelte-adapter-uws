// The client-side import graph must never reach the server runtime.
//
// Every export-map subpath a browser bundle can import (the `/client` entries,
// the crdt channel, the smooth shared-random, safe-url) is walked through its
// STATIC import graph, and the test fails if any reachable module imports a
// `node:` builtin. The failure mode this guards is subtle and expensive
// downstream: a client entry that transitively touches `runtime/runtime.js`
// (or any other `node:`-importing module) does not fail here in this repo - it
// fails in the CONSUMER's Vite production build with
// `"performance" is not exported by "__vite-browser-external"`, because
// Rollup's missing-export check runs during binding, BEFORE tree-shaking, so
// even an unused re-export chain breaks the app build.
//
// The original instance: plugins/crdt/codec.js imported WS_CAPS from the
// `runtime/utils.js` barrel. The barrel re-exports every server utility,
// several of which import `runtime/runtime.js` -> `node:perf_hooks`. The
// symbol lives in the pure `runtime/utils/ws-symbols.js`; client-reachable
// modules must import such leaves directly, never the barrel.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'));

// Every `/client` export subpath is picked up automatically so a future
// client plugin is covered without touching this test; the extras are the
// client-safe entries whose names do not carry the suffix.
const CLIENT_SAFE_EXTRAS = ['./safe-url', './plugins/crdt/channel', './plugins/smooth/random'];

function clientEntryFiles() {
	const files = [];
	for (const [subpath, target] of Object.entries(pkg.exports)) {
		if (subpath.endsWith('/client') || CLIENT_SAFE_EXTRAS.includes(subpath)) {
			files.push({ subpath, file: resolve(pkgDir, target.default) });
		}
	}
	return files;
}

/** Static import/export-from/dynamic-literal specifiers of one module. */
function specifiersOf(source) {
	// Strip block comments and full-line comments so prose that MENTIONS an
	// import (doc headers do) is not read as one.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const out = [];
	const patterns = [
		/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
		/import\s*['"]([^'"]+)['"]/g,
		/import\(\s*['"]([^'"]+)['"]\s*\)/g
	];
	for (const re of patterns) {
		for (let m; (m = re.exec(code)); ) out.push(m[1]);
	}
	return out;
}

/**
 * Walk the static graph from one entry file. Relative specifiers are followed;
 * `node:` specifiers are recorded as violations with the chain that reached
 * them; other bare specifiers (svelte/store, yjs) are external and skipped.
 */
function findNodeImports(entryFile) {
	const violations = [];
	const visited = new Set();
	const walk = (file, chain) => {
		if (visited.has(file)) return;
		visited.add(file);
		let source;
		try {
			source = readFileSync(file, 'utf8');
		} catch {
			violations.push(`${chain.join(' -> ')} -> ${file} (unresolvable)`);
			return;
		}
		for (const spec of specifiersOf(source)) {
			if (spec.startsWith('node:')) {
				violations.push(`${[...chain, file].join(' -> ')} imports ${spec}`);
			} else if (spec.startsWith('./') || spec.startsWith('../')) {
				walk(resolve(dirname(file), spec), [...chain, file]);
			}
		}
	};
	walk(entryFile, []);
	return violations;
}

describe('client import graph', () => {
	const entries = clientEntryFiles();

	it('covers the expected client-safe export subpaths', () => {
		const subpaths = entries.map((e) => e.subpath);
		expect(subpaths).toContain('./client');
		expect(subpaths).toContain('./plugins/crdt/channel');
		expect(subpaths).toContain('./plugins/smooth/client');
	});

	for (const { subpath, file } of clientEntryFiles()) {
		it(`${subpath} never reaches a node: builtin`, () => {
			expect(findNodeImports(file)).toEqual([]);
		});
	}
});