import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateReleaseWorkflow } from '../scripts/check-release-workflow.js';
import { artifactDigest as parseArtifactDigest, validateReleaseContext } from '../scripts/prepare-release.js';
import { validateReleaseEnvironment } from '../scripts/check-release-environment.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const source = read('.github/workflows/release.yml');
const testSource = read('.github/workflows/test.yml');
const pkg = JSON.parse(read('package.json'));
const policy = read('docs/releasing.md');
const check = (text = source, manifest = pkg, tests = testSource) => validateReleaseWorkflow(text, manifest, policy, tests);
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: pkg.name + '@' + pkg.version,
	GITHUB_REF: 'refs/tags/' + pkg.name + '@' + pkg.version, GITHUB_REPOSITORY: 'lanteanio/svelte-adapter-uws', GITHUB_SHA: 'a'.repeat(40) };
const git = { tagType: 'tag', tagObject: 'a'.repeat(40), tagCommit: 'b'.repeat(40), head: 'b'.repeat(40),
	clean: true, sourceBranch: 'origin/main', sourceContainsHead: true, artifactSha256: 'c'.repeat(64) };

const artifactDigest = contents => parseArtifactDigest(contents, 'svelte-adapter-uws@0.5.11');

function mutant(change) {
	const workflow = parse(source);
	change(workflow);
	const text = stringify(workflow);
	expect(text).not.toBe(source);
	expect(check(text)).not.toEqual([]);
}

