import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const guideRelative = 'docs/migrations/0.5-to-0.6.md';
const markerPattern = /<!-- migration-surface:v1 sha256=([a-f0-9]{64}) -->/g;

const fixedSurfaceFiles = [
	'docs/compatibility.v1.csv',
	'protocol.schema.json',
	'src/client.js',
	'src/index.js',
	'src/runtime/handler/wire-fanout.js',
	'src/runtime/observability-manifest.js',
	'src/runtime/wire.js',
	'src/vite.js'
];

function posix(relative) {
	return relative.split(path.sep).join('/');
}

function walkFiles(directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) found.push(...walkFiles(absolute));
		else if (entry.isFile()) found.push(absolute);
	}
	return found;
}

export function normalizeSurfaceText(source) {
	return source.replace(/\r\n?/g, '\n');
}

export function publicPackageSurface(pkg) {
	return {
		exports: pkg.exports,
		types: pkg.types,
		engines: pkg.engines,
		peerDependencies: pkg.peerDependencies,
		peerDependenciesMeta: pkg.peerDependenciesMeta,
		optionalDependencies: pkg.optionalDependencies
	};
}

/**
 * The compatibility manifest with its exact release identity column removed.
 *
 * check-compatibility forces the current row's `adapter_version` to equal
 * `package.json` version, so digesting the raw CSV made every
 * `chore(release)` bump flip this gate - a false freshness input that trains
 * reflexive `--write` re-stamps. The SERIES columns, channels, Node floor,
 * and native pin are what a migration guide is about; the exact prerelease
 * counter is not. A changed column layout falls through untouched so the
 * digest still moves on structural change.
 *
 * @param {string} csvText
 * @returns {string}
 */
export function versionIndependentCompatibilitySurface(csvText) {
	const lines = normalizeSurfaceText(csvText).trim().split('\n');
	const headers = (lines[0] ?? '').split(',');
	// The train FACT columns move with every qualification-pin advance - an
	// exact sibling counter or head is the same false freshness input as the
	// adapter's own release identity. The series columns and `train` stay:
	// they are what a migration guide is about.
	const dropped = new Set([
		'adapter_version', 'realtime_version', 'extensions_version',
		'realtime_head', 'extensions_head', 'wire_protocol', 'procedure'
	]);
	const dropIndexes = headers
		.map((header, index) => (dropped.has(header) ? index : -1))
		.filter((index) => index !== -1);
	if (dropIndexes.length === 0) return normalizeSurfaceText(csvText);
	return lines
		.map((line) => {
			const cells = line.split(',');
			for (let i = dropIndexes.length - 1; i >= 0; i--) cells.splice(dropIndexes[i], 1);
			return cells.join(',');
		})
		.join('\n') + '\n';
}

export function migrationSurfacePaths(rootDirectory = root) {
	const src = path.join(rootDirectory, 'src');
	const discovered = walkFiles(src)
		.map((absolute) => posix(path.relative(rootDirectory, absolute)))
		.filter((relative) => relative.endsWith('.d.ts') ||
			(relative.startsWith('src/plugins/') && relative.endsWith('/codec.js')));
	return [...new Set([...fixedSurfaceFiles, ...discovered])].sort();
}

export function surfaceEntries(rootDirectory = root) {
	const pkg = JSON.parse(readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'));
	const entries = migrationSurfacePaths(rootDirectory).map((relative) => {
		const absolute = path.join(rootDirectory, ...relative.split('/'));
		if (!statSync(absolute).isFile()) throw new Error(`migration surface is not a file: ${relative}`);
		const raw = normalizeSurfaceText(readFileSync(absolute, 'utf8'));
		if (relative === 'docs/compatibility.v1.csv') {
			return {
				path: relative + '#version-independent',
				content: versionIndependentCompatibilitySurface(raw)
			};
		}
		return { path: relative, content: raw };
	});
	entries.push({
		path: 'package.json#public-migration-surface',
		content: JSON.stringify(publicPackageSurface(pkg), null, 2) + '\n'
	});
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function digestSurfaceEntries(entries) {
	const hash = createHash('sha256');
	for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		const content = normalizeSurfaceText(entry.content);
		hash.update(entry.path, 'utf8');
		hash.update('\0', 'utf8');
		hash.update(String(Buffer.byteLength(content, 'utf8')), 'utf8');
		hash.update('\0', 'utf8');
		hash.update(content, 'utf8');
		hash.update('\0', 'utf8');
	}
	return hash.digest('hex');
}

export function computeMigrationSurfaceDigest(rootDirectory = root) {
	return digestSurfaceEntries(surfaceEntries(rootDirectory));
}

export function migrationSurfaceMarker(guide) {
	const matches = [...guide.matchAll(markerPattern)];
	if (matches.length !== 1) {
		throw new Error(`active migration guide must contain exactly one migration-surface:v1 marker; found ${matches.length}`);
	}
	return matches[0][1];
}

export function replaceMigrationSurfaceMarker(guide, digest) {
	migrationSurfaceMarker(guide);
	return guide.replace(markerPattern, `<!-- migration-surface:v1 sha256=${digest} -->`);
}

export function checkMigrationFreshness({ rootDirectory = root, write = false } = {}) {
	const guidePath = path.join(rootDirectory, ...guideRelative.split('/'));
	const guide = readFileSync(guidePath, 'utf8');
	const actual = migrationSurfaceMarker(guide);
	const expected = computeMigrationSurfaceDigest(rootDirectory);
	const count = surfaceEntries(rootDirectory).length;
	if (write) {
		if (actual !== expected) writeFileSync(guidePath, replaceMigrationSurfaceMarker(guide, expected));
		return { actual: expected, expected, count, updated: actual !== expected };
	}
	if (actual !== expected) {
		throw new Error(
			`migration guide surface marker is stale (recorded ${actual}, current ${expected}). ` +
			'Review docs/migrations/0.5-to-0.6.md for the public surface change, then run npm run check:migration -- --write.'
		);
	}
	return { actual, expected, count, updated: false };
}

function isCli() {
	if (!process.argv[1]) return false;
	const invoked = path.resolve(process.argv[1]);
	const current = fileURLToPath(import.meta.url);
	return process.platform === 'win32'
		? invoked.toLowerCase() === current.toLowerCase()
		: invoked === current;
}

if (isCli()) {
	try {
		const result = checkMigrationFreshness({ write: process.argv.includes('--write') });
		const action = result.updated ? 'updated' : 'matches';
		console.log(`check-migration-freshness: ${result.count} public surface/schema entries ${action} ${result.expected}`);
	} catch (error) {
		console.error(`check-migration-freshness FAILED: ${error.message}`);
		process.exitCode = 1;
	}
}
