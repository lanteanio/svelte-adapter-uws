#!/usr/bin/env node
import { createHash } from 'node:crypto';
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
	return typeof value === 'string' ? value.replace(/\r\n/g, '\n').replace(/\n$/, '') : '';
}

// The one mutable script between verification and publication, so a single
// interior edit (an added download, an extra Copy-Item over the tarball) is an
// artifact swap. Substring checks cannot see an ADDED line; only whole-body
// equality closes that class.
const PACK_RUN = [
	"$ErrorActionPreference = 'Stop'",
	'New-Item -ItemType Directory -Force release-artifacts | Out-Null',
	'$packJson = npm run --ignore-scripts --silent pack:release -- --destination release-artifacts',
	"if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }",
	'$records = @($packJson | ConvertFrom-Json)',
	"if ($records.Count -ne 1) { throw 'npm pack did not return exactly one artifact' }",
	'$filename = [IO.Path]::GetFileName([string]$records[0].filename)',
	"if ($filename -notmatch '^[a-z0-9._-]+\\.tgz$') { throw 'npm pack returned an unsafe artifact name' }",
	"$tarball = 'release-artifacts/' + $filename",
	"if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) { throw 'retained tarball is missing' }",
	'$sha256 = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()',
	"$expected = '${{ needs.identity.outputs.sha256 }}'",
	"if ($expected -notmatch '^[0-9a-f]{64}$' -or $sha256 -ne $expected) { throw 'packed tarball differs from the reviewed artifact' }",
	"'tarball=' + $tarball >> $env:GITHUB_OUTPUT",
	"'filename=' + $filename >> $env:GITHUB_OUTPUT",
	"'sha256=' + $sha256 >> $env:GITHUB_OUTPUT"
].join('\n');

// The transfer between the two jobs is the one place the verified bytes leave
// this workflow's control. download-artifact's own digest check reports a
// mismatch as a warning and lets the job continue, so only an explicit
// comparison can stop a publication. Whole-body equality again: an added line
// here could overwrite the tarball after the comparison and before the publish.
const DIGEST_RUN = [
	"$ErrorActionPreference = 'Stop'",
	"$expected = '${{ needs.identity.outputs.sha256 }}'",
	"if ($expected -notmatch '^[0-9a-f]{64}$') { throw 'the identity job produced no usable digest' }",
	"$filename = '${{ needs.identity.outputs.filename }}'",
	"if ($filename -notmatch '^[a-z0-9._-]+\\.tgz$') { throw 'refusing an unsafe artifact name' }",
	"$tarball = 'release-artifacts/' + $filename",
	"if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) { throw 'downloaded tarball is missing' }",
	'$actual = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()',
	"if ($actual -ne $expected) { throw 'downloaded tarball is not the verified artifact' }",
	"'verified digest ' + $actual"
].join('\n');

// Each entry is the COMPLETE step: its key inventory is closed to exactly the
// keys named here. A step-level `if:` skips the verifier, `continue-on-error:`
// makes its refusal advisory, `env:` (NODE_OPTIONS, npm_config_registry)
// preloads code into an exact-matched command, and `shell:` replaces the
// interpreter with an arbitrary command template - none of which touch a name,
// an order, or a body. Only `Pack retained artifact` may carry `id`/`shell`,
// and only `Refuse to publish anything but the verified bytes` may carry
// `shell` - both need pwsh, and neither may acquire anything else.
const IDENTITY_STEPS = [
	{ name: 'Check out immutable tag', uses: CHECKOUT, with: { ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false } },
	{ name: 'Set up pinned Node', uses: SETUP_NODE, with: { 'node-version': '22.23.2' } },
	{ name: 'Verify tag, package, and source identity', id: 'identity', run: 'node scripts/prepare-release.js' },
	{ name: 'Require the protected publication environment', env: { GH_TOKEN: '${{ github.token }}' }, run: 'node scripts/check-release-environment.js' }
];

const VERIFY_STEPS = [
	{ name: 'Check out immutable tag', uses: CHECKOUT, with: { ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false } },
	{ name: 'Set up pinned Node and npm registry', uses: SETUP_NODE, with: { 'node-version-file': '.nvmrc', 'registry-url': 'https://registry.npmjs.org' } },
	{ name: 'Install pinned pack CLI', run: 'npm install --global --ignore-scripts npm@11.5.1' },
	{ name: 'Install locked root dependencies', run: 'npm ci' },
	{ name: 'Verify the closed publication contract', run: 'node scripts/check-release-workflow.js' },
	{ name: 'Pack retained artifact', id: 'pack', shell: 'pwsh', run: PACK_RUN },
	{ name: 'Retain exact publication artifact', uses: UPLOAD_ARTIFACT,
		with: { name: ARTIFACT_NAME, path: '${{ steps.pack.outputs.tarball }}', 'if-no-files-found': 'error', 'retention-days': 90 } }
];

