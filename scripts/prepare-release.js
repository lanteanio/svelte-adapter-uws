/**
 * Fail closed unless the release job is running from the package's exact,
 * annotated version tag and a clean checkout of the commit that tag names.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedRepository = 'lanteanio/svelte-adapter-uws';
const expectedRepositoryUrl = 'git+https://github.com/lanteanio/svelte-adapter-uws.git';
const sourceBranch = 'origin/main';
// The full ref, so a local branch named origin/main cannot stand in for it.
const sourceRef = 'refs/remotes/' + sourceBranch;

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

// Resolve the exact remote-tracking ref; a bare name would fall back to a
// local branch spelled the same when the remote ref is missing.
function sourceCommit(cwd) {
	const result = spawnSync('git', ['show-ref', '--verify', '--hash', sourceRef], { cwd, encoding: 'utf8', windowsHide: true });
	if (result.error || result.status !== 0) throw new Error(sourceRef + ' is missing; fetch ' + sourceBranch + ' first');
	return result.stdout.trim();
}

export function main({ cwd = root, env = process.env } = {}) {
	const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
	const requestErrors = validateReleaseRequest(env, pkg);
	if (requestErrors.length) throw new Error(requestErrors.join('\n- '));
	const ref = env.GITHUB_REF || '';
	const tagContents = git(cwd, ['cat-file', 'tag', ref], false);
	const details = {
		artifactSha256: artifactDigest(tagContents, pkg.name + '@' + pkg.version),
		tagType: ref ? git(cwd, ['cat-file', '-t', ref]) : '',
		tagCommit: ref ? git(cwd, ['rev-list', '-n', '1', ref]) : '',
		tagObject: ref ? git(cwd, ['rev-parse', ref]) : '',
		head: git(cwd, ['rev-parse', 'HEAD']),
		clean: git(cwd, ['status', '--porcelain=v1']).length === 0,
		sourceBranch,
		sourceContainsHead: isAncestor(cwd, 'HEAD', sourceCommit(cwd))
	};
	const errors = validateReleaseContext(env, pkg, details);
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'sha256=' + details.artifactSha256 + '\nfilename=' + pkg.name + '-' + pkg.version + '.tgz\n');
	return { tag: pkg.name + '@' + pkg.version, ...details };
}

/**
 * Return the one regular file at `path` in a gzipped npm tarball, or
 * undefined when it is absent, duplicated or the archive is malformed.
 *
 * @param {Buffer} archive
 * @param {string} path
 */
export function tarballFile(archive, path) {
	const data = gunzipSync(archive);
	let extendedPath;
	let found;
	for (let offset = 0; offset + 512 <= data.length;) {
		const header = data.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
		const sizeField = field(124, 12).trim();
		if (!/^[0-7]*$/.test(sizeField)) return undefined;
		const size = parseInt(sizeField || '0', 8);
		if (offset + 512 + size > data.length) return undefined;
		const type = field(156, 1);
		const prefix = field(345, 155);
		const name = extendedPath ?? (prefix ? prefix + '/' : '') + field(0, 100);
		const body = data.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x') {
			extendedPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
			continue;
		}
		extendedPath = undefined;
		if ((type === '0' || type === '') && name === path) {
			if (found) return undefined;
			found = body;
		}
	}
	return found;
}

/**
 * Check a local annotated tag before it is pushed. A pushed tag is never
 * retargeted, so the tag, package and workflow checks CI applies to the
 * tagged commit run here too. CI additionally repacks that commit and
 * compares the bytes with the bound digest.
 */
export async function verifyLocalTag({ cwd = root, tag, artifact }) {
	if (!tag) throw new Error('a tag name is required');
	if (!artifact) throw new Error('the retained tarball is required');
	const archive = readFileSync(artifact);
	if (git(cwd, ['cat-file', '-t', tag]) !== 'tag') throw new Error('release version tag must be annotated');
	const commit = git(cwd, ['rev-list', '-n', '1', tag]);
	const pkg = JSON.parse(git(cwd, ['show', commit + ':package.json'], false));
	const expectedTag = pkg.name + '@' + pkg.version;
	const errors = [];
	if (tag !== expectedTag) errors.push('tag must be ' + expectedTag + ' for the package at the tagged commit');
	const digest = artifactDigest(git(cwd, ['cat-file', 'tag', tag], false), expectedTag);
	if (!digest) errors.push('annotation must contain exactly one "Artifact-SHA256: <64 lowercase hexadecimal characters>" line');
	if (digest && createHash('sha256').update(archive).digest('hex') !== digest) {
		errors.push('annotation digest does not match ' + artifact);
	}
	// CI repacks the tagged commit, so a tarball packed elsewhere would fail there.
	let manifest;
	try { manifest = JSON.parse(tarballFile(archive, 'package/package.json')?.toString('utf8') ?? ''); } catch { manifest = undefined; }
	if (!manifest) errors.push(artifact + ' is not an npm tarball with package/package.json');
	else {
		if (manifest.name + '@' + manifest.version !== expectedTag) errors.push('tarball package is ' + manifest.name + '@' + manifest.version + ', not ' + expectedTag);
		if (manifest.gitHead !== commit) errors.push('tarball gitHead ' + (manifest.gitHead ?? '(missing)') + ' is not the tagged commit ' + commit);
	}
	if (tag === expectedTag) {
		const env = {
			GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GITHUB_REF: 'refs/tags/' + tag,
			GITHUB_REPOSITORY: expectedRepository, GITHUB_SHA: git(cwd, ['rev-parse', tag])
		};
		errors.push(...validateReleaseRequest(env, pkg));
	}
	// Loaded here only: the CI identity job runs this file before installing dependencies.
	const { validateReleaseWorkflow } = await import('./check-release-workflow.js');
	const blob = file => git(cwd, ['show', commit + ':' + file], false);
	errors.push(...validateReleaseWorkflow(blob('.github/workflows/release.yml'), pkg, blob('docs/releasing.md'), blob('.github/workflows/test.yml')));
	if (!isAncestor(cwd, commit, sourceCommit(cwd))) errors.push('tagged commit is not contained in ' + sourceBranch + '; push main first');
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	return { tag, commit, artifactSha256: digest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	try {
		if (args.length === 0) {
			const result = main();
			console.log('release identity: ' + result.tag + ' at ' + result.head);
		} else if (args.length === 4 && args[0] === '--verify-tag' && args[2] === '--artifact') {
			const result = await verifyLocalTag({ tag: args[1], artifact: args[3] });
			console.log('local tag ' + result.tag + ' binds ' + result.artifactSha256 + ' at ' + result.commit);
		} else {
			throw new Error('usage: node scripts/prepare-release.js [--verify-tag <tag> --artifact <tarball>]');
		}
	} catch (error) {
		console.error('release identity check failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
