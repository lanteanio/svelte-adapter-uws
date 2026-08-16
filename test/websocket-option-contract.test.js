// One contract for the three places a production WebSocket option must exist:
// the published type, the build serializer and the runtime consumer. Checking
// only known keys against serialized keys misses a documented option omitted
// from BOTH tables; checking only the serializer's keys misses a hard-coded
// default that discards the configured value. Both failures have shipped.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import ts from 'typescript';
import {
	KNOWN_ADAPTER_OPTION_KEYS,
	KNOWN_WEBSOCKET_OPTION_KEYS,
	serializeWsOptions,
	unknownWebsocketOptionKeys
} from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Top-level property names declared by a named interface. */
function interfaceProperties(src, name) {
	const sourceFile = ts.createSourceFile(
		'index.d.ts',
		src,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const declaration = sourceFile.statements.find(
		(node) => ts.isInterfaceDeclaration(node) && node.name.text === name
	);
	expect(declaration, `${name} declaration not found`).toBeDefined();
	const names = new Set();
	for (const member of declaration.members) {
		if (!ts.isPropertySignature(member) || !member.name) continue;
		if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
			names.add(member.name.text);
		}
	}
	return names;
}

function jsFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jsFiles(full));
		else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}

function nodes(root) {
	const out = [];
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) { for (const item of node) visit(item); return; }
		if (typeof node.type !== 'string') return;
		out.push(node);
		for (const [key, value] of Object.entries(node)) {
			if (key === 'type' || key === 'start' || key === 'end') continue;
			visit(value);
		}
	};
	visit(root);
	return out;
}

/** Every property read from WS_OPTIONS or a direct alias of it. */
function runtimeOptionReads() {
	const found = new Set();
	for (const file of jsFiles(path.join(ROOT, 'src', 'runtime'))) {
		const tree = nodes(parse(readFileSync(file, 'utf8'), {
			ecmaVersion: 'latest',
			sourceType: 'module'
		}));
		const aliases = new Set(['WS_OPTIONS']);
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of tree) {
				if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') continue;
				if (node.init?.type !== 'Identifier' || !aliases.has(node.init.name)) continue;
				if (!aliases.has(node.id.name)) { aliases.add(node.id.name); changed = true; }
			}
		}
		for (const node of tree) {
			if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && aliases.has(node.object.name)) {
				if (!node.computed && node.property?.type === 'Identifier') found.add(node.property.name);
				else if (node.computed && node.property?.type === 'Literal' && typeof node.property.value === 'string') {
					found.add(node.property.value);
				}
			}
			if (node.type === 'VariableDeclarator' && node.init?.type === 'Identifier' &&
				aliases.has(node.init.name) && node.id?.type === 'ObjectPattern') {
				for (const prop of node.id.properties) {
					if (prop.type === 'Property') found.add(prop.key?.name ?? prop.key?.value);
				}
			}
		}
	}
	return found;
}

describe('production websocket option contract', () => {
	it('keeps every published WebSocketOptions key in the known-key registry', () => {
		const declared = interfaceProperties(read('src/index.d.ts'), 'WebSocketOptions');
		expect(declared.size, 'the declaration scan must not pass vacuously').toBeGreaterThan(25);
		expect([...KNOWN_WEBSOCKET_OPTION_KEYS].sort()).toEqual([...declared].sort());
	});

	it('serializes every option the runtime actually reads', () => {
		const serialized = new Set(Object.keys(serializeWsOptions({}, '/__realtime')));
		const reads = runtimeOptionReads();
		// Self-check the AST/data-flow scan against the two original dropped
		// options and a value read through the WS_OPTIONS global in another file.
		for (const expected of [
			'resourceGrowthAuditIntervalMs',
			'postureExport',
			'compressCredentialedResponses'
		]) {
			expect(reads.has(expected), `runtime scan missed ${expected}`).toBe(true);
		}
		const dropped = [...reads].filter((key) => !serialized.has(key)).sort();
		expect(dropped, `runtime reads options the build does not serialize: ${dropped.join(', ')}`).toEqual([]);
	});

	it('preserves configured resource-audit and posture-export values', () => {
		const postureExport = { path: '/run/adapter-posture.sock' };
		const serialized = serializeWsOptions({
			resourceGrowthAuditIntervalMs: 12_345,
			postureExport
		}, '/__realtime');
		expect(serialized.resourceGrowthAuditIntervalMs).toBe(12_345);
		expect(serialized.postureExport).toEqual(postureExport);
	});

	it('treats the stale resourceGrowthIntervalMs name as unknown', () => {
		expect(unknownWebsocketOptionKeys({ resourceGrowthIntervalMs: 1000 }))
			.toEqual(['resourceGrowthIntervalMs']);
	});

	it('keeps every published AdapterOptions key in the top-level known-key registry', () => {
		// Same contract one level up: a documented top-level option missing
		// from the registry warns on a legitimate config, and a registry key
		// the type does not document admits an option no app can type.
		const declared = interfaceProperties(read('src/index.d.ts'), 'AdapterOptions');
		expect(declared.size, 'the declaration scan must not pass vacuously').toBeGreaterThan(5);
		expect([...KNOWN_ADAPTER_OPTION_KEYS].sort()).toEqual([...declared].sort());
	});

	it('wires the top-level unknown-key report into the build warning', () => {
		// The pure helper is tested elsewhere; this pins the adapt() wiring,
		// which no suite drives end to end - removing the warn call would
		// leave every helper case green while the build went quiet.
		const source = read('src/index.js');
		const warned = /const unknownTopLevelKeys = unknownAdapterOptionKeys\(opts\);\s*\n\s*if \(unknownTopLevelKeys\.length\) \{\s*\n\s*builder\.log\.warn\(/;
		expect(source).toMatch(warned);
	});
});
