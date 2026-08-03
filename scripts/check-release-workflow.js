#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, '.github', 'workflows', 'release.yml');
const packagePath = resolve(root, 'package.json');
const policyPath = resolve(root, 'docs/releasing.md');

function same(value, expected) {
	return JSON.stringify(value) === JSON.stringify(expected);
}

function normalized(value) {
	return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function validateReleaseWorkflow(source, pkg, policy) {
	const errors = [];
	let workflow;
	try {
		workflow = parse(source);
	} catch (error) {
		return ['release workflow is not valid YAML: ' + error.message];
	}
	if (!same(Object.keys(workflow.on || {}), ['push'])) errors.push('release workflow must have only a push trigger');
	if (!same(workflow.on?.push?.tags, ['svelte-adapter-uws@*'])) {
		errors.push('release workflow must trigger only on package version tags');
	}
	if (workflow.on?.push?.branches || source.includes('workflow_dispatch')) {
		errors.push('release workflow must not have a branch or manual-dispatch path');
	}
	if (!same(workflow.permissions, { contents: 'read' })) errors.push('workflow default permission must be contents read');
	if (!same(Object.keys(workflow.jobs || {}), ['release'])) errors.push('release workflow must have exactly one job');
	const job = workflow.jobs?.release;
	if (!job) return errors;
	if (job['runs-on'] !== 'ubuntu-latest') errors.push('trusted publishing must use a GitHub-hosted runner');
	if (job.environment !== 'npm-release') errors.push('release job must use the protected npm-release environment');
	if (!same(job.permissions, { contents: 'read', 'id-token': 'write' })) {
		errors.push('release job permissions must be exactly contents read and id-token write');
	}
	const steps = Array.isArray(job.steps) ? job.steps : [];
	const named = new Map(steps.map((step) => [step.name, step]));
	const checkout = named.get('Check out immutable tag');
	if (!checkout || checkout.uses !== 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' ||
		checkout.with?.ref !== '${{ github.sha }}' || checkout.with?.['fetch-depth'] !== 0 ||
		checkout.with?.['persist-credentials'] !== false) {
		errors.push('checkout must pin the action and exact event revision without credentials');
	}
	const setup = named.get('Set up pinned Node and npm registry');
	if (!setup || setup.uses !== 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020' ||
		setup.with?.['node-version-file'] !== '.nvmrc' ||
		setup.with?.['registry-url'] !== 'https://registry.npmjs.org') {
		errors.push('setup-node must be pinned to the repository Node and public npm registry');
	}
	const actionRefs = steps.filter((step) => step.uses).map((step) => step.uses);
	if (actionRefs.length !== 3 || actionRefs.some((ref) => !/@[0-9a-f]{40}$/.test(ref))) {
		errors.push('release workflow must use exactly three fully pinned actions');
	}
	const requiredRuns = new Map([
		['Install OIDC-capable npm', 'npm install --global npm@11.5.1'],
		['Verify tag, package, and source identity', 'node scripts/prepare-release.js'],
		['Install locked root dependencies', 'npm ci'],
		['Install locked fixture dependencies', 'npm ci --prefix test/fixture'],
		['Run the complete pull-request verification contract', 'npm run verify:pr'],
		['Run the publication lifecycle gate', 'npm run prepublishOnly'],
		['Publish exact tarball to quarantine with trusted OIDC', 'npm publish "${{ steps.pack.outputs.tarball }}" --tag candidate']
	]);
	for (const [name, command] of requiredRuns) {
		if (normalized(named.get(name)?.run) !== command) errors.push(name + ' command is not exact');
	}
	const pack = named.get('Pack retained artifact');
	if (!pack || pack.id !== 'pack' || pack.shell !== 'pwsh') errors.push('retained artifact pack step is missing');
	const packRun = pack?.run || '';
	for (const token of [
		'npm pack --json --pack-destination release-artifacts',
		'$records.Count -ne 1',
		"^[a-z0-9._-]+\\.tgz$",
		'Test-Path -LiteralPath $tarball -PathType Leaf',
		"'tarball=' + $tarball >> $env:GITHUB_OUTPUT"
	]) {
		if (!packRun.includes(token)) errors.push('retained artifact step is missing: ' + token);
	}
	const upload = named.get('Retain exact publication artifact');
	if (!upload || upload.uses !== 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' ||
		upload.with?.path !== '${{ steps.pack.outputs.tarball }}' ||
		upload.with?.['if-no-files-found'] !== 'error') {
		errors.push('retained tarball must be uploaded by the pinned artifact action');
	}
	if (source.includes('NODE_AUTH_TOKEN') || source.includes('secrets.') ||
		/\bnpm\s+publish\s+(?:\.|--)/.test(source)) {
		errors.push('release workflow must not contain token fallback or source-directory publication');
	}
	if (pkg.scripts?.prepublishOnly !== 'npm run check') {
		errors.push('package prepublishOnly gate is not exact');
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
