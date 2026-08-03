import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gt as semverGreater, valid as validSemver } from 'semver';
import { anchorsOf } from './check-links.js';

const START = '<!-- consumer-release-summary:start -->';
const END = '<!-- consumer-release-summary:end -->';
const FIELDS = ['Affects', 'Action', 'Requires', 'Compatibility', 'Detail'];
const KINDS = ['Added', 'Changed', 'Fixed'];
const ROOT = new URL('../', import.meta.url);
const DOCS_ROOT = new URL('docs/', ROOT);
const RELEASES_ROOT = new URL('docs/releases/', ROOT);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')).version;

// Grandfather clause: engineering history up to and including this baseline is
// frozen as written and its bullets keep their original length. Every release
// whose version is newer than the baseline must keep each engineering bullet
// at or under MAX_ENGINEERING_BULLET_CHARS characters; split an oversized
// bullet into focused bullets instead of raising the bound.
const ENGINEERING_BULLET_BASELINE = '0.6.0-next.91';
const MAX_ENGINEERING_BULLET_CHARS = 2000;

function markdownWords(value) {
	const visible = value
		.replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1')
		.replace(/[`*_]/g, ' ');
	return visible.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
}

function oneSentence(value) {
	return (value.match(/[.!?](?=\s|$)/g) ?? []).length === 1 && /[.!?]$/.test(value);
}

function validCalendarDate(value) {
	const parsed = new Date(value + 'T00:00:00.000Z');
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function releaseHeadings(source) {
	const normalized = source.replace(/\r\n/g, '\n');
	const archiveVersions = [];
	for (const line of normalized.split('\n')) {
		if (!line.startsWith('## [') || /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/.test(line)) continue;
		const archive = /^## \[([^\]]+)\] and earlier$/.exec(line);
		if (!archive || validSemver(archive[1]) !== archive[1] ||
			!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(archive[1])) {
			throw new Error('CHANGELOG contains a malformed release heading: ' + line);
		}
		archiveVersions.push(archive[1]);
	}
	const headings = [...normalized.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)];
	if (headings.length === 0) throw new Error('CHANGELOG has no release heading');
	const seenVersions = new Set();
	for (const heading of headings) {
		const version = heading[1];
		const date = heading[2];
		if (validSemver(version) !== version || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
			throw new Error('CHANGELOG release version is not a safe exact SemVer: ' + version);
		}
		if (!validCalendarDate(date)) {
			throw new Error('CHANGELOG release date is not a real calendar date: ' + date);
		}
		if (seenVersions.has(version)) throw new Error('CHANGELOG contains duplicate release version: ' + version);
		seenVersions.add(version);
	}
	for (const version of archiveVersions) {
		if (seenVersions.has(version)) throw new Error('CHANGELOG contains duplicate release version: ' + version);
		seenVersions.add(version);
	}
	return { normalized, headings };
}

/** Every dated release block with its exact heading line and body text. */
function datedReleases(source) {
	const { normalized, headings } = releaseHeadings(source);
	return headings.map((heading, index) => ({
		version: heading[1],
		date: heading[2],
		heading: heading[0],
		body: normalized.slice(
			heading.index + heading[0].length,
			headings[index + 1]?.index ?? normalized.length
		)
	}));
}

function newestRelease(source, expectedVersion = PACKAGE_VERSION) {
	const releases = datedReleases(source);
	if (releases[0].version !== expectedVersion) {
		throw new Error(
			'newest CHANGELOG release ' + releases[0].version +
			' does not match package.json version ' + expectedVersion
		);
	}
	return releases[0];
}

/**
 * GitHub's heading slug for the plain-text headings this changelog uses:
 * lowercase, remove every character that is not a letter, digit, whitespace,
 * hyphen, or underscore, then turn each whitespace character into a hyphen.
 * `## [0.6.0-next.91] - 2026-08-01` produces `060-next91---2026-08-01`.
 * Must stay in agreement with slugify() in scripts/check-links.js, which owns
 * the general rule (including inline-markdown stripping these plain headings
 * never need); the release-notes test suite asserts that agreement.
 */
function githubSlug(headingText) {
	return headingText.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

/** The anchor GitHub assigns to a release's own version heading, computed from the actual heading line. */
function releaseAnchor(release) {
	return githubSlug(release.heading.replace(/^#+[ \t]*/, ''));
}

/**
 * Top-level engineering bullets: a `- ` line plus its indented continuation
 * lines. Nested sub-bullets count toward their parent bullet's size.
 */
function engineeringBullets(body) {
	const bullets = [];
	let current = null;
	for (const line of body.split('\n')) {
		if (line.startsWith('- ')) {
			if (current !== null) bullets.push(current);
			current = line;
		} else if (current !== null && /^[ \t]+\S/.test(line)) {
			current += '\n' + line;
		} else if (current !== null) {
			bullets.push(current);
			current = null;
		}
	}
	if (current !== null) bullets.push(current);
	return bullets;
}

export function validateReleaseSummary(source, expectedVersion = PACKAGE_VERSION) {
	const newest = newestRelease(source, expectedVersion);
	const release = newest.body;
	if (release.split(START).length !== 2 || release.split(END).length !== 2) {
		throw new Error('newest release must contain one consumer summary marker pair');
	}
	const start = release.indexOf(START);
	const end = release.indexOf(END);
	if (start < 0 || end <= start) throw new Error('consumer summary markers are out of order');
	if (release.slice(0, start).trim() !== '') {
		throw new Error('consumer summary must be the first content in the newest release');
	}
	const after = release.slice(end + END.length).trimStart();
	if (!after.startsWith('### ')) throw new Error('consumer summary must precede engineering detail');

	const summary = release.slice(start + START.length, end).trim();
	if (/[<>]/.test(summary)) throw new Error('consumer summary cannot hide content in raw HTML');
	const lines = summary.split('\n');
	if (lines.shift() !== '### Consumer summary') throw new Error('consumer summary heading is required');
	const entries = [];
	let index = 0;
	while (index < lines.length) {
		while (lines[index]?.trim() === '') index++;
		if (index >= lines.length) break;
		if (!lines[index].startsWith('- ')) throw new Error('consumer summary contains prose outside an entry');
		let lead = lines[index].slice(2).trim();
		index++;
		while (index < lines.length && /^  (?!- )/.test(lines[index])) {
			lead += ' ' + lines[index].trim();
			index++;
		}
		const match = lead.match(/^\*\*(Added|Changed|Fixed): ([^.]+)\.\*\* (.+)$/);
		if (!match) throw new Error('consumer entry must lead with Added, Changed, or Fixed plus a capability');
		const [, kind, capability, outcome] = match;
		const count = markdownWords(lead);
		if (count < 40 || count > 60) throw new Error(`${kind}: ${capability} lead has ${count} words; expected 40-60`);
		if (!oneSentence(outcome)) throw new Error(`${kind}: ${capability} must have one outcome sentence`);

		const values = {};
		for (const field of FIELDS) {
			const line = lines[index] ?? '';
			const fieldMatch = line.match(/^  - \*\*([^:]+):\*\* (.+)$/);
			if (!fieldMatch || fieldMatch[1] !== field) {
				throw new Error(`${kind}: ${capability} must provide ${FIELDS.join('/')} in order`);
			}
			values[field] = fieldMatch[2];
			index++;
		}
		const expectedAnchor = kind.toLowerCase();
		if (!new RegExp(`^\\[[^\\]]+\\]\\(#${expectedAnchor}\\)\\.$`).test(values.Detail)) {
			throw new Error(`${kind}: ${capability} detail must link to #${expectedAnchor}`);
		}
		entries.push({ kind, capability, outcome, ...values });
	}

	if (entries.length === 0) throw new Error('consumer summary must contain at least one entry');
	// Keep-a-Changelog uses sections as needed: coverage is required exactly
	// for the kind sections the engineering body actually contains, so a
	// Fixed-only release passes with Fixed-only coverage.
	for (const kind of KINDS) {
		const covered = entries.some((entry) => entry.kind === kind);
		const present = new RegExp(`^### ${kind}$`, 'm').test(after);
		if (present && !covered) {
			throw new Error(`consumer summary is missing ${kind} coverage`);
		}
		if (covered && !present) {
			throw new Error(`consumer summary links to missing ${kind} detail`);
		}
	}
	const capabilities = new Set(entries.map((entry) => `${entry.kind}:${entry.capability.toLowerCase()}`));
	if (capabilities.size !== entries.length) throw new Error('consumer summary capabilities must be unique');

	if (semverGreater(newest.version, ENGINEERING_BULLET_BASELINE)) {
		for (const bullet of engineeringBullets(after)) {
			if (bullet.length > MAX_ENGINEERING_BULLET_CHARS) {
				throw new Error(
					`engineering bullet starting "${bullet.slice(2, 62)}" has ${bullet.length} characters; ` +
					`releases after ${ENGINEERING_BULLET_BASELINE} bound each bullet to ` +
					`${MAX_ENGINEERING_BULLET_CHARS} characters, so split it into focused bullets`
				);
			}
		}
	}
	return entries;
}

/** The newest release version string parsed from CHANGELOG.md; importable without running the gate. */
export function newestReleaseVersion(source = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8')) {
	return releaseHeadings(source).headings[0][1];
}

/**
 * The repository-relative consumer page route for a release version. Accepts
 * either an exact SemVer version string or full changelog source, in which
 * case the newest release's version is used.
 */
export function releasePagePath(value) {
	let version;
	if (value.includes('\n')) {
		version = newestRelease(value).version;
	} else {
		version = value;
		if (validSemver(version) !== version || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
			throw new Error('release page version is not a safe exact SemVer: ' + version);
		}
	}
	return `docs/releases/${version}.md`;
}

function isContained(parent, child) {
	const pathFromParent = relative(parent, child);
	return pathFromParent !== '' && pathFromParent !== '..' &&
		!pathFromParent.startsWith('..' + sep) && !isAbsolute(pathFromParent);
}

/** Resolve the generated page only after proving it remains in docs/releases. */
export function releasePageTarget(source) {
	const relativePath = releasePagePath(source);
	const releasesPath = resolve(fileURLToPath(RELEASES_ROOT));
	const targetPath = resolve(fileURLToPath(new URL(relativePath, ROOT)));
	if (dirname(targetPath) !== releasesPath || !isContained(releasesPath, targetPath)) {
		throw new Error('release page target escapes docs/releases: ' + relativePath);
	}
	const repositoryPath = realpathSync(fileURLToPath(ROOT));
	const docsPath = resolve(fileURLToPath(DOCS_ROOT));
	if (existsSync(docsPath) && !isContained(repositoryPath, realpathSync(docsPath))) {
		throw new Error('resolved docs directory escapes the repository');
	}
	if (existsSync(releasesPath)) {
		const realReleasesPath = realpathSync(releasesPath);
		if (!isContained(repositoryPath, realReleasesPath)) {
			throw new Error('resolved docs/releases directory escapes the repository');
		}
		if (existsSync(targetPath) && !isContained(realReleasesPath, realpathSync(targetPath))) {
			throw new Error('resolved release page target escapes docs/releases: ' + relativePath);
		}
	}
	return { relative: relativePath, target: pathToFileURL(targetPath) };
}

/** Render the consumer release route from the validated newest changelog entry. */
export function renderReleasePage(source) {
	const newest = newestRelease(source);
	const entries = validateReleaseSummary(source);
	// The engineering-detail links pin this release's own version-heading
	// anchor. A `#added` style anchor always resolves to the FIRST `### Added`
	// in CHANGELOG.md - the newest release - so an archived page using it
	// would silently point at the wrong release.
	const anchor = releaseAnchor(newest);
	const lines = [
		`# svelte-adapter-uws ${newest.version}`,
		'',
		`Released ${newest.date}.`,
		'',
		'[README](../../README.md) | [migration index](../../MIGRATION.md) | [complete changelog](../../CHANGELOG.md)',
		'',
		'This versioned consumer page is generated from the structured summary in the',
		'complete changelog. Edit that summary, then regenerate this page; do not maintain',
		'a second release narrative here.',
		'',
		'## Consumer changes',
		''
	];
	for (const entry of entries) {
		lines.push(
			`### ${entry.kind}: ${entry.capability}`,
			'',
			entry.outcome,
			'',
			`- **Affects:** ${entry.Affects}`,
			`- **Action:** ${entry.Action}`,
			`- **Requires:** ${entry.Requires}`,
			`- **Compatibility:** ${entry.Compatibility}`,
			`- **Engineering detail:** [${entry.kind} for ${newest.version} in the complete changelog](../../CHANGELOG.md#${anchor}).`,
			''
		);
	}
	return lines.join('\n');
}

function readReleasePages() {
	const pages = new Map();
	const releasesPath = fileURLToPath(RELEASES_ROOT);
	if (!existsSync(releasesPath)) return pages;
	for (const name of readdirSync(releasesPath)) {
		if (name.endsWith('.md')) pages.set(name, readFileSync(new URL(name, RELEASES_ROOT), 'utf8'));
	}
	return pages;
}

/**
 * Every page in docs/releases must name a dated CHANGELOG release, that
 * release's version-heading anchor must exist in CHANGELOG.md, and every
 * CHANGELOG detail link on the page must pin that anchor. This holds for the
 * whole archive, not only the newest page, so an old page cannot silently
 * drift to pointing at a newer release's sections.
 */
export function validateReleasePages(source, pages = readReleasePages()) {
	const releases = datedReleases(source);
	const anchors = anchorsOf(source);
	let links = 0;
	for (const [name, text] of pages) {
		const version = name.slice(0, -'.md'.length);
		const release = releases.find((candidate) => candidate.version === version);
		if (!release) {
			throw new Error(`docs/releases/${name} does not match any dated CHANGELOG release`);
		}
		const anchor = releaseAnchor(release);
		if (!anchors.has(anchor)) {
			throw new Error(`CHANGELOG.md produces no #${anchor} anchor for docs/releases/${name}`);
		}
		for (const match of text.matchAll(/\]\(\.\.\/\.\.\/CHANGELOG\.md#([^)]+)\)/g)) {
			links++;
			if (match[1] !== anchor) {
				throw new Error(
					`docs/releases/${name} links to ../../CHANGELOG.md#${match[1]}; ` +
					`archived detail links must pin the release's own anchor #${anchor}`
				);
			}
		}
	}
	return { pages: pages.size, links };
}

function readRouteDocuments() {
	const documents = {};
	for (const name of ['README.md', 'MIGRATION.md']) {
		documents[name] = readFileSync(new URL(name, ROOT), 'utf8');
	}
	return documents;
}

/**
 * README.md and MIGRATION.md each publish the current-release route; a
 * version bump that forgets either one ships a stale entry point.
 */
export function validateReleaseRouteLinks(source, documents = readRouteDocuments()) {
	const link = './' + releasePagePath(newestReleaseVersion(source));
	const missing = Object.keys(documents).filter((name) => !documents[name].includes(link));
	if (missing.length > 0) {
		throw new Error(
			missing.join(' and ') + ' must contain the current-release link ' + link +
			'; update the current-release links in README.md and MIGRATION.md after a version bump'
		);
	}
	return link;
}

function main() {
	const source = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8');
	const entries = validateReleaseSummary(source);
	let { relative, target } = releasePageTarget(source);
	const expected = renderReleasePage(source);
	if (process.argv.includes('--write')) {
		mkdirSync(RELEASES_ROOT, { recursive: true });
		({ relative, target } = releasePageTarget(source));
		writeFileSync(target, expected);
	} else if (!existsSync(target) || readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== expected) {
		throw new Error(`${relative} is missing or stale; run node scripts/check-release-notes.js --write`);
	}
	const archive = validateReleasePages(source);
	const routeLink = validateReleaseRouteLinks(source);
	console.log(
		`check-release-notes: ${entries.length} consumer entries are action-first and bounded; ` +
		`${relative} matches; ${archive.pages} release page(s) pin ${archive.links} version anchor(s); ` +
		`README.md and MIGRATION.md route ${routeLink}`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error('check-release-notes FAILED: ' + error.message);
		process.exitCode = 1;
	}
}
