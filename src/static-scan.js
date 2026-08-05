// Build-side mirror of the runtime's index-time dotfile exclusion: collect
// what serving will refuse so the build can say so while the file is still in
// front of the developer, instead of a bare 404 in production. Lives apart
// from build-config.js, which is deliberately filesystem-free.

import fs from 'node:fs';
import path from 'node:path';
import { excludedDotPath } from './runtime/utils/dot-path.js';

/**
 * Dot paths under `dir` that static serving will refuse, `/`-separated and
 * relative to `dir`. A refused DIRECTORY is reported once, as `name/`, and is
 * not descended into - an unpacked `.git` would otherwise enumerate thousands
 * of entries into a warning nobody can read.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listExcludedDotPaths(dir) {
	/** @type {string[]} */
	const refused = [];
	scan(dir, '', refused);
	return refused;
}

/**
 * @param {string} dir
 * @param {string} prefix
 * @param {string[]} refused
 */
function scan(dir, prefix, refused) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	// Sorted so the warning lists offenders in a stable order across platforms.
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		// Precompressed siblings mirror serving's own skip: a `.br`/`.gz` file
		// is never standalone-served in any configuration, so it is not an
		// offender to name - and naming it would triple-list one dotfile when
		// the build compressed it.
		if (entry.isFile() && (entry.name.endsWith('.br') || entry.name.endsWith('.gz'))) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (excludedDotPath(rel)) {
			refused.push(entry.isDirectory() ? `${rel}/` : rel);
			continue;
		}
		if (entry.isDirectory()) scan(path.join(dir, entry.name), rel, refused);
	}
}