describe('closed stable publication', () => {
	it('accepts only the complete checked-in route', () => {
		expect(check()).toEqual([]);
		expect(check(source.replaceAll('\n', '\r\n'), pkg, testSource.replaceAll('\n', '\r\n'))).toEqual([]);
	});

	it('rejects missing, duplicated, reordered, modified and injected steps in every executable job', () => {
		for (const name of ['identity', 'verify', 'publish']) {
			const steps = parse(source).jobs[name].steps;
			for (let index = 0; index < steps.length; index++) {
				mutant(w => w.jobs[name].steps.splice(index, 1));
				mutant(w => w.jobs[name].steps.splice(index, 0, w.jobs[name].steps[index]));
				for (const [key, value] of Object.entries({ if: false, 'continue-on-error': true, shell: 'bash -c "false; {0}"', env: { NODE_OPTIONS: '--require ./wrong.js' } })) {
					mutant(w => { w.jobs[name].steps[index][key] = value; });
				}
				if (steps[index].run) mutant(w => { w.jobs[name].steps[index].run += '\necho changed'; });
				if (steps[index].uses) mutant(w => { w.jobs[name].steps[index].uses = steps[index].uses.split('@')[0] + '@main'; });
			}
			mutant(w => w.jobs[name].steps.reverse());
		}
	});

	it('refuses trigger widening, permissions, skipped jobs and output laundering', () => {
		mutant(w => { w.on.workflow_dispatch = {}; });
		mutant(w => { w.on.push.branches = ['main']; });
		mutant(w => { w.on.push['branches-ignore'] = ['unused']; });
		mutant(w => { w.permissions['id-token'] = 'write'; });
		mutant(w => { w.env = { NODE_OPTIONS: '--require ./wrong.js' }; });
		mutant(w => { w.concurrency['cancel-in-progress'] = true; });
		mutant(w => { w.concurrency.group = 'release'; });
		mutant(w => { delete w.concurrency; });
		for (const name of ['identity', 'tests', 'verify', 'publish']) {
			for (const [key, value] of Object.entries({ if: false, 'continue-on-error': true, env: { NODE_OPTIONS: '--require ./wrong.js' }, container: 'wrong/image', defaults: { run: { shell: 'bash' } } })) {
				mutant(w => { w.jobs[name][key] = value; });
			}
			mutant(w => { delete w.jobs[name]; });
		}
		mutant(w => { w.jobs.tests.permissions['id-token'] = 'write'; });
		mutant(w => { w.jobs.verify.permissions['id-token'] = 'write'; });
		mutant(w => { w.jobs.identity.steps.push({ run: 'npm ci' }); });
		mutant(w => { w.jobs.publish.steps.push({ run: 'npm ci' }); });
		mutant(w => { w.jobs.verify.needs = 'identity'; });
		mutant(w => { w.jobs.publish.needs = 'verify'; });
		mutant(w => { w.jobs.publish.environment = 'unprotected'; });
		mutant(w => { w.jobs.identity.outputs.sha256 = '${{ steps.other.outputs.sha256 }}'; });
		mutant(w => { w.jobs.verify.outputs.sha256 = '${{ steps.other.outputs.sha256 }}'; });
		mutant(w => { w.jobs.publish.steps.at(-1).run = 'npm publish . --tag latest'; });
		expect(check(source.replaceAll('needs.identity.outputs.sha256', 'needs.verify.outputs.sha256'))).not.toEqual([]);
		for (const extra of [{ registry: 'http://127.0.0.1:59999' }, { provenance: false }, { access: 'restricted' }]) {
			const altered = { ...pkg, publishConfig: { ...pkg.publishConfig, ...extra } };
			expect(check(source, altered)).not.toEqual([]);
			expect(validateReleaseContext(env, altered, git)).not.toEqual([]);
		}
		const publish = parse(source).jobs.publish;
		expect(publish.steps.some(step => step.uses?.startsWith('actions/checkout@'))).toBe(false);
		expect(publish.steps.at(-1).run).toContain('--registry=https://registry.npmjs.org --provenance');
	});

	it('pins the full same-SHA test workflow and the complete npm script inventory', () => {
		const workflow = parse(testSource);
		expect(workflow.on).toHaveProperty('workflow_call');
		for (const job of Object.values(workflow.jobs)) expect(job.steps[0].with.ref).toBe('${{ github.sha }}');
		for (const name of Object.keys(workflow.jobs)) {
			const changed = structuredClone(workflow);
			delete changed.jobs[name];
			expect(check(source, pkg, stringify(changed))).not.toEqual([]);
		}
		for (const name of Object.keys(pkg.scripts)) {
			const edited = structuredClone(pkg); edited.scripts[name] = 'echo ok'; expect(check(source, edited)).not.toEqual([]);
			const removed = structuredClone(pkg); delete removed.scripts[name]; expect(check(source, removed)).not.toEqual([]);
		}
		for (const name of ['prepack', 'prepare', 'postpack', 'posttest', 'prepack:release', '__proto__']) {
			const added = structuredClone(pkg); Object.defineProperty(added.scripts, name, { value: 'echo wrong', enumerable: true });
			expect(check(source, added)).not.toEqual([]);
		}
	});

	it('executes the publisher digest gate against real retained and tampered bytes', () => {
		const shell = ['pwsh', 'powershell'].find(bin => spawnSync(bin, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true }).status === 0);
		expect(shell, 'PowerShell is required for the publication digest test').toBeTruthy();
		const dir = mkdtempSync(join(tmpdir(), 'uws-release-digest-'));
		try {
			mkdirSync(join(dir, 'release-artifacts'));
			const original = Buffer.from('retained publication bytes');
			const digest = createHash('sha256').update(original).digest('hex');
			const step = parse(source).jobs.publish.steps.find(step => step.name.startsWith('Refuse to publish'));
			const run = (bytes, expected, filename = 'svelte-adapter-uws-0.5.11.tgz') => {
				writeFileSync(join(dir, 'release-artifacts', 'svelte-adapter-uws-0.5.11.tgz'), bytes);
				const script = step.run.replaceAll('${{ needs.identity.outputs.sha256 }}', expected).replaceAll('${{ needs.identity.outputs.filename }}', filename);
				return spawnSync(shell, ['-NoProfile', '-Command', script], { cwd: dir, encoding: 'utf8', windowsHide: true });
			};
			expect(run(original, digest).status).toBe(0);
			for (const bytes of [Buffer.from('retained publication byteS'), Buffer.concat([original, Buffer.from('x')])]) expect(run(bytes, digest).status).not.toBe(0);
			for (const expected of ['', 'a'.repeat(64), digest + 'x']) expect(run(original, expected).status).not.toBe(0);
			expect(run(original, digest, '../wrong.tgz').status).not.toBe(0);
			expect(run(original, digest, 'missing.tgz').status).not.toBe(0);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}, 60_000);
});

