import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(url) {
	try {
		return JSON.parse(readFileSync(url, 'utf8'));
	} catch {
		return null;
	}
}

function firstJson(urls) {
	for (const url of urls) {
		const value = readJson(url);
		if (value !== null) return value;
	}
	return null;
}

function protocolRevision(schema) {
	const id = typeof schema?.$id === 'string' ? schema.$id : '';
	const title = typeof schema?.title === 'string' ? schema.title : '';
	const match = /(?:revision[- ]|rev(?:ision)?[- ]?)(\d+)/i.exec(id) ||
		/(?:revision|rev)\s+(\d+)/i.exec(title);
	return match ? Number(match[1]) : null;
}

/**
 * Resolve a sibling package through Node's runtime resolver, then walk from
 * the resolved entry to that package's own package.json. No static import is
 * used: absent optional siblings remain absent, and a present sibling reports
 * the version this process actually resolved.
 *
 * Absence is only what the resolver itself calls absence
 * (ERR_MODULE_NOT_FOUND). Every other failure - an exports map that does not
 * expose the probed entry, an invalid package config, an entry that resolves
 * but belongs to no readable package - means something IS there that cannot
 * be read, and printing that as 'not installed' would send an operator
 * comparing version tuples in exactly the wrong direction.
 */
export function resolvedPackageVersion(specifier, expectedName) {
	let entry;
	try {
		entry = import.meta.resolve(specifier);
	} catch (error) {
		return error?.code === 'ERR_MODULE_NOT_FOUND' ? null : 'unresolvable';
	}
	try {
		if (entry.startsWith('file:')) {
			let directory = dirname(fileURLToPath(entry));
			for (let depth = 0; depth < 12; depth++) {
				const candidate = join(directory, 'package.json');
				if (existsSync(candidate)) {
					const pkg = readJson(candidate);
					if (pkg?.name === expectedName && typeof pkg.version === 'string') {
						return pkg.version;
					}
				}
				const parent = dirname(directory);
				if (parent === directory) break;
				directory = parent;
			}
		}
	} catch {
		// Resolved, but the walk could not read a matching package.json.
	}
	return 'unresolvable';
}

/**
 * Versions attached to startup and diagnostic output.
 *
 * Production builds carry the adapter package.json and protocol schema under
 * build/meta; source/test execution falls back to the repository copies.
 * The protocol revision is parsed from the schema id/title, never duplicated
 * as a constant.
 */
export function readRuntimeVersionInfo() {
	const adapterPackage = firstJson([
		new URL('./meta/svelte-adapter-uws/package.json', import.meta.url),
		new URL('../../package.json', import.meta.url)
	]);
	const schema = firstJson([
		new URL('./meta/protocol.schema.json', import.meta.url),
		new URL('../../protocol.schema.json', import.meta.url)
	]);
	return {
		adapter: typeof adapterPackage?.version === 'string' ? adapterPackage.version : null,
		protocolRevision: protocolRevision(schema),
		realtime: resolvedPackageVersion('svelte-realtime', 'svelte-realtime'),
		extensions: resolvedPackageVersion(
			'svelte-adapter-uws-extensions/testing',
			'svelte-adapter-uws-extensions'
		)
	};
}

function shown(value) {
	return value === null ? 'not installed' : String(value);
}

export function formatVersionBanner(info) {
	return (
		'svelte-adapter-uws ' + shown(info.adapter) +
		' (protocol rev ' + shown(info.protocolRevision) +
		', svelte-realtime ' + shown(info.realtime) +
		', svelte-adapter-uws-extensions ' + shown(info.extensions) + ')'
	);
}

export const runtimeVersionInfo = Object.freeze(readRuntimeVersionInfo());