const PUBLISH_STEPS = [
	{ name: 'Set up pinned Node and npm registry', uses: SETUP_NODE, with: { 'node-version': '22.23.2', 'registry-url': 'https://registry.npmjs.org' } },
	{ name: 'Install OIDC-capable npm', run: 'npm install --global --ignore-scripts npm@11.5.1' },
	{ name: 'Download the retained publication artifact', uses: DOWNLOAD_ARTIFACT, with: { name: ARTIFACT_NAME, path: 'release-artifacts' } },
	{ name: 'Refuse to publish anything but the verified bytes', shell: 'pwsh', run: DIGEST_RUN },
	{ name: 'Publish exact tarball to quarantine with trusted OIDC', run: 'npm publish "release-artifacts/${{ needs.identity.outputs.filename }}" --tag candidate --registry=https://registry.npmjs.org --provenance' }
];

// npm script names and bodies are closed so implicit companion hooks cannot
// modify the artifact between verification and packing.
const EXPECTED_SCRIPTS = {
	"test": "vitest run",
	"test:watch": "vitest",
	"test:e2e": "npx playwright test --config test/e2e/playwright.config.js",
	"test:coverage": "node scripts/coverage.js",
	"pack:release": "node scripts/pack-release.js"
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

export function validateReleaseWorkflow(source, pkg, policy, testSource) {
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
	// One run per tag, and a running publication is never cancelled midway.
	if (!same(workflow.concurrency, { group: 'release-${{ github.ref }}', 'cancel-in-progress': false })) {
		errors.push('release workflow must queue runs per tag without cancelling one in progress');
	}
	if (!same(Object.keys(workflow.jobs || {}), ['identity', 'tests', 'verify', 'publish'])) {
		errors.push('release workflow must have exactly the identity, tests, verify and publish jobs, in that order');
	}

	// `id-token: write` is a JOB-scoped grant. Splitting the workflow is what
	// keeps the publication identity away from `npm ci` and the suite, where
	// any third-party lifecycle script would otherwise be able to mint an OIDC
	// token and publish. The split is only real while `verify` cannot mint one
	// and `publish` never installs a dependency tree.
	const identity = workflow.jobs?.identity;
	if (!identity || !sameKeys(identity, ['name', 'runs-on', 'timeout-minutes', 'permissions', 'outputs', 'steps']) ||
		identity['runs-on'] !== 'ubuntu-latest' || !same(identity.permissions, { contents: 'read' }) ||
		!same(identity.outputs, { sha256: '${{ steps.identity.outputs.sha256 }}', filename: '${{ steps.identity.outputs.filename }}' })) {
		errors.push('identity job must bind the tag without dependencies or publication credentials');
	}
	if (identity) checkSteps(errors, 'identity job', identity, IDENTITY_STEPS);
	if (!same(workflow.jobs?.tests, { needs: 'identity', uses: './.github/workflows/test.yml', permissions: { contents: 'read' } })) {
		errors.push('tests job must call the complete local verification workflow with read-only permissions');
	}
	const expectedTests = '5bc100715da07953b54454f48713c3b87908d8308741d008c3b9fcaa35859b05';
	if (typeof testSource !== 'string' || createHash('sha256').update(testSource.replace(/\r\n/g, '\n')).digest('hex') !== expectedTests) {
		errors.push('complete test workflow differs from its reviewed pin');
	}
	const verify = workflow.jobs?.verify;
	if (!verify) return errors;
	if (!sameKeys(verify, ['name', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'outputs', 'steps'])) {
		errors.push('verify job key inventory is not exact: ' + keys(verify).join(', '));
	}
	if (!same(verify.needs, ['identity', 'tests'])) errors.push('artifact packing must depend on every test workflow job');
	if (verify['runs-on'] !== 'ubuntu-latest') errors.push('verify job must use a GitHub-hosted runner');
	if (!same(verify.permissions, { contents: 'read' })) {
		errors.push('verify job permissions must be exactly contents read - it must never hold a publication identity');
	}
	// The verify job reports the filename and digest it checked against the
	// identity job's tag-bound digest. Publication reads only the identity
	// outputs, which never travel inside the artifact they authenticate.
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
	if (!same(publish.needs, ['identity', 'verify'])) {
		errors.push('publish job must depend on identity and verification');
	}
	if (publish.environment !== 'npm-release') errors.push('publish job must use the protected npm-release environment');
	if (!same(publish.permissions, { contents: 'read', 'id-token': 'write' })) {
		errors.push('publish job permissions must be exactly contents read and id-token write');
	}
	checkSteps(errors, 'publish job', publish, PUBLISH_STEPS);

	const actionRefs = [...(identity?.steps || []), ...verify.steps, ...publish.steps].filter((step) => step?.uses).map((step) => step.uses);
	if (actionRefs.length !== 7 || actionRefs.some((ref) => !/@[0-9a-f]{40}$/.test(ref))) {
		errors.push('release workflow must use exactly seven fully pinned actions');
	}
	if (source.includes('NODE_AUTH_TOKEN') || source.includes('secrets.') ||
		/\bnpm\s+publish\s+(?:\.|--)/.test(source)) {
		errors.push('release workflow must not contain token fallback or source-directory publication');
	}
	// Preserve both the names and bodies of all permitted scripts.
	if (!same(pkg.publishConfig, { tag: 'latest' })) errors.push('publishConfig must contain only the stable target tag');
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
	const errors = validateReleaseWorkflow(source, pkg, policy, readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8'));
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
