#!/usr/bin/env node
/**
 * Keep the README ecosystem cards and cross-package import example tied to the
 * sibling manifests. CI passes exact checked-out package.json paths, while the
 * local gate uses the last reviewed descriptions as its fail-closed snapshot.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(root, 'README.md');

export const RELATED_PROJECTS_START = '<!-- related-projects:start -->';
export const RELATED_PROJECTS_END = '<!-- related-projects:end -->';
export const EXTENSIONS_DESCRIPTION =
	'Redis and Postgres extensions for svelte-adapter-uws - distributed pub/sub, replay buffers, presence tracking, rate limiting, groups, and DB change notifications';
export const REALTIME_DESCRIPTION =
	'Realtime RPC and reactive subscriptions for SvelteKit, built on svelte-adapter-uws';

function projectLine(name, url, description) {
	return '- [' + name + '](' + url + ') - ' + description;
}

export function renderRelatedProjects(descriptions = {}) {
	const extensions = descriptions.extensions || EXTENSIONS_DESCRIPTION;
	const realtime = descriptions.realtime || REALTIME_DESCRIPTION;
	return [
		RELATED_PROJECTS_START,
		projectLine(
			'svelte-adapter-uws-extensions',
			'https://github.com/lanteanio/svelte-adapter-uws-extensions',
			extensions
		),
		projectLine(
			'svelte-realtime',
			'https://github.com/lanteanio/svelte-realtime',
			realtime
		),
		projectLine(
			'svelte-realtime-demo',
			'https://github.com/lanteanio/svelte-realtime-demo',
			'Live demo of svelte-realtime. [Try it here.](https://svelte-realtime-demo.lantean.io/)'
		),
		RELATED_PROJECTS_END
	].join('\n');
}

function occurrences(text, needle) {
	let count = 0;
	let offset = 0;
	while ((offset = text.indexOf(needle, offset)) !== -1) {
		count++;
		offset += needle.length;
	}
	return count;
}

function boundedBlock(readme, errors) {
	const starts = occurrences(readme, RELATED_PROJECTS_START);
	const ends = occurrences(readme, RELATED_PROJECTS_END);
	if (starts !== 1 || ends !== 1) {
		errors.push('README must contain exactly one bounded related-projects block');
		return null;
	}
	const start = readme.indexOf(RELATED_PROJECTS_START);
	const end = readme.indexOf(RELATED_PROJECTS_END);
	if (end < start) {
		errors.push('README related-projects markers are reversed');
		return null;
	}
	return readme.slice(start, end + RELATED_PROJECTS_END.length);
}

function validDescription(value) {
	return typeof value === 'string' && value === value.trim() && value.length > 0 &&
		!/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
}

function validateManifest(pkg, name, errors) {
	if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
		errors.push(name + ' manifest must be an object');
		return false;
	}
	if (pkg.name !== name) errors.push(name + ' manifest has the wrong package name');
	if (!validDescription(pkg.description)) {
		errors.push(name + ' manifest description must be one printable line');
		return false;
	}
	return pkg.name === name;
}

export function validateRelatedProjects({
	readme,
	extensionsPackage = null,
	realtimePackage = null
}) {
	const errors = [];
	if (typeof readme !== 'string') return ['README must be text'];
	if ((extensionsPackage === null) !== (realtimePackage === null)) {
		errors.push('both sibling manifests must be supplied together');
	}

	let extensionsDescription = EXTENSIONS_DESCRIPTION;
	let realtimeDescription = REALTIME_DESCRIPTION;
	if (extensionsPackage !== null && realtimePackage !== null) {
		const extensionsValid = validateManifest(
			extensionsPackage,
			'svelte-adapter-uws-extensions',
			errors
		);
		const realtimeValid = validateManifest(realtimePackage, 'svelte-realtime', errors);
		if (extensionsValid && validDescription(extensionsPackage.description)) {
			extensionsDescription = extensionsPackage.description;
		}
		if (realtimeValid && validDescription(realtimePackage.description)) {
			realtimeDescription = realtimePackage.description;
		}
		if (!extensionsPackage.exports ||
			typeof extensionsPackage.exports !== 'object' ||
			!Object.hasOwn(extensionsPackage.exports, './admission')) {
			errors.push('svelte-adapter-uws-extensions must export ./admission');
		}
	}

	const block = boundedBlock(readme, errors);
	const expected = renderRelatedProjects({
		extensions: extensionsDescription,
		realtime: realtimeDescription
	});
	if (block !== null && block !== expected) {
		errors.push('README related-projects block is stale; regenerate it from sibling manifest descriptions');
	}
	if (readme.includes('Opinionated full-stack starter')) {
		errors.push('README contains the retired svelte-realtime positioning');
	}
	if (/from\s+['"]svelte-adapter-uws-extensions['"]/.test(readme)) {
		errors.push('README imports the nonexistent extensions root export');
	}
	if (!/from\s+['"]svelte-adapter-uws-extensions\/admission['"]/.test(readme)) {
		errors.push('README must import createAdmissionControl from the ./admission export');
	}
	return errors;
}

function valueAfter(argv, flag) {
	const index = argv.indexOf(flag);
	if (index === -1) return null;
	if (index === argv.length - 1 || argv[index + 1].startsWith('--')) {
		throw new Error(flag + ' requires a path');
	}
	if (argv.indexOf(flag, index + 1) !== -1) throw new Error(flag + ' may appear only once');
	return argv[index + 1];
}

function readPackage(path) {
	const absolute = resolve(path);
	try {
		return JSON.parse(readFileSync(absolute, 'utf8'));
	} catch (error) {
		throw new Error('could not read package manifest ' + absolute + ': ' + error.message);
	}
}

function main() {
	const argv = process.argv.slice(2);
	const allowed = new Set(['--extensions-package', '--realtime-package']);
	for (let index = 0; index < argv.length; index += 2) {
		if (!allowed.has(argv[index])) throw new Error('unknown argument: ' + argv[index]);
		if (index + 1 >= argv.length) throw new Error(argv[index] + ' requires a path');
	}
	const extensionsPath = valueAfter(argv, '--extensions-package');
	const realtimePath = valueAfter(argv, '--realtime-package');
	const extensionsPackage = extensionsPath === null ? null : readPackage(extensionsPath);
	const realtimePackage = realtimePath === null ? null : readPackage(realtimePath);
	const errors = validateRelatedProjects({
		readme: readFileSync(readmePath, 'utf8'),
		extensionsPackage,
		realtimePackage
	});
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	console.log(
		extensionsPackage === null
			? 'related projects: local snapshot and import path valid'
			: 'related projects: exact sibling manifests and import export valid'
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('related projects check failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
