// Every member the production platform object defines is declared on the
// public `Platform` interface.
//
// A member missing from the declaration works in JavaScript and fails to
// compile in TypeScript. Member coverage is derived from the code:
// the property names of the `platform` object literal in
// src/runtime/handler/platform.js, read with a parser rather than a pattern,
// each of which must appear as a member of `export interface Platform`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'acorn';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function platformKeys() {
	const ast = parse(read('src/runtime/handler/platform.js'), { ecmaVersion: 'latest', sourceType: 'module' });
	let literal = null;
	(function walk(node) {
		if (!node || typeof node !== 'object' || literal) return;
		if (node.type === 'VariableDeclarator' && node.id?.name === 'platform' && node.init?.type === 'ObjectExpression') {
			literal = node.init;
			return;
		}
		for (const key in node) {
			const value = node[key];
			if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value.type === 'string') walk(value);
		}
	})(ast);
	expect(literal, 'the platform object literal moved; this reads its keys').toBeTruthy();
	return literal.properties
		.filter((p) => p.type === 'Property' && !p.computed)
		.map((p) => p.key.name ?? p.key.value);
}

function platformInterfaceBody() {
	const dts = read('src/index.d.ts');
	const start = dts.indexOf('export interface Platform {');
	expect(start, 'the Platform interface moved').toBeGreaterThan(-1);
	let depth = 0;
	for (let i = dts.indexOf('{', start); i < dts.length; i++) {
		if (dts[i] === '{') depth++;
		else if (dts[i] === '}' && --depth === 0) return dts.slice(start, i);
	}
	throw new Error('the Platform interface never closes');
}

describe('the Platform type declares what the platform object has', () => {
	it('declares every member of the production platform object', () => {
		const keys = platformKeys();
		expect(keys.length, 'a scan that found nothing proves nothing').toBeGreaterThan(30);
		const body = platformInterfaceBody();
		const undeclared = keys.filter((key) => !new RegExp('\\n\\t(readonly )?' + key.replace(/\$/g, '\\$') + '[?(<:]').test(body));
		expect(undeclared).toEqual([]);
	});
});


describe('assertion counter types', () => {
	it('exposes a readonly map to strict TypeScript consumers', () => {
		const file = path.join(ROOT, 'test/platform-assertions-consumer.mts').replaceAll('\\', '/');
		const source = [
			'import type { Platform } from "../src/index.js";',
			'declare const platform: Platform;',
			'const count: number | undefined = platform.assertions.get("invariant");',
			'for (const entry of platform.assertions) { const pair: [string, number] = entry; }',
			'// @ts-expect-error assertion counts are not string values',
			'const text: string | undefined = platform.assertions.get("invariant");',
			'// @ts-expect-error map values are not accessed with property indexing',
			'platform.assertions["invariant"];',
			'// @ts-expect-error consumers cannot mutate counters',
			'platform.assertions.set("invariant", 1);'
		].join('\n');
		const options = {
			noEmit: true, strict: true, skipLibCheck: true, types: [],
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext
		};
		const host = ts.createCompilerHost(options);
		const getSourceFile = host.getSourceFile.bind(host);
		host.getSourceFile = (name, ...rest) => name === file
			? ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
			: getSourceFile(name, ...rest);
		const program = ts.createProgram([file], options, host);
		expect(ts.getPreEmitDiagnostics(program).map(diagnostic =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
		)).toEqual([]);
	});
});