describe('stable identity and account protection', () => {
	it('rejects wrong event, branch, tag, commit, lineage, package or digest', () => {
		expect(validateReleaseContext(env, pkg, git)).toEqual([]);
		for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'wrong', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'other/repo', GITHUB_SHA: 'd'.repeat(40) })) {
			expect(validateReleaseContext({ ...env, [key]: value }, pkg, git)).not.toEqual([]);
		}
		for (const [key, value] of Object.entries({ tagType: 'commit', tagCommit: 'd'.repeat(40), clean: false, sourceBranch: 'origin/dev', sourceContainsHead: false, artifactSha256: '' })) {
			expect(validateReleaseContext(env, pkg, { ...git, [key]: value })).not.toEqual([]);
		}
		for (const version of ['0.5.11-next.1', '0.5.11+build', '00.5.11', '9007199254740992.0.0']) expect(validateReleaseContext(env, { ...pkg, version }, git)).not.toEqual([]);
		const result = spawnSync(process.execPath, ['scripts/prepare-release.js'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: '', Path: '', GITHUB_EVENT_NAME: 'pull_request' } });
		expect(result.status).toBe(1); expect(result.stderr).toContain('release event must be push'); expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
	});

	it('reads exactly one canonical digest from the outer annotated commit tag', () => {
		const header = 'object ' + 'b'.repeat(40) + '\ntype commit\ntag svelte-adapter-uws@0.5.11\ntagger Test <test@example.test> 1 +0000\n\n';
		const line = 'Artifact-SHA256: ' + 'c'.repeat(64);
		expect(artifactDigest(header + 'Release\n\n' + line + '\n')).toBe('c'.repeat(64));
		for (const message of ['', line + '\n' + line, line + '\n artifact-sha256: bad', line + ' extra', line + '\nArtifact-SHA256: bad', line.replace('Artifact', 'artifact'), line.replace(/c/g, 'C'), line + '\nArtifact-SHA256: x\nfilename=evil.tgz']) {
			expect(artifactDigest(header + message)).toBeUndefined();
		}
		expect(artifactDigest(header.replace('type commit', 'type tag') + line)).toBeUndefined();
		expect(artifactDigest(header.replace('@0.5.11', '@9.9.9') + line)).toBeUndefined();
		expect(artifactDigest(line)).toBeUndefined();
	});

	it('refuses absent reviewers, missing environments and widened deployment policies', () => {
		const environment = { name: 'npm-release', can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
		const policies = { total_count: 1, branch_policies: [{ name: 'svelte-adapter-uws@*', type: 'tag' }] };
		expect(() => validateReleaseEnvironment(environment, policies)).not.toThrow();
		for (const change of [e => { e.name = 'other'; }, e => { e.protection_rules = []; }, e => { e.protection_rules[0].reviewers = []; }, e => { e.deployment_branch_policy = null; }, e => { e.can_admins_bypass = true; }, e => { delete e.can_admins_bypass; }]) {
			const value = structuredClone(environment); change(value); expect(() => validateReleaseEnvironment(value, policies)).toThrow();
		}
		for (const value of [{ total_count: 0, branch_policies: [] }, { ...policies, total_count: 2 }, { total_count: 1, branch_policies: [{ name: '*', type: 'tag' }] }, { total_count: 1, branch_policies: [{ name: 'svelte-adapter-uws@*', type: 'branch' }] }]) expect(() => validateReleaseEnvironment(environment, value)).toThrow();
	});
});
