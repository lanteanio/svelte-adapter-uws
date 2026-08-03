#!/usr/bin/env node
/**
 * Generate bounded README API-reference blocks from public declarations.
 *
 * A public contract duplicated by hand in README.md and a declaration had
 * already disagreed with the runtime. The declaration is now the sole editable
 * source: an `API_DOC:<id>` region inside its JSDoc is copied byte-for-byte into
 * the matching `GENERATED API_DOC:<id>` region in README.md. Ordinary examples
 * and narrative outside those regions remain hand-written.
 *
 * Usage:
 *   node scripts/generate-api-docs.js          # update README.md
 *   node scripts/generate-api-docs.js --check  # fail if README.md is stale
 *
 * @module scripts/generate-api-docs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceTarget = resolve(root, 'src/index.d.ts');
const readmeTarget = resolve(root, 'README.md');
const SOURCE_MARKER = /^\s*\*\s*<!-- API_DOC:([A-Za-z0-9_.-]+):(START|END) -->\s*$/;

export function readmeStart(id) {
	return `<!-- GENERATED API_DOC:${id}:START (source: src/index.d.ts; run node scripts/generate-api-docs.js) -->`;
}

export function readmeEnd(id) {
	return `<!-- GENERATED API_DOC:${id}:END -->`;
}

function stripJSDocPrefix(line, id) {
	const match = /^\s*\*(?: ?(.*))?$/.exec(line);
	if (!match) throw new Error(`API_DOC:${id} contains a line outside its JSDoc block`);
	return match[1] || '';
}

/** Extract every named canonical Markdown block from declaration JSDoc. */
export function extractApiDocs(source) {
	const docs = new Map();
	let active = null;
	let lines = [];
	for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
		const marker = SOURCE_MARKER.exec(line);
		if (marker) {
			const [, id, edge] = marker;
			if (edge === 'START') {
				if (active !== null) throw new Error(`API_DOC:${id} starts inside API_DOC:${active}`);
				if (docs.has(id)) throw new Error(`API_DOC:${id} is declared more than once`);
				active = id;
				lines = [];
			} else {
				if (active !== id) throw new Error(`API_DOC:${id} ends without its matching start`);
				const body = lines.join('\n').replace(/^\n+|\n+$/g, '') + '\n';
				if (body.trim() === '') throw new Error(`API_DOC:${id} is empty`);
				docs.set(id, body);
				active = null;
				lines = [];
			}
			continue;
		}
		if (active !== null) lines.push(stripJSDocPrefix(line, active));
	}
	if (active !== null) throw new Error(`API_DOC:${active} has no end marker`);
	if (docs.size === 0) throw new Error('no declaration-owned API_DOC blocks found');
	return docs;
}

function replaceOne(readme, id, body) {
	const start = readmeStart(id);
	const end = readmeEnd(id);
	const startAt = readme.indexOf(start);
	const endAt = readme.indexOf(end);
	if (startAt === -1 || endAt === -1 || endAt < startAt) {
		throw new Error(`README generated region for API_DOC:${id} is missing or reversed`);
	}
	if (readme.indexOf(start, startAt + start.length) !== -1 || readme.indexOf(end, endAt + end.length) !== -1) {
		throw new Error(`README generated region for API_DOC:${id} is duplicated`);
	}
	const afterEnd = endAt + end.length;
	return readme.slice(0, startAt) + start + '\n' + body.replace(/\n+$/g, '') + '\n' + end + readme.slice(afterEnd);
}

/** Render every declaration-owned block into its matching bounded README slot. */
export function renderReadme(readme, docs) {
	let rendered = readme.replace(/\r\n/g, '\n');
	// A README region marked GENERATED whose id has no source block would be
	// hand-editable while wearing the generated label - the silent-duplication
	// class this generator exists to remove. The id sets must match exactly.
	const readmeIds = new Set();
	for (const match of rendered.matchAll(/<!-- GENERATED API_DOC:([^:]+):START -->/g)) {
		readmeIds.add(match[1]);
	}
	for (const id of readmeIds) {
		if (!docs.has(id)) {
			throw new Error(`README generated region API_DOC:${id} has no owning source block`);
		}
	}
	for (const [id, body] of docs) rendered = replaceOne(rendered, id, body);
	return rendered;
}

export function expectedReadme(source, readme) {
	return renderReadme(readme, extractApiDocs(source));
}

function main() {
	const source = readFileSync(sourceTarget, 'utf8');
	const actual = readFileSync(readmeTarget, 'utf8').replace(/\r\n/g, '\n');
	const expected = expectedReadme(source, actual);
	if (process.argv.includes('--check')) {
		if (actual !== expected) {
			console.error('generate-api-docs: README.md API reference is stale.');
			console.error('  Run: node scripts/generate-api-docs.js');
			process.exitCode = 1;
			return;
		}
		console.log(`generate-api-docs: ${extractApiDocs(source).size} declaration-owned README block(s) match.`);
		return;
	}
	writeFileSync(readmeTarget, expected);
	console.log(`generate-api-docs: wrote ${readmeTarget}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
