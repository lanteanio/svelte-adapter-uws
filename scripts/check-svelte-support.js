#!/usr/bin/env node
/**
 * Keep the public Svelte 4 support row tied to the independently locked
 * application fixture that CI actually installs, checks, builds, and boots.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startMarker = '<!-- svelte-support:start -->';
const endMarker = '<!-- svelte-support:end -->';

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

// The public reproduce sequence and the CI job are two spellings of the same
// first success, so they are generated and checked from one list. The preflight
// sits between install and check in both: it is what makes an unmet native
// prerequisite fail at the prerequisite boundary instead of several steps later
// inside an unrelated command.
const setupSequence = [
	'npm ci --install-links',
	'npm exec -- svelte-adapter-uws-preflight',
	'npm run check',
	'npm run build',
	'npm run smoke'
];

export function loadSvelte4Profile(base = root) {
	const fixture = join(base, 'test', 'fixtures', 'svelte4');
	const pkg = readJson(join(fixture, 'package.json'));
	const lock = readJson(join(fixture, 'package-lock.json'));
	const rootPkg = readJson(join(base, 'package.json'));
	const node = readFileSync(join(base, '.nvmrc'), 'utf8').trim();
	return { fixture, pkg, lock, rootPkg, node };
}

export function renderSvelte4Support(profile) {
	const deps = profile.pkg.dependencies;
	const dev = profile.pkg.devDependencies;
	return [
		startMarker,
		'| Profile | Svelte | SvelteKit | Vite plugin | Vite | Type checker | Node |',
		'|---|---|---|---|---|---|---|',
		'| Locked Svelte 4 | `' + deps.svelte + '` | `' + deps['@sveltejs/kit'] +
			'` | `' + dev['@sveltejs/vite-plugin-svelte'] + '` | `' +
			dev.vite + '` | `' + dev['svelte-check'] + '` | `' + profile.node + '` |',
		'',
		'Reproduce the type/store, build, HTTP, and WebSocket checks from a clean tree.',
		'The preflight runs before the first check so an unmet Node, platform or native',
		'prerequisite stops here rather than inside a later build:',
		'',
		'```bash',
		'cd test/fixtures/svelte4',
		...setupSequence,
		'```',
		endMarker
	].join('\n');
}

function replaceBlock(source, block) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start < 0 || end < start || source.indexOf(startMarker, start + 1) >= 0 ||
		source.indexOf(endMarker, end + 1) >= 0) {
		throw new Error('README must contain one ordered Svelte support block');
	}
	return source.slice(0, start) + block + source.slice(end + endMarker.length);
}

// npm records a bin path without the leading './' a manifest may carry, and
// neither file has to order its keys. Normalise both sides so the comparison
// reports real drift rather than formatting.
function normalizeManifestField(value) {
	const normalized = {};
	for (const key of Object.keys(value || {}).sort()) {
		normalized[key] = typeof value[key] === 'object' && value[key] !== null
			? JSON.stringify(value[key])
			: String(value[key]).replace(/^\.\//, '');
	}
	return normalized;
}

// Presence alone is not the contract - a preflight that runs after the build
// has already missed the boundary it exists to enforce. Position is checked by
// first occurrence, so a repeated step is rejected rather than measured.
function sequenceErrors(source, prefix, label) {
	const errors = [];
	let previousAt = -1;
	let previousStep = '';
	for (const step of setupSequence) {
		const needle = prefix + step;
		const at = source.indexOf(needle);
		if (at < 0) {
			errors.push(label + ' is missing the step: ' + step);
			continue;
		}
		if (source.indexOf(needle, at + 1) >= 0) {
			errors.push(label + ' repeats the step ' + step + ', so its position cannot be checked');
			continue;
		}
		if (at < previousAt) errors.push(label + ' runs ' + step + ' before ' + previousStep);
		previousAt = at;
		previousStep = step;
	}
	return errors;
}

export function validateSvelte4Profile(profile, readme, workflow) {
	const errors = [];
	const exact = (value) => /^\d+\.\d+\.\d+$/.test(value || '');
	const deps = profile.pkg.dependencies || {};
	const dev = profile.pkg.devDependencies || {};
	const expected = {
		svelte: deps.svelte,
		'@sveltejs/kit': deps['@sveltejs/kit'],
		'@sveltejs/vite-plugin-svelte': dev['@sveltejs/vite-plugin-svelte'],
		vite: dev.vite,
		'svelte-check': dev['svelte-check']
	};
	for (const [name, version] of Object.entries(expected)) {
		if (!exact(version)) errors.push(name + ' must be an exact x.y.z version');
		const locked = profile.lock.packages?.['node_modules/' + name]?.version;
		if (locked !== version) errors.push(name + ' lock version disagrees with package metadata');
	}
	if (deps['svelte-adapter-uws'] !== 'file:../../..') {
		errors.push('fixture must install this checkout through file:../../..');
	}
	const lockRoot = profile.lock.packages?.[''];
	for (const field of ['dependencies', 'devDependencies']) {
		const declared = profile.pkg[field] || {};
		const locked = lockRoot?.[field] || {};
		if (JSON.stringify(declared) !== JSON.stringify(locked)) {
			errors.push('lock root ' + field + ' disagrees with package metadata');
		}
	}
	for (const relative of [
		'jsconfig.json', 'svelte.config.js', 'vite.config.js', 'smoke.mjs',
		'src/app.html', 'src/hooks.ws.js', 'src/routes/+page.server.js', 'src/routes/+page.svelte'
	]) {
		if (!existsSync(join(profile.fixture, relative))) errors.push('fixture missing ' + relative);
	}
	if (profile.pkg.scripts?.check !== 'svelte-kit sync && svelte-check --tsconfig ./jsconfig.json') {
		errors.push('fixture check script must run SvelteKit sync and svelte-check');
	}
	if (profile.pkg.scripts?.build !== 'vite build') errors.push('fixture build script must run Vite');
	if (profile.pkg.scripts?.smoke !== 'node smoke.mjs') errors.push('fixture smoke script must be executable');
	// The fixture installs this checkout as a packed dependency, so its lock
	// records the adapter's own manifest. Nothing compared the two, which let the
	// locked profile keep installing a dependency set the adapter no longer
	// declares - the published corner then reproduces a package no consumer gets.
	const packed = profile.lock.packages?.['node_modules/svelte-adapter-uws'];
	const regenerate = '; regenerate with npm install --install-links --package-lock-only in test/fixtures/svelte4';
	if (!packed) {
		errors.push('fixture lock has no packed svelte-adapter-uws entry' + regenerate);
	} else {
		if (packed.resolved !== 'file:../../..') {
			errors.push('packed adapter lock entry resolves to ' + packed.resolved + ' instead of file:../../..');
		}
		if (packed.version !== profile.rootPkg.version) {
			errors.push('packed adapter lock version ' + packed.version +
				' disagrees with the root manifest version ' + profile.rootPkg.version + regenerate);
		}
		for (const field of [
			'dependencies', 'peerDependencies', 'optionalDependencies',
			'peerDependenciesMeta', 'bin', 'engines'
		]) {
			const declared = JSON.stringify(normalizeManifestField(profile.rootPkg[field]));
			const locked = JSON.stringify(normalizeManifestField(packed[field]));
			if (declared !== locked) {
				errors.push('packed adapter lock ' + field + ' disagrees with the root manifest' +
					regenerate + '\n  manifest: ' + declared + '\n  lock:     ' + locked);
			}
		}
	}
	const rendered = renderSvelte4Support(profile);
	// Matched against the README with line endings normalised. The block is
	// rendered with LF, while a CRLF working copy (before the LF checkout
	// attribute, every fresh Windows clone under `core.autocrlf=true`) holds
	// the README as CRLF - so a raw `includes` reported such a tree as stale,
	// and `--write` could not settle it because the next checkout restored the
	// CRLF.
	if (!readme.replace(/\r\n/g, '\n').includes(rendered)) errors.push('README Svelte support block is stale; run node scripts/check-svelte-support.js --write');
	errors.push(...sequenceErrors(rendered, '', 'the published reproduce sequence'));
	if (!workflow.includes('working-directory: test/fixtures/svelte4')) {
		errors.push('test workflow never enters test/fixtures/svelte4');
	}
	errors.push(...sequenceErrors(workflow, 'run: ', 'the Svelte 4 CI job'));
	return errors;
}

export function checkSvelte4Support({ write = false } = {}) {
	const profile = loadSvelte4Profile();
	const readmePath = join(root, 'README.md');
	const workflowPath = join(root, '.github', 'workflows', 'test.yml');
	let readme = readFileSync(readmePath, 'utf8');
	if (write) {
		// Written with LF, like every generated artifact here, so a rewrite on a
		// CRLF working copy cannot leave the file with mixed endings.
		readme = replaceBlock(readme, renderSvelte4Support(profile)).replace(/\r\n/g, '\n');
		writeFileSync(readmePath, readme);
	}
	const errors = validateSvelte4Profile(profile, readme, readFileSync(workflowPath, 'utf8'));
	if (errors.length) throw new Error(errors.join('\n'));
	console.log(
		'check-svelte-support: Svelte ' + profile.pkg.dependencies.svelte +
		', Kit ' + profile.pkg.dependencies['@sveltejs/kit'] +
		', plugin ' + profile.pkg.devDependencies['@sveltejs/vite-plugin-svelte'] +
		', Vite ' + profile.pkg.devDependencies.vite + ' - locked profile and CI agree.'
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		checkSvelte4Support({ write: process.argv.includes('--write') });
	} catch (error) {
		console.error('check-svelte-support FAILED: ' + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}
