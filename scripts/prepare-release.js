#!/usr/bin/env node
/**
 * Fail closed unless the release job is running from the package's exact,
 * annotated version tag and a clean checkout of the commit that tag names.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedRepository = 'lanteanio/svelte-adapter-uws';
const expectedRepositoryUrl = 'git+https://github.com/lanteanio/svelte-adapter-uws.git';

export function validateReleaseRequest(env, pkg) {
	const errors = [];
	const expectedTag = pkg.name + '@' + pkg.version;
	if (env.GITHUB_EVENT_NAME !== 'push') errors.push('release event must be push');
	if (env.GITHUB_REF_TYPE !== 'tag') errors.push('release ref type must be tag');
	if (env.GITHUB_REF_NAME !== expectedTag) errors.push('release tag must exactly match package name and version');
	if (env.GITHUB_REF !== 'refs/tags/' + expectedTag) errors.push('release ref must be the exact version tag');
	if (env.GITHUB_REPOSITORY !== expectedRepository) errors.push('release repository identity is wrong');
	if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '')) errors.push('release event SHA must be a full commit or tag identity');
	if (pkg.name !== 'svelte-adapter-uws') errors.push('package name is not publishable by this workflow');
	if (pkg.private === true) errors.push('private package cannot use the public release workflow');
	if (pkg.repository?.url !== expectedRepositoryUrl) errors.push('package repository URL does not match GitHub identity');
	if (typeof pkg.version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pkg.version) || pkg.version.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
		errors.push('package version must be canonical stable SemVer');
	}
	if (JSON.stringify(pkg.publishConfig) !== JSON.stringify({ tag: 'latest' })) errors.push('stable publishConfig tag must be latest');
	return errors;
}

export function validateReleaseContext(env, pkg, git) {
	const errors = validateReleaseRequest(env, pkg);
	if (errors.length) return errors;
	const sourceBranch = 'origin/main';
	if (git.sourceBranch !== sourceBranch || !git.sourceContainsHead) {
		errors.push('release commit is not contained in the required ' + sourceBranch + ' lineage');
	}
	if (git.tagType !== 'tag') errors.push('release version tag must be annotated');
	if (!/^[0-9a-f]{40}$/.test(git.head || '')) errors.push('checked-out HEAD is not a full commit');
	if (git.tagCommit !== git.head) errors.push('checked-out HEAD differs from annotated tag commit');
	// Bind the EVENT revision to the checkout: without this, a workflow run
	// whose checkout resolved something other than the pushed revision would
	// pass every identity check while publishing different bytes. The event
	// SHA is the tag object for an annotated tag push, so either identity
	// (tag object or the commit it points at) must equal what is on disk.
	if (env.GITHUB_SHA !== git.head && env.GITHUB_SHA !== git.tagObject) {
		errors.push('release event SHA is bound to neither the checked-out HEAD nor the annotated tag object');
	}
	if (!git.clean) errors.push('release checkout is dirty');
	if (!/^[0-9a-f]{64}$/.test(git.artifactSha256 || '')) errors.push('annotated tag must bind exactly one retained artifact SHA256');
	return errors;
}

export function artifactDigest(tagContents, expectedTag) {
	if (typeof tagContents !== 'string') return undefined;
	const separator = tagContents.indexOf('\n\n');
	if (separator === -1) return undefined;
	const headers = tagContents.slice(0, separator);
	if (!/^object [0-9a-f]{40}\ntype commit\ntag svelte-adapter-uws@[0-9.]+\ntagger [^\n]+$/.test(headers)) return undefined;
	if (headers.split('\n')[2] !== 'tag ' + expectedTag) return undefined;
	const message = tagContents.slice(separator + 2);
	const lines = message.split(/\r?\n/).filter(line => /artifact-sha256/i.test(line));
	return lines.length === 1 ? /^Artifact-SHA256: ([0-9a-f]{64})$/.exec(lines[0])?.[1] : undefined;
}

function git(cwd, args, trim = true) {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		windowsHide: true
	});
	if (result.error || result.status !== 0) {
		throw new Error('git ' + args.join(' ') + ' failed: ' + (result.error?.message || result.stderr.trim()));
	}
	return trim ? result.stdout.trim() : result.stdout;
}

function isAncestor(cwd, commit, branch) {
	const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, branch], {
		cwd,
		encoding: 'utf8',
		windowsHide: true
	});
	if (result.error || (result.status !== 0 && result.status !== 1)) {
		throw new Error('could not verify release lineage: ' + (result.error?.message || result.stderr.trim()));
	}
	return result.status === 0;
}

export function main({ cwd = root, env = process.env } = {}) {
	const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
	const requestErrors = validateReleaseRequest(env, pkg);
	if (requestErrors.length) throw new Error(requestErrors.join('\n- '));
	const ref = env.GITHUB_REF || '';
	const sourceBranch = 'origin/main';
	const tagContents = git(cwd, ['cat-file', 'tag', ref], false);
	const details = {
		artifactSha256: artifactDigest(tagContents, pkg.name + '@' + pkg.version),
		tagType: ref ? git(cwd, ['cat-file', '-t', ref]) : '',
		tagCommit: ref ? git(cwd, ['rev-list', '-n', '1', ref]) : '',
		tagObject: ref ? git(cwd, ['rev-parse', ref]) : '',
		head: git(cwd, ['rev-parse', 'HEAD']),
		clean: git(cwd, ['status', '--porcelain=v1']).length === 0,
		sourceBranch,
		sourceContainsHead: isAncestor(cwd, 'HEAD', sourceBranch)
	};
	const errors = validateReleaseContext(env, pkg, details);
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'sha256=' + details.artifactSha256 + '\nfilename=' + pkg.name + '-' + pkg.version + '.tgz\n');
	return { tag: pkg.name + '@' + pkg.version, ...details };
}

/**
 * Check a local annotated tag before it is pushed. A pushed tag is never
 * retargeted, so a malformed annotation must be caught on the owner's machine.
 */
export function verifyLocalTag({ cwd = root, tag, artifact }) {
	if (!tag) throw new Error('a tag name is required');
	if (git(cwd, ['cat-file', '-t', tag]) !== 'tag') throw new Error('release version tag must be annotated');
	const commit = git(cwd, ['rev-list', '-n', '1', tag]);
	const pkg = JSON.parse(git(cwd, ['show', commit + ':package.json'], false));
	const expectedTag = pkg.name + '@' + pkg.version;
	const errors = [];
	if (tag !== expectedTag) errors.push('tag must be ' + expectedTag + ' for the package at the tagged commit');
	const digest = artifactDigest(git(cwd, ['cat-file', 'tag', tag], false), expectedTag);
	if (!digest) errors.push('annotation must contain exactly one "Artifact-SHA256: <64 lowercase hexadecimal characters>" line');
	if (artifact && digest && createHash('sha256').update(readFileSync(artifact)).digest('hex') !== digest) {
		errors.push('annotation digest does not match ' + artifact);
	}
	if (!isAncestor(cwd, commit, 'origin/main')) errors.push('tagged commit is not contained in origin/main; push main first');
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	return { tag, commit, artifactSha256: digest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const option = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
	try {
		if (args.includes('--verify-tag')) {
			const result = verifyLocalTag({ tag: option('--verify-tag'), artifact: option('--artifact') });
			console.log('local tag ' + result.tag + ' binds ' + result.artifactSha256 + ' at ' + result.commit);
		} else {
			const result = main();
			console.log('release identity: ' + result.tag + ' at ' + result.head);
		}
	} catch (error) {
		console.error('release identity check failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
