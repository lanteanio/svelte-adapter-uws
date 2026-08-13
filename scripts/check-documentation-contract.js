#!/usr/bin/env node
/** Validate and render the packaged documentation-path entry surface. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { uwsRefFromSpec } from './check-compatibility.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'docs', 'documentation.v1.json');
const readmePath = join(root, 'README.md');
const packagePath = join(root, 'package.json');
export const PATHS_START = '<!-- documentation-paths:start -->';
export const PATHS_END = '<!-- documentation-paths:end -->';
const ROOT_FIELDS = ['schemaVersion', 'owner', 'compatibilitySource', 'entryBudgetLines', 'readmeMaxLines', 'paths'];
const PATH_FIELDS = ['key', 'type', 'need', 'label', 'destination', 'owner'];
const PATH_KEYS = ['identity', 'first-success', 'compatibility', 'tutorial', 'how-to', 'reference', 'explanation', 'operations'];
const PATH_TYPES = ['Identity', 'First success', 'Compatibility', 'Tutorial', 'How-to', 'Reference', 'Explanation', 'Operations'];
const SITE = 'svelte-realtime.dev';
const markdown = new MarkdownIt({ html: true });

function exactFields(value, fields, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [label + ' must be an object'];
	const actual = Object.keys(value);
	return actual.length === fields.length && actual.every((field, index) => field === fields[index])
		? [] : [label + ' fields must be exactly ' + fields.join(', ') + ' in order'];
}

function printable(value) {
	return typeof value === 'string' && value === value.trim() && value.length > 0 &&
		!/[\u0000-\u001f\u007f\u2028\u2029`|<>]/.test(value);
}

export function validateManifest(manifest, pkg, compatibilityExists = true) {
	const errors = exactFields(manifest, ROOT_FIELDS, 'documentation manifest');
	if (errors.length) return errors;
	if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
	if (manifest.owner !== pkg.name) errors.push('owner must match package.json name');
	if (manifest.compatibilitySource !== 'docs/compatibility.v1.csv') errors.push('compatibilitySource must name docs/compatibility.v1.csv');
	if (!compatibilityExists) errors.push('compatibilitySource does not exist');
	if (!Number.isInteger(manifest.entryBudgetLines) || manifest.entryBudgetLines < 40 || manifest.entryBudgetLines > 140) {
		errors.push('entryBudgetLines must be an integer from 40 through 140');
	}
	if (!Number.isInteger(manifest.readmeMaxLines) || manifest.readmeMaxLines < 1) {
		errors.push('readmeMaxLines must be a positive integer');
	}
	if (!Array.isArray(manifest.paths) || manifest.paths.length !== PATH_KEYS.length) {
		errors.push('paths must contain exactly ' + PATH_KEYS.length + ' records');
		return errors;
	}
	const destinations = new Set();
	for (let index = 0; index < manifest.paths.length; index++) {
		const path = manifest.paths[index];
		errors.push(...exactFields(path, PATH_FIELDS, 'paths[' + index + ']'));
		if (!path || typeof path !== 'object') continue;
		if (path.key !== PATH_KEYS[index]) errors.push('paths[' + index + '] key must be ' + PATH_KEYS[index]);
		if (path.type !== PATH_TYPES[index]) errors.push(path.key + ': type must be ' + PATH_TYPES[index]);
		for (const field of PATH_FIELDS) if (!printable(path[field])) errors.push((path.key || 'paths[' + index + ']') + ': ' + field + ' must be one printable line');
		if (destinations.has(path.destination)) errors.push(path.key + ': destination must be unique');
		destinations.add(path.destination);
		if (path.destination?.startsWith('#')) {
			if (path.owner !== 'README.md') errors.push(path.key + ': local destinations must be owned by README.md');
		} else {
			let url;
			try { url = new URL(path.destination); } catch { errors.push(path.key + ': destination must be a local anchor or absolute URL'); }
			if (url && (url.protocol !== 'https:' || url.hostname !== SITE || url.search || url.hash)) errors.push(path.key + ': site destination must be a clean HTTPS svelte-realtime.dev route');
			if (path.owner !== SITE) errors.push(path.key + ': site destinations must be owned by ' + SITE);
		}
	}
	return errors;
}

export function renderPaths(manifest) {
	return [
		PATHS_START,
		'**Choose a documentation path (`documentation-paths-v1`):**',
		'',
		'| Need | Documentation type | Route | Owner |',
		'| --- | --- | --- | --- |',
		...manifest.paths.map((path) => '| ' + path.need + ' | ' + path.type + ' | [' + path.label + '](' + path.destination + ') | `' + path.owner + '` |'),
		PATHS_END
	].join('\n');
}

function blockBounds(source) {
	if (source.split(PATHS_START).length !== 2 || source.split(PATHS_END).length !== 2) throw new Error('README must contain exactly one documentation paths block');
	const start = source.indexOf(PATHS_START);
	const endStart = source.indexOf(PATHS_END);
	if (endStart < start) throw new Error('README documentation paths markers are reversed');
	for (const [offset, marker] of [[start, PATHS_START], [endStart, PATHS_END]]) {
		if ((offset > 0 && source[offset - 1] !== '\n') || (offset + marker.length < source.length && !['\r', '\n'].includes(source[offset + marker.length]))) throw new Error('README documentation paths markers must occupy complete lines');
	}
	return { start, end: endStart + PATHS_END.length };
}

export function replacePaths(readme, rendered) {
	const bounds = blockBounds(readme);
	return readme.slice(0, bounds.start) + rendered + readme.slice(bounds.end);
}

function headingAnchors(readme) {
	const anchors = new Set();
	const counts = new Map();
	const tokens = markdown.parse(readme, {});
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type !== 'heading_open') continue;
		const base = (tokens[index + 1]?.content || '').toLowerCase().trim().replace(/<[^>]*>/g, '')
			.replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-');
		const count = counts.get(base) || 0;
		counts.set(base, count + 1);
		anchors.add('#' + base + (count ? '-' + count : ''));
	}
	return anchors;
}

export function governedNativeRefs(pkg, compatibilityCsv = '') {
	const refs = new Set();
	const pinned = uwsRefFromSpec(pkg?.optionalDependencies?.['uWebSockets.js']);
	if (pinned) refs.add(pinned);
	for (const match of compatibilityCsv.matchAll(/(?:github:uNetworking\/uWebSockets\.js#|uWebSockets\.js\/archive\/refs\/tags\/)(v\d+\.\d+\.\d+)/g)) refs.add(match[1]);
	return [...refs];
}

export function validateReadme(readme, manifest, nativeRefs = []) {
	// Normalised once, up front. This function locates its block and its section
	// ordering by literal `\n` anchors, and a Windows checkout under
	// `core.autocrlf=true` hands it CRLF - which made a freshly cloned tree
	// report the block BOTH stale and out of position, two errors from one
	// cause. The line-count rules below already allowed for `\r?\n`; the
	// anchors and the block comparison did not.
	readme = readme.replace(/\r\n/g, '\n');
	const errors = [];
	let bounds;
	try { bounds = blockBounds(readme); } catch (error) { return [error.message]; }
	if (readme.slice(bounds.start, bounds.end) !== renderPaths(manifest)) errors.push('README documentation paths block is stale; run node scripts/check-documentation-contract.js --write');
	// entryBudgetLines bounds only where the routing block ends, so readers
	// meet the path chooser before scrolling; it says nothing about README
	// size overall - that is what readmeMaxLines is for.
	const endLine = readme.slice(0, bounds.end).split(/\r?\n/).length;
	if (endLine > manifest.entryBudgetLines) errors.push('README documentation paths block ends on line ' + endLine + '; the entry budget requires it to end by line ' + manifest.entryBudgetLines);
	// readmeMaxLines is a ratchet, not a target: it exists to force content
	// out of the README and into docs/ or the site over time. Lower it when
	// content moves; never raise it casually. The first pin took the README
	// length plus 500 lines of headroom so a section being written
	// concurrently could not fail the gate. That section landed, and the
	// headroom is now collected: the pin sits AT the current length, so the
	// next line added to the README is a deliberate act that has to be paid
	// for by moving content out or by raising the pin on the record.
	const readmeLines = readme.split(/\r?\n/).length;
	if (readmeLines > manifest.readmeMaxLines) {
		errors.push('README.md is ' + readmeLines + ' lines; the readmeMaxLines ratchet is ' + manifest.readmeMaxLines + '. The ratchet exists to force content out of the README over time: move content to docs/ or the site and lower the pin when it moves; never raise it casually.');
	}
	const publicEntries = readme.indexOf('\n## Public entry points\n');
	const tableOfContents = readme.indexOf('\n## Table of contents\n');
	if (publicEntries < 0 || tableOfContents < 0 || bounds.start < publicEntries || bounds.end > tableOfContents) {
		errors.push('documentation paths block must follow Public entry points and precede Table of contents');
	}
	const anchors = headingAnchors(readme);
	for (const path of manifest.paths.filter((candidate) => candidate.destination.startsWith('#'))) if (!anchors.has(path.destination)) errors.push(path.key + ': missing README destination ' + path.destination);
	const compatibilityStart = readme.indexOf('<!-- compatibility:start -->');
	const compatibilityEnd = readme.indexOf('<!-- compatibility:end -->');
	if (compatibilityStart < 0 || compatibilityEnd < compatibilityStart) errors.push('README compatibility block is missing or reversed');
	else {
		// The guard covers any exact vX.Y.Z token and any uWebSockets.js
		// archive URL regardless of major, plus the bare major.minor form of
		// every governed pin (a stray 20.69 or 20.69.1 with no v is the
		// historical drift shape). Deriving the pins from package.json and
		// the compatibility manifest keeps the guard alive when the pin
		// moves to a new major.
		const patterns = [
			/uWebSockets\.js\/archive\/refs\/tags\/v\d+\.\d+\.\d+/g,
			/\bv\d+\.\d+\.\d+\b/g,
			...nativeRefs.map((ref) => {
				const [major, minor] = ref.replace(/^v/, '').split('.');
				return new RegExp('\\b' + major + '\\.' + minor + '(?:\\.\\d+)?\\b', 'g');
			})
		];
		const flagged = new Set();
		for (const pattern of patterns) for (const match of readme.matchAll(pattern)) {
			if (match.index >= compatibilityStart && match.index <= compatibilityEnd) continue;
			const key = match.index + ':' + match[0];
			if (flagged.has(key)) continue;
			flagged.add(key);
			errors.push('native compatibility fact outside generated compatibility block: ' + match[0]);
		}
	}
	return errors;
}

export function validatePackageScripts(pkg) {
	const errors = [];
	const command = 'node scripts/check-documentation-contract.js';
	for (const key of ['check', 'verify:docs']) {
		const script = pkg.scripts?.[key];
		if (typeof script !== 'string' || script.split(command).length - 1 !== 1) errors.push('scripts.' + key + ' must execute the documentation contract exactly once');
	}
	if (pkg.scripts?.['check:documentation'] !== command) errors.push('scripts.check:documentation must be ' + command);
	return errors;
}

export function validateDocumentationContract({ manifest, readme, pkg, compatibilityExists = true, compatibilityCsv = '' }) {
	return [...validateManifest(manifest, pkg, compatibilityExists), ...validateReadme(readme, manifest, governedNativeRefs(pkg, compatibilityCsv)), ...validatePackageScripts(pkg)];
}

function main() {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
	if (process.argv.includes('--write')) writeFileSync(readmePath, replacePaths(readFileSync(readmePath, 'utf8'), renderPaths(manifest)));
	const compatibilityPath = join(root, String(manifest.compatibilitySource || ''));
	const compatibilityExists = existsSync(compatibilityPath);
	const readme = readFileSync(readmePath, 'utf8');
	const errors = validateDocumentationContract({ manifest, readme, pkg, compatibilityExists, compatibilityCsv: compatibilityExists ? readFileSync(compatibilityPath, 'utf8') : '' });
	if (errors.length) {
		console.error('check-documentation-contract FAILED');
		for (const error of errors) console.error('  - ' + error);
		process.exitCode = 1;
		return;
	}
	const local = manifest.paths.filter((path) => path.owner === 'README.md').length;
	const endLine = readme.slice(0, readme.indexOf(PATHS_END) + PATHS_END.length).split(/\r?\n/).length;
	const readmeLines = readme.split(/\r?\n/).length;
	console.log('check-documentation-contract: ' + manifest.paths.length + ' reader paths, ' + local + ' package-owned and ' + (manifest.paths.length - local) + ' site-owned; paths block ends on line ' + endLine + ' of its ' + manifest.entryBudgetLines + '-line entry budget; README.md is ' + readmeLines + ' of at most ' + manifest.readmeMaxLines + ' ratcheted lines');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
