#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const declaration = readFileSync(new URL('src/index.d.ts', root), 'utf8');
const source = ts.createSourceFile('index.d.ts', declaration, ts.ScriptTarget.Latest, true);
const interfaces = source.statements.filter((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'Platform');
if (interfaces.length !== 1 || interfaces[0].heritageClauses?.length) {
	throw new Error('Platform must be one complete interface; update the inventory generator for merged or inherited declarations.');
}
const members = [...new Set(interfaces[0].members.map((member) => {
	if (!member.name || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) {
		throw new Error('Platform contains an unnamed or computed member; define its inventory policy.');
	}
	return member.name.text;
}))].sort();
if (members.length === 0) {
	throw new Error('Platform inventory must contain unique named members.');
}
const entries = members.map((member) => `\t${JSON.stringify(member)}`).join(',\n');
const notice = '// Generated from src/index.d.ts by scripts/generate-platform-contract.js.\n';
const documentation = '/**\n * All public Platform member names, including per-request and per-connection\n * context fields. This inventory describes the uWS contract, not the\n * capabilities implemented by another adapter or an arbitrary platform object.\n */\n';
const outputs = new Map([
	['src/platform-contract.js', notice + documentation + 'export const PLATFORM_MEMBERS = Object.freeze([\n' + entries + '\n]);\n'],
	['src/platform-contract.d.ts', notice + documentation + 'export declare const PLATFORM_MEMBERS: readonly [\n' + entries + '\n];\n\n/** A public Platform member name. */\nexport type PlatformMember = typeof PLATFORM_MEMBERS[number];\n']
]);
for (const [relative, expected] of outputs) {
	const target = new URL(relative, root);
	if (process.argv.includes('--check')) {
		let actual;
		try { actual = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch { actual = ''; }
		if (actual !== expected) {
			console.error(fileURLToPath(target) + ' is stale; run node scripts/generate-platform-contract.js');
			process.exitCode = 1;
		}
	} else writeFileSync(target, expected);
}
if (!process.exitCode) console.log('platform-contract: ' + members.length + ' public members');
