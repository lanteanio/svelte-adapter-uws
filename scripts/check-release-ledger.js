import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lte as semverLte, valid as validSemver } from 'semver';

const ROOT = new URL('../', import.meta.url);
const PACKAGE_NAME = 'svelte-adapter-uws';

// The one accepted spelling of "this heading's version was never accepted by
// the registry". It sits on the first body line under the heading.
export const NOT_PUBLISHED_MARKER = '*Not published to npm; superseded before release.*';

const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SHASUM = /^[0-9a-f]{40}$/;

function tableCells(line) {
	return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

/** Rows of the published-releases table in docs/release-manifest.md. */
export function manifestReleases(manifest) {
	const lines = manifest.replace(/\r\n/g, '\n').split('\n');
	const start = lines.indexOf('## Published releases');
	if (start === -1) throw new Error('release manifest has no "## Published releases" section');
	const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
	const section = lines.slice(start + 1, end === -1 ? lines.length : end);
	const table = section.filter((line) => line.startsWith('|'));
	if (table.length < 2) throw new Error('release manifest has no published-releases table');
	const headers = tableCells(table[0]);
	return table.slice(2).map((line) => {
		const cells = tableCells(line);
		return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
	});
}

/**
 * Dated version headings in CHANGELOG.md, each with whether its first body
 * line carries the not-published marker, plus the version of the one optional
 * `## [x.y.z] and earlier` archive heading, which covers that version and
 * every earlier published version collectively.
 */
export function changelogHeadings(changelog) {
	const lines = changelog.replace(/\r\n/g, '\n').split('\n');
	const headings = [];
	let archiveVersion = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.startsWith('## [')) continue;
		const archive = /^## \[([^\]]+)\] and earlier$/.exec(line);
		if (archive) {
			if (validSemver(archive[1]) !== archive[1]) {
				throw new Error('CHANGELOG archive heading is not an exact SemVer: ' + line);
			}
			if (archiveVersion !== null) throw new Error('CHANGELOG has more than one archive heading');
			archiveVersion = archive[1];
			continue;
		}
		const dated = /^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/.exec(line);
		if (!dated) throw new Error('CHANGELOG contains a malformed release heading: ' + line);
		if (validSemver(dated[1]) !== dated[1]) {
			throw new Error('CHANGELOG release version is not an exact SemVer: ' + line);
		}
		let body = index + 1;
		while (body < lines.length && lines[body].trim() === '' ) body++;
		headings.push({
			version: dated[1],
			marked: lines[body]?.trim() === NOT_PUBLISHED_MARKER
		});
	}
	return { headings, archiveVersion };
}

/**
 * Reconcile the published-releases ledger against the changelog without the
 * network: every published version must have exactly one heading (or fall
 * under the archive heading), every heading the registry never accepted must
 * carry the not-published marker, the current package version must be neither
 * published nor marked, and every ledger row must be well formed.
 */
export function validateReleaseLedger(manifest, changelog, currentVersion) {
	const errors = [];
	let rows;
	try {
		rows = manifestReleases(manifest);
	} catch (error) {
		return [error.message];
	}
	let parsed;
	try {
		parsed = changelogHeadings(changelog);
	} catch (error) {
		return [error.message];
	}
	const { headings, archiveVersion } = parsed;

	const publishedVersions = new Set();
	for (const row of rows) {
		const label = row.Package + '@' + row.Version;
		if (row.Package !== PACKAGE_NAME) {
			errors.push('manifest row names an unknown package: ' + label);
			continue;
		}
		if (validSemver(row.Version) !== row.Version) {
			errors.push('manifest row version is not an exact SemVer: ' + label);
			continue;
		}
		if (publishedVersions.has(row.Version)) {
			errors.push('manifest contains a duplicate published row: ' + label);
			continue;
		}
		publishedVersions.add(row.Version);
		const published = row['Published UTC'] ?? '';
		if (!CANONICAL_UTC.test(published) || new Date(published).toISOString() !== published) {
			errors.push('manifest row has a non-canonical Published UTC: ' + label);
		}
		if (!INTEGRITY.test(row['npm integrity'] ?? '')) {
			errors.push('manifest row has a missing or malformed npm integrity: ' + label);
		}
		if (!SHASUM.test(row['npm shasum'] ?? '')) {
			errors.push('manifest row has a missing or malformed npm shasum: ' + label);
		}
	}

	const headingByVersion = new Map();
	for (const heading of headings) {
		if (headingByVersion.has(heading.version)) {
			errors.push('CHANGELOG contains a duplicate release heading: ' + heading.version);
			continue;
		}
		headingByVersion.set(heading.version, heading);
	}

	let archived = 0;
	for (const version of publishedVersions) {
		const heading = headingByVersion.get(version);
		if (heading) {
			if (heading.marked) {
				errors.push('published version carries the not-published marker: ' + version);
			}
			continue;
		}
		if (archiveVersion !== null && semverLte(version, archiveVersion)) {
			archived++;
			continue;
		}
		errors.push('published version has no changelog heading: ' + version);
	}
	if (archiveVersion !== null && !publishedVersions.has(archiveVersion)) {
		errors.push('archive heading names a version the manifest does not record: ' + archiveVersion);
	}

	let marked = 0;
	for (const heading of headings) {
		if (heading.marked) marked++;
		if (publishedVersions.has(heading.version)) continue;
		if (heading.version === currentVersion) continue;
		if (!heading.marked) {
			errors.push(
				'changelog heading names a version the registry never accepted, without the ' +
				'not-published marker: ' + heading.version
			);
		}
	}

	// The working head is exempt from the marker by rule, not by accident: it
	// is unpublished today and must read as a normal release entry, so it can
	// carry neither the marker nor a manifest row.
	if (publishedVersions.has(currentVersion)) {
		errors.push('current package version has a manifest row while still unpublished: ' + currentVersion);
	}
	const currentHeading = headingByVersion.get(currentVersion);
	if (currentHeading?.marked) {
		errors.push('current package version must not carry the not-published marker: ' + currentVersion);
	}

	return errors.length > 0 ? errors : {
		rows: rows.length,
		headings: headings.length,
		archived,
		marked
	};
}

function main() {
	const manifest = readFileSync(new URL('docs/release-manifest.md', ROOT), 'utf8');
	const changelog = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8');
	const currentVersion = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')).version;
	const result = validateReleaseLedger(manifest, changelog, currentVersion);
	if (Array.isArray(result)) throw new Error(result.join('\n- '));
	console.log(
		`check-release-ledger: ${result.rows} published rows reconcile with ` +
		`${result.headings} dated changelog headings (${result.archived} covered by the archive heading, ` +
		`${result.marked} marked not published); current ${currentVersion} is unpublished and unmarked`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error('check-release-ledger failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
