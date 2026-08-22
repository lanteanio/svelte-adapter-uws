#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, '.github', 'workflows', 'release.yml');
const packagePath = resolve(root, 'package.json');
const policyPath = resolve(root, 'docs/releasing.md');

const CHECKOUT = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
const SETUP_NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const UPLOAD_ARTIFACT = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const DOWNLOAD_ARTIFACT = 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';
const ARTIFACT_NAME = 'npm-candidate-${{ github.run_attempt }}';

function keys(value) {
	return Object.keys(value || {}).slice().sort();
}

function same(value, expected) {
	return JSON.stringify(value) === JSON.stringify(expected);
}

function sameKeys(value, expected) {
	return same(keys(value), expected.slice().sort());
}

function normalized(value) {
	return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

// The one mutable script between verification and publication, so a single
// interior edit (an added download, an extra Copy-Item over the tarball) is an
// artifact swap. Substring checks cannot see an ADDED line; only whole-body
// equality closes that class.
const PACK_RUN = [
	"$ErrorActionPreference = 'Stop'",
	'New-Item -ItemType Directory -Force release-artifacts | Out-Null',
	'$packJson = npm pack --json --pack-destination release-artifacts',
	"if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }",
	'$records = @($packJson | ConvertFrom-Json)',
	"if ($records.Count -ne 1) { throw 'npm pack did not return exactly one artifact' }",
	'$filename = [IO.Path]::GetFileName([string]$records[0].filename)',
	"if ($filename -notmatch '^[a-z0-9._-]+\\.tgz$') { throw 'npm pack returned an unsafe artifact name' }",
	"$tarball = 'release-artifacts/' + $filename",
	"if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) { throw 'retained tarball is missing' }",
	'$sha256 = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()',
	"'tarball=' + $tarball >> $env:GITHUB_OUTPUT",
	"'filename=' + $filename >> $env:GITHUB_OUTPUT",
	"'sha256=' + $sha256 >> $env:GITHUB_OUTPUT"
].join(' ');

// The transfer between the two jobs is the one place the verified bytes leave
// this workflow's control. download-artifact's own digest check reports a
// mismatch as a warning and lets the job continue, so only an explicit
// comparison can stop a publication. Whole-body equality again: an added line
// here could overwrite the tarball after the comparison and before the publish.
const DIGEST_RUN = [
	"$ErrorActionPreference = 'Stop'",
	"$expected = '${{ needs.verify.outputs.sha256 }}'",
	"if ($expected -notmatch '^[0-9a-f]{64}$') { throw 'the verify job produced no usable digest' }",
	"$filename = '${{ needs.verify.outputs.filename }}'",
	"if ($filename -notmatch '^[a-z0-9._-]+\\.tgz$') { throw 'refusing an unsafe artifact name' }",
	"$tarball = 'release-artifacts/' + $filename",
	"if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) { throw 'downloaded tarball is missing' }",
	'$actual = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()',
	"if ($actual -ne $expected) { throw 'downloaded tarball is not the verified artifact' }",
	"'verified digest ' + $actual"
].join(' ');

// Each entry is the COMPLETE step: its key inventory is closed to exactly the
// keys named here. A step-level `if:` skips the verifier, `continue-on-error:`
// makes its refusal advisory, `env:` (NODE_OPTIONS, npm_config_registry)
// preloads code into an exact-matched command, and `shell:` replaces the
// interpreter with an arbitrary command template - none of which touch a name,
// an order, or a body. Only `Pack retained artifact` may carry `id`/`shell`,
// and only `Refuse to publish anything but the verified bytes` may carry
// `shell` - both need pwsh, and neither may acquire anything else.
const VERIFY_STEPS = [
	{ name: 'Check out immutable tag', uses: CHECKOUT, with: { ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false } },
	{ name: 'Set up pinned Node and npm registry', uses: SETUP_NODE, with: { 'node-version-file': '.nvmrc', 'registry-url': 'https://registry.npmjs.org' } },
	{ name: 'Install locked root dependencies', run: 'npm ci' },
	// The verifier imports installed dependencies at module load, so it must
	// run AFTER npm ci - an earlier order killed every tag push with
	// ERR_MODULE_NOT_FOUND before any check could refuse.
	{ name: 'Verify tag, package, and source identity', run: 'node scripts/prepare-release.js' },
	{ name: 'Install locked fixture dependencies', run: 'npm ci --prefix test/fixture' },
	{ name: 'Run the complete pull-request verification contract', run: 'npm run verify:pr' },
	{ name: 'Run the publication lifecycle gate', run: 'npm run prepublishOnly' },
	{ name: 'Pack retained artifact', id: 'pack', shell: 'pwsh', run: PACK_RUN },
	{
		name: 'Retain exact publication artifact',
		uses: UPLOAD_ARTIFACT,
		with: { name: ARTIFACT_NAME, path: '${{ steps.pack.outputs.tarball }}', 'if-no-files-found': 'error', 'retention-days': 90 }
	}
];

const PUBLISH_STEPS = [
	{ name: 'Check out immutable tag', uses: CHECKOUT, with: { ref: '${{ github.sha }}', 'fetch-depth': 1, 'persist-credentials': false } },
	{ name: 'Set up pinned Node and npm registry', uses: SETUP_NODE, with: { 'node-version-file': '.nvmrc', 'registry-url': 'https://registry.npmjs.org' } },
	{ name: 'Install OIDC-capable npm', run: 'npm install --global npm@11.5.1' },
	{ name: 'Download the retained publication artifact', uses: DOWNLOAD_ARTIFACT, with: { name: ARTIFACT_NAME, path: 'release-artifacts' } },
	{ name: 'Refuse to publish anything but the verified bytes', shell: 'pwsh', run: DIGEST_RUN },
	{ name: 'Publish exact tarball to quarantine with trusted OIDC', run: 'npm publish "release-artifacts/${{ needs.verify.outputs.filename }}" --tag candidate' }
];

// The closed inventory of package scripts, pinned to their exact bodies.
// npm implicitly executes the pre<name>/post<name> companion of every script
// it runs, so the name SPACE is one attack surface - see the scripts check
// in validateReleaseWorkflow - and a body is the other half: the release
// path runs several of these by name, so an edited body (a check reduced to
// a no-op) would weaken the verification the workflow claims to run while
// every name pin stayed green. Presence AND content are therefore both
// closed. Editing a script is a deliberate change to this inventory in the
// same commit, where the diff of the gate shows exactly what the release
// path will now run - the protocol, not a workaround. pretest and
// postinstall are themselves implicit companions and belong here because
// they run BEFORE the verification steps, where their effects are still
// tested.
const EXPECTED_SCRIPTS = {
	'check': 'node scripts/check-compatibility.js && node scripts/check-formatting.js && node scripts/check-contributor-map.js && node scripts/check-svelte-support.js && node scripts/generate-error-reference.js --check && node scripts/check-migration-freshness.js && node scripts/check-release-notes.js && node scripts/check-release-ledger.js && node scripts/check-release-workflow.js && node scripts/generate-api-docs.js --check && node scripts/check-doc-code.js && node scripts/check-documentation-contract.js && node scripts/check-operations-pack.js && node scripts/check-capacity-kit.js && node scripts/generate-observability.js --check && node scripts/generate-privacy-integration.js --check && node scripts/check-types.js && node scripts/check-entry-points.js && node scripts/check-diagnostic-attribution.js && node scripts/check-console-index.js && node scripts/check-determinism.js && node scripts/check-slugs.js && node scripts/check-uws-pin.js && node scripts/check-uws-binaries.js && node scripts/check-related-projects.js && node scripts/check-links.js && node scripts/check-scope.js && node --no-warnings --experimental-vm-modules scripts/check-syntax.js',
	'pretest': 'npm run check',
	'postinstall': 'node scripts/check-native-install.js',
	'prepublishOnly': 'npm run check',
	'check:publish': 'publint && attw --pack . --profile esm-only',
	'check:links': 'node scripts/check-links.js',
	'check:entry-points': 'node scripts/check-entry-points.js',
	'check:docs-code': 'node scripts/check-doc-code.js',
	'check:documentation': 'node scripts/check-documentation-contract.js',
	'check:operations': 'node scripts/check-operations-pack.js',
	'check:capacity': 'node scripts/check-capacity-kit.js',
	'capacity:run': 'node scripts/capacity/open-arrival.mjs',
	'check:privacy': 'node scripts/generate-privacy-integration.js --check',
	'privacy:generate': 'node scripts/generate-privacy-integration.js',
	'drill:operations': 'node scripts/check-operations-pack.js',
	'drill:respawner': 'node scripts/drill-respawner.js',
	'check:errors': 'node scripts/generate-error-reference.js --check',
	'check:migration': 'node scripts/check-migration-freshness.js',
	'doctor': 'node scripts/doctor.js',
	'smoke': 'node scripts/smoke.js',
	'bootstrap': 'node scripts/bootstrap.js',
	'test': 'vitest run',
	'test:watch': 'vitest',
	'test:e2e': 'npx playwright test --config test/e2e/playwright.config.js',
	'test:coverage': 'node scripts/coverage.js',
	'test:floor': 'vitest run test/client test/crdt- test/cursor-handle test/cursor-viewport-client test/lease-client test/presence-client test/presence-heartbeat test/smooth-channel test/smooth-interpolate test/smooth-wire-view test/utils test/wire-client test/wire-sink',
	'sim:swarm': 'node scripts/sim-swarm.js',
	'sim:golden': 'node scripts/sim-golden.js',
	'verify:fast': 'node scripts/verify.js fast',
	'verify:docs': 'node scripts/check-related-projects.js && node scripts/check-links.js && node scripts/check-entry-points.js && node scripts/generate-api-docs.js --check && node scripts/check-doc-code.js && node scripts/check-documentation-contract.js && node scripts/generate-error-reference.js --check && node scripts/check-migration-freshness.js && vitest run test/related-projects.test.js test/docs-map.test.js test/api-docs-contract.test.js test/entry-point-catalog.test.js test/doc-code-contract.test.js test/documentation-contract.test.js test/error-reference.test.js test/packed-readme-examples.test.js test/migration-lifecycle.test.js test/migration-rehearsal.test.js test/compatibility-contract.test.js',
	'verify:suite': 'node scripts/verify.js suite',
	'verify:sim': 'node scripts/verify.js sim',
	'verify:pr': 'npm run verify:suite && npm run verify:sim',
	'verify:full': 'npm run verify:pr && npm run test:e2e'
};

function checkSteps(errors, jobName, job, expected) {
	const steps = Array.isArray(job.steps) ? job.steps : [];
	const actualNames = steps.map((step) => step?.name);
	const expectedNames = expected.map((step) => step.name);
	if (!same(actualNames, expectedNames)) {
		errors.push(
			jobName + ' steps must be exactly, in order: ' + expectedNames.join(' -> ') +
			' - got: ' + actualNames.join(' -> ')
		);
		return;
	}
	for (const [index, step] of expected.entries()) {
		const actual = steps[index];
		const label = jobName + ' step "' + step.name + '"';
		const extra = keys(actual).filter((key) => !(key in step));
		if (extra.length > 0) errors.push(label + ' carries disallowed keys: ' + extra.join(', '));
		for (const [key, value] of Object.entries(step)) {
			const got = actual[key];
			const ok = key === 'run' ? normalized(got) === normalized(value) : same(got, value);
			if (!ok) errors.push(label + ' has a non-exact ' + key);
		}
	}
}

export function validateReleaseWorkflow(source, pkg, policy) {
	const errors = [];
	let workflow;
	try {
		workflow = parse(source);
	} catch (error) {
		return ['release workflow is not valid YAML: ' + error.message];
	}
	// Closed key inventories at EVERY level, not just steps: a job-level or
	// workflow-level `env:` (NODE_OPTIONS, npm_config_registry) is inherited
	// by every exact-matched run command, `defaults.run.shell` wraps them in
	// an attacker template, and `container:` swaps the whole execution image
	// - each without touching any pinned name, order, or body.
	if (!sameKeys(workflow, ['name', 'on', 'permissions', 'concurrency', 'jobs'])) {
		errors.push('release workflow key inventory is not exact: ' + keys(workflow).join(', '));
	}
	if (!same(keys(workflow.on), ['push'])) errors.push('release workflow must have only a push trigger');
	if (!same(workflow.on?.push?.tags, ['svelte-adapter-uws@*'])) {
		errors.push('release workflow must trigger only on package version tags');
	}
	// The trigger filter is a closed inventory too. Defining only `tags` is
	// what keeps branch pushes out; adding `branches-ignore` re-admits every
	// branch, and the verify job would then run npm ci - which executes that
	// branch's lifecycle scripts - before the identity verifier runs.
	if (!same(keys(workflow.on?.push), ['tags'])) {
		errors.push('release workflow push trigger must carry exactly the tags filter');
	}
	if (source.includes('workflow_dispatch')) {
		errors.push('release workflow must not have a branch or manual-dispatch path');
	}
	if (!same(workflow.permissions, { contents: 'read' })) errors.push('workflow default permission must be contents read');
	if (!same(Object.keys(workflow.jobs || {}), ['verify', 'publish'])) {
		errors.push('release workflow must have exactly the verify and publish jobs, in that order');
	}

	// `id-token: write` is a JOB-scoped grant. Splitting the workflow is what
	// keeps the publication identity away from `npm ci` and the suite, where
	// any third-party lifecycle script would otherwise be able to mint an OIDC
	// token and publish. The split is only real while `verify` cannot mint one
	// and `publish` never installs a dependency tree.
	const verify = workflow.jobs?.verify;
	if (!verify) return errors;
	if (!sameKeys(verify, ['name', 'runs-on', 'timeout-minutes', 'permissions', 'outputs', 'steps'])) {
		errors.push('verify job key inventory is not exact: ' + keys(verify).join(', '));
	}
	if (verify['runs-on'] !== 'ubuntu-latest') errors.push('verify job must use a GitHub-hosted runner');
	if (!same(verify.permissions, { contents: 'read' })) {
		errors.push('verify job permissions must be exactly contents read - it must never hold a publication identity');
	}
	// The digest is an output, not a file beside the tarball: an output is
	// written by the verify job and read by the publish job through the run
	// context, so it does not travel inside the artifact it authenticates.
	if (!same(verify.outputs, {
		filename: '${{ steps.pack.outputs.filename }}',
		sha256: '${{ steps.pack.outputs.sha256 }}'
	})) {
		errors.push('verify job must publish exactly the packed filename and its digest as outputs');
	}
	checkSteps(errors, 'verify job', verify, VERIFY_STEPS);

	const publish = workflow.jobs?.publish;
	if (!publish) return errors;
	if (!sameKeys(publish, ['name', 'needs', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'steps'])) {
		errors.push('publish job key inventory is not exact: ' + keys(publish).join(', '));
	}
	if (publish['runs-on'] !== 'ubuntu-latest') errors.push('trusted publishing must use a GitHub-hosted runner');
	if (publish.needs !== 'verify' && !same(publish.needs, ['verify'])) {
		errors.push('publish job must depend on the verify job');
	}
	if (publish.environment !== 'npm-release') errors.push('publish job must use the protected npm-release environment');
	if (!same(publish.permissions, { contents: 'read', 'id-token': 'write' })) {
		errors.push('publish job permissions must be exactly contents read and id-token write');
	}
	checkSteps(errors, 'publish job', publish, PUBLISH_STEPS);

	const actionRefs = [...verify.steps, ...publish.steps].filter((step) => step?.uses).map((step) => step.uses);
	if (actionRefs.length !== 6 || actionRefs.some((ref) => !/@[0-9a-f]{40}$/.test(ref))) {
		errors.push('release workflow must use exactly six fully pinned actions');
	}
	if (source.includes('NODE_AUTH_TOKEN') || source.includes('secrets.') ||
		/\bnpm\s+publish\s+(?:\.|--)/.test(source)) {
		errors.push('release workflow must not contain token fallback or source-directory publication');
	}
	// npm pack runs prepack, prepare, and postpack around tarball creation -
	// AFTER every explicit verification step in the verify job - and npm run
	// implicitly executes the pre<name> and post<name> companions of every
	// script it runs, so ANY unexpected script name can put code inside the
	// window between the last check and the bytes that are hashed: a
	// postprepublishOnly lands exactly there, and postpack can swap the
	// finished tarball on disk before the hash step reads it. That namespace
	// cannot be enumerated by a blocklist, so the scripts object is a closed
	// inventory like every other level of this file: a name outside the list
	// does not exist yet, and adding one is a deliberate review of where npm
	// will implicitly run it. Removals are refused too - the release path
	// runs several of these by name, and a silent removal would move that
	// failure from this gate to the middle of a tag build. BODIES are pinned
	// beside the names, because presence alone leaves the other half open: an
	// edited body turns a check the workflow claims to run into whatever the
	// edit says, without moving a single pinned name - so a body change must
	// move this inventory in the same commit, where the gate's own diff shows
	// what the release path will now run.
	// Object.hasOwn, not `in`: a manifest script named after a prototype key
	// (constructor, toString, __proto__ arrives as an own property from
	// JSON.parse) must be refused as OUTSIDE the inventory, not as a body
	// mismatch against a pin that never existed.
	const scripts = pkg.scripts ?? {};
	for (const [name, body] of Object.entries(scripts)) {
		if (!Object.hasOwn(EXPECTED_SCRIPTS, name)) {
			errors.push('package script is outside the closed inventory: ' + name);
		} else if (body !== EXPECTED_SCRIPTS[name]) {
			errors.push(
				'package script "' + name + '" does not match its pinned body - an edit here changes what ' +
				'the release path runs, so it must move the pin in scripts/check-release-workflow.js in the same change'
			);
		}
	}
	for (const name of Object.keys(EXPECTED_SCRIPTS)) {
		if (!Object.hasOwn(scripts, name)) {
			errors.push('package script is missing from the closed inventory: ' + name);
		}
	}
	for (const phrase of [
		'npm trusted publisher',
		'release.yml',
		'npm-release',
		'required reviewers',
		'candidate',
		'no token fallback'
	]) {
		if (!policy.includes(phrase)) errors.push('release policy is missing trusted-publisher setup: ' + phrase);
	}
	return errors;
}

function main() {
	const source = readFileSync(workflowPath, 'utf8');
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
	const policy = readFileSync(policyPath, 'utf8');
	const errors = validateReleaseWorkflow(source, pkg, policy);
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	console.log('check-release-workflow: tag-only trusted OIDC publication path is structurally closed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('check-release-workflow failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
