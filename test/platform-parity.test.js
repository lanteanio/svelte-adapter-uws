// Every production platform key must exist on the actual development platform.
// Read production keys from its object declaration without starting a server;
// construct the Vite plugin to include methods supplied by helper objects.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as acorn from 'acorn';
import uws from '../vite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Walk the AST and return the first `const platform = { ... }`
 * ObjectExpression found at any depth.
 *
 * @param {string} filepath
 * @returns {Set<string>} top-level keys (methods, properties, getters)
 */
function platformKeys(filepath) {
	const src = readFileSync(filepath, 'utf8');
	const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });

	let obj = null;
	const stack = [ast];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== 'object') continue;
		if (Array.isArray(node)) {
			for (const n of node) stack.push(n);
			continue;
		}
		if (
			node.type === 'VariableDeclarator' &&
			node.id?.type === 'Identifier' &&
			node.id.name === 'platform' &&
			node.init?.type === 'ObjectExpression'
		) {
			obj = node.init;
			break;
		}
		for (const k in node) {
			if (k === 'type' || k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
			stack.push(node[k]);
		}
	}
	if (!obj) throw new Error('could not find `const platform = { ... }` in ' + filepath);

	const keys = new Set();
	for (const prop of obj.properties) {
		if (prop.type !== 'Property') continue;
		if (prop.computed) continue;
		const name = prop.key.name ?? prop.key.value;
		if (typeof name === 'string') keys.add(name);
	}
	return keys;
}

describe('platform dev/prod parity', () => {
	it('every key on the production base platform exists on the dev base platform', () => {
		const prod = platformKeys(path.join(ROOT, 'files/handler.js'));
		const previous = Object.getOwnPropertyDescriptor(globalThis, '__uws_dev_platform');
		let dev;
		try {
			uws();
			dev = new Set(Reflect.ownKeys(globalThis.__uws_dev_platform));
			for (const name of ['subscribe', 'checkSubscribe', 'unsubscribe']) {
				expect(typeof globalThis.__uws_dev_platform[name]).toBe('function');
			}
		} finally {
			if (previous) Object.defineProperty(globalThis, '__uws_dev_platform', previous);
			else delete globalThis.__uws_dev_platform;
		}

		// Sanity check: both sides have a non-trivial platform surface. If
		// either is empty, the wrong object was inspected.
		expect(prod.size).toBeGreaterThan(5);
		expect(dev.size).toBeGreaterThan(5);

		const missing = [...prod].filter((k) => !dev.has(k));
		expect(
			missing,
			'dev platform in vite.js is missing ' + missing.length + ' key(s) present on the production platform in files/handler.js: ' +
			JSON.stringify(missing) + '. ' +
			'When a primitive lands on prod, mirror it on dev (degrade to a no-op or zero-valued shape if needed). ' +
			'See the parity-contract comment block above the dev platform definition in vite.js.'
		).toEqual([]);
	});
});
